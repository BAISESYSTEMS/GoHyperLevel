import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Check, Field, Input, Modal, Select, act, navigate, toast, useLoad } from '../ui';
import { Icon, type IconName } from '../icons';
import { type CardKind, CARD_KINDS, CARD_LABELS, CARD_SIZE, createElement } from '../../../server/services/canvas-model';
import { newId } from './store';
import type { DialogProps } from './dialogs';

/** CRM on the board: live cards, notes → tasks/deals, workflows as diagrams, flowcharts as workflows, frames as funnel pages. */

const KIND_ICON: Record<CardKind, IconName> = {
  contact: 'contact',
  company: 'company',
  deal: 'deal',
  task: 'tasks',
  ticket: 'ticket',
  appointment: 'calendars',
  project: 'project',
  report: 'reports',
  pipeline: 'opportunities',
};

interface Row {
  id: string;
  title: string;
  sub?: string;
}

const fullName = (c: any) => [c?.first_name, c?.last_name].filter(Boolean).join(' ') || c?.email || c?.phone || 'Unbekannt';
const list = (r: any, ...keys: string[]): any[] => (Array.isArray(r) ? r : (keys.map((k) => r?.[k]).find(Array.isArray) ?? []));

/** Records of one kind for the picker (the caller's own rights apply: the API answers 403 for areas they lack). */
async function load(kind: CardKind, q: string): Promise<Row[]> {
  const needle = q.trim().toLowerCase();
  const match = (...vals: unknown[]) => !needle || vals.some((v) => String(v ?? '').toLowerCase().includes(needle));
  const enc = encodeURIComponent(q.trim());
  switch (kind) {
    case 'contact':
      return list(await api.get(`/api/contacts?limit=25&q=${enc}`), 'contacts').map((c) => ({ id: c.id, title: fullName(c), sub: [c.company, c.email].filter(Boolean).join(' · ') }));
    case 'company':
      return list(await api.get(`/api/companies?limit=25&q=${enc}`), 'companies').map((c) => ({ id: c.id, title: c.name, sub: [c.industry, c.city].filter(Boolean).join(' · ') }));
    case 'deal':
      return list(await api.get(`/api/opportunities?status=open&q=${enc}`))
        .filter((o) => match(o.name))
        .slice(0, 40)
        .map((o) => ({ id: o.id, title: o.name, sub: fullName(o) }));
    case 'task':
      return list(await api.get('/api/tasks?status=all'))
        .filter((t) => match(t.title))
        .slice(0, 40)
        .map((t) => ({ id: t.id, title: t.title, sub: t.done ? 'erledigt' : t.due_at ? `fällig ${new Date(t.due_at).toLocaleDateString('de-DE')}` : '' }));
    case 'ticket':
      return list(await api.get(`/api/tickets?limit=25&q=${enc}`), 'tickets', 'items', 'rows').map((t) => ({ id: t.id, title: `#${t.number} ${t.subject}`, sub: t.status_kind }));
    case 'appointment':
      return list(await api.get('/api/appointments'))
        .filter((a) => match(a.title, fullName(a)))
        .slice(0, 40)
        .map((a) => ({ id: a.id, title: a.title, sub: `${new Date(a.start_at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })} · ${a.calendar_name ?? ''}` }));
    case 'report':
      return list(await api.get('/api/reports/library'))
        .filter((r) => match(r.name))
        .slice(0, 40)
        .map((r) => ({ id: r.id, title: r.name, sub: r.description ?? '' }));
    case 'pipeline':
      return list(await api.get('/api/pipelines')).map((p) => ({ id: p.id, title: p.name, sub: `${p.open_count ?? 0} offene Deals` }));
    case 'project':
      return [{ id: 'current', title: 'Dieses Projekt', sub: 'Kennzahlen des Sub-Accounts' }];
  }
}

export function CrmDialog({ api: ed, onClose }: DialogProps) {
  const [kind, setKind] = useState<CardKind>('contact');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<Row[]>([]);
  useEffect(() => {
    setRows(null);
    setError('');
    let live = true;
    const t = setTimeout(() => {
      load(kind, q)
        .then((r) => live && setRows(r))
        .catch((e) => live && (setError((e as Error).message), setRows([])));
    }, q ? 250 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [kind, q]);
  const toggle = (r: Row) => setPicked((p) => (p.some((x) => x.id === r.id) ? p.filter((x) => x.id !== r.id) : [...p, r].slice(0, 30)));
  const insert = (rs: Row[]) => {
    const [w, h] = CARD_SIZE[kind];
    const cols = Math.min(rs.length, kind === 'pipeline' || kind === 'report' ? 1 : 3);
    const rowsN = Math.ceil(rs.length / cols);
    const [cx, cy] = ed.center();
    const x0 = cx - (cols * (w + 24) - 24) / 2;
    const y0 = cy - (rowsN * (h + 24) - 24) / 2;
    const els = rs.map((r, i) => createElement({ type: 'card', card: { kind, id: r.id }, x: Math.round(x0 + (i % cols) * (w + 24)), y: Math.round(y0 + Math.floor(i / cols) * (h + 24)), name: r.title.slice(0, 200) }, newId));
    ed.insert(els);
    toast(els.length === 1 ? 'Live-Karte eingefügt' : `${els.length} Live-Karten eingefügt`);
    onClose();
  };
  return (
    <Modal
      title="Live-CRM-Karte einfügen"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted small" style={{ marginRight: 'auto' }}>
            {picked.length ? `${picked.length} gewählt` : 'Karten zeigen immer den aktuellen Stand des Datensatzes.'}
          </span>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" disabled={!picked.length} onClick={() => insert(picked)}>
            {picked.length > 1 ? `${picked.length} Karten einfügen` : 'Einfügen'}
          </button>
        </>
      }
    >
      <div className="cv-kinds" data-tour="canvas-crm-kinds">
        {CARD_KINDS.map((k) => (
          <button
            key={k}
            className={`cv-kind${kind === k ? ' on' : ''}`}
            onClick={() => {
              setKind(k);
              setPicked([]);
              setQ('');
            }}
          >
            <Icon name={KIND_ICON[k]} size={16} /> {CARD_LABELS[k]}
          </button>
        ))}
      </div>
      {kind !== 'project' && ['contact', 'company', 'deal', 'task', 'ticket', 'appointment', 'report'].includes(kind) && <Input value={q} onChange={setQ} placeholder={`${CARD_LABELS[kind]} suchen …`} autoFocus aria-label="Suchen" />}
      <div className="cv-pick-list">
        {rows === null && <p className="muted">Lädt …</p>}
        {error && <p className="cv-error">{error}</p>}
        {rows?.length === 0 && !error && <p className="muted">Nichts gefunden.</p>}
        {rows?.map((r) => (
          <label key={r.id} className={`cv-pick${picked.some((x) => x.id === r.id) ? ' on' : ''}`}>
            <input type="checkbox" checked={picked.some((x) => x.id === r.id)} onChange={() => toggle(r)} />
            <span>
              <b>{r.title}</b>
              {r.sub && <small className="muted"> {r.sub}</small>}
            </span>
            <button
              className="btn small secondary"
              onClick={(e) => {
                e.preventDefault();
                insert([r]);
              }}
            >
              Einfügen
            </button>
          </label>
        ))}
      </div>
    </Modal>
  );
}

// --- notes → task / deal -------------------------------------------------------------------------------------

function ContactPick({ value, onChange }: { value: { id: string; title: string } | null; onChange: (c: { id: string; title: string } | null) => void }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) return setRows([]);
    const t = setTimeout(() => void load('contact', q).then(setRows).catch(() => setRows([])), 250);
    return () => clearTimeout(t);
  }, [q]);
  if (value)
    return (
      <div className="cv-picked">
        <Icon name="contact" /> {value.title}{' '}
        <button className="icon-btn" onClick={() => onChange(null)} aria-label="Kontakt entfernen">
          ✕
        </button>
      </div>
    );
  return (
    <div>
      <Input value={q} onChange={setQ} placeholder="Kontakt suchen (optional)" />
      {rows.length > 0 && (
        <div className="cv-pick-list short">
          {rows.slice(0, 6).map((r) => (
            <button key={r.id} className="cv-pick" onClick={() => onChange({ id: r.id, title: r.title })}>
              <span>
                <b>{r.title}</b> <small className="muted">{r.sub}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ConvertTaskDialog({ api: ed, data, onClose }: DialogProps) {
  const ids: string[] = data?.ids ?? ed.selection;
  const n = ids.filter((id) => (ed.store.els.get(id)?.text ?? '').trim()).length;
  const [due, setDue] = useState('');
  const [contact, setContact] = useState<{ id: string; title: string } | null>(null);
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    await ed.store.flush();
    const r = await act(() => api.post(`/api/canvas/${ed.board.id}/convert`, { element_ids: ids, to: 'task', due_at: due ? new Date(`${due}T00:00:00.000Z`).toISOString() : null, contact_id: contact?.id ?? null, keep, clientId: ed.store.clientId }), n === 1 ? 'Aufgabe angelegt' : `${n} Aufgaben angelegt`);
    setBusy(false);
    if (r) {
      if (!keep) await ed.catchUpCreated();
      onClose();
    }
  };
  return (
    <Modal
      title="Als Aufgabe anlegen"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" onClick={go} disabled={busy || !n}>
            {n > 1 ? `${n} Aufgaben anlegen` : 'Aufgabe anlegen'}
          </button>
        </>
      }
    >
      <p className="muted">Die erste Zeile jeder Notiz wird der Titel, der Rest die Beschreibung. Die Notiz wird durch eine Live-Karte der Aufgabe ersetzt.</p>
      <Field label="Fällig am (optional)">
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
      </Field>
      <Field label="Kontakt">
        <ContactPick value={contact} onChange={setContact} />
      </Field>
      <Check checked={keep} onChange={setKeep} label="Notiz behalten (zusätzlich zur Karte)" />
    </Modal>
  );
}

export function DealDialog({ api: ed, data, onClose }: DialogProps) {
  const ids: string[] = data?.ids ?? ed.selection;
  const n = ids.filter((id) => (ed.store.els.get(id)?.text ?? '').trim()).length;
  const pipes = useLoad(() => api.get<any[]>('/api/pipelines'), []);
  const [pipeline, setPipeline] = useState('');
  const [stage, setStage] = useState('');
  const [contact, setContact] = useState<{ id: string; title: string } | null>(null);
  const [create, setCreate] = useState(false);
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const pl = pipes.data?.find((p) => p.id === (pipeline || pipes.data?.[0]?.id));
  const go = async () => {
    if (!pl) return;
    setBusy(true);
    await ed.store.flush();
    const r = await act(
      () => api.post(`/api/canvas/${ed.board.id}/convert`, { element_ids: ids, to: 'deal', pipeline_id: pl.id, stage_id: stage || pl.stages?.[0]?.id, contact_id: contact?.id, create_contact: !contact && create, keep, clientId: ed.store.clientId }),
      n === 1 ? 'Deal angelegt' : `${n} Deals angelegt`,
    );
    setBusy(false);
    if (r) {
      if (!keep) await ed.catchUpCreated();
      onClose();
    }
  };
  return (
    <Modal
      title="Als Deal anlegen"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" onClick={go} disabled={busy || !n || !pl || (!contact && !create)}>
            {n > 1 ? `${n} Deals anlegen` : 'Deal anlegen'}
          </button>
        </>
      }
    >
      <p className="muted">Titel = erste Zeile der Notiz. Steht darin ein Betrag wie „5.000 €“, wird er der Dealwert. Die Notiz wird durch eine Live-Karte des Deals ersetzt.</p>
      <div className="grid2">
        <Field label="Pipeline">
          <Select
            value={pl?.id ?? ''}
            onChange={(v) => {
              setPipeline(v);
              setStage('');
            }}
            options={(pipes.data ?? []).map((p) => [p.id, p.name] as [string, string])}
          />
        </Field>
        <Field label="Stufe">
          <Select value={stage || pl?.stages?.[0]?.id || ''} onChange={setStage} options={(pl?.stages ?? []).map((s: any) => [s.id, s.name] as [string, string])} />
        </Field>
      </div>
      <Field label="Kontakt" hint="Ein Deal gehört immer zu einem Kontakt.">
        <ContactPick value={contact} onChange={setContact} />
      </Field>
      {!contact && <Check checked={create} onChange={setCreate} label="Neuen Kontakt aus dem Notiz-Titel anlegen" />}
      <Check checked={keep} onChange={setKeep} label="Notiz behalten (zusätzlich zur Karte)" />
    </Modal>
  );
}

// --- workflows ---------------------------------------------------------------------------------------------------

export function WorkflowDialog({ api: ed, onClose }: DialogProps) {
  const wfs = useLoad(() => api.get<any[]>('/api/workflows'), []);
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    await ed.store.flush();
    const r = await act(() => api.post(`/api/canvas/${ed.board.id}/workflow-diagram`, { workflow_id: id || wfs.data?.[0]?.id, clientId: ed.store.clientId }));
    setBusy(false);
    if (!r) return;
    await ed.catchUpCreated();
    onClose();
    setTimeout(() => ed.zoomTo(r.frame_id ? [r.frame_id] : undefined), 60);
  };
  return (
    <Modal
      title="Workflow als Diagramm"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" onClick={go} disabled={busy || !wfs.data?.length}>
            Zeichnen
          </button>
        </>
      }
    >
      <p className="muted">Zeichnet Auslöser, Schritte und Verzweigungen einer Automation als Flussdiagramm. Der Rahmen verlinkt auf den Workflow.</p>
      {wfs.loading ? <p className="muted">Lädt …</p> : wfs.data?.length ? <Select value={id || wfs.data[0].id} onChange={setId} options={wfs.data.map((w) => [w.id, `${w.name}${w.status === 'active' ? '' : ' (Entwurf)'}`] as [string, string])} /> : <p className="muted">Noch keine Automationen angelegt.</p>}
    </Modal>
  );
}

export function WorkflowDraftDialog({ api: ed, onClose }: DialogProps) {
  const frames = ed.store.ordered.filter((e) => e.type === 'frame');
  const hasSel = ed.selection.length > 1;
  const [scope, setScope] = useState<'selection' | 'frame' | 'board'>(hasSel ? 'selection' : frames.length ? 'frame' : 'board');
  const [frame, setFrame] = useState(frames[0]?.id ?? '');
  const [name, setName] = useState(`${ed.board.name} (aus Canvas)`);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  const go = async () => {
    setBusy(true);
    await ed.store.flush();
    const body: Record<string, unknown> = { name };
    if (scope === 'selection') body.element_ids = ed.selection;
    if (scope === 'frame') body.frame_id = frame;
    const r = await act(() => api.post(`/api/canvas/${ed.board.id}/workflow-draft`, body));
    setBusy(false);
    if (r) setRes(r);
  };
  if (res)
    return (
      <Modal title="Workflow-Entwurf angelegt" onClose={onClose} footer={<button className="btn" onClick={() => (onClose(), navigate(res.url))}>Workflow öffnen</button>}>
        <p>
          <b>{res.workflow_name}</b> mit {res.steps} Schritt{res.steps === 1 ? '' : 'en'} ist als <b>Entwurf</b> gespeichert – gestartet wird erst, wenn du ihn im Editor prüfst und einschaltest.
        </p>
        {res.notes?.length > 0 && (
          <ul className="cv-notes">
            {res.notes.map((n: string, i: number) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </Modal>
    );
  return (
    <Modal
      title="Flussdiagramm → Workflow-Entwurf"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" onClick={go} disabled={busy || !name.trim() || (scope === 'frame' && !frame)}>
            Entwurf anlegen
          </button>
        </>
      }
    >
      <p className="muted">Der Start (ohne eingehenden Pfeil) wird der Auslöser, jede Form ein Schritt – „E-Mail …“, „SMS …“, „Warte 2 Tage“, „Tag: …“, sonst eine Aufgabe. Rauten werden Wenn/Sonst-Verzweigungen. Du prüfst alles im Workflow-Editor.</p>
      <Field label="Name des Workflows">
        <Input value={name} onChange={setName} />
      </Field>
      <Field label="Welcher Teil des Boards?">
        <Select
          value={scope}
          onChange={(v) => setScope(v as typeof scope)}
          options={[...(hasSel ? ([['selection', `Auswahl (${ed.selection.length})`]] as [string, string][]) : []), ...(frames.length ? ([['frame', 'Ein Rahmen']] as [string, string][]) : []), ['board', 'Ganzes Board']]}
        />
      </Field>
      {scope === 'frame' && <Select value={frame} onChange={setFrame} options={frames.map((f) => [f.id, f.name ?? 'Rahmen'] as [string, string])} />}
    </Modal>
  );
}

// --- frames → funnel pages ----------------------------------------------------------------------------------------

export function FunnelDialog({ api: ed, data, onClose }: DialogProps) {
  const frames = useMemo(() => ed.store.ordered.filter((e) => e.type === 'frame' && !e.hidden).sort((a, b) => a.x - b.x || a.y - b.y), [ed.store.rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const funnels = useLoad(() => api.get<any[]>('/api/funnels'), []);
  const [picked, setPicked] = useState<string[]>(() => (data?.frameIds?.length ? data.frameIds : frames.map((f) => f.id)));
  const [target, setTarget] = useState('new');
  const [name, setName] = useState(ed.board.name);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  const go = async () => {
    setBusy(true);
    await ed.store.flush();
    const r = await act(() => api.post(`/api/canvas/${ed.board.id}/funnel-pages`, { frame_ids: picked, ...(target === 'new' ? { funnel_name: name } : { funnel_id: target }) }));
    setBusy(false);
    if (!r) return;
    setRes(r);
    void ed.store.catchUp().catch(() => {});
  };
  if (res)
    return (
      <Modal title="Funnel-Seiten angelegt" onClose={onClose} footer={<button className="btn" onClick={() => (onClose(), navigate(res.url))}>Funnel öffnen</button>}>
        <p>{res.pages.length} Seite{res.pages.length === 1 ? '' : 'n'} aus den Rahmen erzeugt. Überschriften, Texte, Bilder und Buttons wurden übernommen – Feinschliff im Funnel-Editor.</p>
        <ul className="cv-notes">
          {res.pages.map((p: any) => (
            <li key={p.page_id}>{p.name}</li>
          ))}
        </ul>
      </Modal>
    );
  return (
    <Modal
      title="Rahmen → Funnel-Seiten"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" onClick={go} disabled={busy || !picked.length || (target === 'new' && !name.trim())}>
            Funnel-Seiten anlegen
          </button>
        </>
      }
      wide
    >
      {!frames.length ? (
        <p className="muted">Auf dem Board gibt es noch keine Rahmen. Lege für jede Seite einen Rahmen an (z. B. „Mobile 390“ oder „Desktop 1440“) und gestalte ihn.</p>
      ) : (
        <>
          <p className="muted">Jeder gewählte Rahmen wird eine Seite – von links nach rechts. Texte werden Überschriften und Absätze, farbige Formen mit Text Buttons, Bilder bleiben Bilder.</p>
          <div className="cv-pick-list short">
            {frames.map((f) => (
              <label key={f.id} className={`cv-pick${picked.includes(f.id) ? ' on' : ''}`}>
                <input type="checkbox" checked={picked.includes(f.id)} onChange={() => setPicked((p) => (p.includes(f.id) ? p.filter((x) => x !== f.id) : [...p, f.id]))} />
                <span>
                  <b>{f.name ?? 'Rahmen'}</b> <small className="muted">{Math.round(f.w)}×{Math.round(f.h)}</small>
                </span>
              </label>
            ))}
          </div>
          <div className="grid2">
            <Field label="Ziel">
              <Select value={target} onChange={setTarget} options={[['new', 'Neuer Funnel'], ...(funnels.data ?? []).map((f) => [f.id, `In „${f.name}“ ergänzen`] as [string, string])]} />
            </Field>
            {target === 'new' && (
              <Field label="Name des Funnels">
                <Input value={name} onChange={setName} />
              </Field>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
