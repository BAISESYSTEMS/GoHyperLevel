import { useState } from 'react';
import { api, currentLocation, dt, money } from '../api';
import { useT } from '../i18n';
import { Copy, Empty, Link, Select, Spinner, Stat, useLoad } from '../ui';
import { SortableGrid } from '../sortable/Sortable';

/**
 * Online-Shop → Abgebrochen (modules/store-extras.ts, docs/store.md#abandoned-carts): carts with an e-mail address and no paid order,
 * their value and the link that restores the cart; the reminder itself is the workflow trigger checkout.abandoned. The batch link
 * prints the packing slips of every paid order that still has to go out.
 */
export function ShopAbandoned() {
  const t = useT('parity');
  const [days, setDays] = useState('30');
  const list = useLoad(() => api.get<any>(`/api/store/abandoned?days=${days}`), [days]);
  return (
    <>
      <div className="row shop-filter" style={{ alignItems: 'center' }}>
        <Select
          value={days}
          onChange={setDays}
          aria={t('Zeitraum')}
          options={[
            ['7', t('Letzte 7 Tage')],
            ['30', t('Letzte 30 Tage')],
            ['90', t('Letzte 90 Tage')],
          ]}
        />
        <a className="btn small secondary" href={`/api/store/packing-slips?open=1&locationId=${currentLocation()}`} target="_blank" rel="noreferrer">
          {t('Packzettel aller offenen Bestellungen')}
        </a>
      </div>
      {!list.data ? (
        <Spinner />
      ) : !list.data.count ? (
        <Empty>{t('Keine abgebrochenen Warenkörbe in diesem Zeitraum.')}</Empty>
      ) : (
        <>
          <SortableGrid id="shop-abandoned.stats" className="shop-stats">
            <Stat label={t('Abgebrochene Warenkörbe')} value={list.data.count} />
            <Stat label={t('Wert (netto)')} value={money(list.data.value_cents, list.data.currency)} />
          </SortableGrid>
          <div className="card shop-scroll">
            <table className="t">
              <thead>
                <tr>
                  <th>{t('Zuletzt')}</th>
                  <th>{t('Kontakt')}</th>
                  <th>{t('Artikel')}</th>
                  <th className="num">{t('Wert')}</th>
                  <th>{t('Erinnert')}</th>
                  <th>{t('Link zum Warenkorb')}</th>
                </tr>
              </thead>
              <tbody>
                {list.data.carts.map((c: any) => (
                  <tr key={c.id}>
                    <td className="muted">{dt(c.updated_at)}</td>
                    <td>{c.contact_id ? <Link to={`contacts/${c.contact_id}`}>{c.contact_name || c.email}</Link> : c.email}</td>
                    <td className="small">{c.items.map((i: any) => `${i.qty} × ${i.name}`).join(', ')}</td>
                    <td className="num">{money(c.value_cents, list.data.currency)}</td>
                    <td>{c.reminded ? t('Ja') : t('Nein')}</td>
                    <td>
                      <Copy text={c.recovery_url} label={t('Kopieren')} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
