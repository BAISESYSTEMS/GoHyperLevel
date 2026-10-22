import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../icons';
import { api, d, dt, name } from '../api';
import { Badge, Check, Empty, Field, Input, Link, PageHead, Select, Spinner, act, confirmAsk, useLoad } from '../ui';
import { useT } from '../i18n';

/** Lead-Scoring: rule editor, score card on the contact page, list column/filter and workflow filter. */

const OPS: [string, string][] = [
  ['equals', 'ist'],
  ['not_equals', 'ist nicht'],
  ['contains', 'enthält'],
  ['has', 'hat / enthält'],
  ['not_has', 'hat nicht'],
  ['empty', 'ist leer'],
  ['not_empty', 'ist nicht leer'],
  ['gt', 'größer als'],
  ['lt', 'kleiner als'],
];
const CONTACT_FIELDS: [string, string][] = [
  ['source', 'Quelle'],
  ['email', 'E-Mail'],
  ['phone', 'Telefon'],
  ['company', 'Firma (Text)'],
  ['website', 'Webseite'],
  ['city', 'Ort'],
  ['postal_code', 'PLZ'],
  ['country', 'Land'],
  ['first_name', 'Vorname'],
  ['last_name', 'Nachname'],
];
const COMPANY_FIELDS: [string, string][] = [
  ['company.industry', 'Firma: Branche'],
  ['company.size', 'Firma: Größe'],
  ['company.lifecycle_stage', 'Firma: Phase'],
  ['company.city', 'Firma: Ort'],
  ['company.country', 'Firma: Land'],
  ['company.domain', 'Firma: Domain'],
];
const ATTR_FIELDS: [string, string][] = [
  ['attribution.first_source', 'Erste Quelle (UTM)'],
  ['attribution.last_source', 'Letzte Quelle (UTM)'],
  ['attribution.first_medium', 'Erstes Medium'],
  ['attribution.last_medium', 'Letztes Medium'],
  ['attribution.first_campaign', 'Erste Kampagne'],
  ['attribution.last_campaign', 'Letzte Kampagne'],
  ['attribution.touches', 'Anzahl Besuche'],
];

const newId = () => Math.random().toString(36).slice(2, 10);

function useMeta() {
  return useLoad(() => api.get<any>('/api/lead-scoring/meta'), []);
}

function RuleRow({ r, fields, events, tags, onChange, onRemove }: { r: any; fields: [string, string][]; events: Record<string, string>; tags: string[]; onChange: (r: any) => void; onRemove: () => void }) {
  const pts = (
    <div className="ls-points">
      <Input type="number" value={r.points} onChange={(v) => onChange({ ...r, points: v === '' ? '' : Number(v) })} aria-label="Punkte" className={Number(r.points) < 0 ? 'neg' : 'pos'} />
      <span className="muted small">Pkt.</span>
    </div>
  );
  const del = (
    <button type="button" className="icon-btn" onClick={onRemove} aria-label="Kriterium entfernen">
      ✕
    </button>
  );
  if (r.kind === 'event')
    return (
      <div className="ls-rule">
        <Select value={r.event} onChange={(v) => onChange({ ...r, event: v })} aria="Ereignis" options={Object.entries(events)} />
        {pts}
        <span className="muted small">je Mal, höchstens</span>
        <Input type="number" value={r.max_points ?? ''} onChange={(v) => onChange({ ...r, max_points: v })} placeholder="∞" aria-label="Höchstpunkte" className="ls-small" />
        <span className="muted small">in</span>
        <Input type="number" value={r.within_days ?? ''} onChange={(v) => onChange({ ...r, within_days: v })} placeholder="allen" aria-label="Zeitraum in Tagen" className="ls-small" />
        <span className="muted small">Tagen</span>
        {del}
      </div>
    );
  const needsValue = !['empty', 'not_empty'].includes(r.op);
  return (
    <div className="ls-rule">
      <Select value={r.field} aria="Feld" onChange={(v) => onChange({ ...r, field: v, op: v === 'tag' ? 'has' : r.op === 'has' || r.op === 'not_has' ? 'equals' : r.op })} options={fields} />
      <Select value={r.op} onChange={(v) => onChange({ ...r, op: v })} aria="Bedingung" options={r.field === 'tag' ? OPS.filter(([k]) => k === 'has' || k === 'not_has') : OPS.filter(([k]) => k !== 'has' && k !== 'not_has')} />
      {needsValue &&
        (r.field === 'tag' ? (
          <Select value={r.value} onChange={(v) => onChange({ ...r, value: v })} placeholder="Tag wählen…" options={tags} />
        ) : (
          <Input value={r.value ?? ''} onChange={(v) => onChange({ ...r, value: v })} placeholder="Wert" aria-label="Wert" />
        ))}
      {pts}
      {del}
    </div>
  );
}

function ModelEditor({ model, meta, onSaved, onDeleted }: { model: any; meta: any; onSaved: (m: any) => void; onDeleted: () => void }) {
  const [m, setM] = useState<any>(model);
  useEffect(() => setM(model), [model.id, model.updated_at]);
  const fields: [string, string][] = [
    ...CONTACT_FIELDS,
    ...meta.custom_fields.map((f: any) => [`custom.${f.key}`, `Feld: ${f.label}`] as [string, string]),
    ['tag', 'Tag'],
    ...COMPANY_FIELDS,
    ...meta.company_properties.map((p: any) => [`company.custom.${p.key}`, `Firma: ${p.label}`] as [string, string]),
    ...ATTR_FIELDS,
  ];
  const rules: any[] = m.rules ?? [];
  const setRules = (next: any[]) => setM({ ...m, rules: next });
  const fit = rules.filter((r) => r.kind === 'property');
  const eng = rules.filter((r) => r.kind === 'event');
  const dirty = JSON.stringify({ ...m, stats: undefined }) !== JSON.stringify({ ...model, stats: undefined });
  const save = async () => {
    const r = await act(() => api.patch(`/api/lead-scoring/models/${m.id}`, { name: m.name, active: m.active, is_primary: m.is_primary, rules: m.rules, thresholds: m.thresholds, decay: m.decay, max_score: m.max_score }), 'Gespeichert und neu berechnet');
    if (r) onSaved(r);
  };
  const stats = model.stats ?? { scored: 0, average: 0, labels: {}, top: [] };
  const maxCount = Math.max(1, ...Object.values(stats.labels as Record<string, number>));
  return (
    <div className="row ls-layout">
      <div className="ls-main">
        <div className="card" data-tour="ls-model">
          <div className="row" style={{ alignItems: 'center' }}>
            <div className="grow">
              <Input value={m.name} onChange={(v) => setM({ ...m, name: v })} aria-label="Name des Modells" className="ls-name" />
            </div>
            <Check checked={m.active} onChange={(v) => setM({ ...m, active: v })} label="Aktiv" />
            <Check checked={m.is_primary} onChange={(v) => setM({ ...m, is_primary: v || model.is_primary })} label="Haupt-Score (Kontaktliste)" />
          </div>
          <h3 className="ls-h" data-tour="ls-fit">
            <Icon name="contact" /> Eigenschaften <span className="muted small">– passt der Kontakt?</span>
          </h3>
          {fit.map((r) => (
            <RuleRow key={r.id} r={r} fields={fields} events={meta.events} tags={meta.tags} onChange={(x) => setRules(rules.map((y) => (y.id === r.id ? x : y)))} onRemove={() => setRules(rules.filter((y) => y.id !== r.id))} />
          ))}
          <button className="btn small secondary" onClick={() => setRules([...rules, { id: newId(), kind: 'property', field: 'source', op: 'equals', value: '', points: 10 }])}>
            + Eigenschaft
          </button>
          <h3 className="ls-h" data-tour="ls-engagement">
            <Icon name="activity" /> Aktivität <span className="muted small">– wie engagiert ist er?</span>
          </h3>
          {eng.map((r) => (
            <RuleRow key={r.id} r={r} fields={fields} events={meta.events} tags={meta.tags} onChange={(x) => setRules(rules.map((y) => (y.id === r.id ? x : y)))} onRemove={() => setRules(rules.filter((y) => y.id !== r.id))} />
          ))}
          <button className="btn small secondary" onClick={() => setRules([...rules, { id: newId(), kind: 'event', event: 'email.opened', points: 2 }])}>
            + Aktivität
          </button>
          <p className="muted small">Negative Punkte ziehen ab (z. B. Freemail-Adresse, Wettbewerber-Domain). Der Score fällt nie unter 0.</p>
          <div className="actions" style={{ justifyContent: 'flex-end' }}>
            <button className="btn danger" onClick={async () => confirmAsk(`Modell „${model.name}“ löschen? Alle Scores und der Verlauf gehen verloren.`) && (await act(() => api.del(`/api/lead-scoring/models/${model.id}`), 'Gelöscht')) && onDeleted()}>
              Löschen
            </button>
            <button className="btn secondary" onClick={() => act(() => api.post(`/api/lead-scoring/models/${model.id}/recalculate`), 'Neu berechnet').then((r) => r && onSaved({ ...model, stats: r }))}>
              <Icon name="refresh" /> Neu berechnen
            </button>
            <button className="btn" data-tour="ls-save" disabled={!dirty} onClick={save}>
              {dirty ? 'Speichern' : 'Gespeichert ✓'}
            </button>
          </div>
        </div>
      </div>
      <div className="ls-side">
        <div className="card" data-tour="ls-thresholds">
          <h2>Schwellen</h2>
          {(m.thresholds ?? []).map((th: any, i: number) => (
            <div key={i} className="ls-th">
              <Input value={th.label} onChange={(v) => setM({ ...m, thresholds: m.thresholds.map((x: any, j: number) => (j === i ? { ...x, label: v } : x)) })} aria-label="Name der Schwelle" />
              <span className="muted">ab</span>
              <Input type="number" value={th.min} onChange={(v) => setM({ ...m, thresholds: m.thresholds.map((x: any, j: number) => (j === i ? { ...x, min: Number(v) } : x)) })} aria-label="Mindestpunkte" className="ls-small" />
              <button className="icon-btn" onClick={() => setM({ ...m, thresholds: m.thresholds.filter((_: any, j: number) => j !== i) })} aria-label="Schwelle entfernen">
                ✕
              </button>
            </div>
          ))}
          <button className="btn small secondary" onClick={() => setM({ ...m, thresholds: [...(m.thresholds ?? []), { label: '', min: 0 }] })}>
            + Schwelle
          </button>
          <p className="muted small">Erreicht ein Kontakt eine Schwelle, startet der Workflow-Auslöser „Lead-Score erreicht Schwelle“.</p>
        </div>
        <div className="card" data-tour="ls-decay">
          <h2>Zerfall & Grenze</h2>
          <div className="ls-th">
            <span className="muted">−</span>
            <Input type="number" value={m.decay?.percent ?? 0} onChange={(v) => setM({ ...m, decay: { ...m.decay, percent: Number(v) } })} aria-label="Prozent" className="ls-small" />
            <span className="muted">% je</span>
            <Input type="number" value={m.decay?.days ?? 30} onChange={(v) => setM({ ...m, decay: { ...m.decay, days: Number(v) } })} aria-label="Tage" className="ls-small" />
            <span className="muted">Tage ohne Aktivität</span>
          </div>
          <Field label="Höchstwert (leer = keiner)">
            <Input type="number" value={m.max_score ?? ''} onChange={(v) => setM({ ...m, max_score: v === '' ? null : Number(v) })} placeholder="z. B. 100" />
          </Field>
          <p className="muted small">Jede Nacht neu berechnet (Zerfall, Zeiträume), sonst sofort bei neuen Ereignissen.</p>
        </div>
        <div className="card" data-tour="ls-dist">
          <h2>Verteilung</h2>
          <p className="muted small" style={{ marginTop: 0 }}>
            {stats.scored} Kontakte bewertet · Ø {stats.average} Punkte {model.calculated_at ? `· berechnet ${dt(model.calculated_at)}` : ''}
          </p>
          {[...(model.thresholds ?? [])].reverse().map((th: any) => (
            <div key={th.label} className="ls-dist">
              <span>{th.label}</span>
              <div className="bar">
                <div style={{ width: `${((stats.labels[th.label] ?? 0) / maxCount) * 100}%` }} />
              </div>
              <b>{stats.labels[th.label] ?? 0}</b>
            </div>
          ))}
          <div className="ls-dist">
            <span className="muted">darunter</span>
            <div className="bar">
              <div style={{ width: `${((stats.labels[''] ?? 0) / maxCount) * 100}%`, opacity: 0.45 }} />
            </div>
            <b>{stats.labels[''] ?? 0}</b>
          </div>
          {stats.top.length > 0 && (
            <>
              <div className="prop-group">Top-Leads</div>
              {stats.top.map((c: any) => (
                <div key={c.contact_id} className="ls-top">
                  <Link to={`contacts/${c.contact_id}`}>{name(c)}</Link>
                  <span>
                    <ScoreBadge score={c.score} label={c.label} />
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function LeadScoring() {
  const meta = useMeta();
  const list = useLoad(() => api.get<any[]>('/api/lead-scoring/models'), []);
  const [sel, setSel] = useState('');
  const models = list.data ?? [];
  const cur = models.find((m) => m.id === sel) ?? models[0];
  const create = async () => {
    const m = await act(
      () =>
        api.post('/api/lead-scoring/models', {
          name: models.length ? `Modell ${models.length + 1}` : 'Lead-Score',
          rules: [
            { kind: 'event', event: 'form.submitted', points: 10, max_points: 30 },
            { kind: 'event', event: 'email.clicked', points: 5, max_points: 25 },
            { kind: 'event', event: 'appointment.booked', points: 25 },
            { kind: 'property', field: 'email', op: 'contains', value: 'gmail', points: -5 },
          ],
          decay: { percent: 10, days: 30 },
          max_score: 100,
        }),
      'Modell angelegt',
    );
    if (m) (await list.reload(), setSel(m.id));
  };
  return (
    <>
      <PageHead title="Lead-Scoring" sub="Punkte für passende Eigenschaften und Aktivität – Schwellen wie MQL und SQL starten Workflows">
        <button className="btn" data-tour="ls-new" onClick={create}>
          + Modell
        </button>
      </PageHead>
      {!list.data || !meta.data ? (
        <Spinner />
      ) : !cur ? (
        <Empty tour="ls-empty" action={<button className="btn" onClick={create}>Erstes Scoring-Modell anlegen</button>}>Noch kein Lead-Scoring. Wir starten mit einer Vorlage (Formulare, Klicks, Termine), die du anpasst.</Empty>
      ) : (
        <>
          {models.length > 1 && (
            <div className="views-bar">
              {models.map((m) => (
                <button key={m.id} className={`chip${m.id === cur.id ? ' on' : ''}`} onClick={() => setSel(m.id)}>
                  {m.is_primary && <Icon name="crown" size={13} />} {m.name} {!m.active && <span className="muted small">(pausiert)</span>}
                </button>
              ))}
            </div>
          )}
          <ModelEditor key={cur.id} model={cur} meta={meta.data} onSaved={(m) => (list.setData(models.map((x) => (x.id === m.id ? m : m.is_primary ? { ...x, is_primary: false } : x))), setSel(m.id))} onDeleted={() => (setSel(''), list.reload())} />
        </>
      )}
    </>
  );
}

// --- elsewhere in the app -----------------------------------------------------------------------

export function ScoreBadge({ score, label }: { score: number; label?: string }) {
  const tone = label ? (label.toUpperCase().includes('SQL') ? 'green' : 'blue') : 'gray';
  return (
    <span className="score-badge">
      <b>{score}</b>
      {label && <Badge tone={tone as any}>{label}</Badge>}
    </span>
  );
}

/** Contact page: score(s) with breakdown and history. */
export function ContactLeadScore({ contactId }: { contactId: string }) {
  const s = useLoad(() => api.get<any>(`/api/lead-scoring/contacts/${contactId}`), [contactId]);
  const [open, setOpen] = useState(false);
  if (!s.data || !s.data.scores.length) return null;
  return (
    <div className="card lead-score-card" data-tour="contact-lead-score">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>
          <Icon name="gauge" /> Lead-Score
        </h2>
        <button className="icon-btn" title="Neu berechnen" aria-label="Neu berechnen" onClick={() => act(() => api.post(`/api/lead-scoring/contacts/${contactId}/recalculate`)).then((r) => r && s.setData(r))}>
          <Icon name="refresh" size={15} />
        </button>
      </div>
      {s.data.scores.map((sc: any) => (
        <div key={sc.model_id} className="ls-contact">
          <div className="ls-big">
            <b>{sc.score}</b>
            {sc.label && <Badge tone={sc.label.toUpperCase().includes('SQL') ? 'green' : 'blue'}>{sc.label}</Badge>}
            {s.data.scores.length > 1 && <span className="muted small">{sc.model_name}</span>}
          </div>
          <div className="ls-breakdown">
            {sc.breakdown.map((b: any) => (
              <div key={b.rule} className="ls-bd-row">
                <span>
                  {b.label}
                  {b.count ? <span className="muted"> ×{b.count}</span> : null}
                </span>
                <b className={b.points < 0 ? 'neg' : 'pos'}>{b.points > 0 ? `+${b.points}` : b.points}</b>
              </div>
            ))}
            {!sc.breakdown.length && <span className="muted small">Noch keine Punkte.</span>}
          </div>
        </div>
      ))}
      {s.data.history.length > 0 && (
        <>
          <button className="th-sort small ls-hist-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? '▾' : '▸'} Verlauf ({s.data.history.length})
          </button>
          {open && (
            <div className="ls-history">
              {s.data.history.slice(0, 20).map((h: any) => {
                const delta = h.score - (h.previous ?? 0);
                return (
                  <div key={h.id} className="ls-bd-row">
                    <span className="muted small">{d(h.created_at)}</span>
                    <span className="grow small">{h.reason}</span>
                    <b className={delta < 0 ? 'neg' : 'pos'}>{delta > 0 ? `▲ ${delta}` : `▼ ${-delta}`}</b>
                    <b>{h.score}</b>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

let modelsCache: { loc: string; p: Promise<any[]> } | null = null;
function usePrimaryModel() {
  const [m, setM] = useState<any | null | undefined>(undefined);
  useEffect(() => {
    const loc = localStorage.getItem('pghl.location') ?? '';
    if (!modelsCache || modelsCache.loc !== loc) modelsCache = { loc, p: api.get<any[]>('/api/lead-scoring/models').catch(() => []) };
    void modelsCache.p.then((list) => setM(list.find((x) => x.is_primary && x.active) ?? null));
  }, []);
  return m;
}

/** Contacts list: scores of the shown contacts (primary model); `enabled` false when no model exists. */
export function useLeadScores(ids: string[]) {
  const model = usePrimaryModel();
  const key = ids.join(',');
  const [map, setMap] = useState<Record<string, { score: number; label: string }>>({});
  useEffect(() => {
    if (!model || !ids.length) return;
    api.get(`/api/lead-scoring/scores?ids=${encodeURIComponent(key)}`).then(setMap).catch(() => {});
  }, [model?.id, key]);
  return { enabled: !!model, map };
}

export type ScoreFilterValue = { score_label?: string; score_min?: string };
export const scoreQs = (v: ScoreFilterValue) =>
  Object.entries(v)
    .filter(([, x]) => x)
    .map(([k, x]) => `&${k}=${encodeURIComponent(String(x))}`)
    .join('');
export const pickScore = (f: Record<string, any>): ScoreFilterValue => ({ ...(f?.score_label ? { score_label: String(f.score_label) } : {}), ...(f?.score_min ? { score_min: String(f.score_min) } : {}) });

export function LeadScoreFilter({ value, onChange }: { value: ScoreFilterValue; onChange: (v: ScoreFilterValue) => void }) {
  // Part of the contact list: translated with it (contacts catalog).
  const t = useT('contacts');
  const model = usePrimaryModel();
  const options = useMemo<[string, string][]>(() => [...[...(model?.thresholds ?? [])].reverse().map((x: any) => [`label:${x.label}`, t('Score: ab {label} ({min})', { label: x.label, min: x.min })] as [string, string]), ['min:1', t('Score: mit Punkten')]], [model?.id, t]);
  if (!model) return null;
  const cur = value.score_label ? `label:${value.score_label}` : value.score_min ? `min:${value.score_min}` : '';
  return (
    <div style={{ width: 190 }} data-tour="contacts-score">
      <Select value={cur} onChange={(v) => onChange(!v ? {} : v.startsWith('label:') ? { score_label: v.slice(6) } : { score_min: v.slice(4) })} placeholder={t('Score: alle')} options={options} />
    </div>
  );
}

/** Workflow trigger filters for lead_score.* */
export function LeadScoreTriggerFilter({ type, config, set }: { type: string; config: any; set: (p: any) => void }) {
  const models = useLoad(() => api.get<any[]>('/api/lead-scoring/models'), []);
  const model = (models.data ?? []).find((m) => m.id === config.model_id) ?? (models.data ?? []).find((m) => m.is_primary);
  if (models.data && !models.data.length) return <p className="muted small">Erst unter <Link to="lead-scoring">Lead-Scoring</Link> ein Modell anlegen.</p>;
  return (
    <>
      <Field label="Modell">
        <Select value={config.model_id} onChange={(v) => set({ model_id: v, threshold: '' })} placeholder="jedes" options={(models.data ?? []).map((m) => [m.id, m.name] as [string, string])} />
      </Field>
      {type === 'lead_score.threshold_reached' && (
        <Field label="Schwelle">
          <Select value={config.threshold} onChange={(v) => set({ threshold: v })} placeholder="jede" options={(model?.thresholds ?? []).map((t: any) => [t.label, `${t.label} (ab ${t.min})`] as [string, string])} />
        </Field>
      )}
      {type === 'lead_score.changed' && (
        <div className="grid2">
          <Field label="Richtung">
            <Select value={config.direction} onChange={(v) => set({ direction: v })} placeholder="beide" options={[['up', 'gestiegen'], ['down', 'gefallen']]} />
          </Field>
          <Field label="Neuer Score mindestens">
            <Input type="number" value={config.min} onChange={(v) => set({ min: v })} placeholder="–" />
          </Field>
        </div>
      )}
      <p className="muted small">Platzhalter: {'{{event.score}}'}, {'{{event.label}}'}, {'{{event.previous}}'}.</p>
    </>
  );
}
