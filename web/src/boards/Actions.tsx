import { useEffect, useState } from 'react';
import { api, name as contactName } from '../api';
import { ICONS, Icon, type IconName } from '../icons';
import { Field, Input, Modal, act, navigate, toast } from '../ui';
import type { ActionView } from './types';

/**
 * The buttons of a "Schnellaktionen" widget. Everything they start goes through the regular routes as the person who
 * clicks – a workflow is started for contacts they pick, a task or contact is created with their own rights.
 */

const KIND_ICON: Record<ActionView['kind'], IconName> = { workflow: 'workflows', form: 'forms', page: 'external', task: 'tasks', contact: 'contact' };

export function ActionButtons({ actions, onDone }: { actions: ActionView[]; onDone?: () => void }) {
  const [open, setOpen] = useState<ActionView | null>(null);
  if (!actions.length) return <p className="bd-hint">Noch keine Knöpfe. Öffne die Einstellungen und füge welche hinzu.</p>;
  const click = (a: ActionView) => {
    if (!a.enabled) return;
    if (a.kind === 'page' && a.href) navigate(a.href);
    else if (a.kind === 'form' && a.href) window.open(a.href, '_blank', 'noopener,noreferrer');
    else setOpen(a);
  };
  return (
    <div className="bd-actions">
      {actions.map((a) => {
        const icon = (a.icon && a.icon in ICONS ? a.icon : KIND_ICON[a.kind]) as IconName;
        return (
          <button key={a.id} type="button" className="bd-action" disabled={!a.enabled} title={a.enabled ? a.label : a.why} onClick={() => click(a)}>
            <Icon name={icon} size={18} />
            <span>{a.label}</span>
          </button>
        );
      })}
      {open?.kind === 'task' && <TaskDialog title={open.label} onClose={() => setOpen(null)} onDone={onDone} />}
      {open?.kind === 'contact' && <ContactDialog title={open.label} onClose={() => setOpen(null)} onDone={onDone} />}
      {open?.kind === 'workflow' && <WorkflowDialog action={open} onClose={() => setOpen(null)} onDone={onDone} />}
    </div>
  );
}

function TaskDialog({ title, onClose, onDone }: { title: string; onClose: () => void; onDone?: () => void }) {
  const [text, setText] = useState('');
  const [due, setDue] = useState('');
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="btn"
            disabled={!text.trim()}
            onClick={async () => {
              const r = await act(() => api.post('/api/tasks', { title: text.trim(), due_at: due || null }), 'Aufgabe angelegt');
              if (r) {
                onDone?.();
                onClose();
              }
            }}
          >
            Anlegen
          </button>
        </>
      }
    >
      <Field label="Was ist zu tun?">
        <Input value={text} onChange={setText} maxLength={300} autoFocus />
      </Field>
      <Field label="Fällig am (optional)">
        <Input type="date" value={due} onChange={setDue} />
      </Field>
    </Modal>
  );
}

function ContactDialog({ title, onClose, onDone }: { title: string; onClose: () => void; onDone?: () => void }) {
  const [f, setF] = useState({ first_name: '', last_name: '', email: '', phone: '' });
  const ok = !!(f.first_name.trim() || f.last_name.trim() || f.email.trim() || f.phone.trim());
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="btn"
            disabled={!ok}
            onClick={async () => {
              const r = await act(() => api.post('/api/contacts', f), 'Kontakt gespeichert');
              if (r) {
                onDone?.();
                onClose();
              }
            }}
          >
            Anlegen
          </button>
        </>
      }
    >
      <div className="grid2">
        <Field label="Vorname">
          <Input value={f.first_name} onChange={(v) => setF({ ...f, first_name: v })} autoFocus />
        </Field>
        <Field label="Nachname">
          <Input value={f.last_name} onChange={(v) => setF({ ...f, last_name: v })} />
        </Field>
      </div>
      <Field label="E-Mail">
        <Input type="email" value={f.email} onChange={(v) => setF({ ...f, email: v })} />
      </Field>
      <Field label="Telefon">
        <Input value={f.phone} onChange={(v) => setF({ ...f, phone: v })} />
      </Field>
    </Modal>
  );
}

function WorkflowDialog({ action, onClose, onDone }: { action: ActionView; onClose: () => void; onDone?: () => void }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<any[]>([]);
  const [picked, setPicked] = useState<any[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) return setFound([]);
    const t = setTimeout(() => api.get(`/api/contacts?q=${encodeURIComponent(q.trim())}&limit=6`).then((r) => setFound(r.contacts ?? [])).catch(() => setFound([])), 200);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <Modal
      title={action.label}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="btn"
            disabled={!picked.length}
            onClick={async () => {
              const r = await act(() => api.post(`/api/workflows/${action.target}/enroll`, { contact_ids: picked.map((c) => c.id) }));
              if (r) {
                toast(r.enrolled ? `Automation für ${r.enrolled} ${r.enrolled === 1 ? 'Kontakt' : 'Kontakte'} gestartet` : 'Niemand wurde aufgenommen (läuft die Automation für diesen Kontakt schon?)');
                onDone?.();
                onClose();
              }
            }}
          >
            Starten
          </button>
        </>
      }
    >
      <Field label="Für welche Kontakte?" hint="Suche nach Name, E-Mail oder Telefon.">
        <Input value={q} onChange={setQ} placeholder="Name oder E-Mail" autoFocus />
      </Field>
      {found.length > 0 && (
        <ul className="bd-found">
          {found
            .filter((c) => !picked.some((p) => p.id === c.id))
            .map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => (setPicked([...picked, c]), setQ(''))}>
                  {contactName(c)} <span className="muted small">{c.email || c.phone || ''}</span>
                </button>
              </li>
            ))}
        </ul>
      )}
      {picked.length > 0 && (
        <div className="chips">
          {picked.map((c) => (
            <span key={c.id} className="chip on">
              {contactName(c)}
              <button type="button" className="chip-x" aria-label={`${contactName(c)} entfernen`} onClick={() => setPicked(picked.filter((p) => p.id !== c.id))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </Modal>
  );
}
