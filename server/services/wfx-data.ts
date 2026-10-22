import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { lookup } from '../core/template.js';
import { normalizeEmail, normalizePhone } from '../core/util.js';
import { evaluate, ExprError } from './expr.js';
import { DATE_OPS, DATE_UNITS, FormatError, NUMBER_OPS, TEXT_OPS, dateOp, numberOp, parseNumber, textOp, tzOrDefault } from './formatters.js';
import { upsertContact } from './contacts.js';
import type { ActionOutcome } from './workflow-engine.js';
import { assign, describeTarget, preview, readPath, requireText, resolve, rowsOf, text, toText, tzOf, type ActionDef, type FieldDef } from './wfx-kit.js';

/**
 * Data steps: run variables, text/number/date formatting, math, copying and bulk-setting fields, lists, JSON,
 * value maps, random picks, the sandboxed "Code" step, and finding contacts and deals. Nothing here sends or calls
 * anything: results go to run variables (`{{var.name}}`) or contact fields.
 */

const TARGET: FieldDef = { key: 'save_to', label: 'Ergebnis speichern in', type: 'target', default: 'var.result', help: 'Variable (z. B. var.summe → {{var.summe}} in späteren Schritten) oder ein Kontaktfeld.' };
const opts = (o: Record<string, string>): [string, string][] => Object.entries(o);

function fail(e: unknown): never {
  if (e instanceof FormatError || e instanceof ExprError) throw new Error(e.message);
  throw e;
}

/** A list from a value: lists stay, JSON text is read, other text is split at line breaks (or commas). */
export function toList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined || v === '') return [];
  if (typeof v === 'object') return Object.entries(v as object).map(([key, value]) => ({ key, value }));
  const s = String(v).trim();
  if (/^\[/.test(s)) {
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) return j;
    } catch {
      /* plain text */
    }
  }
  return (s.includes('\n') ? s.split(/\r?\n/) : s.split(',')).map((x) => x.trim()).filter(Boolean);
}

const contactRow = (c: any) => ({ id: c.id, first_name: c.first_name, last_name: c.last_name, name: [c.first_name, c.last_name].filter(Boolean).join(' '), email: c.email, phone: c.phone, company: c.company, tags: c.tags ?? [], custom: c.custom ?? {}, created_at: c.created_at });

export function dataActions(app: App): ActionDef[] {
  const db = app.db;
  const defs: ActionDef[] = [];
  const add = (d: ActionDef) => defs.push(d);

  // --- variables ----------------------------------------------------------------------------------
  add({
    meta: {
      type: 'set_variable',
      label: 'Variablen setzen',
      category: 'data',
      icon: 'braces',
      summary: 'Merkt sich Werte für den Rest dieses Durchlaufs ({{var.name}}).',
      doc: 'Variablen gelten nur für diesen Durchlauf des Kontakts und bleiben über Wartezeiten erhalten. Der Wert darf Platzhalter enthalten (z. B. {{contact.custom.budget}}). Mit „Zahl“ oder „Liste/JSON“ wird der Wert umgewandelt. Spätere Schritte lesen die Variable als {{var.name}}, Bedingungen als Feld „var.name“.',
      keywords: 'variable merken speichern',
      pure: true,
      fields: [
        {
          key: 'rows',
          label: 'Variablen',
          type: 'rows',
          addLabel: '+ Variable',
          rows: [
            { key: 'name', label: 'Name', type: 'text', placeholder: 'summe' },
            { key: 'value', label: 'Wert', type: 'text', placeholder: '{{contact.custom.budget}}' },
            { key: 'type', label: 'Typ', type: 'select', options: [['text', 'Text'], ['number', 'Zahl'], ['bool', 'Ja/Nein'], ['json', 'Liste/JSON']], default: 'text' },
          ],
        },
      ],
      sample: { rows: [{ name: 'budget', value: '{{contact.custom.budget}}', type: 'number' }] },
    },
    run: (_run, step, vars) => {
      const rows = rowsOf<{ name: string; value: string; type?: string }>(step.rows, ['name']);
      if (!rows.length) throw new Error('Keine Variable angegeben');
      const out: ActionOutcome = { result: '' };
      for (const r of rows) {
        const name = String(r.name).trim().replace(/^var\./, '');
        let v: unknown = resolve(r.value, vars, { json: r.type === 'json' });
        if (r.type === 'number') {
          v = parseNumber(v);
          if (Number.isNaN(v as number)) throw new Error(`„${name}“: „${preview(r.value, 30)}“ ist keine Zahl`);
        } else if (r.type === 'bool') v = typeof v === 'boolean' ? v : /^(1|true|ja|yes|an|on)$/i.test(toText(v).trim());
        else if (r.type === 'json' && typeof v === 'string') {
          try {
            v = JSON.parse(v);
          } catch {
            throw new Error(`„${name}“: kein gültiges JSON`);
          }
        } else if (r.type !== 'json' && typeof v !== 'string' && v !== null && typeof v === 'object') v = toText(v);
        assign(out, `var.${name}`, v);
      }
      out.result = `Variablen gesetzt: ${Object.keys(out.vars ?? {}).join(', ')}`;
      out.output = out.vars;
      return out;
    },
  });

  // --- formatter: text ----------------------------------------------------------------------------
  add({
    meta: {
      type: 'format_text',
      label: 'Text formatieren',
      category: 'data',
      icon: 'text',
      summary: 'Groß/klein, ersetzen, teilen, extrahieren, kürzen, Telefonnummer vereinheitlichen …',
      doc: 'Wendet eine Text-Aktion auf einen Wert an und speichert das Ergebnis. „Teilen“ liefert eine Liste (oder – mit Position im zweiten Feld – ein Stück). „Extrahieren“ nimmt einen regulären Ausdruck (Gruppe 1, wenn vorhanden); gefährliche Muster mit verschachtelten Wiederholungen werden abgelehnt. Beispiel: Eingabe {{contact.phone}}, Aktion „Telefonnummer vereinheitlichen“ → +49…',
      keywords: 'formatter upper lower trim replace split extract regex',
      pure: true,
      fields: [
        { key: 'op', label: 'Aktion', type: 'select', options: opts(TEXT_OPS), default: 'trim', required: true },
        { key: 'input', label: 'Text', type: 'text', default: '{{contact.first_name}}', help: 'Platzhalter erlaubt.' },
        { key: 'arg1', label: 'Wert 1', type: 'text', help: 'Je nach Aktion: Suchtext, Muster, Trenner, Anzahl, Länge, Text zum Anfügen …', showIf: { field: 'op', in: ['replace', 'regex_replace', 'split', 'extract', 'substring', 'left', 'right', 'truncate', 'pad_left', 'pad_right', 'prepend', 'append', 'default', 'phone', 'repeat'] } },
        { key: 'arg2', label: 'Wert 2', type: 'text', help: 'Ersetzen durch / Position (split) / Gruppe (extract) / Länge (substring) / Füllzeichen / Endung', showIf: { field: 'op', in: ['replace', 'regex_replace', 'split', 'extract', 'substring', 'truncate', 'pad_left', 'pad_right'] } },
        TARGET,
      ],
      sample: { op: 'phone', input: '{{contact.phone}}', save_to: 'phone' },
    },
    run: (_run, step, vars) => {
      try {
        const v = textOp(String(step.op ?? 'trim'), resolve(step.input, vars), text(step.arg1, vars), text(step.arg2, vars));
        const out = assign({ result: '' }, step.save_to, Array.isArray(v) ? v : typeof v === 'number' ? v : v);
        out.result = `${describeTarget(step.save_to)} = ${preview(v)}`;
        out.output = v;
        return out;
      } catch (e) {
        return fail(e);
      }
    },
  });

  // --- formatter: number --------------------------------------------------------------------------
  add({
    meta: {
      type: 'format_number',
      label: 'Zahl formatieren',
      category: 'data',
      icon: 'hash',
      summary: 'Runden, 1.234,56 schreiben, als Währung oder Prozent, Text in Zahl umwandeln.',
      doc: 'Liest Zahlen auch im deutschen Format („1.234,56“) und gibt sie formatiert zurück. „Als Währung“ gibt z. B. „1.234,56 €“ aus (Währung wählbar). Kaufmännisches Runden, Auf-/Abrunden mit Nachkommastellen.',
      keywords: 'rundung währung euro currency round prozent',
      pure: true,
      fields: [
        { key: 'op', label: 'Aktion', type: 'select', options: opts(NUMBER_OPS), default: 'round', required: true },
        { key: 'input', label: 'Zahl', type: 'text', default: '{{contact.custom.betrag}}' },
        { key: 'digits', label: 'Nachkommastellen', type: 'number', default: 2, showIf: { field: 'op', in: ['round', 'floor', 'ceil', 'format', 'percent', 'fixed'] } },
        { key: 'locale', label: 'Schreibweise', type: 'select', options: [['de-DE', '1.234,56 (Deutsch)'], ['en-US', '1,234.56 (US)'], ['de-CH', '1’234.56 (Schweiz)'], ['fr-FR', '1 234,56 (Französisch)']], default: 'de-DE', showIf: { field: 'op', in: ['format', 'currency', 'percent'] } },
        { key: 'currency', label: 'Währung', type: 'text', default: 'EUR', placeholder: 'EUR', showIf: { field: 'op', in: ['currency'] } },
        { key: 'min', label: 'Minimum', type: 'number', showIf: { field: 'op', in: ['clamp'] } },
        { key: 'max', label: 'Maximum', type: 'number', showIf: { field: 'op', in: ['clamp'] } },
        { key: 'width', label: 'Stellen', type: 'number', default: 3, showIf: { field: 'op', in: ['pad'] } },
        TARGET,
      ],
      sample: { op: 'currency', input: '{{contact.custom.betrag}}', currency: 'EUR', save_to: 'var.betrag_text' },
    },
    run: (_run, step, vars) => {
      try {
        const o = { digits: step.digits === '' || step.digits === undefined ? undefined : Number(step.digits), locale: step.locale, currency: step.currency, min: step.min === '' ? undefined : Number(step.min), max: step.max === '' ? undefined : Number(step.max), width: step.width === '' ? undefined : Number(step.width) };
        const v = numberOp(String(step.op ?? 'round'), resolve(step.input, vars), o);
        const out = assign({ result: '' }, step.save_to, v);
        out.result = `${describeTarget(step.save_to)} = ${preview(v)}`;
        out.output = v;
        return out;
      } catch (e) {
        return fail(e);
      }
    },
  });

  // --- formatter: date ----------------------------------------------------------------------------
  add({
    meta: {
      type: 'format_date',
      label: 'Datum / Zeit',
      category: 'data',
      icon: 'schedule',
      summary: 'Addieren, abziehen, formatieren, Werktage, Zeitzonen, Differenz, Alter.',
      doc: 'Rechnet mit Datum und Uhrzeit in der Zeitzone des Sub-Accounts (oder einer gewählten). Tage, Wochen, Monate, Jahre und Werktage verschieben die Uhrzeit auf der Wanduhr – „+1 Tag“ um 12:00 bleibt 12:00, auch über die Sommerzeitumstellung. Minuten und Stunden sind verstrichene Zeit. Monatsende wird begrenzt (31. Jan + 1 Monat = 28./29. Feb). Eingaben: ISO, TT.MM.JJJJ (auch mit Uhrzeit), „now“, „today“. Muster zum Formatieren: DD.MM.YYYY HH:mm, dddd, D. MMMM YYYY, oder „date“, „datetime“, „time“, „long“, „iso“. Feiertage (für Werktage): ein Datum JJJJ-MM-TT je Zeile.',
      keywords: 'datum zeit date time zeitzone timezone werktage business days format add subtract',
      pure: true,
      fields: [
        { key: 'op', label: 'Aktion', type: 'select', options: opts(DATE_OPS), default: 'add', required: true },
        { key: 'input', label: 'Datum', type: 'text', default: 'now', help: '„now“, „today“, ein Datum, oder ein Platzhalter wie {{contact.date_of_birth}}.' },
        { key: 'amount', label: 'Menge', type: 'number', default: 1, showIf: { field: 'op', in: ['add', 'subtract'] } },
        { key: 'unit', label: 'Einheit', type: 'select', options: opts(DATE_UNITS), default: 'days', showIf: { field: 'op', in: ['add', 'subtract', 'diff'] } },
        { key: 'unit_b', label: 'Bezug', type: 'select', options: [['day', 'Tag'], ['hour', 'Stunde'], ['week', 'Woche (ab Montag)'], ['month', 'Monat'], ['year', 'Jahr']], default: 'day', showIf: { field: 'op', in: ['start_of', 'end_of'] } },
        { key: 'pattern', label: 'Muster', type: 'text', default: 'DD.MM.YYYY HH:mm', help: 'z. B. DD.MM.YYYY, HH:mm, dddd, "long", "iso"', showIf: { field: 'op', in: ['format', 'convert_tz', 'weekday'] } },
        { key: 'other', label: 'Vergleichsdatum', type: 'text', default: 'now', showIf: { field: 'op', in: ['diff', 'age'] } },
        { key: 'time', label: 'Uhrzeit (HH:mm)', type: 'time', showIf: { field: 'op', in: ['set_time'] } },
        { key: 'tz', label: 'Zeitzone', type: 'tz', help: 'Leer = Zeitzone des Sub-Accounts.' },
        { key: 'to_tz', label: 'In Zeitzone', type: 'tz', default: 'UTC', showIf: { field: 'op', in: ['convert_tz'] } },
        { key: 'holidays', label: 'Feiertage (JJJJ-MM-TT je Zeile)', type: 'textarea', showIf: { field: 'op', in: ['add', 'subtract', 'is_business_day', 'next_business_day'] } },
        TARGET,
      ],
      sample: { op: 'add', input: 'now', amount: 3, unit: 'business_days', save_to: 'var.faellig' },
    },
    run: (run, step, vars, fc) => {
      try {
        const tz = tzOrDefault(step.tz || tzOf(app, run.location_id));
        const op = String(step.op ?? 'add');
        const v = dateOp(op, resolve(step.input, vars) ?? 'now', {
          amount: Number(text(step.amount, vars)) || 0,
          unit: op === 'start_of' || op === 'end_of' ? String(step.unit_b ?? 'day') : String(step.unit ?? 'days'),
          pattern: text(step.pattern, vars),
          other: text(step.other, vars) || 'now',
          time: text(step.time, vars),
          tz,
          to_tz: step.to_tz,
          holidays: String(step.holidays ?? '').split(/[\s,;]+/).filter(Boolean),
        });
        const out = assign({ result: '' }, step.save_to, v);
        out.result = `${describeTarget(step.save_to)} = ${preview(v)}`;
        out.output = v;
        return out;
      } catch (e) {
        return fail(e);
      }
    },
  });

  // --- math ---------------------------------------------------------------------------------------
  const MATH_OPS: [string, string][] = [
    ['add', 'A + B'],
    ['subtract', 'A − B'],
    ['multiply', 'A × B'],
    ['divide', 'A ÷ B'],
    ['modulo', 'A mod B (Rest)'],
    ['power', 'A hoch B'],
    ['min', 'Kleiner von A und B'],
    ['max', 'Größer von A und B'],
    ['average', 'Durchschnitt von A und B'],
    ['percent_of', 'B Prozent von A'],
    ['percent_change', 'Veränderung von A zu B in Prozent'],
    ['formula', 'Eigene Formel (Ausdruck)'],
  ];
  add({
    meta: {
      type: 'math',
      label: 'Rechnen',
      category: 'data',
      icon: 'gauge',
      summary: 'Zahlenfelder verrechnen: plus, minus, mal, geteilt, Prozent, eigene Formel.',
      doc: 'A und B dürfen Platzhalter sein ({{contact.custom.menge}}); Zahlen im deutschen Format („1.234,50“) werden verstanden, leere Werte zählen als 0 (ein Zähler, der noch nie gesetzt wurde, startet bei 0). Mit „Eigene Formel“ steht der Ausdruck-Editor zur Verfügung, z. B. round(number(contact.custom.preis) * 1.19, 2). Division durch 0 ist ein Fehler. Das Ergebnis geht in eine Variable oder ein Kontaktfeld.',
      keywords: 'math rechnen calc berechnen summe prozent',
      pure: true,
      fields: [
        { key: 'operation', label: 'Rechenart', type: 'select', options: MATH_OPS, default: 'add', required: true },
        { key: 'a', label: 'A', type: 'text', default: '{{contact.custom.preis}}', showIf: { field: 'operation', in: MATH_OPS.map((o) => o[0]).filter((k) => k !== 'formula') } },
        { key: 'b', label: 'B', type: 'text', default: '1', showIf: { field: 'operation', in: MATH_OPS.map((o) => o[0]).filter((k) => k !== 'formula') } },
        { key: 'formula', label: 'Formel', type: 'code', placeholder: 'round(number(contact.custom.preis) * 1.19, 2)', showIf: { field: 'operation', in: ['formula'] } },
        { key: 'digits', label: 'Runden auf Nachkommastellen (leer = nicht runden)', type: 'number' },
        TARGET,
      ],
      sample: { operation: 'multiply', a: '{{contact.custom.menge}}', b: '{{contact.custom.preis}}', digits: 2, save_to: 'var.summe' },
    },
    run: (run, step, vars) => {
      const op = String(step.operation ?? 'add');
      let value: number;
      try {
        if (op === 'formula') {
          const r = evaluate(requireText(step.formula, 'Formel'), { contact: vars.contact, event: vars.event, var: vars.var, location: { name: vars.location?.name } }, { tz: tzOf(app, run.location_id) });
          value = parseNumber(r.value);
        } else {
          // an empty value counts as 0 (a counter that was never set starts at 0)
          const n = (v: unknown) => (text(v, vars).trim() === '' ? 0 : parseNumber(text(v, vars)));
          const a = n(step.a);
          const b = n(step.b);
          if (Number.isNaN(a)) throw new Error(`A („${preview(text(step.a, vars), 30)}“) ist keine Zahl`);
          if (Number.isNaN(b) && op !== 'average') throw new Error(`B („${preview(text(step.b, vars), 30)}“) ist keine Zahl`);
          switch (op) {
            case 'add': value = a + b; break;
            case 'subtract': value = a - b; break;
            case 'multiply': value = a * b; break;
            case 'divide':
              if (b === 0) throw new Error('Division durch 0');
              value = a / b;
              break;
            case 'modulo':
              if (b === 0) throw new Error('Division durch 0');
              value = a % b;
              break;
            case 'power': value = a ** b; break;
            case 'min': value = Math.min(a, b); break;
            case 'max': value = Math.max(a, b); break;
            case 'average': value = (a + b) / 2; break;
            case 'percent_of': value = (a * b) / 100; break;
            case 'percent_change':
              if (a === 0) throw new Error('Veränderung gegenüber 0 ist nicht definiert');
              value = ((b - a) / Math.abs(a)) * 100;
              break;
            default: throw new Error(`Unbekannte Rechenart ${op}`);
          }
        }
      } catch (e) {
        return fail(e);
      }
      if (!Number.isFinite(value)) throw new Error('Das Ergebnis ist keine Zahl');
      const digits = step.digits === '' || step.digits === undefined || step.digits === null ? undefined : Number(step.digits);
      const result = digits === undefined || Number.isNaN(digits) ? value : (numberOp('round', value, { digits }) as number);
      const out = assign({ result: '' }, step.save_to, result);
      out.result = `${describeTarget(step.save_to)} = ${result}`;
      out.output = result;
      return out;
    },
  });

  // --- copy / bulk fields -------------------------------------------------------------------------
  add({
    meta: {
      type: 'copy_field',
      label: 'Feld kopieren',
      category: 'data',
      icon: 'copy',
      summary: 'Kopiert einen Wert in ein anderes Feld oder eine Variable – optional umgewandelt.',
      doc: 'Quelle: ein Kontaktfeld (first_name, custom.telefon2), ein Wert aus dem Ereignis (event.order.id) oder eine Variable (var.name). Optional umwandeln (klein, groß, trimmen, Telefonnummer, Zahl) und nur schreiben, wenn das Ziel noch leer ist.',
      keywords: 'copy kopieren übernehmen mapping',
      pure: true,
      fields: [
        { key: 'from', label: 'Quelle', type: 'text', placeholder: 'custom.telefon2  ·  event.order.id  ·  var.name', required: true },
        { key: 'to', label: 'Ziel', type: 'target', default: 'custom.', required: true },
        { key: 'transform', label: 'Umwandeln', type: 'select', options: [['', 'nicht'], ['trim', 'Leerzeichen entfernen'], ['lower', 'klein schreiben'], ['upper', 'GROSS schreiben'], ['title', 'Jedes Wort Groß'], ['phone', 'Telefonnummer vereinheitlichen'], ['number', 'In Zahl umwandeln']] },
        { key: 'only_if_empty', label: 'Nur schreiben, wenn das Ziel leer ist', type: 'bool' },
      ],
      sample: { from: 'event.answers.Telefon', to: 'phone', transform: 'phone' },
    },
    run: (_run, step, vars) => {
      const from = requireText(step.from, 'Quelle');
      let v = readPath(vars, from);
      if (v === undefined || v === null || v === '') return { result: `Quelle ${from} ist leer – nichts kopiert` };
      const tr = String(step.transform ?? '');
      if (tr === 'number') {
        const n = parseNumber(v);
        if (Number.isNaN(n)) throw new Error(`„${preview(toText(v), 30)}“ ist keine Zahl`);
        v = n;
      } else if (tr) v = textOp(tr === 'lower' ? 'lower' : tr === 'upper' ? 'upper' : tr, toText(v));
      const to = requireText(step.to, 'Ziel');
      if (step.only_if_empty) {
        const cur = readPath(vars, to.startsWith('var.') ? to : to);
        if (cur !== undefined && cur !== null && cur !== '') return { result: `${to} ist schon gefüllt – nicht überschrieben` };
      }
      const out = assign({ result: '' }, to, v);
      out.result = `${from} → ${to}: ${preview(v)}`;
      return out;
    },
  });

  add({
    meta: {
      type: 'set_fields',
      label: 'Mehrere Felder setzen',
      category: 'data',
      icon: 'edit',
      summary: 'Setzt mehrere Kontaktfelder (oder Variablen) auf einmal.',
      doc: 'Pro Zeile ein Ziel und ein Wert mit Platzhaltern. Ziele: Standardfelder (city, company …), eigene Felder (custom.budget) oder Variablen (var.name). Ändert sich ein Feld wirklich, wird „Feld geändert“ ausgelöst.',
      keywords: 'bulk felder setzen update',
      pure: true,
      fields: [
        {
          key: 'rows',
          label: 'Felder',
          type: 'rows',
          addLabel: '+ Feld',
          rows: [
            { key: 'field', label: 'Feld', type: 'target', default: 'custom.' },
            { key: 'value', label: 'Wert', type: 'text', placeholder: '{{event.answers.Stadt}}' },
          ],
        },
      ],
      sample: { rows: [{ field: 'city', value: '{{event.answers.Stadt}}' }, { field: 'custom.quelle', value: 'Messe 2026' }] },
    },
    run: (_run, step, vars) => {
      const rows = rowsOf<{ field: string; value: string }>(step.rows, ['field']);
      if (!rows.length) throw new Error('Keine Felder angegeben');
      const out: ActionOutcome = { result: '' };
      for (const r of rows) assign(out, String(r.field).trim(), resolve(r.value, vars, { json: false }));
      const names = [...Object.keys(out.fields ?? {}), ...Object.keys(out.vars ?? {}).map((k) => `var.${k}`)];
      out.result = `${names.length} Feld${names.length === 1 ? '' : 'er'} gesetzt: ${names.join(', ')}`;
      return out;
    },
  });

  add({
    meta: {
      type: 'clear_fields',
      label: 'Felder leeren',
      category: 'data',
      icon: 'trash',
      summary: 'Leert Kontaktfelder oder Variablen.',
      doc: 'Eigene Felder werden entfernt, Standardfelder auf leer gesetzt, Variablen gelöscht. E-Mail und Telefon lassen sich nicht leeren, wenn der Kontakt sonst nicht mehr erreichbar wäre – dann kommt ein Fehler.',
      keywords: 'clear löschen leeren reset',
      pure: true,
      fields: [{ key: 'rows', label: 'Felder', type: 'rows', addLabel: '+ Feld', rows: [{ key: 'field', label: 'Feld', type: 'target', default: 'custom.' }] }],
      sample: { rows: [{ field: 'custom.zwischenstand' }, { field: 'var.tmp' }] },
    },
    run: (_run, step, vars) => {
      const rows = rowsOf<{ field: string }>(step.rows, ['field']);
      if (!rows.length) throw new Error('Keine Felder angegeben');
      const out: ActionOutcome = { result: '' };
      for (const r of rows) {
        const f = String(r.field).trim();
        if (f.startsWith('var.')) out.vars = { ...(out.vars ?? {}), [f.slice(4)]: null };
        else {
          if ((f === 'email' || f === 'phone') && !(f === 'email' ? vars.contact?.phone : vars.contact?.email)) throw new Error('E-Mail und Telefon dürfen nicht beide leer werden');
          out.fields = { ...(out.fields ?? {}), [f]: null };
        }
      }
      out.result = `Geleert: ${rows.map((r) => r.field).join(', ')}`;
      return out;
    },
  });

  // --- lists --------------------------------------------------------------------------------------
  const ARRAY_OPS: [string, string][] = [
    ['split', 'Text teilen (Trenner)'],
    ['from_tags', 'Tags des Kontakts als Liste'],
    ['json', 'JSON-Text in Liste'],
    ['join', 'Liste zu Text verbinden'],
    ['count', 'Anzahl'],
    ['first', 'Erstes Element'],
    ['last', 'Letztes Element'],
    ['at', 'Element an Position'],
    ['unique', 'Doppelte entfernen'],
    ['sort', 'Sortieren'],
    ['reverse', 'Umkehren'],
    ['slice', 'Ausschnitt (von, Anzahl)'],
    ['contains', 'Enthält Wert? (ja/nein)'],
    ['filter_text', 'Nur Einträge, die Text enthalten'],
    ['sum', 'Summe'],
    ['pluck', 'Feld aus Objekten ziehen'],
  ];
  add({
    meta: {
      type: 'array_op',
      label: 'Liste bearbeiten',
      category: 'data',
      icon: 'list',
      summary: 'Listen bauen und umwandeln: teilen, verbinden, zählen, sortieren, filtern, Summe.',
      doc: 'Die Eingabe kann eine Liste ({{var.items}}), JSON-Text oder Text mit einem Eintrag je Zeile (oder durch Komma getrennt) sein. Das Ergebnis (Liste, Text oder Zahl) geht in eine Variable – z. B. als Eingabe für die Schleife.',
      keywords: 'array liste list split join count sort unique',
      pure: true,
      fields: [
        { key: 'op', label: 'Aktion', type: 'select', options: ARRAY_OPS, default: 'split', required: true },
        { key: 'input', label: 'Liste / Text', type: 'text', placeholder: '{{var.items}}', showIf: { field: 'op', in: ARRAY_OPS.map((o) => o[0]).filter((k) => k !== 'from_tags') } },
        { key: 'arg', label: 'Wert', type: 'text', help: 'Trenner, Position, Suchtext, Feldname … je nach Aktion', showIf: { field: 'op', in: ['split', 'join', 'at', 'slice', 'contains', 'filter_text', 'pluck'] } },
        { key: 'arg2', label: 'Anzahl', type: 'text', showIf: { field: 'op', in: ['slice'] } },
        { key: 'save_to', label: 'Ergebnis speichern in', type: 'target', default: 'var.liste' },
      ],
      sample: { op: 'split', input: '{{contact.custom.interessen}}', arg: ',', save_to: 'var.interessen' },
    },
    run: (_run, step, vars) => {
      const op = String(step.op ?? 'split');
      const arg = text(step.arg, vars);
      const input = op === 'from_tags' ? vars.contact?.tags : resolve(step.input, vars, { json: true });
      const list = op === 'split' ? (arg ? toText(input).split(arg) : [toText(input)]) : toList(input);
      let v: unknown;
      switch (op) {
        case 'split': v = list.map((x) => String(x).trim()).filter((x) => x !== ''); break;
        case 'from_tags': v = [...list]; break;
        case 'json': v = toList(input); break;
        case 'join': v = list.map(toText).join(arg === '' ? ', ' : arg); break;
        case 'count': v = list.length; break;
        case 'first': v = list[0] ?? ''; break;
        case 'last': v = list[list.length - 1] ?? ''; break;
        case 'at': v = list[Number(arg) < 0 ? list.length + Number(arg) : Number(arg)] ?? ''; break;
        case 'unique': v = [...new Map(list.map((x) => [JSON.stringify(x), x])).values()]; break;
        case 'sort': v = [...list].sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : toText(a).localeCompare(toText(b), 'de', { numeric: true }))); break;
        case 'reverse': v = [...list].reverse(); break;
        case 'slice': v = list.slice(Number(arg) || 0, (Number(arg) || 0) + (Number(text(step.arg2, vars)) || list.length)); break;
        case 'contains': v = list.some((x) => toText(x).toLowerCase() === arg.toLowerCase()) ? 'ja' : 'nein'; break;
        case 'filter_text': v = list.filter((x) => toText(x).toLowerCase().includes(arg.toLowerCase())); break;
        case 'sum': v = list.map((x) => parseNumber(x)).filter((n) => !Number.isNaN(n)).reduce((a, b) => a + b, 0); break;
        case 'pluck': v = list.map((x) => lookup(x, arg)).filter((x) => x !== undefined && x !== null); break;
        default: throw new Error(`Unbekannte Aktion ${op}`);
      }
      const out = assign({ result: '' }, step.save_to, v, 'var.liste');
      out.result = `${describeTarget(step.save_to, 'var.liste')} = ${Array.isArray(v) ? `Liste mit ${v.length} Einträgen` : preview(v)}`;
      out.output = v;
      return out;
    },
  });

  add({
    meta: {
      type: 'json_extract',
      label: 'JSON auslesen',
      category: 'data',
      icon: 'braces',
      summary: 'Zieht Werte aus JSON (z. B. einer API-Antwort) in Variablen oder Felder.',
      doc: 'Quelle: JSON-Text oder ein Objekt aus den Daten, z. B. {{var.response}} oder {{event.payload}}. Pfade mit Punkten, Listenpositionen als Zahl: data.items.0.id. Jede Zeile legt einen Wert in eine Variable oder ein Kontaktfeld ab; fehlt ein Pfad, bleibt das Ziel unverändert.',
      keywords: 'json path api antwort response parse',
      pure: true,
      fields: [
        { key: 'input', label: 'JSON / Objekt', type: 'text', default: '{{var.response}}', required: true },
        { key: 'rows', label: 'Werte', type: 'rows', addLabel: '+ Wert', rows: [{ key: 'path', label: 'Pfad', type: 'text', placeholder: 'data.items.0.id' }, { key: 'to', label: 'Speichern in', type: 'target', default: 'var.' }] },
      ],
      sample: { input: '{{var.response}}', rows: [{ path: 'data.id', to: 'custom.crm_id' }] },
    },
    run: (_run, step, vars) => {
      let data = resolve(step.input, vars, { json: true });
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          throw new Error('Die Quelle ist kein gültiges JSON');
        }
      }
      const rows = rowsOf<{ path: string; to: string }>(step.rows, ['path']);
      if (!rows.length) throw new Error('Keine Pfade angegeben');
      const out: ActionOutcome = { result: '' };
      const missing: string[] = [];
      for (const r of rows) {
        const v = lookup(data, String(r.path).trim());
        if (v === undefined || v === null) missing.push(r.path);
        else assign(out, r.to, v);
      }
      const set = [...Object.keys(out.fields ?? {}), ...Object.keys(out.vars ?? {}).map((k) => `var.${k}`)];
      out.result = `${set.length} Wert${set.length === 1 ? '' : 'e'} übernommen${missing.length ? ` · nicht gefunden: ${missing.join(', ')}` : ''}`;
      return out;
    },
  });

  add({
    meta: {
      type: 'value_map',
      label: 'Wert zuordnen',
      category: 'data',
      icon: 'sort',
      summary: 'Übersetzt einen Wert über eine Tabelle (z. B. Stadt → Region).',
      doc: 'Die erste Zeile, deren „Wenn“ zum Eingabewert passt, liefert den „Dann“-Wert; sonst der Ersatzwert. Vergleich ohne Groß/Klein. Praktisch für Kampagnen-Codes, Länder, Preisstufen.',
      keywords: 'map lookup tabelle zuordnung switch',
      pure: true,
      fields: [
        { key: 'input', label: 'Wert', type: 'text', default: '{{contact.city}}', required: true },
        { key: 'rows', label: 'Tabelle', type: 'rows', addLabel: '+ Zeile', rows: [{ key: 'from', label: 'Wenn', type: 'text' }, { key: 'to', label: 'Dann', type: 'text' }] },
        { key: 'default', label: 'Ersatzwert', type: 'text', help: 'Wenn nichts passt (leer = Eingabe unverändert).' },
        TARGET,
      ],
      sample: { input: '{{contact.city}}', rows: [{ from: 'Köln', to: 'West' }, { from: 'Berlin', to: 'Ost' }], default: 'Sonstige', save_to: 'custom.region' },
    },
    run: (_run, step, vars) => {
      const v = text(step.input, vars);
      const rows = rowsOf<{ from: string; to: string }>(step.rows, ['from']);
      const hit = rows.find((r) => text(r.from, vars).trim().toLowerCase() === v.trim().toLowerCase());
      const res = hit ? text(hit.to, vars) : step.default !== undefined && step.default !== '' ? text(step.default, vars) : v;
      const out = assign({ result: '' }, step.save_to, res);
      out.result = `${preview(v, 30)} → ${preview(res, 30)}${hit ? '' : ' (kein Treffer)'}`;
      return out;
    },
  });

  add({
    meta: {
      type: 'random_pick',
      label: 'Zufall',
      category: 'data',
      icon: 'shapes',
      summary: 'Wählt einen zufälligen Eintrag, eine Zufallszahl oder eine eindeutige ID.',
      doc: 'Liste: ein Wert je Zeile, einer wird gewählt. Zahl: zwischen Minimum und Maximum. ID: eine zufällige eindeutige Kennung (z. B. für Gutscheincodes mit Präfix).',
      keywords: 'random zufällig auslosen id code',
      pure: true,
      fields: [
        { key: 'mode', label: 'Art', type: 'select', options: [['list', 'Eintrag aus Liste'], ['number', 'Zufallszahl'], ['code', 'Zufälliger Code']], default: 'list' },
        { key: 'options', label: 'Einträge (einer je Zeile)', type: 'textarea', showIf: { field: 'mode', in: ['list'] } },
        { key: 'min', label: 'Minimum', type: 'number', default: 1, showIf: { field: 'mode', in: ['number'] } },
        { key: 'max', label: 'Maximum', type: 'number', default: 100, showIf: { field: 'mode', in: ['number'] } },
        { key: 'prefix', label: 'Präfix', type: 'text', default: 'GH-', showIf: { field: 'mode', in: ['code'] } },
        { key: 'length', label: 'Länge', type: 'number', default: 8, showIf: { field: 'mode', in: ['code'] } },
        TARGET,
      ],
      sample: { mode: 'code', prefix: 'WILLKOMMEN-', length: 6, save_to: 'var.gutschein' },
    },
    run: (_run, step, vars) => {
      const rnd: () => number = app.services.wfxRandom ?? Math.random;
      const mode = String(step.mode ?? 'list');
      let v: unknown;
      if (mode === 'number') {
        const lo = Math.ceil(Number(step.min ?? 1));
        const hi = Math.floor(Number(step.max ?? 100));
        v = hi <= lo ? lo : lo + Math.floor(rnd() * (hi - lo + 1));
      } else if (mode === 'code') {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const n = Math.min(40, Math.max(4, Number(step.length) || 8));
        v = text(step.prefix, vars) + Array.from({ length: n }, () => chars[Math.floor(rnd() * chars.length)]).join('');
      } else {
        const list = String(step.options ?? '').split(/\r?\n/).map((x) => text(x, vars).trim()).filter(Boolean);
        if (!list.length) throw new Error('Keine Einträge angegeben');
        v = list[Math.floor(rnd() * list.length)];
      }
      const out = assign({ result: '' }, step.save_to, v);
      out.result = `${describeTarget(step.save_to)} = ${preview(v)}`;
      return out;
    },
  });

  // --- code ---------------------------------------------------------------------------------------
  add({
    meta: {
      type: 'code',
      label: 'Code (Ausdruck)',
      category: 'data',
      icon: 'code',
      summary: 'Kleine Berechnungen in einer sicheren Mini-Sprache – ohne JavaScript, ohne Zugriff auf den Server.',
      doc: 'Ein Ausdruck oder kurzes Programm: Rechnen, Vergleiche, Text-Funktionen, Listen (map, filter, sum …), Datum-Funktionen, a ? b : c, let/if/for/while, return. Verfügbar: contact, event, var, location. Mit var.name = … änderst du Variablen; der Rückgabewert geht in „Ergebnis speichern in“. Grenzen: 8 000 Zeichen, 20 000 Rechenschritte, 150 ms, kein Netzwerk, keine Dateien, kein eval. Beispiel: contact.custom.budget > 1000 ? "vip" : "standard".',
      keywords: 'code javascript script ausdruck expression formel',
      pure: true,
      fields: [
        { key: 'code', label: 'Code', type: 'code', placeholder: 'let net = number(contact.custom.preis);\nreturn round(net * 1.19, 2);', required: true },
        TARGET,
      ],
      sample: { code: 'contact.custom.budget > 1000 ? "vip" : "standard"', save_to: 'var.segment' },
    },
    run: (run, step, vars) => {
      const source = requireText(step.code, 'Code');
      let r;
      try {
        r = evaluate(source, { contact: vars.contact, event: vars.event, var: vars.var, location: { name: vars.location?.name, timezone: vars.location?.timezone } }, { tz: tzOf(app, run.location_id) });
      } catch (e) {
        return fail(e);
      }
      const out: ActionOutcome = { result: '', vars: { ...r.vars } };
      if (r.value !== null || step.save_to) assign(out, step.save_to, r.value);
      out.result = `${describeTarget(step.save_to)} = ${preview(r.value)} (${r.steps} Schritte)`;
      out.output = { value: r.value, vars: r.vars };
      return out;
    },
  });

  // --- find ---------------------------------------------------------------------------------------
  const lookupContact = (loc: string, by: string, value: string, key: string): any | undefined => {
    const v = value.trim();
    if (!v) return undefined;
    let row: any;
    if (by === 'email') row = db.get('SELECT * FROM contacts WHERE location_id = ? AND email = ? ORDER BY created_at LIMIT 1', loc, normalizeEmail(v));
    else if (by === 'phone') row = db.get('SELECT * FROM contacts WHERE location_id = ? AND phone = ? ORDER BY created_at LIMIT 1', loc, normalizePhone(v));
    else if (by === 'name') row = db.get(`SELECT * FROM contacts WHERE location_id = ? AND lower(trim(first_name || ' ' || last_name)) = ? ORDER BY created_at LIMIT 1`, loc, v.toLowerCase().replace(/\s+/g, ' '));
    else if (by === 'company') row = db.get('SELECT * FROM contacts WHERE location_id = ? AND lower(company) = ? ORDER BY created_at LIMIT 1', loc, v.toLowerCase());
    else if (by === 'custom') {
      if (!/^[\w-]{1,60}$/.test(key)) throw new Error('Ungültiger Feldschlüssel');
      row = db.get(`SELECT * FROM contacts WHERE location_id = ? AND json_extract(custom, ?) = ? ORDER BY created_at LIMIT 1`, loc, `$.${key}`, v);
    } else if (by === 'id') row = db.get('SELECT * FROM contacts WHERE location_id = ? AND id = ?', loc, v);
    else throw new Error(`Unbekannte Suche ${by}`);
    return row ? parseJson(row, ['tags', 'custom']) : undefined;
  };
  const FIND_BY: [string, string][] = [['email', 'E-Mail'], ['phone', 'Telefon'], ['name', 'Vor- und Nachname'], ['company', 'Firma'], ['custom', 'Eigenes Feld'], ['id', 'Kontakt-ID']];
  const findFields = (extra: FieldDef[] = []): FieldDef[] => [
    { key: 'by', label: 'Suchen nach', type: 'select', options: FIND_BY, default: 'email', required: true },
    { key: 'custom_key', label: 'Schlüssel des eigenen Felds', type: 'text', placeholder: 'kundennummer', showIf: { field: 'by', in: ['custom'] } },
    { key: 'value', label: 'Wert', type: 'text', default: '{{event.answers.E-Mail}}', required: true, help: 'Platzhalter erlaubt, z. B. {{event.payload.email}}.' },
    ...extra,
  ];

  add({
    meta: {
      type: 'find_contact',
      label: 'Kontakt suchen',
      category: 'crm',
      icon: 'contact',
      summary: 'Sucht einen Kontakt (E-Mail, Telefon, Name, eigenes Feld) und merkt sich das Ergebnis.',
      doc: 'Setzt {{var.contact_found}} (ja/nein) und {{var.found_contact.*}} (id, first_name, email, tags, custom …). Mit „Mit diesem Kontakt weitermachen“ laufen die folgenden Schritte für den gefundenen Kontakt (praktisch bei Ereignissen von Firmen oder Webhooks). Findet sich keiner, kann der Ablauf enden oder weitergehen.',
      keywords: 'suchen find lookup kontakt contact',
      pure: true,
      fields: findFields([
        { key: 'switch_contact', label: 'Mit dem gefundenen Kontakt weitermachen', type: 'bool' },
        { key: 'on_missing', label: 'Wenn keiner gefunden wird', type: 'select', options: [['continue', 'Weiter (contact_found = nein)'], ['end', 'Ablauf beenden']], default: 'continue' },
      ]),
      provides: ['var.contact_found', 'var.found_contact'],
      sample: { by: 'email', value: '{{event.payload.email}}', switch_contact: true },
    },
    run: (run, step, vars) => {
      const c = lookupContact(run.location_id, String(step.by ?? 'email'), text(step.value, vars), text(step.custom_key, vars));
      if (!c) {
        if (step.on_missing === 'end') return { result: 'Kein Kontakt gefunden – Ablauf beendet', end: true, vars: { contact_found: false, found_contact: null } };
        return { result: 'Kein Kontakt gefunden', vars: { contact_found: false, found_contact: null } };
      }
      const row = contactRow(c);
      return { result: `Gefunden: ${row.name || row.email || row.id}`, vars: { contact_found: true, found_contact: row }, output: row, ...(step.switch_contact ? { contact_id: c.id } : {}) };
    },
  });

  add({
    meta: {
      type: 'find_or_create_contact',
      label: 'Kontakt suchen oder anlegen',
      category: 'crm',
      icon: 'contact',
      summary: 'Findet einen Kontakt oder legt ihn mit den angegebenen Feldern neu an.',
      doc: 'Wie „Kontakt suchen“, aber ohne Treffer wird ein neuer Kontakt angelegt (mit Quelle „Workflow“ und den Tags). Gefundene Kontakte können mit den Feldern aktualisiert werden. {{var.contact_created}} sagt, ob neu angelegt wurde.',
      keywords: 'find or create upsert kontakt anlegen',
      fields: findFields([
        {
          key: 'rows',
          label: 'Felder für einen neuen Kontakt',
          type: 'rows',
          addLabel: '+ Feld',
          rows: [{ key: 'field', label: 'Feld', type: 'contact_field' }, { key: 'value', label: 'Wert', type: 'text' }],
        },
        { key: 'tags', label: 'Tags für neue Kontakte', type: 'tags' },
        { key: 'update_existing', label: 'Gefundene Kontakte mit den Feldern aktualisieren', type: 'bool' },
        { key: 'switch_contact', label: 'Mit diesem Kontakt weitermachen', type: 'bool', default: true },
      ]),
      provides: ['var.contact_found', 'var.contact_created', 'var.found_contact'],
      sample: { by: 'email', value: '{{event.payload.email}}', rows: [{ field: 'first_name', value: '{{event.payload.name}}' }], tags: ['webhook'] },
    },
    run: (run, step, vars) => {
      const loc = run.location_id;
      const by = String(step.by ?? 'email');
      const value = text(step.value, vars);
      const found = lookupContact(loc, by, value, text(step.custom_key, vars));
      const input: Record<string, any> = {};
      const custom: Record<string, string> = {};
      for (const r of rowsOf<{ field: string; value: string }>(step.rows, ['field'])) {
        const f = String(r.field).trim();
        const v = text(r.value, vars);
        if (f.startsWith('custom.')) custom[f.slice(7)] = v;
        else input[f] = v;
      }
      if (Object.keys(custom).length) input.custom = custom;
      if (by === 'email' && value && !input.email) input.email = value;
      if (by === 'phone' && value && !input.phone) input.phone = value;
      const tags = Array.isArray(step.tags) ? step.tags.map(String) : [];
      if (found) {
        let c = found;
        if (step.update_existing && Object.keys(input).length) c = upsertContact(app, loc, { ...input, id: found.id }, { source: 'Workflow' }).contact;
        const row = contactRow(c);
        return { result: `Gefunden: ${row.name || row.email}`, vars: { contact_found: true, contact_created: false, found_contact: row }, output: row, ...(step.switch_contact !== false ? { contact_id: c.id } : {}) };
      }
      if (!input.email && !input.phone && !input.first_name && !input.last_name && !input.company) throw new Error('Zum Anlegen fehlen Angaben (E-Mail, Telefon oder Name)');
      const { contact } = upsertContact(app, loc, input, { source: 'Workflow', tags });
      const row = contactRow(contact);
      return { result: `Angelegt: ${row.name || row.email}`, vars: { contact_found: false, contact_created: true, found_contact: row }, output: row, ...(step.switch_contact !== false ? { contact_id: contact.id } : {}) };
    },
  });

  add({
    meta: {
      type: 'find_opportunity',
      label: 'Deal suchen',
      category: 'sales',
      icon: 'deal',
      summary: 'Sucht einen Deal des Kontakts (Pipeline, Status) und merkt sich ihn als {{var.deal.*}}.',
      doc: 'Setzt {{var.deal_found}} (ja/nein) und {{var.deal.*}} (id, name, value, status, stage_id, pipeline_id, stage_name). Typisch gefolgt von einer Bedingung („Deal-Wert größer als …“) oder „Deal ändern“.',
      keywords: 'deal opportunity suchen find',
      pure: true,
      fields: [
        { key: 'pipeline_id', label: 'Pipeline', type: 'pipeline', help: 'Leer = jede.' },
        { key: 'status', label: 'Status', type: 'select', options: [['open', 'Offen'], ['won', 'Gewonnen'], ['lost', 'Verloren'], ['abandoned', 'Aufgegeben'], ['any', 'Beliebig']], default: 'open' },
        { key: 'which', label: 'Welcher', type: 'select', options: [['newest', 'Neuester'], ['oldest', 'Ältester'], ['highest', 'Höchster Wert']], default: 'newest' },
      ],
      provides: ['var.deal_found', 'var.deal'],
      sample: { status: 'open', which: 'newest' },
    },
    run: (run, step) => {
      const where = ['contact_id = ?', 'location_id = ?'];
      const params: any[] = [run.contact_id, run.location_id];
      if (step.pipeline_id) (where.push('pipeline_id = ?'), params.push(step.pipeline_id));
      if (step.status && step.status !== 'any') (where.push('status = ?'), params.push(step.status));
      const order = step.which === 'oldest' ? 'created_at ASC' : step.which === 'highest' ? 'value DESC, created_at DESC' : 'created_at DESC';
      const o = db.get<any>(`SELECT * FROM opportunities WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 1`, ...params);
      if (!o) return { result: 'Kein Deal gefunden', vars: { deal_found: false, deal: null } };
      const pipe = parseJson(db.get<any>('SELECT * FROM pipelines WHERE id = ? AND location_id = ?', o.pipeline_id, run.location_id), ['stages']);
      const stage = pipe?.stages?.find((s: any) => s.id === o.stage_id);
      const deal = { id: o.id, name: o.name, value: o.value, status: o.status, pipeline_id: o.pipeline_id, pipeline_name: pipe?.name ?? '', stage_id: o.stage_id, stage_name: stage?.name ?? '', created_at: o.created_at };
      return { result: `Deal „${o.name}“ (${o.value} €, ${stage?.name ?? o.status})`, vars: { deal_found: true, deal }, output: deal };
    },
  });

  return defs;
}
