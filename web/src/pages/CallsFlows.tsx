import { useEffect, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../icons';
import { api } from '../api';
import { lazyPages } from '../lazy';
import { Badge, Check, Empty, Field, Input, Modal, Select, Spinner, Tabs, Textarea, act, confirmAsk, useLoad } from '../ui';
import { Callout, Item, Panel } from './CreatorKit';
import { Tl, splitList, useCanSettings } from './CallsKit';

/**
 * Telefonmenü-Baukasten: the menu a caller walks through (greeting, keys, business hours and holidays, ring group or queue, voicemail,
 * KI-Telefonagent) drawn as a tree of steps. A step opens in a dialog; where it leads next is a choice from the steps that exist (or a
 * new step). "Testlauf" walks the saved menu with key presses at a chosen time without dialling anyone. Docs: docs/telephony.md.
 */

const { CallsRouting } = lazyPages(() => import('./CallsRouting'), 'CallsRouting');

type Node = Record<string, any> & { id: string; type: string; label: string };
interface Flow {
  start: string;
  nodes: Record<string, Node>;
}
interface Meta {
  node_types: { key: string; label: string }[];
  users: { id: string; name: string }[];
  groups: { id: string; name: string; kind: string }[];
  schedules: { id: string; name: string }[];
  audio: { id: string; name: string; duration_s: number }[];
  states: { code: string; name: string }[];
}

const TYPE: Record<string, { icon: IconName; short: string }> = {
  menu: { icon: 'keypad', short: 'Menü' },
  schedule: { icon: 'schedule', short: 'Zeitplan' },
  say: { icon: 'audio', short: 'Ansage' },
  forward: { icon: 'callOut', short: 'Weiterleiten' },
  group: { icon: 'contacts', short: 'Gruppe / Warteschlange' },
  voicemail: { icon: 'voicemail', short: 'Voicemail' },
  ai: { icon: 'bot', short: 'KI-Telefonagent' },
  hangup: { icon: 'hangup', short: 'Auflegen' },
};
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#'];

const blank = (type: string, id: string): Node => {
  const base = { id, type, label: TYPE[type].short };
  switch (type) {
    case 'menu':
      return { ...base, say: 'Für … drücken Sie die 1, für … die 2.', audio_id: '', options: {}, option_labels: {}, on_timeout: '', on_invalid: '', retries: 2, timeout: 6 };
    case 'schedule':
      return { ...base, schedule_id: '', open: '', closed: '', holiday: '' };
    case 'say':
      return { ...base, say: '', audio_id: '', next: '' };
    case 'forward':
      return { ...base, say: '', numbers: [], users: [], timeout: 20, on_fail: '' };
    case 'group':
      return { ...base, group_id: '', on_fail: '' };
    case 'voicemail':
      return { ...base, box: '', say: '', audio_id: '', assign_user: '' };
    case 'hangup':
      return { ...base, say: '' };
    default:
      return { ...base, on_fail: '' };
  }
};
const freeId = (flow: Flow) => {
  for (let i = 1; ; i++) if (!flow.nodes[`n${i}`]) return `n${i}`;
};

/** The ways out of a step: where each leads (empty target = the normal flow takes over). */
function edgesOf(n: Node): { label: ReactNode; to: string }[] {
  switch (n.type) {
    case 'menu':
      return [
        ...Object.keys(n.options ?? {})
          .sort()
          .map((k) => ({ label: <><b>{k}</b> {n.option_labels?.[k] || ''}</>, to: n.options[k] })),
        { label: 'keine Eingabe', to: n.on_timeout },
        { label: 'falsche Taste', to: n.on_invalid },
      ];
    case 'schedule':
      return [
        { label: 'geöffnet', to: n.open },
        { label: 'geschlossen', to: n.closed },
        { label: 'Feiertag', to: n.holiday },
      ];
    case 'say':
      return [{ label: 'danach', to: n.next }];
    case 'forward':
    case 'group':
    case 'ai':
      return [{ label: 'niemand erreichbar', to: n.on_fail }];
    default:
      return [];
  }
}

function summary(n: Node, meta: Meta): string {
  switch (n.type) {
    case 'menu':
      return n.say || 'Aufgenommene Ansage';
    case 'schedule':
      return n.schedule_id ? (meta.schedules.find((s) => s.id === n.schedule_id)?.name ?? 'Zeitplan (gelöscht)') : 'Öffnungszeiten aus den Telefonie-Einstellungen';
    case 'say':
      return n.say || 'Aufgenommene Ansage';
    case 'forward':
      return [...(n.numbers ?? []), ...(n.users ?? []).map((u: string) => meta.users.find((x) => x.id === u)?.name ?? 'Person')].join(', ') || 'Noch kein Ziel';
    case 'group':
      return meta.groups.find((g) => g.id === n.group_id)?.name ?? 'Noch keine Gruppe gewählt';
    case 'voicemail':
      return `Postfach „${n.box || n.label}“`;
    case 'ai':
      return 'Nimmt das Gespräch an, wenn der KI-Telefonagent eingerichtet ist';
    default:
      return n.say || 'Beendet den Anruf';
  }
}

function FlowTree({ flow, meta, issues, onOpen }: { flow: Flow; meta: Meta; issues: string[]; onOpen: (id: string) => void }) {
  const seen = new Set<string>();
  const card = (n: Node) => (
    <button type="button" className={`tl-node${n.id === flow.start ? ' start' : ''}${issues.some((i) => i.includes(`„${n.label}“`)) ? ' bad' : ''}`} onClick={() => onOpen(n.id)} data-tour={n.id === flow.start ? 'ivr-start' : undefined}>
      <span className="tl-node-icon">
        <Icon name={TYPE[n.type]?.icon ?? 'phone'} size={18} />
      </span>
      <span className="tl-node-main">
        <strong>
          {n.label} {n.id === flow.start && <Badge tone="green">Start</Badge>}
        </strong>
        <span>
          {TYPE[n.type]?.short}: {summary(n, meta)}
        </span>
      </span>
      <Icon name="edit" size={16} />
    </button>
  );
  const render = (id: string): ReactNode => {
    const n = flow.nodes[id];
    if (!n) return null;
    seen.add(id);
    const out = edgesOf(n);
    return (
      <>
        {card(n)}
        {out.some((e) => e.to && flow.nodes[e.to]) && (
          <div className="tl-branch">
            {out
              .filter((e) => e.to && flow.nodes[e.to])
              .map((e, i) => (
                <div className="tl-edge" key={`${id}-${i}`}>
                  <span className="tl-edge-label">{e.label}</span>
                  {seen.has(e.to) ? (
                    <button type="button" className="tl-ref" onClick={() => onOpen(e.to)}>
                      <Icon name="repeat" size={14} /> weiter bei „{flow.nodes[e.to].label}“
                    </button>
                  ) : (
                    render(e.to)
                  )}
                </div>
              ))}
          </div>
        )}
      </>
    );
  };
  const tree = render(flow.start);
  const loose = Object.values(flow.nodes).filter((n) => !seen.has(n.id));
  return (
    <div className="tl-flow" data-tour="ivr-tree">
      {tree}
      {loose.length > 0 && (
        <>
          <p className="muted small" style={{ margin: '10px 0 0' }}>
            Nicht angeschlossene Schritte (kein anderer Schritt führt hierher):
          </p>
          {loose.map((n) => (
            <div key={n.id}>{card(n)}</div>
          ))}
        </>
      )}
    </div>
  );
}

/** Where a step leads next: an existing step, a new one, or nowhere (the normal flow continues). */
function Target({ value, flow, self, onChange, required }: { value: string; flow: Flow; self: string; onChange: (v: string) => void; required?: boolean }) {
  return (
    <select value={value || ''} onChange={(e) => onChange(e.target.value)} aria-label="Weiter bei">
      <option value="">{required ? '— bitte wählen —' : '— nichts (normaler Ablauf) —'}</option>
      {Object.values(flow.nodes)
        .filter((n) => n.id !== self)
        .map((n) => (
          <option key={n.id} value={n.id}>
            {n.label} ({TYPE[n.type]?.short})
          </option>
        ))}
      <optgroup label="Neuer Schritt">
        {Object.entries(TYPE).map(([k, t]) => (
          <option key={k} value={`__new:${k}`}>
            ＋ {t.short}
          </option>
        ))}
      </optgroup>
    </select>
  );
}

function AudioSelect({ value, meta, onChange }: { value: string; meta: Meta; onChange: (v: string) => void }) {
  return (
    <Select value={value} onChange={onChange} placeholder="Text vorlesen lassen" options={meta.audio.map((a) => [a.id, `${a.name} (${a.duration_s} s)`])} />
  );
}

function NodeEditor({ flowIn, nodeId, meta, onCommit, onClose }: { flowIn: Flow; nodeId: string; meta: Meta; onCommit: (f: Flow) => void; onClose: () => void }) {
  const [flow, setFlow] = useState<Flow>(() => JSON.parse(JSON.stringify(flowIn)));
  const n = flow.nodes[nodeId];
  const set = (p: Record<string, any>) => setFlow((f) => ({ ...f, nodes: { ...f.nodes, [nodeId]: { ...f.nodes[nodeId], ...p } } }));
  /** A choice in a target select: "__new:type" makes the step. */
  const link = (field: string, v: string, sub?: string) =>
    setFlow((f) => {
      let to = v;
      let nodes = { ...f.nodes };
      if (v.startsWith('__new:')) {
        const id = freeId(f);
        nodes = { ...nodes, [id]: blank(v.slice(6), id) };
        to = id;
      }
      const cur = nodes[nodeId];
      nodes[nodeId] = sub === undefined ? { ...cur, [field]: to } : { ...cur, [field]: { ...cur[field], [sub]: to } };
      return { ...f, nodes };
    });
  const remove = () => {
    if (!confirmAsk(`„${n.label}“ löschen? Verweise darauf werden entfernt.`)) return;
    const nodes: Record<string, Node> = {};
    for (const [id, x] of Object.entries(flow.nodes)) {
      if (id === nodeId) continue;
      const y: Node = { ...x };
      for (const f of ['on_timeout', 'on_invalid', 'open', 'closed', 'holiday', 'next', 'on_fail']) if (y[f] === nodeId) y[f] = '';
      if (y.options) y.options = Object.fromEntries(Object.entries(y.options as Record<string, string>).filter(([, v]) => v !== nodeId));
      nodes[id] = y;
    }
    onCommit({ ...flow, nodes });
  };
  if (!n) return null;
  const isStart = flow.start === nodeId;
  const T = (field: string, label: string, required?: boolean) => (
    <Field label={label}>
      <Target value={n[field]} flow={flow} self={nodeId} onChange={(v) => link(field, v)} required={required} />
    </Field>
  );
  const opts: Record<string, string> = n.options ?? {};
  const freeKeys = KEYS.filter((k) => !(k in opts));
  return (
    <Modal
      title={`${TYPE[n.type].short}: ${n.label}`}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => onCommit(flow)}>
            Übernehmen
          </button>
          {!isStart && (
            <button className="btn secondary" onClick={() => onCommit({ ...flow, start: nodeId })}>
              Als Start festlegen
            </button>
          )}
          {!isStart && (
            <button className="btn danger" onClick={remove}>
              <Icon name="trash" size={14} /> Schritt löschen
            </button>
          )}
        </>
      }
    >
      <Field label="Name des Schritts" hint="Steht im Anrufprotokoll („Hauptmenü › Taste 2 Support“).">
        <Input value={n.label} onChange={(v) => set({ label: v })} maxLength={60} />
      </Field>

      {(n.type === 'menu' || n.type === 'say') && (
        <>
          <Field label="Ansage" hint="Wird mit deutscher Stimme vorgelesen – oder lade unter „Audio“ eine eigene Aufnahme hoch.">
            <Textarea value={n.say} onChange={(v) => set({ say: v })} rows={3} placeholder="Willkommen bei …" />
          </Field>
          <Field label="oder eigene Aufnahme">
            <AudioSelect value={n.audio_id} meta={meta} onChange={(v) => set({ audio_id: v })} />
          </Field>
        </>
      )}

      {n.type === 'menu' && (
        <>
          <h4 style={{ margin: '12px 0 6px' }}>Tasten</h4>
          <div className="cr-lines">
            {Object.keys(opts)
              .sort()
              .map((k) => (
                <div className="cr-line" key={k}>
                  <strong style={{ width: 28, textAlign: 'center' }}>{k}</strong>
                  <div className="grow">
                    <Input value={n.option_labels?.[k] ?? ''} onChange={(v) => set({ option_labels: { ...n.option_labels, [k]: v } })} placeholder="Wofür? (nur zur Übersicht)" aria-label={`Beschriftung Taste ${k}`} />
                  </div>
                  <div className="grow">
                    <Target value={opts[k]} flow={flow} self={nodeId} onChange={(v) => link('options', v, k)} required />
                  </div>
                  <button
                    className="icon-btn"
                    aria-label={`Taste ${k} entfernen`}
                    onClick={() => {
                      const o = { ...opts };
                      delete o[k];
                      set({ options: o });
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
          </div>
          {freeKeys.length > 0 && (
            <div className="actions" style={{ margin: '10px 0' }}>
              <Select value="" onChange={(k) => k && set({ options: { ...opts, [k]: '' } })} placeholder="＋ Taste hinzufügen" options={freeKeys} />
            </div>
          )}
          <div className="cr-form-row">
            {T('on_timeout', 'Wenn nichts gedrückt wird (nach den Wiederholungen)')}
            {T('on_invalid', 'Wenn eine nicht belegte Taste gedrückt wird')}
          </div>
          <div className="cr-form-row">
            <Field label="Wiederholungen">
              <Input type="number" min={0} max={5} value={n.retries} onChange={(v) => set({ retries: Number(v) })} />
            </Field>
            <Field label="Sekunden auf eine Taste warten">
              <Input type="number" min={3} max={20} value={n.timeout} onChange={(v) => set({ timeout: Number(v) })} />
            </Field>
          </div>
        </>
      )}

      {n.type === 'schedule' && (
        <>
          <Field label="Zeitplan" hint="Öffnungszeiten, Feiertage und Sonderzeiten legst du im Reiter „Zeitpläne“ an.">
            <Select value={n.schedule_id} onChange={(v) => set({ schedule_id: v })} placeholder="Öffnungszeiten aus den Telefonie-Einstellungen" options={meta.schedules.map((s) => [s.id, s.name])} />
          </Field>
          {T('open', 'Wenn geöffnet', true)}
          {T('closed', 'Wenn geschlossen', true)}
          {T('holiday', 'An Feiertagen (leer: wie geschlossen)')}
        </>
      )}

      {n.type === 'say' && T('next', 'Danach weiter bei')}

      {n.type === 'forward' && (
        <>
          <Field label="Ansage vor dem Weiterleiten (optional)">
            <Input value={n.say} onChange={(v) => set({ say: v })} maxLength={500} />
          </Field>
          <Field label="Nummern" hint="Mehrere mit Komma trennen – alle klingeln gleichzeitig. Format +49…">
            <Input value={(n.numbers ?? []).join(', ')} onChange={(v) => set({ numbers: splitList(v) })} placeholder="+49151…" />
          </Field>
          <Field label="Personen (Browser-Telefon)">
            <div className="cr-lines">
              {meta.users.map((u) => (
                <Check key={u.id} checked={(n.users ?? []).includes(u.id)} onChange={(on) => set({ users: on ? [...(n.users ?? []), u.id] : (n.users ?? []).filter((x: string) => x !== u.id) })} label={u.name} />
              ))}
            </div>
          </Field>
          <Field label="Klingeldauer (Sekunden)">
            <Input type="number" min={5} max={60} value={n.timeout} onChange={(v) => set({ timeout: Number(v) })} />
          </Field>
          {T('on_fail', 'Wenn niemand abnimmt')}
        </>
      )}

      {n.type === 'group' && (
        <>
          <Field label="Ruf-Gruppe oder Warteschlange" hint="Mitglieder, Verteilung, Wartemusik und Überlauf stellst du im Reiter „Gruppen“ ein.">
            <Select value={n.group_id} onChange={(v) => set({ group_id: v })} placeholder="— bitte wählen —" options={meta.groups.map((g) => [g.id, `${g.name} (${g.kind === 'queue' ? 'Warteschlange' : 'Ruf-Gruppe'})`])} />
          </Field>
          {T('on_fail', 'Wenn niemand erreichbar ist')}
        </>
      )}

      {n.type === 'voicemail' && (
        <>
          <Field label="Name des Postfachs" hint="Erscheint im Anrufprotokoll und in der Benachrichtigung („Vertrieb“).">
            <Input value={n.box} onChange={(v) => set({ box: v })} maxLength={60} placeholder={n.label} />
          </Field>
          <Field label="Ansage vor dem Signalton" hint="Leer: die Standardansage.">
            <Textarea value={n.say} onChange={(v) => set({ say: v })} rows={3} />
          </Field>
          <Field label="oder eigene Aufnahme">
            <AudioSelect value={n.audio_id} meta={meta} onChange={(v) => set({ audio_id: v })} />
          </Field>
          <Field label="Rückruf-Aufgabe für" hint="Zu jeder Nachricht entsteht eine Aufgabe für diese Person.">
            <Select value={n.assign_user} onChange={(v) => set({ assign_user: v })} placeholder="niemanden" options={meta.users.map((u) => [u.id, u.name])} />
          </Field>
        </>
      )}

      {n.type === 'ai' && (
        <>
          <p className="muted">Der Anruf geht an den KI-Telefonagent (Einstellungen → KI-Telefonagent). Ist er nicht eingerichtet oder nicht erreichbar, geht es hier weiter:</p>
          {T('on_fail', 'Wenn die KI nicht antworten kann')}
        </>
      )}

      {n.type === 'hangup' && (
        <Field label="Letzter Satz (optional)">
          <Input value={n.say} onChange={(v) => set({ say: v })} maxLength={500} placeholder="Vielen Dank für Ihren Anruf." />
        </Field>
      )}
    </Modal>
  );
}

const END_TEXT: Record<string, string> = {
  waiting: 'Das Menü wartet hier auf eine Taste.',
  default: 'Der normale Ablauf übernimmt (Weiterleitung, KI-Telefonagent oder Voicemail).',
  loop: 'Der Weg läuft im Kreis.',
  forward: 'Der Anruf wird weitergeleitet.',
  group: 'Der Anruf geht an die Ruf-Gruppe oder Warteschlange.',
  voicemail: 'Der Anrufer spricht eine Voicemail auf.',
  ai: 'Der KI-Telefonagent nimmt das Gespräch an.',
  hangup: 'Der Anruf wird beendet.',
  say: 'Nach der Ansage ist der Anruf zu Ende.',
};

function Simulator({ id, dirty }: { id: string; dirty: boolean }) {
  const [keys, setKeys] = useState('');
  const [at, setAt] = useState('');
  const [res, setRes] = useState<any>(null);
  const run = async () => {
    const list = [...keys].map((k) => (k === '_' || k === '-' || k === ' ' ? '' : k));
    const r = await act(() => api.post(`/api/telephony/ivr/${id}/simulate`, { keys: list, ...(at ? { at: new Date(at).toISOString() } : {}) }));
    if (r) setRes(r);
  };
  return (
    <Panel title="Testlauf" sub="Geht den gespeicherten Ablauf durch, als würde jemand anrufen – es wird niemand angerufen." tour="ivr-test">
      {dirty && <Callout tone="warn">Du hast ungespeicherte Änderungen. Der Testlauf nutzt den gespeicherten Stand.</Callout>}
      <div className="cr-form-row">
        <Field label="Gedrückte Tasten" hint="In der Reihenfolge, z. B. 12 – ein Unterstrich steht für „nichts gedrückt“.">
          <Input value={keys} onChange={setKeys} placeholder="z. B. 1" />
        </Field>
        <Field label="Zeitpunkt des Anrufs" hint="Leer: jetzt. So prüfst du Feiertage und Abendstunden.">
          <Input type="datetime-local" value={at} onChange={setAt} />
        </Field>
      </div>
      <button className="btn" onClick={run}>
        <Icon name="play" size={14} /> Testen
      </button>
      {res && (
        <>
          <ol className="tl-sim">
            {res.steps.map((s: any, i: number) => (
              <li key={i}>
                <span className="n">{i + 1}</span>
                <span>
                  <strong>{s.label}</strong> <span className="muted">– {s.note}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="small" style={{ marginTop: 10 }}>
            <strong>Ergebnis:</strong> {END_TEXT[res.end] ?? res.end}
          </p>
        </>
      )}
    </Panel>
  );
}

function FlowEditor({ id, meta, onBack }: { id: string; meta: Meta; onBack: () => void }) {
  const data = useLoad(() => api.get(`/api/telephony/ivr/${id}`), [id]);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [name, setName] = useState('');
  const [open, setOpen] = useState('');
  const [base, setBase] = useState('');
  useEffect(() => {
    if (data.data && !flow) {
      setFlow(data.data.flow);
      setName(data.data.name);
      setBase(JSON.stringify([data.data.name, data.data.flow]));
    }
  }, [data.data]);
  if (!data.data || !flow) return <Spinner />;
  const dirty = JSON.stringify([name, flow]) !== base;
  const save = async () => {
    const r = await act(() => api.put(`/api/telephony/ivr/${id}`, { name, flow }), 'Gespeichert');
    if (r) {
      setFlow(r.flow);
      setBase(JSON.stringify([r.name, r.flow]));
      data.setData(r);
    }
  };
  const add = (type: string) => {
    const nid = freeId(flow);
    setFlow({ ...flow, nodes: { ...flow.nodes, [nid]: blank(type, nid) } });
    setOpen(nid);
  };
  return (
    <>
      <div className="tl-bar">
        <button className="btn secondary" onClick={() => (!dirty || confirmAsk('Ungespeicherte Änderungen verwerfen?')) && onBack()}>
          ← Alle Menüs
        </button>
        <div className="grow">
          <Input value={name} onChange={setName} aria-label="Name des Menüs" maxLength={80} />
        </div>
        <button className="btn" disabled={!dirty} onClick={save} data-tour="ivr-save">
          Speichern
        </button>
      </div>
      {data.data.issues.length > 0 && (
        <Callout tone="warn">
          <strong>Das fällt auf:</strong>
          <ul>
            {data.data.issues.map((t: string) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </Callout>
      )}
      {data.data.numbers.length === 0 && (
        <Callout>
          Dieses Menü ist noch keiner Nummer zugeordnet. Unter „Nummern“ legst du fest, welche Nummer in dieses Menü führt.
        </Callout>
      )}
      <div className="cr-panels two">
        <Panel
          title="Ablauf"
          sub="Klicke einen Schritt, um ihn zu bearbeiten. Die Linien zeigen, wohin welche Taste oder Bedingung führt."
          wide
          actions={
            <Select value="" onChange={(t) => t && add(t)} placeholder="＋ Schritt hinzufügen" options={Object.entries(TYPE).map(([k, t]) => [k, t.short])} />
          }
        >
          <FlowTree flow={flow} meta={meta} issues={data.data.issues} onOpen={setOpen} />
        </Panel>
        <Simulator id={id} dirty={dirty} />
        <Panel title="Nummern in dieses Menü">
          {data.data.numbers.length ? (
            data.data.numbers.map((n: any) => (
              <p key={n.id} style={{ margin: '0 0 6px' }}>
                <span className="tl-num">{n.number}</span> <span className="muted">{n.label}</span>
              </p>
            ))
          ) : (
            <p className="muted">Noch keine.</p>
          )}
        </Panel>
      </div>
      {open && (
        <NodeEditor
          key={open}
          flowIn={flow}
          nodeId={open}
          meta={meta}
          onClose={() => setOpen('')}
          onCommit={(f) => {
            setFlow(f);
            setOpen('');
          }}
        />
      )}
    </>
  );
}

function FlowList({ onOpen }: { onOpen: (id: string) => void }) {
  const list = useLoad(() => api.get<any[]>('/api/telephony/ivr'), []);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  if (!list.data) return <Spinner />;
  return (
    <>
      <Panel
        title="Telefonmenüs"
        sub="Ein Menü begrüßt Anrufer, lässt sie eine Taste drücken, prüft Öffnungszeiten und Feiertage und leitet an Personen, Gruppen, die KI oder die Voicemail weiter."
        wide
        actions={
          <button className="btn" onClick={() => setCreating(true)} data-tour="ivr-new">
            <Icon name="plus" size={14} /> Neues Menü
          </button>
        }
      >
        {list.data.length ? (
          <div className="cr-list">
            {list.data.map((f) => (
              <Item
                key={f.id}
                onClick={() => onOpen(f.id)}
                side={
                  <>
                    {f.issues.length > 0 && <Badge tone="yellow">{f.issues.length} Hinweis{f.issues.length > 1 ? 'e' : ''}</Badge>}
                    <button
                      className="icon-btn"
                      aria-label={`${f.name} löschen`}
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (confirmAsk(`Telefonmenü „${f.name}“ löschen?`) && (await act(() => api.del(`/api/telephony/ivr/${f.id}`), 'Gelöscht'))) void list.reload();
                      }}
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  </>
                }
              >
                <strong>{f.name}</strong>
                <div className="cr-sub">
                  {Object.keys(f.flow.nodes).length} Schritte · {f.numbers.length ? f.numbers.map((n: any) => n.label || n.number).join(', ') : 'noch keiner Nummer zugeordnet'}
                </div>
              </Item>
            ))}
          </div>
        ) : (
          <Empty>Noch kein Telefonmenü. Lege eins an und ordne es unter „Nummern“ einer Rufnummer zu.</Empty>
        )}
      </Panel>
      {creating && (
        <Modal
          title="Neues Telefonmenü"
          onClose={() => setCreating(false)}
          footer={
            <button
              className="btn"
              disabled={!name.trim()}
              onClick={async () => {
                const r = await act(() => api.post('/api/telephony/ivr', { name }));
                if (r) {
                  setCreating(false);
                  setName('');
                  onOpen(r.id);
                }
              }}
            >
              Anlegen
            </button>
          }
        >
          <Field label="Name" hint="Zum Beispiel „Hauptnummer“ oder „Support-Hotline“. Du startest mit einem Begrüßungsmenü und baust von dort aus weiter.">
            <Input value={name} onChange={setName} maxLength={80} autoFocus />
          </Field>
        </Modal>
      )}
    </>
  );
}

export function CallsFlows({ sub }: { sub?: string }) {
  const can = useCanSettings();
  const [tab, setTab] = useState(['menus', 'schedules', 'groups', 'audio'].includes(sub ?? '') ? sub! : 'menus');
  const [flowId, setFlowId] = useState('');
  const meta = useLoad(() => api.get<Meta>('/api/telephony/ivr/meta'), [tab, flowId]);
  if (!can) return <Empty>Telefonmenüs, Gruppen und Nummern stellt die Agentur oder ein Mitglied mit Zugriff auf die Einstellungen ein.</Empty>;
  return (
    <Tl name="flows">
      <Tabs
        tabs={[
          ['menus', 'Menüs'],
          ['schedules', 'Zeitpläne'],
          ['groups', 'Gruppen & Warteschlangen'],
          ['audio', 'Audio'],
        ]}
        value={tab}
        onChange={(t) => (setTab(t), setFlowId(''))}
      />
      <div style={{ height: 14 }} />
      {!meta.data ? (
        <Spinner />
      ) : tab === 'menus' ? (
        flowId ? (
          <FlowEditor id={flowId} meta={meta.data} onBack={() => setFlowId('')} />
        ) : (
          <FlowList onOpen={setFlowId} />
        )
      ) : (
        <CallsRouting tab={tab as 'schedules' | 'groups' | 'audio'} meta={meta.data} reloadMeta={meta.reload} />
      )}
    </Tl>
  );
}
