import { useEffect, useState } from 'react';
import { api, dt } from '../api';
import { MoreFields } from '../areas/fields';
import { useT } from '../i18n';
import { Badge, CodeBox, Field, Input, Select, act, toast, useLoad } from '../ui';

/**
 * Vertrag → several signers with roles and a signing order (modules/contract-signers.ts, docs/sales.md#several-signers). In a draft
 * the list is edited here (Einfach-Modus: folded under "Mehrere Unterzeichner" unless signers are set); the normal "Senden" button
 * then starts the signing run. After sending, the panel shows each person's state, link and a reminder button. Slot "contract.signers".
 */

type Signer = { id?: string; position?: number; role: string; name: string; email: string; status?: string; signed_at?: string | null; signed_name?: string | null; url?: string };
const TONE: Record<string, 'gray' | 'green' | 'red' | 'blue' | 'yellow'> = { waiting: 'gray', invited: 'blue', viewed: 'yellow', signed: 'green', declined: 'red' };

export function ContractSignersPanel({ contract, onChanged }: { contract: any; onChanged?: () => void }) {
  const t = useT('parity');
  const data = useLoad(() => api.get<any>(`/api/contracts/${contract.id}/signers`), [contract.id, contract.status]);
  const [list, setList] = useState<Signer[]>([]);
  const [mode, setMode] = useState('sequential');
  useEffect(() => {
    if (!data.data) return;
    setList(data.data.signers.map((s: any) => ({ role: s.role, name: s.name, email: s.email })));
    setMode(data.data.mode ?? 'sequential');
  }, [data.data]);
  if (!data.data) return null;
  const d = data.data;
  const STATUS: Record<string, string> = { waiting: t('Wartet'), invited: t('Eingeladen'), viewed: t('Geöffnet'), signed: t('Unterschrieben'), declined: t('Abgelehnt') };

  if (contract.status !== 'draft') {
    if (!d.total) return null;
    return (
      <div className="card" style={{ flex: '1 1 260px' }}>
        <h2>
          {t('Unterzeichner')} <span className="muted">({d.signed}/{d.total})</span>
        </h2>
        <p className="muted" style={{ marginTop: 0 }}>{d.mode === 'parallel' ? t('Alle gleichzeitig') : t('Nacheinander in dieser Reihenfolge')}</p>
        {d.signers.map((s: any) => (
          <div key={s.id} style={{ borderTop: '1px solid var(--line)', padding: '8px 0' }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>
                {s.position}. {s.signed_name || s.name}
              </strong>
              <Badge tone={TONE[s.status]}>{STATUS[s.status] ?? s.status}</Badge>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              {[s.role, s.email, s.signed_at ? dt(s.signed_at) : ''].filter(Boolean).join(' · ')}
            </div>
            {['invited', 'viewed'].includes(s.status) && ['sent', 'viewed'].includes(contract.status) && (
              <div className="row" style={{ marginTop: 6, alignItems: 'center' }}>
                <CodeBox text={s.url} />
                <button
                  className="btn small secondary"
                  onClick={async () => {
                    const r = await act(() => api.post(`/api/contracts/${contract.id}/signers/${s.id}/remind`));
                    if (r) toast(r.message?.status === 'failed' ? `${t('Nicht gesendet')}: ${r.message.error}` : t('Erinnerung gesendet'));
                  }}
                >
                  {t('Erinnern')}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }

  const save = async (next: Signer[], nextMode = mode) => {
    const r = await act(() => api.put(`/api/contracts/${contract.id}/signers`, { mode: nextMode, signers: next.map(({ role, name, email }) => ({ role, name, email })) }), t('Gespeichert'));
    if (r) {
      data.reload();
      onChanged?.();
    }
  };
  const edit = (i: number, p: Partial<Signer>) => setList(list.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const move = (i: number, by: number) => {
    const next = [...list];
    const [x] = next.splice(i, 1);
    next.splice(i + by, 0, x);
    setList(next);
  };
  return (
    <div className="card" style={{ flex: '1 1 260px' }}>
      <MoreFields id="contract-signers" values={[d.total]} label={t('Mehrere Unterzeichner')} count={d.total || undefined}>
        <h2>{t('Unterzeichner')}</h2>
        <p className="muted" style={{ marginTop: 0 }}>{t('Leer = nur der Kontakt unterschreibt. Mit Liste bekommt jede Person beim Senden ihren eigenen Link.')}</p>
        {list.map((s, i) => (
          <fieldset key={i} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 8, marginBottom: 8 }}>
            <legend className="muted" style={{ fontSize: 12 }}>
              {i + 1}.
            </legend>
            <Field label={t('Rolle')}>
              <Input value={s.role} onChange={(x) => edit(i, { role: x })} placeholder={t('z. B. Kunde, Geschäftsführung')} />
            </Field>
            <Field label={t('Name')}>
              <Input value={s.name} onChange={(x) => edit(i, { name: x })} />
            </Field>
            <Field label={t('E-Mail')}>
              <Input type="email" value={s.email} onChange={(x) => edit(i, { email: x })} />
            </Field>
            <div className="row">
              <button className="btn small ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('Nach oben')}>
                ↑
              </button>
              <button className="btn small ghost" disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label={t('Nach unten')}>
                ↓
              </button>
              <button className="btn small ghost" onClick={() => setList(list.filter((_, j) => j !== i))}>
                {t('Entfernen')}
              </button>
            </div>
          </fieldset>
        ))}
        <div className="row" style={{ alignItems: 'center' }}>
          <button className="btn small secondary" disabled={list.length >= 10} onClick={() => setList([...list, { role: '', name: '', email: '' }])}>
            + {t('Unterzeichner')}
          </button>
          {list.length > 1 && (
            <Select
              aria={t('Reihenfolge')}
              value={mode}
              onChange={setMode}
              options={[
                ['sequential', t('Nacheinander')],
                ['parallel', t('Alle gleichzeitig')],
              ]}
            />
          )}
          <button className="btn small" onClick={() => save(list)}>
            {t('Speichern')}
          </button>
        </div>
      </MoreFields>
    </div>
  );
}
