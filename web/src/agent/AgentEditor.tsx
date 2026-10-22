import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useSession } from '../session';
import { Check, Field, Input, Modal, Select, Tabs, Textarea, act, confirmAsk, useLoad } from '../ui';
import { MODE_LABEL } from './Panel';

/**
 * Editor for a custom agent: basics (name, emoji, role, instructions, starter prompts), model and
 * tools (grouped checklist), safety mode, knowledge and memory, automations (schedules, auto-reply in
 * the inbox) and visibility. Saves via /api/agents.
 */

const EMOJIS = ['🤖', '💼', '🛟', '📣', '🗂️', '🧾', '🎓', '🧹', '🔎', '✨', '📈', '🗓️', '✍️', '🧠'];
const KNOWLEDGE: [string, string][] = [
  ['agent', 'Eigenes Wissen (unten)'],
  ['ai', 'Wissen des KI-Assistenten'],
  ['kb', 'Wissensdatenbank (Hilfe-Artikel)'],
  ['docs', 'Projekt-Dokumente'],
  ['project', 'Projekt-Steckbrief'],
];
const CHANNELS: [string, string][] = [
  ['email', 'E-Mail'],
  ['sms', 'SMS'],
  ['chat', 'Website-Chat'],
  ['whatsapp', 'WhatsApp'],
  ['messenger', 'Messenger'],
  ['instagram', 'Instagram'],
];
const CADENCE: [string, string][] = [
  ['daily', 'Täglich'],
  ['weekdays', 'Werktags'],
  ['weekly', 'Wöchentlich'],
  ['monthly', 'Monatlich'],
];
const WEEKDAYS: [string, string][] = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'].map((d, i) => [String(i), d]);
const DELIVER: [string, string][] = [
  ['notification', 'Benachrichtigung (Push)'],
  ['email', 'E-Mail an mich'],
  ['task', 'Aufgabe (auch in Todoist, wenn verbunden)'],
];
const MODE_TEXT: Record<string, string> = {
  read: 'Darf nur lesen und auswerten – schlägt Änderungen vor, macht sie aber nicht.',
  ask: 'Zeigt jede Änderung vorher als Karte mit allen Details – du klickst „Ausführen“. Empfohlen.',
  book: 'Wie „Vor Änderungen fragen“ – sieht aber freie Termine nach und bucht einen freien Termin selbst (auch in der Auto-Antwort), mit Bestätigung samt Links zum Verschieben und Absagen.',
  auto: 'Ändert selbstständig. Versenden, Löschen, Zahlungen und Social-Posts brauchen trotzdem deine Bestätigung.',
};

export function AgentEditor({ agent, onClose, onSaved }: { agent: any; onClose: () => void; onSaved: (a: any) => void }) {
  const session = useSession();
  const admin = session.user.role === 'admin';
  const [tab, setTab] = useState('basics');
  const [a, setA] = useState<any>(() => ({
    name: '',
    emoji: '🤖',
    color: '',
    description: '',
    instructions: '',
    connection_id: '',
    model: '',
    tools: null,
    mode: 'ask',
    confirm_sensitive: true,
    knowledge: { sources: ['agent', 'ai', 'kb'], text: '' },
    starters: [],
    visibility: 'private',
    web_fetch: false,
    max_steps: 12,
    memory: true,
    responder: { enabled: false, channels: [], mode: 'draft', outside_hours: false },
    schedules: [],
    ...agent,
  }));
  const set = (patch: any) => setA((x: any) => ({ ...x, ...patch }));
  const tools = useLoad(() => api.get<any[]>('/api/agent/tools'), []);
  const conns = useLoad(() => api.get('/api/agent/bootstrap'), []);
  const memory = useLoad(() => (agent?.id ? api.get<any[]>(`/api/agent/memory?agent_id=${agent.id}`) : Promise.resolve([])), [agent?.id]);
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    if (!a.connection_id || a.connection_id === 'bridge') return setModels([]);
    api
      .get(`/api/ai-connections/${a.connection_id}/models`)
      .then((r) => setModels(r.models ?? []))
      .catch(() => setModels([]));
  }, [a.connection_id]);

  const groups = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const t of tools.data ?? []) m.set(t.group, [...(m.get(t.group) ?? []), t]);
    return [...m.entries()].sort((x, y) => (x[0] === 'Agent' ? -1 : y[0] === 'Agent' ? 1 : x[0].localeCompare(y[0])));
  }, [tools.data]);
  const all = a.tools === null;
  const has = (name: string) => all || (a.tools as string[]).includes(name);
  const toggleTool = (name: string, on: boolean) => {
    const cur: string[] = all ? (tools.data ?? []).map((t) => t.name) : a.tools;
    set({ tools: on ? [...new Set([...cur, name])] : cur.filter((n) => n !== name) });
  };

  const save = async () => {
    const body = { ...a, starters: (a.starters as string[]).filter((s) => s.trim()) };
    for (const k of ['id', 'owner', 'owner_id', 'location_id', 'can_edit', 'created_at', 'updated_at', 'template']) delete body[k];
    if (!admin) delete body.confirm_sensitive;
    const r = await act(() => (agent?.id ? api.patch(`/api/agents/${agent.id}`, body) : api.post('/api/agents', body)), 'Gespeichert');
    if (r) onSaved(r);
  };

  return (
    <Modal
      title={agent?.id ? `${a.emoji} ${a.name || 'Agent'} bearbeiten` : 'Neuer KI-Agent'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" onClick={save} disabled={!a.name.trim()} data-tour="agent-save">
            Speichern
          </button>
        </>
      }
    >
      <Tabs
        tabs={[
          ['basics', 'Grundlagen'],
          ['tools', 'Modell & Werkzeuge'],
          ['safety', 'Sicherheit'],
          ['knowledge', 'Wissen'],
          ['auto', 'Automatisch'],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'basics' && (
        <>
          <div className="row">
            <Field label="Name" tour="agent-name">
              <Input value={a.name} onChange={(v) => set({ name: v })} placeholder="z. B. Vertriebs-Assistent" autoFocus />
            </Field>
            <Field label="Emoji">
              <Select value={a.emoji} onChange={(v) => set({ emoji: v })} options={EMOJIS} />
            </Field>
            <Field label="Farbe">
              <input type="color" value={a.color || '#2563eb'} onChange={(e) => set({ color: e.target.value })} />
            </Field>
          </div>
          <Field label="Rolle (kurz)" hint="Was macht der Agent? Steht auch auf der Karte.">
            <Input value={a.description} onChange={(v) => set({ description: v })} placeholder="Behält Leads und Deals im Blick …" />
          </Field>
          <Field label="Anweisungen" hint="Wie soll er arbeiten? Tonfall, Regeln, was er nie tun soll.">
            <Textarea value={a.instructions} onChange={(v) => set({ instructions: v })} rows={7} placeholder="Du hilfst dem Vertriebsteam. Priorisiere …" />
          </Field>
          <Field label="Startfragen" hint="Eine pro Zeile – erscheinen als Knöpfe im Chat.">
            <Textarea value={(a.starters as string[]).join('\n')} onChange={(v) => set({ starters: v.split('\n').slice(0, 8) })} rows={4} />
          </Field>
          <Field label="Sichtbar für">
            <Select
              value={a.visibility}
              onChange={(v) => set({ visibility: v })}
              options={[['private', 'Nur ich'], ...(admin ? [['team', 'Agentur-Team (alle Admins)'] as [string, string]] : []), ['location', 'Alle im Sub-Account (auch Kunden-Logins)']]}
            />
          </Field>
        </>
      )}
      {tab === 'tools' && (
        <>
          <div className="row">
            <Field label="Modell-Verbindung" hint="Standard = Zuordnung „KI-Agent“ unter KI-Anbieter.">
              <Select
                value={a.connection_id}
                onChange={(v) => set({ connection_id: v, model: '' })}
                options={[['', 'Standard'], ...(conns.data?.models ?? []).map((m: any) => [m.id, `${m.label}${m.model ? ` · ${m.model}` : ''}`] as [string, string]), ['bridge', 'Mein Abo über die Bridge (nur Chat, nur für mich)']]}
              />
            </Field>
            <Field label="Modell (optional)" hint="Leer = Standard der Verbindung. Jede Modell-ID ist erlaubt.">
              <Input value={a.model} onChange={(v) => set({ model: v })} list="agent-models" placeholder="z. B. gpt-5-mini" disabled={a.connection_id === 'bridge'} />
              <datalist id="agent-models">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
          </div>
          <Check checked={all} onChange={(v) => set({ tools: v ? null : (tools.data ?? []).filter((t) => t.source === 'agent').map((t) => t.name) })} label={<strong>Alle Werkzeuge (auch neue, die Module später ergänzen)</strong>} tour="agent-all-tools" />
          {!all && (
            <div className="agent-tool-groups" data-tour="agent-tool-groups">
              {groups.map(([g, list]) => (
                <div key={g} className="agent-tool-group">
                  <div className="agent-tool-group-head">
                    <span>{g}</span>
                    <button className="btn small ghost" onClick={() => list.forEach((t) => toggleTool(t.name, !list.every((x) => has(x.name))))}>
                      {list.every((x) => has(x.name)) ? 'keine' : 'alle'}
                    </button>
                  </div>
                  {list.map((t) => (
                    <Check
                      key={t.name}
                      checked={has(t.name)}
                      onChange={(v) => toggleTool(t.name, v)}
                      label={
                        <span title={t.description}>
                          {t.title}
                          {t.klass === 'write' && <span className="agent-klass k-write">ändert</span>}
                          {t.klass === 'sensitive' && <span className="agent-klass k-sensitive">versendet</span>}
                        </span>
                      }
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {tab === 'safety' && (
        <>
          <div className="agent-radio" data-tour="agent-mode">
            {(['read', 'ask', 'book', 'auto'] as const).map((m) => (
              <label key={m} className={a.mode === m ? 'on' : ''}>
                <input type="radio" name="mode" checked={a.mode === m} onChange={() => set({ mode: m })} />
                <span>
                  <strong>{MODE_LABEL[m]}</strong>
                  <br />
                  <span className="muted small">{MODE_TEXT[m]}</span>
                </span>
              </label>
            ))}
          </div>
          {admin ? (
            <Check checked={!!a.confirm_sensitive} onChange={(v) => (v || confirmAsk('Wirklich ohne Rückfrage versenden, löschen und bezahlen lassen? Nach dem Lesen von E-Mails oder Webseiten fragt der Agent trotzdem.')) && set({ confirm_sensitive: v })} label="Versenden, Löschen, Zahlungen und Social-Posts immer bestätigen (empfohlen)" />
          ) : (
            <p className="muted small">Versenden, Löschen, Zahlungen und Social-Posts werden immer bestätigt (abschalten kann das nur ein Agentur-Admin).</p>
          )}
          <Check checked={!!a.web_fetch} onChange={(v) => set({ web_fetch: v })} label="Darf öffentliche Webseiten lesen (web_fetch)" />
          <Field label="Höchstens Schritte je Auftrag">
            <Input type="number" min={1} max={30} value={a.max_steps} onChange={(v) => set({ max_steps: Number(v) || 12 })} />
          </Field>
          <p className="muted small">Der Agent arbeitet immer mit deinen Rechten und nur in diesem Sub-Account. Jede Änderung steht im Protokoll als „KI-Agent (im Auftrag von …)“. Inhalte aus E-Mails, Chats und Webseiten gelten als Daten – sie können ihm keine Anweisungen geben.</p>
        </>
      )}
      {tab === 'knowledge' && (
        <>
          <div className="row">
            {KNOWLEDGE.map(([k, l]) => (
              <Check key={k} checked={(a.knowledge.sources as string[]).includes(k)} onChange={(v) => set({ knowledge: { ...a.knowledge, sources: v ? [...a.knowledge.sources, k] : a.knowledge.sources.filter((x: string) => x !== k) } })} label={l} />
            ))}
          </div>
          <Field label="Eigenes Wissen" hint="Fakten, Preise, Abläufe – der Agent nutzt sie als Daten. Keine Passwörter.">
            <Textarea value={a.knowledge.text} onChange={(v) => set({ knowledge: { ...a.knowledge, text: v } })} rows={8} />
          </Field>
          <Check checked={!!a.memory} onChange={(v) => set({ memory: v })} label="Darf sich Notizen merken (über Gespräche hinweg)" />
          {!!memory.data?.length && (
            <div className="card">
              <div className="agent-label">Gemerkte Notizen</div>
              {memory.data.map((n: any) => (
                <div key={n.id} className="row" style={{ alignItems: 'center' }}>
                  <span className="grow small">{n.text}</span>
                  <button className="icon-btn" aria-label="Notiz löschen" onClick={async () => (await act(() => api.del(`/api/agent/memory/${n.id}?agent_id=${agent.id}`))) && memory.reload()}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {tab === 'auto' && (
        <>
          <h3>Zeitpläne</h3>
          <p className="muted small">Der Agent läuft zur gewählten Zeit mit deinen Rechten in diesem Sub-Account und liefert das Ergebnis. Aktionen, die eine Bestätigung brauchen, landen unter „Freigaben“.</p>
          {(a.schedules as any[]).map((s, i) => {
            const up = (patch: any) => set({ schedules: a.schedules.map((x: any, j: number) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <div key={s.id ?? i} className="agent-schedule">
                <Field label="Auftrag">
                  <Input value={s.prompt} onChange={(v) => up({ prompt: v })} placeholder="Was ist heute wichtig?" />
                </Field>
                <Field label="Wann">
                  <Select value={s.cadence} onChange={(v) => up({ cadence: v })} options={CADENCE} />
                </Field>
                <Field label="Uhrzeit">
                  <Input type="time" value={s.time} onChange={(v) => up({ time: v })} />
                </Field>
                {s.cadence === 'weekly' ? (
                  <Field label="Tag">
                    <Select value={String(s.weekday ?? 0)} onChange={(v) => up({ weekday: Number(v) })} options={WEEKDAYS} />
                  </Field>
                ) : s.cadence === 'monthly' ? (
                  <Field label="Tag im Monat">
                    <Input type="number" min={1} max={28} value={s.day ?? 1} onChange={(v) => up({ day: Number(v) })} />
                  </Field>
                ) : (
                  <Field label="Ergebnis als">
                    <Select value={s.deliver} onChange={(v) => up({ deliver: v })} options={DELIVER} />
                  </Field>
                )}
                <button className="icon-btn" aria-label="Zeitplan entfernen" onClick={() => set({ schedules: a.schedules.filter((_: any, j: number) => j !== i) })}>
                  ✕
                </button>
                {(s.cadence === 'weekly' || s.cadence === 'monthly') && (
                  <Field label="Ergebnis als">
                    <Select value={s.deliver} onChange={(v) => up({ deliver: v })} options={DELIVER} />
                  </Field>
                )}
              </div>
            );
          })}
          <button className="btn small secondary" onClick={() => set({ schedules: [...a.schedules, { cadence: 'daily', time: '08:00', prompt: '', deliver: 'notification', enabled: true, weekday: 0, day: 1 }] })}>
            + Zeitplan
          </button>
          <hr />
          <h3>Auto-Antwort im Posteingang</h3>
          <p className="muted small">
            Der Agent beantwortet neue Nachrichten – als <strong>Entwurf</strong> zum Prüfen, oder im Modus „Autonom“ direkt. Er liest dabei nur (keine Änderungen) – in den Modi „Termin buchen“ und „Autonom“ bucht er außerdem freie Termine – und lässt Gespräche in Ruhe, die das Team übernommen hat. Kanäle, die der KI-Assistent schon bedient (Chat-Bot, E-Mail-Entwürfe), bleiben beim KI-Assistenten.
          </p>
          <Check checked={!!a.responder.enabled} onChange={(v) => set({ responder: { ...a.responder, enabled: v } })} label="Auto-Antwort einschalten" />
          {a.responder.enabled && (
            <>
              <div className="row">
                {CHANNELS.map(([k, l]) => (
                  <Check key={k} checked={a.responder.channels.includes(k)} onChange={(v) => set({ responder: { ...a.responder, channels: v ? [...a.responder.channels, k] : a.responder.channels.filter((x: string) => x !== k) } })} label={l} />
                ))}
              </div>
              <Field label="Antworten als">
                <Select value={a.responder.mode} onChange={(v) => set({ responder: { ...a.responder, mode: v } })} options={[['draft', 'Entwurf (das Team schickt ab)'], ['send', a.mode === 'auto' ? 'Direkt senden' : 'Direkt senden (nur im Modus „Autonom“)']]} />
              </Field>
              <Check checked={!!a.responder.outside_hours} onChange={(v) => set({ responder: { ...a.responder, outside_hours: v } })} label="Nur außerhalb der Geschäftszeiten (aus dem KI-Assistenten)" />
            </>
          )}
        </>
      )}
    </Modal>
  );
}
