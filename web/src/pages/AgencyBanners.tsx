import { useState } from 'react';
import { api, dt } from '../api';
import { useT } from '../i18n';
import { MoreFields } from '../areas/fields';
import { Badge, Check, Field, Input, Modal, Select, Textarea, act, confirmAsk, useLoad } from '../ui';

/**
 * Agentur-Ankündigungen (modules/agency-banners.ts, docs/saas.md#announcements): the agency's card under Agentur → Kunden
 * (slot "agency.clients") and the banner at the top of the app in the sub-accounts (slot "shell.banner").
 */

const TONE_STYLE: Record<string, { bg: string; line: string }> = {
  info: { bg: 'var(--c-info-soft, #eff6ff)', line: '#2563eb' },
  success: { bg: 'var(--c-success-soft, #ecfdf5)', line: '#047857' },
  warning: { bg: 'var(--c-warning-soft, #fffbeb)', line: '#b45309' },
};

/** The banners the agency shows in this sub-account (at most three, newest first). */
export function ShellBanners() {
  const t = useT('gaps');
  const list = useLoad(() => api.get<any[]>('/api/agency-banners/active').catch(() => []), []);
  const [hidden, setHidden] = useState<string[]>([]);
  const items = (list.data ?? []).filter((b) => !hidden.includes(b.id));
  if (!items.length) return null;
  return (
    <>
      {items.map((b) => {
        const s = TONE_STYLE[b.tone] ?? TONE_STYLE.info;
        return (
          <div key={b.id} role="status" className="row" style={{ alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 12px', margin: '0 0 12px', borderRadius: 8, background: s.bg, borderLeft: `4px solid ${s.line}`, color: 'var(--text)' }}>
            <div>
              <strong>{b.title}</strong>
              {b.message && <span> – {b.message}</span>}{' '}
              {b.link_url && (
                <a href={b.link_url} target={b.link_url.startsWith('/') ? undefined : '_blank'} rel="noreferrer">
                  {b.link_label || t('Mehr erfahren')}
                </a>
              )}
            </div>
            {b.dismissible && (
              <button className="icon-btn" aria-label={t('Ankündigung schließen')} onClick={() => (setHidden([...hidden, b.id]), api.post(`/api/agency-banners/${b.id}/dismiss`).catch(() => undefined))}>
                ✕
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}

const empty = { title: '', message: '', link_url: '', link_label: '', tone: 'info', location_ids: [] as string[], starts_at: '', ends_at: '', dismissible: true, active: true };
const toLocal = (iso?: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');

export function AgencyBannersCard() {
  const t = useT('gaps');
  const list = useLoad(() => api.get<any[]>('/api/agency/banners'), []);
  const locs = useLoad(() => api.get<any[]>('/api/locations').catch(() => []), []);
  const [edit, setEdit] = useState<(typeof empty & { id?: string }) | null>(null);
  const save = async () => {
    if (!edit) return;
    const body = { ...edit, starts_at: edit.starts_at ? new Date(edit.starts_at).toISOString() : null, ends_at: edit.ends_at ? new Date(edit.ends_at).toISOString() : null, location_ids: edit.location_ids.length ? edit.location_ids : null };
    const r = await act(() => (edit.id ? api.patch(`/api/agency/banners/${edit.id}`, body) : api.post('/api/agency/banners', body)), t('Gespeichert'));
    if (r) {
      setEdit(null);
      list.reload();
    }
  };
  const toneLabel: Record<string, string> = { info: t('Info'), success: t('Erfolg'), warning: t('Warnung') };
  return (
    <div className="card" data-tour="agency-banners">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>{t('Ankündigungen für Sub-Accounts')}</h2>
        <button className="btn small" onClick={() => setEdit({ ...empty })}>
          {t('+ Ankündigung')}
        </button>
      </div>
      <p className="muted small">{t('Ein Hinweis oben in der App deiner Kunden – z. B. Wartung, neue Funktion oder Webinar-Einladung.')}</p>
      {(list.data ?? []).length > 0 && (
        <table className="t">
          <tbody>
            {list.data!.map((b) => (
              <tr key={b.id}>
                <td>
                  <strong>{b.title}</strong> <Badge tone={b.tone === 'warning' ? 'yellow' : b.tone === 'success' ? 'green' : 'blue'}>{toneLabel[b.tone] ?? b.tone}</Badge>
                  {!b.active && <Badge>{t('aus')}</Badge>}
                  <div className="muted small">
                    {b.location_ids ? t.plural(b.location_ids.length, { one: '{n} Sub-Account', other: '{n} Sub-Accounts' }) : t('alle Sub-Accounts')}
                    {(b.starts_at || b.ends_at) && ` · ${b.starts_at ? dt(b.starts_at) : '…'} – ${b.ends_at ? dt(b.ends_at) : '…'}`}
                  </div>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <div className="actions" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn small secondary" onClick={() => setEdit({ ...empty, ...b, location_ids: b.location_ids ?? [], starts_at: toLocal(b.starts_at), ends_at: toLocal(b.ends_at), message: b.message ?? '', link_url: b.link_url ?? '', link_label: b.link_label ?? '' })}>
                      {t('Bearbeiten')}
                    </button>
                    <button className="btn small secondary" onClick={async () => confirmAsk(t('Ankündigung „{n}“ löschen?', { n: b.title })) && (await act(() => api.del(`/api/agency/banners/${b.id}`))) && list.reload()}>
                      {t('Löschen')}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && (
        <Modal
          title={edit.id ? t('Ankündigung bearbeiten') : t('Neue Ankündigung')}
          onClose={() => setEdit(null)}
          footer={
            <button className="btn" disabled={!edit.title.trim()} onClick={save}>
              {t('Speichern')}
            </button>
          }
        >
          <Field label={t('Titel')}>
            <Input value={edit.title} onChange={(v) => setEdit({ ...edit, title: v })} placeholder={t('z. B. Wartung heute ab 22 Uhr')} />
          </Field>
          <Field label={t('Text')}>
            <Textarea rows={2} value={edit.message} onChange={(v) => setEdit({ ...edit, message: v })} />
          </Field>
          <Field label={t('Art')}>
            <Select value={edit.tone} onChange={(v) => setEdit({ ...edit, tone: v })} options={Object.entries(toneLabel)} />
          </Field>
          <MoreFields id="agency-banner-more" values={[edit.link_url, edit.link_label, edit.starts_at, edit.ends_at, edit.location_ids.length ? 'x' : '', edit.dismissible ? '' : 'x', edit.active ? '' : 'x']}>
            <div className="grid2">
              <Field label={t('Link (https://…)')}>
                <Input value={edit.link_url} onChange={(v) => setEdit({ ...edit, link_url: v })} />
              </Field>
              <Field label={t('Link-Text')}>
                <Input value={edit.link_label} onChange={(v) => setEdit({ ...edit, link_label: v })} placeholder={t('Mehr erfahren')} />
              </Field>
              <Field label={t('Ab')}>
                <Input type="datetime-local" value={edit.starts_at} onChange={(v) => setEdit({ ...edit, starts_at: v })} />
              </Field>
              <Field label={t('Bis')}>
                <Input type="datetime-local" value={edit.ends_at} onChange={(v) => setEdit({ ...edit, ends_at: v })} />
              </Field>
            </div>
            <Field label={t('Nur für diese Sub-Accounts (leer = alle)')}>
              <div className="grid2">
                {(locs.data ?? []).map((l: any) => (
                  <Check key={l.id} checked={edit.location_ids.includes(l.id)} onChange={(on) => setEdit({ ...edit, location_ids: on ? [...edit.location_ids, l.id] : edit.location_ids.filter((x) => x !== l.id) })} label={l.name} />
                ))}
              </div>
            </Field>
            <Check checked={edit.dismissible} onChange={(v) => setEdit({ ...edit, dismissible: v })} label={t('Darf weggeklickt werden')} />
            <Check checked={edit.active} onChange={(v) => setEdit({ ...edit, active: v })} label={t('Aktiv')} />
          </MoreFields>
        </Modal>
      )}
    </div>
  );
}
