import { useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { useT } from '../i18n';
import { act, Badge, Field, Modal, Select, Textarea, useLoad } from '../ui';

/**
 * "Spam / Blockieren" in the conversation header (modules/inbox-spam.ts): marks the contact as spam and blocks it – new
 * messages are archived silently, calls rejected – and the same place unblocks it again. The inbox filter "Spam" lists the
 * conversations of blocked senders.
 */

const REASONS: [string, string][] = [
  ['spam', 'Spam'],
  ['harassment', 'Belästigung'],
  ['other', 'Sonstiges'],
];

export function SpamButton({ contactId, onChanged }: { contactId: string; onChanged: () => void }) {
  const t = useT('spam');
  const st = useLoad(() => api.get<{ blocked: boolean; reason?: string; blocked_messages?: number; blocked_calls?: number }>(`/api/blocked-contacts/${contactId}`).catch(() => null), [contactId]);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('spam');
  const [note, setNote] = useState('');
  if (!st.data) return null;
  if (st.data.blocked)
    return (
      <span className="row" style={{ gap: 6, alignItems: 'center' }} data-tour="inbox-blocked">
        <Badge tone="red">
          <Icon name="shield" size={12} /> {t('Blockiert')}
          {st.data.blocked_messages || st.data.blocked_calls ? ` · ${t('{m} Nachrichten, {c} Anrufe abgefangen', { m: st.data.blocked_messages ?? 0, c: st.data.blocked_calls ?? 0 })}` : ''}
        </Badge>
        <button className="btn small secondary" onClick={async () => (await act(() => api.del(`/api/blocked-contacts/${contactId}`), t('Blockierung aufgehoben'))) && (st.reload(), onChanged())}>
          {t('Entsperren')}
        </button>
      </span>
    );
  return (
    <>
      <button className="btn small secondary" data-tour="inbox-spam" onClick={() => setOpen(true)} title={t('Als Spam markieren und Absender blockieren')}>
        <Icon name="shield" size={14} /> {t('Spam')}
      </button>
      {open && (
        <Modal
          title={t('Als Spam markieren & blockieren')}
          onClose={() => setOpen(false)}
          footer={
            <button
              className="btn danger"
              onClick={async () => {
                if (!(await act(() => api.post('/api/blocked-contacts', { contact_id: contactId, reason, note }), t('Absender blockiert')))) return;
                setOpen(false);
                st.reload();
                onChanged();
              }}
            >
              {t('Blockieren')}
            </button>
          }
        >
          <p style={{ marginTop: 0 }}>{t('Neue Nachrichten dieses Absenders werden still archiviert – ohne Benachrichtigung und ohne Workflow. Anrufe werden abgewiesen. Die Konversation verschwindet aus dem Posteingang (Filter „Spam“).')}</p>
          <Field label={t('Grund')}>
            <Select value={reason} onChange={setReason} options={REASONS.map(([k, l]) => [k, t(l)] as [string, string])} />
          </Field>
          <Field label={t('Notiz (optional)')}>
            <Textarea value={note} onChange={setNote} rows={2} maxLength={500} />
          </Field>
          <p className="muted small">{t('Rückgängig jederzeit mit „Entsperren“ in der Konversation.')}</p>
        </Modal>
      )}
    </>
  );
}
