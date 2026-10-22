import { useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { act, Select, toast, useLoad } from '../ui';

/** Contact list bulk bar: give the selected contacts one owner, or take it away (modules/contact-bulk-owner.ts). */
export function ContactBulkOwner({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const t = useT('crmgaps');
  const users = useLoad(() => api.get<{ id: string; name: string }[]>('/api/location-users').catch(() => []), []);
  const [owner, setOwner] = useState('');
  const assign = async () => {
    const r = await act(() => api.post<{ count: number }>('/api/contacts/bulk-owner', { ids, assigned_to: owner === '-' ? null : owner }));
    if (r) {
      toast(t.plural(r.count, { one: '{n} Kontakt neu zugewiesen', other: '{n} Kontakte neu zugewiesen' }));
      setOwner('');
      onDone();
    }
  };
  return (
    <>
      <div style={{ width: 180 }}>
        <Select value={owner} onChange={setOwner} placeholder={t('Zuständig setzen…')} aria={t('Zuständige Person für die Auswahl')} options={[...(users.data ?? []).map((u) => [u.id, u.name] as [string, string]), ['-', t('Ohne Zuständigen')]]} />
      </div>
      <button className="btn small secondary" disabled={!owner} onClick={assign}>
        {t('Zuweisen')}
      </button>
    </>
  );
}
