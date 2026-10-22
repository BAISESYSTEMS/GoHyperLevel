import { useState } from 'react';
import { api } from '../api';
import { Field, Input, Modal, Select, act, navigate, useLoad } from '../ui';
import { Icon } from '../icons';
import { can, useSession } from '../session';
import { CARD_LABELS, type CardKind } from '../../../server/services/canvas-model';
import { useT } from '../i18n';

/**
 * "Aufs Canvas" on record pages (contact, company, ticket, pipeline, workflow): puts a live card – or
 * a workflow as a diagram – on an existing board or a new one, then opens the board at that spot.
 * Small on purpose: it lives in the main bundle, the editor itself is loaded only when the board opens.
 */

interface BoardRow {
  id: string;
  name: string;
  access: 'owner' | 'edit' | 'view';
}

export function CanvasPin({ kind, id, name }: { kind: CardKind | 'workflow'; id: string; name: string }) {
  const t = useT('core');
  const session = useSession();
  const [open, setOpen] = useState(false);
  if (!can(session, 'canvas')) return null;
  return (
    <>
      <button className="btn secondary" onClick={() => setOpen(true)} title={kind === 'workflow' ? t('Diesen Ablauf als Diagramm auf ein Canvas-Board zeichnen') : t('Als Live-Karte auf ein Canvas-Board legen')} data-tour="canvas-pin">
        <Icon name="canvas" size={14} /> {t('Aufs Canvas')}
      </button>
      {open && <PinDialog kind={kind} id={id} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

function PinDialog({ kind, id, name, onClose }: { kind: CardKind | 'workflow'; id: string; name: string; onClose: () => void }) {
  const t = useT('core');
  const boards = useLoad(() => api.get<{ boards: BoardRow[] }>('/api/canvas'), []);
  const editable = (boards.data?.boards ?? []).filter((b) => b.access !== 'view');
  const [target, setTarget] = useState('');
  const [title, setTitle] = useState(kind === 'workflow' ? `Workflow: ${name}` : name);
  const [busy, setBusy] = useState(false);
  const pick = target || editable[0]?.id || 'new';
  // the server's German card names; the ones that differ in other languages are named here
  const named: Partial<Record<CardKind, string>> = { contact: t('Kontakt'), company: t('Firma'), task: t('Aufgabe'), appointment: t('Termin'), project: t('Projekt'), report: t('Bericht') };
  const kindLabel = kind === 'workflow' ? '' : named[kind] ?? CARD_LABELS[kind];
  const go = async () => {
    setBusy(true);
    const r = await act(async () => {
      let board = pick;
      if (pick === 'new') board = (await api.post('/api/canvas', { name: title.trim() || t('Neues Board') })).id;
      if (kind === 'workflow') {
        const w = await api.post(`/api/canvas/${board}/workflow-diagram`, { workflow_id: id });
        return { board, focus: w.frame_id ? [w.frame_id] : [] };
      }
      const c = await api.post(`/api/canvas/${board}/elements`, { elements: [{ type: 'card', card: { kind, id }, name }] });
      return { board, focus: (c.created ?? []) as string[] };
    });
    setBusy(false);
    if (!r) return;
    onClose();
    navigate(`canvas/${r.board}${r.focus.length ? `?focus=${r.focus.map(encodeURIComponent).join('%2C')}` : ''}`);
  };
  return (
    <Modal
      title={kind === 'workflow' ? t('Workflow als Diagramm aufs Canvas') : t('{kind} aufs Canvas legen', { kind: kindLabel })}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
          <button className="btn" onClick={go} disabled={busy || boards.loading}>
            {t('Aufs Canvas legen')}
          </button>
        </>
      }
    >
      <p className="muted">
        {kind === 'workflow' ? t('Zeichnet Auslöser, Schritte und Verzweigungen als Flussdiagramm – der Rahmen verlinkt zurück auf den Workflow.') : t('Die Karte zeigt immer den aktuellen Stand des Datensatzes und öffnet ihn per Doppelklick.')}
      </p>
      <Field label={t('Auf welches Board?')}>
        <Select value={pick} onChange={setTarget} options={[...editable.map((b) => [b.id, b.name] as [string, string]), ['new', t('+ Neues Board')]]} />
      </Field>
      {pick === 'new' && (
        <Field label={t('Name des neuen Boards')}>
          <Input value={title} onChange={setTitle} maxLength={200} />
        </Field>
      )}
    </Modal>
  );
}
