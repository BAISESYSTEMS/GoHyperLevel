import { useState } from 'react';
import { api, dt } from '../api';
import { Badge, Check, Empty, Field, Input, Select, Spinner, act, confirmAsk, useLoad } from '../ui';
import { AdsModal, PlatformBadge, fromCents, toCents } from './AdsKit';
import { MoreFields } from '../areas/fields';

/** Regeln: "pause when the cost per lead is above X" – checked every 30 minutes; a rule can only pause or notify. */

const METRICS: [string, string, string][] = [
  ['cpl', 'Kosten pro Lead', '€'],
  ['cpc', 'Kosten pro Klick', '€'],
  ['ctr', 'Klickrate (CTR)', '%'],
  ['spend', 'Ausgaben', '€'],
  ['leads', 'Leads', 'Stück'],
];

export function AdsRules() {
  const { data, loading, reload } = useLoad(() => api.get<{ rules: any[]; log: any[] }>('/api/ads/rules'), []);
  const [edit, setEdit] = useState<any | null>(null);
  const [test, setTest] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  if (loading && !data) return <Spinner />;
  const rules = data?.rules ?? [];
  const probe = async () => {
    setBusy(true);
    const r = await act(() => api.post('/api/ads/rules/run', { dry_run: true, fresh: true }));
    setBusy(false);
    if (r) setTest(r);
  };
  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <div>
            <h2 style={{ margin: 0 }}>Regeln für laufende Kampagnen</h2>
            <p className="muted small" style={{ margin: '4px 0 0' }}>Beispiel: „Pausieren, wenn die Kosten pro Lead über 25 € liegen“. Geprüft alle 30 Minuten mit frischen Zahlen. Regeln können nur pausieren oder benachrichtigen – nie aktivieren oder Budget erhöhen.</p>
          </div>
          <div className="actions">
            <button className="btn secondary" disabled={busy || !rules.length} onClick={probe}>
              Probelauf
            </button>
            <button className="btn" data-tour="ads-rule-new" onClick={() => setEdit({})}>
              + Regel
            </button>
          </div>
        </div>
      </div>
      {test && (
        <div className="card">
          <strong>Probelauf:</strong> {test.checked} Kampagnen geprüft, {test.hits.length ? `${test.hits.length} würden auslösen:` : 'keine würde auslösen.'}
          <ul>
            {test.hits.map((h: any, i: number) => (
              <li key={i}>
                „{h.rule}“ bei <PlatformBadge platform={h.platform} /> {h.campaign} (Wert {h.value === null ? '–' : (h.value / 100).toLocaleString('de-DE', { maximumFractionDigits: 2 })}) → {h.action === 'pause' ? 'pausieren' : 'melden'}
              </li>
            ))}
          </ul>
          <small className="muted">Nichts wurde geändert.</small>
        </div>
      )}
      {rules.length === 0 ? (
        <Empty>Noch keine Regeln.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Regel</th>
                <th>Gilt für</th>
                <th>Ausgelöst</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>{r.name}</strong> {!r.enabled && <Badge>aus</Badge>}
                    <div className="muted small">{r.text}</div>
                  </td>
                  <td className="muted">{r.campaign_ref ? 'eine Kampagne' : 'alle aktiven'} · {r.platform === 'all' ? 'Meta & Google' : r.platform === 'meta' ? 'Meta' : 'Google'}</td>
                  <td className="muted">{r.times_triggered ? `${r.times_triggered}× · zuletzt ${dt(r.last_triggered_at)}` : '–'}</td>
                  <td className="ads-actions">
                    <button className="btn small secondary" onClick={async () => (await act(() => api.patch(`/api/ads/rules/${r.id}`, { enabled: !r.enabled })), reload())}>
                      {r.enabled ? 'Ausschalten' : 'Einschalten'}
                    </button>
                    <button className="btn small secondary" onClick={() => setEdit(r)}>
                      Ändern
                    </button>
                    <button className="btn small ghost" onClick={async () => confirmAsk(`Regel „${r.name}“ löschen?`) && (await act(() => api.del(`/api/ads/rules/${r.id}`), 'Gelöscht'), reload())}>
                      Löschen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(data?.log ?? []).length > 0 && (
        <div className="card">
          <h2>Verlauf</h2>
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Zeit</th>
                  <th>Regel</th>
                  <th>Kampagne</th>
                  <th>Ergebnis</th>
                </tr>
              </thead>
              <tbody>
                {data!.log.slice(0, 20).map((l) => (
                  <tr key={l.id}>
                    <td className="muted">{dt(l.created_at)}</td>
                    <td>{l.rule_name}</td>
                    <td>
                      <PlatformBadge platform={l.platform} /> {l.campaign_name || l.campaign_id}
                    </td>
                    <td>{l.result}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {edit && <RuleModal rule={edit} onClose={() => setEdit(null)} onDone={() => (setEdit(null), reload())} />}
    </>
  );
}

function RuleModal({ rule, onClose, onDone }: { rule: any; onClose: () => void; onDone: () => void }) {
  const money = (m: string) => ['cpl', 'cpc', 'spend'].includes(m);
  const [f, setF] = useState({
    name: rule.name ?? '',
    platform: rule.platform ?? 'all',
    metric: rule.metric ?? 'cpl',
    op: rule.op ?? '>',
    value: rule.id ? (money(rule.metric) ? fromCents(rule.value) : String(rule.value)) : '',
    window_days: String(rule.window_days ?? 3),
    min_spend: fromCents(rule.min_spend_cents),
    action: rule.action ?? 'pause',
    enabled: rule.enabled !== false,
  });
  const set = (k: keyof typeof f, v: any) => setF({ ...f, [k]: v });
  const unit = METRICS.find((m) => m[0] === f.metric)![2];
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const body = { name: f.name, platform: f.platform, metric: f.metric, op: f.op, value: money(f.metric) ? toCents(f.value) : Number(String(f.value).replace(',', '.')), window_days: Number(f.window_days), min_spend_cents: toCents(f.min_spend), action: f.action, enabled: f.enabled };
    const r = await act(() => (rule.id ? api.patch(`/api/ads/rules/${rule.id}`, body) : api.post('/api/ads/rules', body)), 'Gespeichert');
    setBusy(false);
    if (r) onDone();
  };
  return (
    <AdsModal
      title={rule.id ? 'Regel ändern' : 'Neue Regel'}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" disabled={busy || f.value === ''} onClick={save}>
            Speichern
          </button>
        </>
      }
    >
      <div className="grid3">
        <Field label="Wenn">
          <Select value={f.metric} onChange={(v) => set('metric', v)} options={METRICS.map(([k, l]) => [k, l] as [string, string])} />
        </Field>
        <Field label="ist">
          <Select value={f.op} onChange={(v) => set('op', v)} options={[['>', 'größer als'], ['<', 'kleiner als']]} />
        </Field>
        <Field label={`Wert (${unit})`}>
          <Input inputMode="decimal" value={f.value} onChange={(v) => set('value', v)} />
        </Field>
      </div>
      <div className="grid2">
        <Field label="Dann">
          <Select value={f.action} onChange={(v) => set('action', v)} options={[['pause', 'Kampagne pausieren'], ['notify', 'Nur melden (Protokoll, Ereignis)']]} />
        </Field>
        <Field label="Für">
          <Select value={f.platform} onChange={(v) => set('platform', v)} options={[['all', 'alle aktiven Kampagnen (Meta & Google)'], ['meta', 'alle aktiven Meta-Kampagnen'], ['google', 'alle aktiven Google-Kampagnen']]} />
        </Field>
      </div>
      <Check checked={f.enabled} onChange={(v) => set('enabled', v)} label="Regel ist eingeschaltet" />
      {/* Einfach-Modus: name, time window and minimum spend keep their defaults behind one toggle */}
      <MoreFields id="ads-rule" values={[f.name, f.window_days !== '3' && f.window_days, f.min_spend && Number(String(f.min_spend).replace(',', '.')) > 0]}>
        <Field label="Name (optional)">
          <Input value={f.name} onChange={(v) => set('name', v)} placeholder="z. B. CPL über 25 € pausieren" />
        </Field>
        <div className="grid2">
          <Field label="Zeitraum (Tage)" hint="Die letzten 1–30 Tage">
            <Input inputMode="numeric" value={f.window_days} onChange={(v) => set('window_days', v)} />
          </Field>
          <Field label="Erst ab Ausgaben (€)" hint="Verhindert Entscheidungen auf zu wenig Daten">
            <Input inputMode="decimal" value={f.min_spend} onChange={(v) => set('min_spend', v)} placeholder="0" />
          </Field>
        </div>
      </MoreFields>
      {f.metric === 'cpl' && <p className="muted small">Leads zählen aus dem CRM (Attribution), sonst laut Plattform. Ohne Lead gelten die bisherigen Ausgaben als Kosten – „über 25 €“ greift also auch bei 25 € ohne Lead.</p>}
    </AdsModal>
  );
}
