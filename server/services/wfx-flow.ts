import { createHash } from 'node:crypto';
import type { App } from '../core/app.js';
import { ymdInTz } from '../core/time.js';
import { id as newId, now } from '../core/util.js';
import { FormatError, addToDate, nextInWindow, parseDate, tzOrDefault, wallClock, fromWall } from './formatters.js';
import { evalConditions, type ActionOutcome } from './workflow-engine.js';
import { readPath, requireText, resolve, toText, tzOf, type ActionDef, type FieldDef } from './wfx-kit.js';
import { toList } from './wfx-data.js';

/**
 * Flow steps: Go-to, "Ziel erreicht → springe", split test A/B/n, loop over a list, drip release, and the waits
 * "bis Bedingung", "Zeitfenster (Geschäftszeiten)", "Datum relativ zu einem Feld" and "auf Antwort warten".
 * Branching steps return where to go on (`goto`, `enter`, `wait_until`) and the engine does it; every jump and every
 * loop is capped, so a wrong workflow cannot run forever.
 */

export const HARD_MAX_JUMPS = 100;
export const HARD_MAX_LOOP_ITEMS = 500;
export const MAX_VARIANTS = 5;

const CONDITIONS: FieldDef[] = [
  { key: 'conditions', label: 'Bedingungen', type: 'conditions', help: 'Felder (contact.…, event.…, var.…) mit Vergleichen – oder unten ein Ausdruck.' },
  { key: 'expression', label: 'Oder Ausdruck', type: 'code', placeholder: 'contact.custom.budget > 1000 && "vip" in contact.tags' },
];

const intervalMs = (amount: unknown, unit: unknown): number => {
  const n = Math.max(0, Number(amount) || 0);
  return n * (unit === 'days' ? 864e5 : unit === 'hours' ? 36e5 : 6e4);
};

/** Picks a variant index by weight; `r` is a number in [0, 1). */
export function pickVariant(weights: number[], r: number): number {
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const total = w.reduce((a, b) => a + b, 0);
  if (!total) return Math.min(weights.length - 1, Math.floor(r * weights.length));
  let acc = 0;
  for (let i = 0; i < w.length; i++) {
    acc += w[i] / total;
    if (r < acc) return i;
  }
  return w.length - 1;
}

/** A stable number in [0, 1) from a text (the same contact gets the same split-test path every time). */
export function stableRandom(key: string): number {
  const h = createHash('sha256').update(key).digest();
  return h.readUIntBE(0, 6) / 2 ** 48;
}

/** The earliest slot of a drip with room left, or a new one `interval` after the last (never in the past). */
export function dripSlot(last: { slot_at: string; used: number } | undefined, batch: number, intervalMillis: number, nowMs: number): { slot: number; fresh: boolean } {
  if (last) {
    const t = Date.parse(last.slot_at);
    if (last.used < batch && (t > nowMs || t + intervalMillis > nowMs)) return { slot: t, fresh: false };
    return { slot: Math.max(t + intervalMillis, nowMs), fresh: true };
  }
  return { slot: nowMs, fresh: true };
}

export function flowActions(app: App): ActionDef[] {
  const db = app.db;
  const defs: ActionDef[] = [];
  const add = (d: ActionDef) => defs.push(d);
  const nowMs = () => (app.services.wfxNow ? Number(app.services.wfxNow()) : Date.now());
  const gate = (step: any, vars: Record<string, any>) => evalConditions({ id: step.id, type: step.type, conditions: step.conditions, match: step.match, expression: step.expression }, vars);
  const hasCondition = (step: any) => (Array.isArray(step.conditions) && step.conditions.some((c: any) => c?.field)) || !!String(step.expression ?? '').trim();
  const stepName = (fc: { find: (id: string) => (number | string)[] | null }, target: string) => {
    const c = fc.find(target);
    return c ? `Schritt ${c.filter((x): x is number => typeof x === 'number').map((x) => x + 1).join('.')}` : target;
  };

  /** Counts a jump at this step; null once the limit is used up (the flow then simply goes on). */
  const jumpCount = (run: any, stepId: string, max: number): { n: number; vars: Record<string, unknown> } | null => {
    const jumps = { ...(run.vars._jumps ?? {}) } as Record<string, number>;
    const n = (jumps[stepId] ?? 0) + 1;
    if (n > max) return null;
    jumps[stepId] = n;
    return { n, vars: { _jumps: jumps } };
  };
  const capJumps = (step: any) => Math.min(HARD_MAX_JUMPS, Math.max(1, Math.floor(Number(step.max_jumps) || 10)));

  // --- go to --------------------------------------------------------------------------------------
  add({
    meta: {
      type: 'goto',
      label: 'Springe zu Schritt',
      category: 'flow',
      icon: 'move',
      summary: 'Springt im Ablauf zu einem anderen Schritt – optional nur, wenn eine Bedingung zutrifft.',
      doc: 'Damit baust du Wiederholungen („nach 3 Tagen nochmal prüfen“) und Abkürzungen. Ziel ist ein beliebiger Schritt des Workflows (auch in einem Wenn/Sonst-Zweig). Jeder Sprung ist begrenzt: nach der eingestellten Zahl von Sprüngen (höchstens 100) läuft der Ablauf einfach weiter, und je Durchlauf gibt es eine Gesamtgrenze an Schritten – so entsteht keine Endlosschleife.',
      keywords: 'goto jump springen schleife wiederholen',
      pure: true,
      fields: [
        { key: 'target', label: 'Springe zu', type: 'step', required: true },
        { key: 'max_jumps', label: 'Höchstens so oft springen', type: 'number', default: 10, help: 'Danach geht es ohne Sprung weiter (max. 100).' },
        ...CONDITIONS.map((f) => ({ ...f, label: f.key === 'conditions' ? 'Nur springen, wenn …' : f.label })),
      ],
      sample: { target: '', max_jumps: 3 },
    },
    run: (run, step, vars, fc) => {
      const target = requireText(step.target, 'Sprungziel');
      if (hasCondition(step) && !gate(step, vars)) return { result: 'Bedingung nicht erfüllt – kein Sprung' };
      if (!fc.find(target)) throw new Error('Sprungziel nicht gefunden – bitte den Schritt neu wählen');
      const j = jumpCount(run, step.id, capJumps(step));
      if (!j) return { result: `Sprunggrenze erreicht (${capJumps(step)} Sprünge) – kein weiterer Sprung, der Ablauf geht weiter` };
      return { result: `Sprung zu ${stepName(fc, target)} (${j.n}. Mal)`, goto: target, vars: j.vars };
    },
  });

  add({
    meta: {
      type: 'goal_jump',
      label: 'Ziel erreicht → springe',
      category: 'flow',
      icon: 'goal',
      summary: 'Prüft ein Ziel: erreicht → zu einem Schritt springen oder beenden, sonst weiter.',
      doc: 'Wie „Ziel erreicht? → Ende“, aber mit Wahl: Wird das Ziel erreicht (z. B. Tag „termin-gebucht“ oder Rechnung bezahlt), springt der Ablauf zu einem Schritt (z. B. „Danke-Mail“) oder endet. Ist es noch nicht erreicht, geht es mit dem nächsten Schritt weiter. Das Ziel zählt in der Auswertung eines Split-Tests als Erfolg.',
      keywords: 'goal ziel conversion erreicht',
      pure: true,
      fields: [
        ...CONDITIONS.map((f) => ({ ...f, label: f.key === 'conditions' ? 'Ziel erreicht, wenn …' : f.label })),
        { key: 'on_reached', label: 'Wenn erreicht', type: 'select', options: [['goto', 'Zu Schritt springen'], ['end', 'Ablauf beenden']], default: 'goto' },
        { key: 'target', label: 'Springe zu', type: 'step', showIf: { field: 'on_reached', in: ['goto'] } },
        { key: 'max_jumps', label: 'Höchstens so oft springen', type: 'number', default: 10, showIf: { field: 'on_reached', in: ['goto'] } },
      ],
      sample: { conditions: [{ field: 'tag', op: 'has', value: 'termin-gebucht' }], on_reached: 'end' },
    },
    run: (run, step, vars, fc) => {
      if (!hasCondition(step)) throw new Error('Bitte eine Bedingung für das Ziel angeben');
      if (!gate(step, vars)) return { result: 'Ziel noch nicht erreicht' };
      if (step.on_reached === 'end') return { result: 'erreicht → Ende', end: true };
      const target = requireText(step.target, 'Sprungziel');
      if (!fc.find(target)) throw new Error('Sprungziel nicht gefunden – bitte den Schritt neu wählen');
      const j = jumpCount(run, step.id, capJumps(step));
      if (!j) return { result: `erreicht – Sprunggrenze (${capJumps(step)}) aufgebraucht, der Ablauf geht weiter` };
      return { result: `erreicht → ${stepName(fc, target)}`, goto: target, vars: j.vars };
    },
  });

  // --- split test ---------------------------------------------------------------------------------
  add({
    meta: {
      type: 'split_test',
      label: 'Split-Test (A/B/n)',
      category: 'flow',
      icon: 'branch',
      summary: 'Teilt Kontakte nach Gewichten auf bis zu 5 Pfade auf und zählt, welcher besser läuft.',
      doc: 'Jeder Kontakt wird zufällig einem Pfad zugewiesen (Gewichte in Prozent, 50/50 oder z. B. 70/20/10). Mit „Immer derselbe Pfad“ landet derselbe Kontakt bei Wiederholung wieder im gleichen Pfad. Die Pfade sind eigene Schrittlisten im Ablauf; danach geht es gemeinsam weiter. Die Variable {{var.<Name>}} enthält den Pfadnamen. Auswertung unter „Verlauf → Split-Tests“: Zuweisungen, laufend, abgeschlossen und erreichte Ziele je Pfad.',
      keywords: 'ab test split variant experiment',
      pure: true,
      container: true,
      fields: [
        { key: 'name', label: 'Name des Tests', type: 'text', placeholder: 'Betreffzeilen-Test' },
        { key: 'var_name', label: 'Variable für den Pfadnamen', type: 'text', default: 'split' },
        { key: 'sticky', label: 'Immer derselbe Pfad für denselben Kontakt', type: 'bool', default: true },
        {
          key: 'variants',
          label: 'Pfade',
          type: 'rows',
          addLabel: '+ Pfad',
          rows: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'weight', label: 'Anteil %', type: 'number', default: 50 }],
        },
      ],
      sample: { name: 'Betreff-Test', variants: [{ name: 'A', weight: 50 }, { name: 'B', weight: 50 }], sticky: true },
    },
    run: (run, step, _vars, fc) => {
      const variants: { name: string; weight: number }[] = (Array.isArray(step.variants) ? step.variants : []).slice(0, MAX_VARIANTS).map((v: any, i: number) => ({ name: String(v?.name || String.fromCharCode(65 + i)).slice(0, 40), weight: Math.max(0, Number(v?.weight) || 0) }));
      if (variants.length < 2) throw new Error('Ein Split-Test braucht mindestens zwei Pfade');
      const store = { ...(run.vars._split ?? {}) } as Record<string, number>;
      let index = store[step.id];
      if (index === undefined || index >= variants.length) {
        const prior = !fc.dry && step.sticky !== false ? db.get<{ variant: number }>('SELECT variant FROM wfx_split WHERE workflow_id = ? AND step_id = ? AND contact_id = ? ORDER BY created_at DESC LIMIT 1', run.workflow_id, step.id, run.contact_id) : undefined;
        const rnd: () => number = app.services.wfxRandom ?? Math.random;
        index = prior && prior.variant < variants.length ? prior.variant : pickVariant(variants.map((v) => v.weight), step.sticky !== false && !fc.dry ? stableRandom(`${run.workflow_id}:${step.id}:${run.contact_id}`) : rnd());
        store[step.id] = index;
        if (!fc.dry) db.run('INSERT OR IGNORE INTO wfx_split (id, workflow_id, step_id, run_id, contact_id, variant, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', newId(), run.workflow_id, step.id, run.id, run.contact_id, index, variants[index].name, now());
      }
      const total = variants.reduce((a, v) => a + v.weight, 0) || 1;
      const varName = /^[A-Za-z_]\w{0,40}$/.test(String(step.var_name ?? '')) ? String(step.var_name) : 'split';
      return { result: `Pfad ${variants[index].name} (${Math.round((variants[index].weight / total) * 100)} %)`, enter: `b${index}`, vars: { [varName]: variants[index].name, _split: store }, output: { variant: variants[index].name, index } };
    },
  });

  // --- loop ---------------------------------------------------------------------------------------
  add({
    meta: {
      type: 'loop',
      label: 'Schleife (für jedes Element)',
      category: 'flow',
      icon: 'repeat',
      summary: 'Führt die Schritte darin für jedes Element einer Liste aus – mit fester Obergrenze.',
      doc: 'Die Liste kommt aus einer Variable ({{var.items}}), JSON ({{event.payload.lines}}) oder Text mit einem Eintrag je Zeile. In den Schritten darin stehen {{var.item}} (das Element) und {{var.index}} (Position ab 0) zur Verfügung – die Namen sind einstellbar. Sicherheit: höchstens 100 Elemente (einstellbar bis 500), die Liste wird beim Start gemerkt; zusätzlich begrenzt die Schritt-Grenze je Durchlauf jede Schleife.',
      keywords: 'loop for each schleife iteration array liste',
      pure: true,
      container: true,
      fields: [
        { key: 'items', label: 'Liste', type: 'text', placeholder: '{{var.items}}', required: true },
        { key: 'item_var', label: 'Variable für das Element', type: 'text', default: 'item' },
        { key: 'index_var', label: 'Variable für die Position', type: 'text', default: 'index' },
        { key: 'max_items', label: 'Höchstens so viele Elemente', type: 'number', default: 100, help: 'Mehr als 500 sind nicht möglich.' },
      ],
      provides: ['var.item', 'var.index'],
      sample: { items: '{{var.items}}', item_var: 'item', max_items: 50 },
    },
    run: (run, step, vars) => {
      if (!Array.isArray(step.each) || !step.each.length) return { result: 'Schleife ohne Schritte – übersprungen' };
      const itemVar = /^[A-Za-z_]\w{0,40}$/.test(String(step.item_var ?? '')) ? String(step.item_var) : 'item';
      const indexVar = /^[A-Za-z_]\w{0,40}$/.test(String(step.index_var ?? '')) ? String(step.index_var) : 'index';
      const loops = { ...(run.vars._loops ?? {}) } as Record<string, { i: number; items: unknown[] }>;
      let st = loops[step.id];
      if (!st) {
        const cap = Math.min(HARD_MAX_LOOP_ITEMS, Math.max(1, Math.floor(Number(step.max_items) || 100)));
        const all = toList(resolve(step.items, vars, { json: true }));
        if (JSON.stringify(all.slice(0, cap)).length > 100_000) throw new Error('Die Liste ist zu groß (über 100 KB)');
        st = { i: 0, items: all.slice(0, cap) };
        if (!st.items.length) return { result: 'Liste ist leer – übersprungen' };
        loops[step.id] = st;
        const out: ActionOutcome = { result: `Element 1 von ${st.items.length}${all.length > cap ? ` (Liste auf ${cap} gekürzt, ${all.length} vorhanden)` : ''}`, enter: 'each', vars: { [itemVar]: st.items[0], [indexVar]: 0, _loops: loops }, output: st.items[0] };
        return out;
      }
      const next = { ...st, i: st.i + 1 };
      if (next.i >= next.items.length) {
        delete loops[step.id];
        return { result: `Schleife beendet (${next.items.length} Elemente)`, vars: { _loops: loops } };
      }
      loops[step.id] = next;
      return { result: `Element ${next.i + 1} von ${next.items.length}`, enter: 'each', vars: { [itemVar]: next.items[next.i], [indexVar]: next.i, _loops: loops }, output: next.items[next.i] };
    },
  });

  // --- drip ---------------------------------------------------------------------------------------
  add({
    meta: {
      type: 'drip',
      label: 'Tröpfchen-Freigabe (Drip)',
      category: 'flow',
      icon: 'pause',
      summary: 'Lässt nur eine bestimmte Zahl Kontakte pro Zeitraum weiterlaufen.',
      doc: 'Beispiel: 20 Kontakte pro Stunde. Wer ankommt, wird einem Zeitfenster zugeteilt; ist es voll, wartet der Kontakt bis zum nächsten. So bekommt ein Vertriebsteam nicht 500 Leads auf einmal und der Mailserver wird geschont. Ohne Andrang läuft jeder sofort weiter.',
      keywords: 'drip batch throttle rate limit freigabe',
      fields: [
        { key: 'batch_size', label: 'Kontakte je Zeitraum', type: 'number', default: 10, required: true },
        { key: 'every', label: 'Zeitraum', type: 'number', default: 1 },
        { key: 'unit', label: 'Einheit', type: 'select', options: [['minutes', 'Minuten'], ['hours', 'Stunden'], ['days', 'Tage']], default: 'hours' },
      ],
      sample: { batch_size: 20, every: 1, unit: 'hours' },
    },
    run: (run, step, _vars, fc) => {
      const batch = Math.min(100_000, Math.max(1, Math.floor(Number(step.batch_size) || 10)));
      const ms = Math.max(60_000, intervalMs(step.every ?? 1, step.unit ?? 'hours'));
      const t = nowMs();
      let slot = t;
      if (!fc.dry) {
        db.tx(() => {
          const last = db.get<{ slot_at: string; used: number }>('SELECT slot_at, used FROM wfx_drip WHERE workflow_id = ? AND step_id = ? ORDER BY slot_at DESC LIMIT 1', run.workflow_id, step.id);
          const d = dripSlot(last, batch, ms, t);
          slot = d.slot;
          const at = new Date(slot).toISOString();
          if (d.fresh) db.run('INSERT OR REPLACE INTO wfx_drip (workflow_id, step_id, slot_at, used) VALUES (?, ?, ?, 1)', run.workflow_id, step.id, at);
          else db.run('UPDATE wfx_drip SET used = used + 1 WHERE workflow_id = ? AND step_id = ? AND slot_at = ?', run.workflow_id, step.id, at);
          db.run('DELETE FROM wfx_drip WHERE workflow_id = ? AND step_id = ? AND slot_at < ?', run.workflow_id, step.id, new Date(t - 7 * 864e5).toISOString());
        });
      }
      return slot > t ? { result: `Wartet bis ${new Date(slot).toISOString()} (Freigabe in Gruppen zu ${batch})`, wait_until: new Date(slot).toISOString(), output: { slot: new Date(slot).toISOString() } } : { result: 'Sofort freigegeben' };
    },
  });

  // --- waits --------------------------------------------------------------------------------------
  const timeoutMs = (step: any) => (Number(step.timeout_amount) > 0 ? intervalMs(step.timeout_amount, step.timeout_unit ?? 'hours') : 0);
  const waitState = (run: any, stepId: string) => ({ ...(run.vars._waits ?? {}) }) as Record<string, string>;

  add({
    meta: {
      type: 'wait_until',
      label: 'Warten bis Bedingung',
      category: 'flow',
      icon: 'wait',
      summary: 'Wartet, bis ein Feld oder eine Bedingung stimmt – mit Zeitlimit.',
      doc: 'Prüft in festen Abständen (Standard 15 Minuten), ob die Bedingung zutrifft, z. B. „Tag bezahlt gesetzt“ oder „Feld Status = bereit“. Trifft sie zu, geht es sofort weiter. Mit Zeitlimit: danach weiter, beenden oder zu einem Schritt springen. Das Zeitlimit rechnet ab dem ersten Erreichen des Schritts.',
      keywords: 'wait until warten bedingung feld polling',
      pure: true,
      fields: [
        ...CONDITIONS.map((f) => ({ ...f, label: f.key === 'conditions' ? 'Weiter, wenn …' : f.label })),
        { key: 'check_every', label: 'Prüfen alle … Minuten', type: 'number', default: 15 },
        { key: 'timeout_amount', label: 'Zeitlimit (leer = unbegrenzt)', type: 'number' },
        { key: 'timeout_unit', label: 'Einheit', type: 'select', options: [['minutes', 'Minuten'], ['hours', 'Stunden'], ['days', 'Tage']], default: 'days' },
        { key: 'on_timeout', label: 'Nach Ablauf des Zeitlimits', type: 'select', options: [['continue', 'Weiter'], ['end', 'Ablauf beenden'], ['goto', 'Zu Schritt springen']], default: 'continue' },
        { key: 'timeout_target', label: 'Springe zu', type: 'step', showIf: { field: 'on_timeout', in: ['goto'] } },
      ],
      sample: { conditions: [{ field: 'tag', op: 'has', value: 'bezahlt' }], check_every: 30, timeout_amount: 7, timeout_unit: 'days', on_timeout: 'end' },
    },
    run: (run, step, vars, fc) => {
      if (!hasCondition(step)) throw new Error('Bitte eine Bedingung angeben');
      const states = waitState(run, step.id);
      const clear = () => {
        const { [step.id]: _drop, ...rest } = states;
        return { _waits: rest };
      };
      if (gate(step, vars)) return { result: 'Bedingung erfüllt', vars: clear() };
      const t = nowMs();
      const since = states[step.id] ? Date.parse(states[step.id]) : t;
      const limit = timeoutMs(step);
      if (limit && t - since >= limit) {
        if (step.on_timeout === 'end') return { result: 'Zeitlimit erreicht → Ende', end: true, vars: clear() };
        if (step.on_timeout === 'goto' && step.timeout_target && fc.find(String(step.timeout_target))) return { result: 'Zeitlimit erreicht → Sprung', goto: String(step.timeout_target), vars: clear() };
        return { result: 'Zeitlimit erreicht – weiter', vars: clear() };
      }
      const every = Math.max(1, Math.floor(Number(step.check_every) || 15)) * 60_000;
      let next = t + every;
      if (limit) next = Math.min(next, since + limit);
      return { result: `Bedingung noch nicht erfüllt – prüfe wieder um ${new Date(next).toISOString()}`, wait_until: new Date(Math.max(next, t + 1000)).toISOString(), stay: true, vars: { _waits: { ...states, [step.id]: states[step.id] ?? new Date(since).toISOString() } } };
    },
  });

  add({
    meta: {
      type: 'wait_window',
      label: 'Warten auf Zeitfenster',
      category: 'flow',
      icon: 'schedule',
      summary: 'Lässt nur zu bestimmten Tagen und Uhrzeiten weiterlaufen (z. B. Geschäftszeiten).',
      doc: 'Ist es gerade innerhalb des Fensters (erlaubte Wochentage, von–bis in der Zeitzone des Sub-Accounts), geht es sofort weiter. Sonst wartet der Ablauf bis zum nächsten Beginn. Feiertage (JJJJ-MM-TT, einer je Zeile) werden übersprungen. Sommerzeit-fest: 09:00 bleibt 09:00 Ortszeit.',
      keywords: 'business hours geschäftszeiten window zeitfenster öffnungszeiten',
      pure: true,
      fields: [
        { key: 'days', label: 'Tage', type: 'weekdays', default: ['mon', 'tue', 'wed', 'thu', 'fri'] },
        { key: 'from', label: 'Von', type: 'time', default: '09:00' },
        { key: 'to', label: 'Bis', type: 'time', default: '17:00' },
        { key: 'holidays', label: 'Feiertage (JJJJ-MM-TT je Zeile)', type: 'textarea' },
        { key: 'tz', label: 'Zeitzone', type: 'tz', help: 'Leer = Zeitzone des Sub-Accounts.' },
      ],
      sample: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '17:00' },
    },
    run: (run, step) => {
      const tz = tzOrDefault(step.tz || tzOf(app, run.location_id));
      let at: Date | null;
      try {
        at = nextInWindow(new Date(nowMs()), { days: Array.isArray(step.days) ? step.days : undefined, from: step.from || '09:00', to: step.to || '17:00', holidays: String(step.holidays ?? '').split(/[\s,;]+/).filter(Boolean) }, tz);
      } catch (e) {
        if (e instanceof FormatError) throw new Error(e.message);
        throw e;
      }
      if (!at) throw new Error('Im Zeitfenster gibt es in den nächsten 8 Wochen keinen erlaubten Tag');
      if (at.getTime() <= nowMs()) return { result: 'Innerhalb des Zeitfensters – weiter' };
      return { result: `Wartet auf das nächste Zeitfenster: ${at.toISOString()}`, wait_until: at.toISOString() };
    },
  });

  add({
    meta: {
      type: 'wait_date',
      label: 'Warten bis Datum (relativ)',
      category: 'flow',
      icon: 'calendars',
      summary: 'Wartet bis zu einem Datum aus einem Feld – z. B. 3 Tage vor dem Geburtstag um 09:00.',
      doc: 'Quelle ist ein Datum aus dem Kontakt (date_of_birth, custom.vertragsende), dem Ereignis (event.appointment.start_at) oder einer Variable. Dazu ein Versatz davor/danach in Minuten, Stunden, Tagen, Wochen, Monaten oder Werktagen und optional eine Uhrzeit. „Jedes Jahr“ nimmt den nächsten Jahrestag (29. Feb wird in anderen Jahren der 28.). Alles in der Zeitzone des Sub-Accounts und sommerzeit-fest; liegt der Zeitpunkt schon hinter uns, geht es sofort weiter (oder – bei „Jedes Jahr“ – beim nächsten Jahrestag).',
      keywords: 'wait date datum geburtstag anniversary relativ termin',
      pure: true,
      fields: [
        { key: 'field', label: 'Datum aus', type: 'text', default: 'date_of_birth', placeholder: 'date_of_birth  ·  custom.vertragsende  ·  event.appointment.start_at  ·  var.datum', required: true },
        { key: 'direction', label: 'Versatz', type: 'select', options: [['before', 'davor'], ['after', 'danach']], default: 'before' },
        { key: 'amount', label: 'Menge', type: 'number', default: 3 },
        { key: 'unit', label: 'Einheit', type: 'select', options: [['days', 'Tage'], ['weeks', 'Wochen'], ['months', 'Monate'], ['business_days', 'Werktage'], ['hours', 'Stunden'], ['minutes', 'Minuten']], default: 'days' },
        { key: 'time', label: 'Uhrzeit (HH:mm)', type: 'time', default: '09:00', help: 'Leer = Uhrzeit des Datums (bei reinen Datumsangaben 09:00).' },
        { key: 'yearly', label: 'Jedes Jahr wiederholen (Jahrestag)', type: 'bool' },
        { key: 'if_missing', label: 'Wenn das Datum fehlt', type: 'select', options: [['continue', 'Weiter'], ['end', 'Ablauf beenden'], ['error', 'Fehler']], default: 'continue' },
      ],
      sample: { field: 'date_of_birth', direction: 'before', amount: 3, unit: 'days', time: '09:00', yearly: true },
    },
    run: (run, step, vars) => {
      const tz = tzOf(app, run.location_id);
      const raw = readPath(vars, requireText(step.field, 'Datumsfeld'));
      const base = parseDate(raw, tz);
      if (!base) {
        if (step.if_missing === 'end') return { result: 'Kein Datum – Ablauf beendet', end: true };
        if (step.if_missing === 'error') throw new Error(`Kein Datum in ${step.field}`);
        return { result: `Kein Datum in ${step.field} – weiter` };
      }
      const dateOnly = /^\d{4}-\d{2}-\d{2}$|^\d{1,2}\.\d{1,2}\.\d{4}$/.test(toText(raw).trim());
      const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(step.time ?? '')) ? String(step.time) : dateOnly ? '09:00' : '';
      const sign = step.direction === 'after' ? 1 : -1;
      const amount = Math.abs(Number(step.amount) || 0) * sign;
      const unit = String(step.unit ?? 'days');
      const at = (d: Date) => {
        let t = d;
        if (time) {
          const w = wallClock(t, tz);
          const [h, m] = time.split(':').map(Number);
          t = fromWall({ ...w, h, mi: m, s: 0 }, tz);
        }
        return addToDate(t, amount, unit, tz);
      };
      const t0 = new Date(nowMs());
      let target: Date;
      if (step.yearly) {
        const w = wallClock(base, tz);
        const year = Number(ymdInTz(t0, tz).slice(0, 4));
        let found: Date | null = null;
        for (const y of [year - 1, year, year + 1, year + 2]) {
          const day = w.mo === 2 && w.d === 29 && !((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 28 : w.d;
          const cand = at(fromWall({ ...w, y, d: day }, tz));
          if (cand > t0) {
            found = cand;
            break;
          }
        }
        target = found ?? at(base);
      } else target = at(base);
      if (target <= t0) return { result: `${target.toISOString()} liegt schon in der Vergangenheit – weiter` };
      return { result: `Wartet bis ${target.toISOString()}`, wait_until: target.toISOString(), output: { at: target.toISOString() } };
    },
  });

  add({
    meta: {
      type: 'wait_reply',
      label: 'Warten auf Antwort',
      category: 'flow',
      icon: 'conversations',
      summary: 'Wartet, bis der Kontakt antwortet – oder bis ein Zeitlimit abläuft.',
      doc: 'Prüft in festen Abständen (Standard 5 Minuten), ob seit Erreichen des Schritts eine Nachricht des Kontakts eingegangen ist (optional nur ein Kanal). Danach steht {{var.replied}} auf ja/nein. Typisch: „2 Tage auf Antwort warten, dann Wenn var.replied = nein → Nachfass-E-Mail“.',
      keywords: 'reply antwort warten nachfassen follow-up',
      fields: [
        { key: 'channel', label: 'Kanal', type: 'select', options: [['', 'Jeder Kanal'], ['email', 'E-Mail'], ['sms', 'SMS'], ['whatsapp', 'WhatsApp'], ['chat', 'Live-Chat'], ['telegram', 'Telegram']] },
        { key: 'timeout_amount', label: 'Höchstens warten', type: 'number', default: 2 },
        { key: 'timeout_unit', label: 'Einheit', type: 'select', options: [['minutes', 'Minuten'], ['hours', 'Stunden'], ['days', 'Tage']], default: 'days' },
        { key: 'check_every', label: 'Prüfen alle … Minuten', type: 'number', default: 5 },
        { key: 'on_reply', label: 'Bei Antwort', type: 'select', options: [['continue', 'Weiter'], ['end', 'Ablauf beenden']], default: 'continue' },
      ],
      provides: ['var.replied'],
      sample: { timeout_amount: 2, timeout_unit: 'days' },
    },
    run: (run, step, _vars, fc) => {
      const states = waitState(run, step.id);
      const t = nowMs();
      const since = states[step.id] ?? new Date(t).toISOString();
      const clear = () => {
        const { [step.id]: _d, ...rest } = states;
        return rest;
      };
      const hit = fc.dry ? undefined : db.get('SELECT id FROM messages WHERE contact_id = ? AND location_id = ? AND direction = ? AND created_at > ?' + (step.channel ? ' AND channel = ?' : '') + ' LIMIT 1', run.contact_id, run.location_id, 'in', since, ...(step.channel ? [String(step.channel)] : []));
      if (hit) return { result: 'Antwort erhalten', vars: { replied: true, _waits: clear() }, ...(step.on_reply === 'end' ? { end: true } : {}) };
      const limit = intervalMs(step.timeout_amount ?? 2, step.timeout_unit ?? 'days');
      if (limit && t - Date.parse(since) >= limit) return { result: 'Keine Antwort im Zeitlimit', vars: { replied: false, _waits: clear() } };
      const every = Math.max(1, Math.floor(Number(step.check_every) || 5)) * 60_000;
      const next = Math.min(t + every, limit ? Date.parse(since) + limit : t + every);
      return { result: `Wartet auf Antwort (bis ${new Date(Date.parse(since) + limit).toISOString()})`, wait_until: new Date(Math.max(next, t + 1000)).toISOString(), stay: true, vars: { replied: false, _waits: { ...states, [step.id]: since } } };
    },
  });

  return defs;
}
