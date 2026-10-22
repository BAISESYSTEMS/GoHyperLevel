import { useEffect, useState } from 'react';
import { api, name } from '../api';
import { MoreFields } from '../areas/fields';
import { useT } from '../i18n';
import { Check, Field, Input, Link, Select, act, useLoad } from '../ui';

/**
 * Umsatz → Gutscheine → Treuepunkte (modules/loyalty.ts, docs/store.md#loyalty-points): switch the programme on, points per euro,
 * tiers and rewards (folded in Einfach-Modus), and the contacts with the most points. Slot "giftcards.panel".
 */

type Tier = { name: string; min_points: number };
type Reward = { id?: string; name: string; points: number; kind: 'coupon' | 'gift_card'; product_id?: string; coupon_kind?: 'percent' | 'amount'; value: number };

export function LoyaltyPanel() {
  const t = useT('parity');
  const data = useLoad(() => api.get<any>('/api/loyalty/settings').catch(() => null), []);
  const members = useLoad(() => api.get<any[]>('/api/loyalty/members').catch(() => []), []);
  const products = useLoad(() => api.get<any[]>('/api/products').catch(() => []), []);
  const [s, setS] = useState<any>(null);
  useEffect(() => setS(data.data), [data.data]);
  if (!s) return null;
  const save = async () => {
    const r = await act(() => api.put('/api/loyalty/settings', s), t('Gespeichert'));
    if (r) setS(r);
  };
  const tiers: Tier[] = s.tiers ?? [];
  const rewards: Reward[] = s.rewards ?? [];
  const setTier = (i: number, p: Partial<Tier>) => setS({ ...s, tiers: tiers.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const setReward = (i: number, p: Partial<Reward>) => setS({ ...s, rewards: rewards.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const oneOff = (products.data ?? []).filter((p: any) => !p.recurring);
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>{t('Treuepunkte')}</h2>
      <p className="muted" style={{ marginTop: 0 }}>{t('Kunden sammeln mit jeder bezahlten Rechnung Punkte und tauschen sie gegen Rabattcodes oder Gutscheine.')}</p>
      <Check checked={!!s.enabled} onChange={(x) => setS({ ...s, enabled: x })} label={t('Treueprogramm eingeschaltet')} />
      <Field label={t('Punkte je Euro')}>
        <Input type="number" min={0.01} step={0.5} value={s.points_per_euro} onChange={(x) => setS({ ...s, points_per_euro: Number(x) })} />
      </Field>
      <MoreFields id="loyalty-more" values={[rewards.length]} label={t('Stufen und Prämien')} count={rewards.length || undefined}>
        <h3>{t('Stufen')}</h3>
        {tiers.map((x, i) => (
          <div key={i} className="row" style={{ alignItems: 'flex-end' }}>
            <Field label={t('Name')}>
              <Input value={x.name} onChange={(v) => setTier(i, { name: v })} />
            </Field>
            <Field label={t('ab Punkten (gesamt)')}>
              <Input type="number" min={0} value={x.min_points} onChange={(v) => setTier(i, { min_points: Number(v) })} />
            </Field>
            <button className="btn small ghost" onClick={() => setS({ ...s, tiers: tiers.filter((_, j) => j !== i) })}>
              {t('Entfernen')}
            </button>
          </div>
        ))}
        <button className="btn small secondary" disabled={tiers.length >= 10} onClick={() => setS({ ...s, tiers: [...tiers, { name: '', min_points: 0 }] })}>
          + {t('Stufe')}
        </button>
        <h3>{t('Prämien')}</h3>
        {rewards.map((r, i) => (
          <fieldset key={r.id ?? i} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 8, marginBottom: 8 }}>
            <div className="row">
              <Field label={t('Name')}>
                <Input value={r.name} onChange={(v) => setReward(i, { name: v })} />
              </Field>
              <Field label={t('Punkte')}>
                <Input type="number" min={1} value={r.points} onChange={(v) => setReward(i, { points: Number(v) })} />
              </Field>
              <Field label={t('Art')}>
                <Select
                  value={r.kind}
                  onChange={(v) => setReward(i, { kind: v as Reward['kind'] })}
                  options={[
                    ['coupon', t('Einmal-Rabattcode')],
                    ['gift_card', t('Gutschein')],
                  ]}
                />
              </Field>
            </div>
            <div className="row">
              {r.kind === 'coupon' && (
                <>
                  <Field label={t('Produkt')}>
                    <Select value={r.product_id ?? ''} onChange={(v) => setReward(i, { product_id: v })} options={oneOff.map((p: any) => [p.id, p.name] as [string, string])} placeholder={t('Produkt wählen')} />
                  </Field>
                  <Field label={t('Rabatt')}>
                    <Select
                      value={r.coupon_kind ?? 'percent'}
                      onChange={(v) => setReward(i, { coupon_kind: v as 'percent' | 'amount' })}
                      options={[
                        ['percent', t('Prozent')],
                        ['amount', t('Betrag (Cent)')],
                      ]}
                    />
                  </Field>
                </>
              )}
              <Field label={r.kind === 'gift_card' || r.coupon_kind === 'amount' ? t('Wert in Cent') : t('Prozent')}>
                <Input type="number" min={1} value={r.value} onChange={(v) => setReward(i, { value: Number(v) })} />
              </Field>
              <button className="btn small ghost" onClick={() => setS({ ...s, rewards: rewards.filter((_, j) => j !== i) })}>
                {t('Entfernen')}
              </button>
            </div>
          </fieldset>
        ))}
        <button className="btn small secondary" disabled={rewards.length >= 20} onClick={() => setS({ ...s, rewards: [...rewards, { name: '', points: 100, kind: 'gift_card', value: 500 }] })}>
          + {t('Prämie')}
        </button>
      </MoreFields>
      <p>
        <button className="btn" onClick={save}>
          {t('Speichern')}
        </button>
      </p>
      {!!members.data?.length && (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>{t('Kontakt')}</th>
                <th>{t('Stufe')}</th>
                <th className="num">{t('Stand')}</th>
                <th className="num">{t('Gesamt')}</th>
              </tr>
            </thead>
            <tbody>
              {members.data.slice(0, 20).map((m: any) => (
                <tr key={m.contact_id}>
                  <td>
                    <Link to={`contacts/${m.contact_id}`}>{name(m)}</Link>
                  </td>
                  <td>{m.tier ?? '–'}</td>
                  <td className="num">{m.balance}</td>
                  <td className="num">{m.lifetime}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
