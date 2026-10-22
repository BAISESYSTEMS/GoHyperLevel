import { useState } from 'react';
import { api, d } from '../api';
import { Badge, act, confirmAsk, useLoad } from '../ui';
import { ContactDupes } from './SalesDupes';
import { EnrollContact } from './SalesSequences';
import './sales.css';

/**
 * What the contact page gets from sales (docs/sales.md): the duplicate hint on top and the person's sequences next to the other
 * actions. Loaded as its own chunk; without the area „Opportunities“ the sequence box simply stays away.
 */

export function ContactDupeBanner({ contactId }: { contactId: string }) {
  return <ContactDupes contactId={contactId} />;
}

const TONE: Record<string, 'green' | 'blue' | 'gray' | 'yellow'> = { active: 'blue', paused: 'yellow', finished: 'green', stopped: 'gray' };
const LABEL: Record<string, string> = { active: 'läuft', paused: 'pausiert', finished: 'durchlaufen', stopped: 'beendet' };

export function ContactSequences({ contactId }: { contactId: string }) {
  const list = useLoad(() => api.get<any[]>(`/api/sequence-enrollments?contact_id=${contactId}`).catch(() => null), [contactId]);
  const [enroll, setEnroll] = useState(false);
  if (!list.data) return null;
  const rows = list.data;
  return (
    <div className="contact-seq" data-tour="contact-sequences">
      <div className="muted small" style={{ marginBottom: 4 }}>
        Sequenzen
      </div>
      {rows.slice(0, 5).map((e) => (
        <div className="deal-row" key={e.id}>
          <div className="grow">
            <b>{e.sequence_name}</b>
            <div className="muted small">
              {e.status === 'active' ? `Schritt ${e.step_index + 1}${e.next_at ? ` · weiter am ${d(e.next_at)}` : ''}` : e.stop_label || `seit ${d(e.enrolled_at)}`} · {e.sent} gesendet
            </div>
          </div>
          <Badge tone={TONE[e.status] ?? 'gray'}>{LABEL[e.status] ?? e.status}</Badge>
          {(e.status === 'active' || e.status === 'paused') && (
            <button className="icon-btn" aria-label="Sequenz für diese Person beenden" title="Beenden" onClick={async () => confirmAsk('Sequenz für diese Person beenden?') && (await act(() => api.post(`/api/sequence-enrollments/${e.id}/stop`, {}), 'Beendet')) && list.reload()}>
              ✕
            </button>
          )}
        </div>
      ))}
      <button className="btn small secondary" onClick={() => setEnroll(true)}>
        In Sequenz aufnehmen
      </button>
      {enroll && <EnrollContact contactId={contactId} onClose={() => setEnroll(false)} onDone={() => (setEnroll(false), list.reload())} />}
    </div>
  );
}
