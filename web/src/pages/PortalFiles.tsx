import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from '../api';
import { MoreFields } from '../areas/fields';
import { Icon } from '../icons';
import { useT } from '../i18n';
import { act, Check, Field, Input, Spinner, useLoad } from '../ui';

/**
 * Files in the customer portal (modules/portal-files.ts): the "Im Portal freigeben" toggle on each document chip of a contact
 * (slot "contact.document") and the upload rules under Kurse → Mitgliederbereich (slot "portal.settings").
 */

interface PortalFile {
  doc_id: string;
  source: 'team' | 'customer';
  shared: boolean;
  downloads: number;
}
interface Shares {
  files: PortalFile[];
  portal_url: string;
  uploads: boolean;
}

const store = new Map<string, { data: Shares | null; loading: boolean; subs: Set<() => void> }>();
const entry = (contactId: string) => {
  let e = store.get(contactId);
  if (!e) store.set(contactId, (e = { data: null, loading: false, subs: new Set() }));
  return e;
};
const publish = (contactId: string, data: Shares) => {
  const e = entry(contactId);
  e.data = data;
  e.subs.forEach((f) => f());
};
function useShares(contactId: string): Shares | null {
  const e = entry(contactId);
  const data = useSyncExternalStore(
    (f) => (e.subs.add(f), () => void e.subs.delete(f)),
    () => e.data,
  );
  useEffect(() => {
    if (e.data || e.loading) return;
    e.loading = true;
    void api
      .get<Shares>(`/api/contacts/${encodeURIComponent(contactId)}/portal-files`)
      .then((d) => publish(contactId, d))
      .catch(() => undefined)
      .finally(() => (e.loading = false));
  }, [contactId]);
  return data;
}

/** The share toggle on one document chip; "vom Kunden" marks a file the customer sent through the portal. */
export function PortalShareToggle({ doc }: { doc: { id: string; contact_id: string; private: boolean; name: string } }) {
  const t = useT('portalfiles');
  const shares = useShares(doc.contact_id);
  if (doc.private || !shares) return null;
  const f = shares.files.find((x) => x.doc_id === doc.id);
  const on = !!f?.shared;
  const toggle = async () => {
    const r = await act(() => api.put<Shares>(`/api/contacts/${encodeURIComponent(doc.contact_id)}/documents/${doc.id}/portal`, { shared: !on }), on ? t('Freigabe zurückgezogen') : t('Im Portal freigegeben'));
    if (r) publish(doc.contact_id, r);
  };
  const label = on ? t('„{name}“ ist im Portal freigegeben – Freigabe zurückziehen', { name: doc.name }) : t('„{name}“ im Portal freigeben', { name: doc.name });
  return (
    <>
      {f?.source === 'customer' && <span className="muted small">{t('vom Kunden')}</span>}
      <button type="button" className={`icon-btn${on ? ' active' : ''}`} aria-pressed={on} aria-label={label} title={on ? t('Im Portal freigegeben') + (f?.downloads ? ` · ${t.plural(f.downloads, { one: '{n}× geladen', other: '{n}× geladen' })}` : '') : t('Im Portal freigeben')} onClick={() => void toggle()} style={on ? { color: 'var(--brand-text)' } : undefined}>
        <Icon name={on ? 'link' : 'unlink'} size={12} />
      </button>
    </>
  );
}

/** Kurse → Mitgliederbereich: may customers send files, and within which limits. */
export function PortalFilesSettings() {
  const t = useT('portalfiles');
  const loaded = useLoad(() => api.get<any>('/api/portal-files/settings'), []);
  const [s, setS] = useState<any>(null);
  useEffect(() => {
    if (loaded.data) setS(loaded.data);
  }, [loaded.data]);
  if (!s) return <Spinner />;
  const cats: [string, string][] = [
    ['pdf', t('PDF')],
    ['images', t('Bilder')],
    ['office', t('Office-Dateien')],
    ['text', t('Text/CSV')],
  ];
  const save = async (patch: any) => {
    const next = { ...s, ...patch };
    setS(next);
    const r = await act(() => api.put('/api/portal-files/settings', next), t('Gespeichert'));
    if (r) setS(r);
  };
  const changed = s.max_mb !== 8 || s.quota_mb !== 50 || s.types.length !== 4 || !s.notify;
  return (
    <div className="card" data-tour="portal-files-settings" style={{ gridColumn: '1 / -1' }}>
      <h2>
        <Icon name="file" size={18} /> {t('Dateien im Portal')}
      </h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t('Dokumente gibst du am Kontakt frei (Notizen → Dateien). Jeder Kunde sieht nur seine eigenen.')}
      </p>
      <Check checked={s.uploads} onChange={(v) => void save({ uploads: v })} label={t('Kunden dürfen Dateien hochladen')} />
      {s.uploads && (
        <MoreFields id="portal-files-limits" values={[changed ? '1' : '']} label={t('Grenzen')}>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <Field label={t('Höchstens MB je Datei')}>
              <Input type="number" min={1} max={s.max_file_mb} value={s.max_mb} onChange={(v) => setS({ ...s, max_mb: Number(v) })} onBlur={() => void save({})} />
            </Field>
            <Field label={t('Speicher je Kunde (MB)')}>
              <Input type="number" min={1} max={2048} value={s.quota_mb} onChange={(v) => setS({ ...s, quota_mb: Number(v) })} onBlur={() => void save({})} />
            </Field>
          </div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {cats.map(([k, l]) => (
              <Check key={k} checked={s.types.includes(k)} onChange={(v) => void save({ types: v ? [...s.types, k] : s.types.filter((x: string) => x !== k) })} label={l} />
            ))}
          </div>
          <Check checked={s.notify} onChange={(v) => void save({ notify: v })} label={t('Zuständige Person benachrichtigen')} />
        </MoreFields>
      )}
    </div>
  );
}
