import { useState } from 'react';
import { api, dt } from '../api';
import { Badge, Check, Field, Input, Select, Spinner, Textarea, act, confirmAsk, navigate, toast, useLoad } from '../ui';
import { Kpi, de, hourLabel } from './MarketingKit';
import './marketing.css';
import { useT } from '../i18n';
import { SortableGrid } from '../sortable/Sortable';

/** Deliverability tools: list hygiene (soft bounces, sunset), address checks and the settings of both. */

export function HygieneBox() {
  const t = useT('campaigns');
  const h = useLoad(() => api.get('/api/deliverability/hygiene'), []);
  const [months, setMonths] = useState('');
  const [tag, setTag] = useState(false);
  if (!h.data) return <div className="card mk-card">{h.error ? <p className="muted">{h.error}</p> : <Spinner />}</div>;
  const d = h.data;
  const m = months || String(d.sunset_months);
  const suppress = async (ids?: string[]) => {
    const r = await act(() => api.post('/api/deliverability/hygiene/suppress', ids ? { contact_ids: ids } : {}), t('Auf „Nicht stören“ gesetzt'));
    if (r) h.reload();
  };
  const sunset = async () => {
    const r = await act(() => api.post('/api/deliverability/hygiene/sunset', { months: Number(m), ...(tag ? { tag: 'inaktiv' } : {}) }));
    if (r) {
      toast(r.tagged ? t('Sunset-Segment: {n} Kontakte, {tagged} markiert', { n: de(r.count), tagged: de(r.tagged) }) : t('Sunset-Segment: {n} Kontakte', { n: de(r.count) }));
      h.reload();
    }
  };
  return (
    <div className="card mk-card" data-tour="mk-hygiene">
      <h2>{t('Listenhygiene')}</h2>
      <p className="muted small mk-lead">{t('Adressen, die dauernd nicht ankommen oder nie gelesen werden, kosten Reputation. Sie früh auszusortieren schützt die Zustellung der anderen.')}</p>

      <h3 style={{ margin: '8px 0 4px' }}>{t('Wiederholte Soft Bounces')}</h3>
      <p className="muted small" style={{ margin: '0 0 6px' }}>
        {t('Ein Soft Bounce ist ein vorübergehender Zustellfehler (Postfach voll, Server nicht erreichbar).')}{' '}
        {d.auto_suppress
          ? t('Ab {n} Fehlern in Folge wird die Adresse auf „Nicht stören“ gesetzt – das passiert automatisch jede Stunde.', { n: d.soft_bounce_limit })
          : t('Ab {n} Fehlern in Folge wird die Adresse auf „Nicht stören“ gesetzt – automatisch ist ausgeschaltet, du entscheidest hier.', { n: d.soft_bounce_limit })}
      </p>
      {d.suspect_count > 0 ? (
        <>
          <div className="mk-table-wrap">
            <table className="t">
              <tbody>
                {d.suspects.map((s: any) => (
                  <tr key={s.contact_id}>
                    <td>
                      <strong>{s.name || s.email}</strong>
                      <div className="muted small">{s.email}</div>
                    </td>
                    <td>{t.plural(s.count, { other: '{n} Fehler' })}</td>
                    <td className="muted">{dt(s.last_at)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn small secondary" style={{ minHeight: 44 }} onClick={() => suppress([s.contact_id])}>
                        {t('Ausschließen')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn" style={{ marginTop: 8 }} onClick={() => confirmAsk(t.plural(d.suspect_count, { other: '{n} Adressen auf „Nicht stören“ setzen?' })) && suppress()}>
            {t('Alle {n} ausschließen', { n: d.suspect_count })}
          </button>
        </>
      ) : (
        <p className="mk-note ok">{t('Keine Adresse mit wiederholten Zustellfehlern.')}</p>
      )}
      <p className="muted small">{t('Insgesamt {n} Kontakte haben „Nicht stören“ und bekommen keine Kampagnen.', { n: de(d.dnd) })}</p>

      <h3 style={{ margin: '14px 0 4px' }}>{t('Inaktive Kontakte (Sunset)')}</h3>
      <p className="muted small" style={{ margin: '0 0 6px' }}>
        {t('Wer seit Monaten Mails bekommt, aber nie öffnet oder klickt, belastet die Statistik. Das Sunset-Segment sammelt diese Kontakte. Schreibe ihnen zuerst eine Reaktivierungs-Mail und nimm danach die auf, die nicht reagieren.')}
      </p>
      <div className="mk-check-row">
        <div>
          <Field label={t('Monate ohne Öffnung oder Klick')}>
            <Input type="number" min={1} max={36} value={m} onChange={setMonths} style={{ width: 120 }} />
          </Field>
        </div>
        <Check checked={tag} onChange={setTag} label={t('Kontakte zusätzlich mit „inaktiv“ markieren')} />
        <button className="btn secondary" style={{ marginBottom: 12 }} onClick={sunset} data-tour="mk-sunset">
          {d.sunset_segment ? t('Segment aktualisieren') : t('Segment anlegen')}
        </button>
      </div>
      {d.sunset_segment && (
        <p className="small">
          <Badge tone="blue">{t('Segment „Sunset“')}</Badge> {d.sunset_segment.count === null ? '' : `${t('{n} Kontakte', { n: de(d.sunset_segment.count) })} `}
          <a href="#" onClick={(e) => (e.preventDefault(), navigate('campaigns/segments'))}>
            {t('In den Segmenten ansehen')}
          </a>
        </p>
      )}
    </div>
  );
}

// the labels come from the server (verdict_label); these are for reading the code
const VERDICT: Record<string, ['green' | 'yellow' | 'red', string]> = { ok: ['green', 'in Ordnung'], risky: ['yellow', 'riskant'], invalid: ['red', 'ungültig'] };

export function AddressCheck() {
  const t = useT('campaigns');
  const sum = useLoad(() => api.get('/api/email-validation/summary'), []);
  const [text, setText] = useState('');
  const [res, setRes] = useState<any[] | null>(null);
  const [which, setWhich] = useState<'invalid' | 'risky'>('invalid');
  const issues = useLoad(() => api.get<any[]>(`/api/email-validation/issues?verdict=${which}`), [which]);
  const [busy, setBusy] = useState(false);
  const s = sum.data;
  const check = async () => {
    const emails = text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    if (!emails.length) return;
    setBusy(true);
    const r = await act(() => api.post('/api/email-validation/check', { emails }));
    setBusy(false);
    if (r) setRes(r.results);
  };
  const scan = async () => {
    setBusy(true);
    const r = await act(() => api.post('/api/email-validation/scan', {}), t('Adressen geprüft'));
    setBusy(false);
    if (r) {
      sum.reload();
      issues.reload();
    }
  };
  const tagThem = async (verdict: 'invalid' | 'risky') => {
    const r = await act(() => api.post('/api/email-validation/tag', { verdict }));
    if (r) toast(t('{n} Kontakte mit „{tag}“ markiert', { n: de(r.tagged), tag: r.tag }));
  };
  return (
    <div className="card mk-card" data-tour="mk-validate">
      <h2>{t('Adressprüfung')}</h2>
      <p className="muted small mk-lead">{t('Prüft Schreibweise, ob die Domain Mails empfangen kann (MX), Wegwerf-Adressen und Funktionsadressen wie info@. Neue Kontakte werden im Hintergrund geprüft; Kampagnen lassen ungültige Adressen aus.')}</p>
      {s ? (
        <SortableGrid id="deliverability.hygiene" className="mk-kpis">
          <Kpi label={t('Geprüft')} value={`${de(s.checked)} / ${de(s.total)}`} />
          <Kpi label={t('In Ordnung')} value={de(s.ok)} tone="ok" />
          <Kpi label={t('Riskant')} value={de(s.risky)} tone={s.risky ? 'warn' : ''} sub={t('Wegwerf {disposable} · Funktion {role}', { disposable: de(s.disposable), role: de(s.role) })} />
          <Kpi label={t('Ungültig')} value={de(s.invalid)} tone={s.invalid ? 'critical' : ''} />
          <Kpi label={t('Noch offen')} value={de(s.unchecked)} />
        </SortableGrid>
      ) : (
        <Spinner />
      )}
      <div className="mk-actions">
        <button className="btn secondary" disabled={busy} onClick={scan}>
          {t('Nächste Adressen jetzt prüfen')}
        </button>
        <button className="btn secondary" disabled={!s?.invalid} onClick={() => tagThem('invalid')}>
          {t('Ungültige markieren')}
        </button>
        <button className="btn secondary" disabled={!s?.risky && !s?.invalid} onClick={() => tagThem('risky')}>
          {t('Ungültige und riskante markieren')}
        </button>
      </div>
      <div className="mk-sub" role="group" aria-label={t('Liste wählen')} style={{ marginTop: 10 }}>
        <button type="button" className={which === 'invalid' ? 'on' : ''} onClick={() => setWhich('invalid')}>
          {t('Ungültige Adressen')}
        </button>
        <button type="button" className={which === 'risky' ? 'on' : ''} onClick={() => setWhich('risky')}>
          {t('Riskante Adressen')}
        </button>
      </div>
      {issues.data?.length ? (
        <div className="mk-table-wrap">
          <table className="t">
            <tbody>
              {issues.data.slice(0, 25).map((r: any) => (
                <tr key={r.contact_id}>
                  <td>
                    <a href={`/contacts/${r.contact_id}`} onClick={(e) => (e.preventDefault(), navigate(`contacts/${r.contact_id}`))}>
                      {[r.first_name, r.last_name].filter(Boolean).join(' ') || r.email}
                    </a>
                    <div className="muted small">{r.email}</div>
                  </td>
                  <td className="small">{(r.issues ?? []).map((i: any) => i.text).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted small">{which === 'invalid' ? t('Keine ungültigen Adressen gefunden.') : t('Keine riskanten Adressen gefunden.')}</p>
      )}

      <h3 style={{ margin: '14px 0 4px' }}>{t('Adressen von Hand prüfen')}</h3>
      <div className="mk-check-row">
        <div className="grow">
          <Field label={t('Eine oder mehrere Adressen (bis 200, durch Zeilenumbruch oder Komma getrennt)')}>
            <Textarea value={text} onChange={setText} rows={3} placeholder={t('max@beispiel.de')} />
          </Field>
        </div>
        <button className="btn" style={{ marginBottom: 12 }} disabled={busy || !text.trim()} onClick={check} data-tour="mk-validate-run">
          {t('Prüfen')}
        </button>
      </div>
      {res && (
        <div className="mk-verdicts" aria-live="polite">
          {res.map((r, i) => (
            <div key={i} className={`mk-verdict ${r.verdict}`}>
              <div>
                <strong>{r.email}</strong> <Badge tone={(VERDICT[r.verdict] ?? VERDICT.ok)[0]}>{r.verdict_label}</Badge>
              </div>
              {r.issues.map((x: any, j: number) => (
                <div key={j} className="small muted">
                  {x.text}
                </div>
              ))}
              {r.suggestion && <div className="small">{t('Meintest du')} <strong>{r.suggestion}</strong>?</div>}
              {r.mx === null && r.verdict !== 'invalid' && <div className="small muted">{t('Die Domain wurde nicht in DNS nachgeschlagen.')}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SettingsBox() {
  const t = useT('campaigns');
  const st = useLoad(() => api.get('/api/deliverability/settings'), []);
  const [draft, setDraft] = useState<any>(null);
  const cur = draft ?? st.data;
  if (!cur) return <div className="card mk-card">{st.error ? <p className="muted">{st.error}</p> : <Spinner />}</div>;
  const set = (group: string, patch: Record<string, any>) => setDraft({ ...cur, [group]: { ...cur[group], ...patch } });
  const save = async () => {
    const r = await act(() => api.put('/api/deliverability/settings', cur), t('Einstellungen gespeichert'));
    if (r) {
      setDraft(null);
      st.reload();
    }
  };
  const num = (v: string, min: number, max: number, def: number) => Math.min(max, Math.max(min, Math.round(Number(v)) || def));
  return (
    <div className="card mk-card" data-tour="mk-settings">
      <h2>{t('Einstellungen')}</h2>
      <div className="grid2">
        <div>
          <h3 style={{ margin: '4px 0' }}>{t('Hygiene')}</h3>
          <Field label={t('Soft Bounces bis zum Ausschluss (2–10)')}>
            <Input type="number" min={2} max={10} value={cur.hygiene.soft_bounce_limit} onChange={(v) => set('hygiene', { soft_bounce_limit: num(v, 2, 10, 3) })} />
          </Field>
          <Check checked={cur.hygiene.auto_suppress} onChange={(v) => set('hygiene', { auto_suppress: v })} label={t('Automatisch auf „Nicht stören“ setzen (stündlich)')} />
          <Field label={t('Monate bis ein Kontakt als inaktiv gilt (1–36)')}>
            <Input type="number" min={1} max={36} value={cur.hygiene.sunset_months} onChange={(v) => set('hygiene', { sunset_months: num(v, 1, 36, 6) })} />
          </Field>
        </div>
        <div>
          <h3 style={{ margin: '4px 0' }}>{t('Adressprüfung')}</h3>
          <Check checked={cur.validation.auto} onChange={(v) => set('validation', { auto: v })} label={t('Neue Adressen im Hintergrund prüfen')} />
          <Check checked={cur.validation.mx} onChange={(v) => set('validation', { mx: v })} label={t('Domain per DNS nachschlagen (MX)')} />
          <Check checked={cur.validation.exclude_invalid} onChange={(v) => set('validation', { exclude_invalid: v })} label={t('Kampagnen lassen ungültige Adressen aus')} />
          <Check checked={cur.validation.exclude_disposable} onChange={(v) => set('validation', { exclude_disposable: v })} label={t('… auch Wegwerf-Adressen')} />
          <Check checked={cur.validation.exclude_role} onChange={(v) => set('validation', { exclude_role: v })} label={t('… auch Funktionsadressen (info@, support@ …)')} />
        </div>
      </div>
      <div className="grid2">
        <Field label={t('Standard-Sendestunde, wenn es noch keine Öffnungsdaten gibt')} hint={t('Für „zur besten Zeit je Kontakt“ in Kampagnen')}>
          <Select value={String(cur.sto.default_hour)} onChange={(v) => set('sto', { default_hour: Number(v) })} options={Array.from({ length: 24 }, (_, h) => [String(h), hourLabel(h)] as [string, string])} />
        </Field>
        <div>
          <Check checked={cur.abandoned.create_contacts} onChange={(v) => set('abandoned', { create_contacts: v })} label={t('Warenkorbabbruch: auch unbekannte E-Mail-Adressen als Kontakt anlegen')} />
          <p className="muted small" style={{ margin: 0 }}>{t('Aus: nur bekannte Kontakte werden erinnert.')}</p>
        </div>
      </div>
      <button className="btn" disabled={!draft} onClick={save}>
        {t('Speichern')}
      </button>
    </div>
  );
}
