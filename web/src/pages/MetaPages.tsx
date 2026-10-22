import { useState } from 'react';
import { Icon } from '../icons';
import { api } from '../api';
import { useT } from '../i18n';
import { Badge, Field, Input, Modal, act, confirmAsk, useLoad } from '../ui';
import { ChannelIcon } from './MetaInbox';

/**
 * Einstellungen → Kanäle: every connected Facebook page with its Instagram account (modules/meta-channels.ts, table meta_pages).
 * Messages are routed by page ID, the inbox shows the page as a sub-channel and replies use that page's token. Slot "channels.meta".
 */

const EMPTY = { page_id: '', ig_account_id: '', page_token: '' };

export function MetaPagesCard() {
  const t = useT('metapages');
  const list = useLoad(() => api.get<any[]>('/api/settings/meta/pages').catch(() => null), []);
  const [edit, setEdit] = useState<null | { id?: string; f: typeof EMPTY }>(null);
  if (!list.data) return null;
  const save = async () => {
    if (!edit) return;
    const body: Record<string, string> = { ...edit.f };
    if (!body.page_token) delete body.page_token;
    const r = await act(() => (edit.id ? api.patch(`/api/settings/meta/pages/${edit.id}`, body) : api.post('/api/settings/meta/pages', body)), t('Gespeichert'));
    if (r) (setEdit(null), list.reload());
  };
  return (
    <div className="card" data-tour="meta-pages">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>
          <ChannelIcon channel="messenger" size={18} /> {t('Seiten und Instagram-Konten')}
        </h2>
        <button className="btn small" onClick={() => setEdit({ f: EMPTY })}>
          + {t('Weitere Seite')}
        </button>
      </div>
      <p className="muted small">{t('Mehrere Facebook-Seiten und Instagram-Konten in einem Sub-Account: Nachrichten werden über die Seiten-ID zugeordnet, der Posteingang zeigt die Seite an, Antworten gehen mit dem Token dieser Seite raus. „Verbindung testen“ oben liest die Namen.')}</p>
      {list.data.length ? (
        <table className="t">
          <thead>
            <tr>
              <th>{t('Seite')}</th>
              <th>Instagram</th>
              <th>{t('Token')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.map((p, i) => (
              <tr key={p.id}>
                <td>
                  {p.page_name || p.page_id || '–'} {i === 0 && <Badge tone="blue">{t('Standard')}</Badge>}
                  {p.page_name && <div className="muted small">{p.page_id}</div>}
                </td>
                <td>{p.ig_username ? `@${p.ig_username}` : p.ig_account_id || '–'}</td>
                <td>{p.token_set ? <Badge tone="green">{t('gespeichert')}</Badge> : <Badge tone="red">{t('fehlt')}</Badge>}</td>
                <td>
                  <div className="actions" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn small secondary" aria-label={t('Seite {name} bearbeiten', { name: p.page_name || p.page_id })} onClick={() => setEdit({ id: p.id, f: { page_id: p.page_id, ig_account_id: p.ig_account_id, page_token: '' } })}>
                      <Icon name="edit" size={14} />
                    </button>
                    <button
                      className="btn small secondary"
                      aria-label={t('Seite {name} entfernen', { name: p.page_name || p.page_id })}
                      onClick={async () => confirmAsk(t('Seite entfernen? Bisherige Nachrichten bleiben, Antworten an ihre Kontakte gehen nicht mehr.')) && (await act(() => api.del(`/api/settings/meta/pages/${p.id}`))) && list.reload()}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">{t('Noch keine Seite verbunden.')}</p>
      )}
      {edit && (
        <Modal
          title={edit.id ? t('Seite bearbeiten') : t('Weitere Seite verbinden')}
          onClose={() => setEdit(null)}
          footer={
            <button className="btn" onClick={save}>
              {t('Speichern')}
            </button>
          }
        >
          <Field label={t('Seiten-ID')}>
            <Input value={edit.f.page_id} onChange={(v) => setEdit({ ...edit, f: { ...edit.f, page_id: v } })} inputMode="numeric" placeholder="112233445566778" />
          </Field>
          <Field label={t('Instagram-Konto-ID (optional)')}>
            <Input value={edit.f.ig_account_id} onChange={(v) => setEdit({ ...edit, f: { ...edit.f, ig_account_id: v } })} inputMode="numeric" placeholder="17841400000000000" />
          </Field>
          <Field label={t('Seiten-Zugriffstoken')} hint={edit.id ? t('Leer lassen, um den gespeicherten Token zu behalten.') : t('Dauerhafter Token der Seite (System-Benutzer) mit pages_messaging, für Instagram zusätzlich instagram_manage_messages.')}>
            <Input type="password" autoComplete="new-password" value={edit.f.page_token} onChange={(v) => setEdit({ ...edit, f: { ...edit.f, page_token: v } })} placeholder="EAAG…" /> {/* i18n-ignore */}
          </Field>
        </Modal>
      )}
    </div>
  );
}
