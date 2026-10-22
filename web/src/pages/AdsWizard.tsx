import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, money } from '../api';
import { Icon } from '../icons';
import { Badge, Check, Empty, Field, Input, Link, PageHead, Select, Spinner, Textarea, TagInput, act, navigate, useLoad } from '../ui';
import { LeadFormModal } from './AdsAudiences';
import { CTAS, GOALS, PLATFORM_FULL, emptySpec, fromCents, toCents, type Platform, type Review, type Spec } from './AdsKit';
import { GenImageButton } from './GenMediaKit';
import { MoreFields } from '../areas/fields';

/**
 * The campaign builder: goal → budget → audience → ad → review. Nothing reaches Meta or Google before the last step,
 * and even then the campaign is created paused (the server binds the publish to exactly the reviewed version).
 */

const STEPS = ['Ziel', 'Budget & Zeitraum', 'Zielgruppe', 'Anzeige', 'Prüfen & anlegen'];
const LANGS: [string, string][] = [['de', 'Deutsch'], ['en', 'Englisch'], ['fr', 'Französisch'], ['es', 'Spanisch'], ['it', 'Italienisch'], ['nl', 'Niederländisch'], ['pl', 'Polnisch'], ['tr', 'Türkisch']];
const COUNTRY_HINTS = ['DE', 'AT', 'CH', 'NL', 'FR', 'IT', 'ES', 'PL', 'GB', 'US'];

type Overview = {
  connected: { meta: boolean; google: boolean };
  meta: { account: { id: string; name: string; currency: string } | null; page: { id: string; name: string } | null; pixel_id: string; can_manage: boolean };
  google: { account: { id: string; name: string; currency: string } | null; can_manage: boolean };
  max_daily_budget_cents: number;
};

const Counter = ({ value, max }: { value?: string; max: number }) => {
  const n = (value ?? '').length;
  return <small className={n > max ? 'ads-over' : 'muted'}>{n}/{max}</small>;
};

export function AdsWizard({ draftId }: { draftId?: string }) {
  const [spec, setSpec] = useState<Spec>(emptySpec());
  const [id, setId] = useState<string | undefined>(draftId);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(!draftId);
  const overview = useLoad(() => api.get<Overview>('/api/ads/overview').catch(() => null), []);
  const set = (patch: Partial<Spec>) => setSpec((s) => ({ ...s, ...patch }));
  const setAud = (patch: Partial<Spec['audience']>) => setSpec((s) => ({ ...s, audience: { ...s.audience, ...patch } }));
  const setCre = (patch: Partial<Spec['creative']>) => setSpec((s) => ({ ...s, creative: { ...s.creative, ...patch } }));

  useEffect(() => {
    if (!draftId) return;
    api.get(`/api/ads/campaigns/${draftId}`).then((c) => {
      setSpec({ ...emptySpec(c.spec.platform), ...c.spec, audience: { ...c.spec.audience }, creative: { ...c.spec.creative } });
      setLoaded(true);
    }).catch((e) => (act(() => Promise.reject(e)), navigate('ads')));
  }, [draftId]);

  const save = async (): Promise<string | undefined> => {
    if (!spec.name.trim()) {
      await act(() => Promise.reject(new Error('Bitte der Kampagne einen Namen geben')));
      return undefined;
    }
    const r = id ? await act(() => api.patch(`/api/ads/campaigns/${id}`, { spec })) : await act(() => api.post('/api/ads/campaigns', { spec }));
    if (r?.id) setId(r.id);
    return r?.id;
  };

  const needsReview = step === STEPS.length - 1;
  const specKey = JSON.stringify(spec);
  const review = useLoad(() => (needsReview ? api.post<Review>('/api/ads/review', { spec }) : Promise.resolve(undefined)), [needsReview, specKey]);

  const publish = async () => {
    const rv = review.data;
    if (!rv?.ready) return;
    setBusy(true);
    const cid = await save();
    if (cid) {
      const r = await act(() => api.post(`/api/ads/campaigns/${cid}/publish`, { review_hash: rv.hash }), 'Pausiert angelegt – es wird nichts ausgegeben, bis du aktivierst');
      if (r) {
        navigate('ads');
        return;
      }
    }
    setBusy(false);
  };

  if (!loaded || overview.loading) return <Spinner />;
  const ov = overview.data;
  const account = ov ? (spec.platform === 'meta' ? ov.meta.account : ov.google.account) : null;

  return (
    <div className="ads ads-wizard">
      <PageHead title={id ? 'Kampagne bearbeiten' : 'Neue Kampagne'} sub="Alles wird pausiert angelegt – bei Meta und Google fließt erst Geld, wenn du die Kampagne aktivierst.">
        <button className="btn secondary" onClick={() => navigate('ads')}>
          Abbrechen
        </button>
      </PageHead>
      <ol className="ads-steps" aria-label="Schritte" data-tour="ads-steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i === step ? 'on' : i < step ? 'done' : ''}>
            <button type="button" onClick={() => setStep(i)}>
              <span>{i + 1}</span> {s}
            </button>
          </li>
        ))}
      </ol>

      {ov && !ov.connected[spec.platform] && (
        <div className="card ads-warn">
          {PLATFORM_FULL[spec.platform]} ist noch nicht verbunden. Du kannst den Entwurf vorbereiten, anlegen geht erst nach dem <Link to="ads/connections">Verbinden</Link>.
        </div>
      )}

      {step === 0 && <StepGoal spec={spec} setSpec={setSpec} set={set} ov={ov} />}
      {step === 1 && <StepBudget spec={spec} set={set} ov={ov} currency={account?.currency ?? 'EUR'} />}
      {step === 2 && <StepAudience spec={spec} setAud={setAud} />}
      {step === 3 && <StepCreative spec={spec} set={set} setCre={setCre} ov={ov} />}
      {step === 4 && <StepReview review={review.data} loading={review.loading} error={review.error} />}

      <div className="ads-nav">
        <button className="btn secondary" disabled={step === 0} onClick={() => setStep(step - 1)}>
          Zurück
        </button>
        <button className="btn secondary" disabled={busy} onClick={async () => (await save()) && act(() => Promise.resolve(), 'Entwurf gespeichert')}>
          Entwurf speichern
        </button>
        {step < STEPS.length - 1 ? (
          <button className="btn" onClick={() => setStep(step + 1)}>
            Weiter
          </button>
        ) : (
          <button className="btn" data-tour="ads-publish" disabled={busy || !review.data?.ready} onClick={publish} title={review.data?.ready ? '' : 'Erst die Fehler oben beheben'}>
            {busy ? 'Legt an …' : 'Pausiert anlegen'}
          </button>
        )}
      </div>
    </div>
  );
}

// --- 1: goal ------------------------------------------------------------------------------------------

function StepGoal({ spec, setSpec, set, ov }: { spec: Spec; setSpec: (f: (s: Spec) => Spec) => void; set: (p: Partial<Spec>) => void; ov: Overview | null | undefined }) {
  const pick = (platform: Platform) => {
    if (platform === spec.platform) return;
    setSpec((s) => ({ ...emptySpec(platform), name: s.name, goal: platform === 'google' && s.goal === 'reach' ? 'leads' : s.goal, budget: s.budget, schedule: s.schedule }));
  };
  const kinds: [string, string][] =
    spec.platform === 'meta'
      ? spec.goal === 'leads'
        ? [['lead_form', 'Sofortformular (Lead-Anzeige) – Formular direkt in Facebook/Instagram'], ['website', 'Link zur Website (Pixel nötig)']]
        : [['website', 'Anzeige mit Link zur Website']]
      : [['search', 'Suchnetzwerk – Responsive Suchanzeige mit Keywords'], ['pmax', 'Performance Max – Google verteilt auf alle Kanäle']];
  return (
    <div className="card" data-tour="ads-step-goal">
      <div className="ads-plat">
        {(['meta', 'google'] as Platform[]).map((p) => {
          const connected = ov?.connected[p];
          const acc = ov ? (p === 'meta' ? ov.meta.account : ov.google.account) : null;
          return (
            <button key={p} type="button" className={`ads-opt${spec.platform === p ? ' on' : ''}`} onClick={() => pick(p)}>
              <strong>{PLATFORM_FULL[p]}</strong>
              <small className="muted">{connected ? `Verbunden: ${acc?.name || acc?.id}` : 'Nicht verbunden'}</small>
            </button>
          );
        })}
      </div>
      <Field label="Name der Kampagne" hint="Erscheint in den Berichten und als utm_campaign.">
        <Input value={spec.name} onChange={(v) => set({ name: v })} placeholder="z. B. Sommer-Aktion Yoga" maxLength={120} />
      </Field>
      <div className="ads-goals">
        {GOALS.map(([k, label, hint]) => {
          const off = k === 'reach' && spec.platform === 'google';
          return (
            <button key={k} type="button" disabled={off} className={`ads-opt${spec.goal === k ? ' on' : ''}`} onClick={() => set({ goal: k, kind: spec.platform === 'meta' ? (k === 'leads' ? 'lead_form' : 'website') : spec.kind })}>
              <strong>{label}</strong>
              <small className="muted">{off ? 'Nur bei Meta' : hint}</small>
            </button>
          );
        })}
      </div>
      <Field label="Art der Anzeige">
        <Select value={spec.kind} onChange={(v) => set({ kind: v })} options={kinds} />
      </Field>
      {spec.platform === 'meta' && (spec.goal === 'conversions' || (spec.goal === 'leads' && spec.kind === 'website')) && (
        <Field label="Ereignis, auf das optimiert wird" hint={ov?.meta.pixel_id ? `Pixel ${ov.meta.pixel_id}` : 'Dafür braucht es ein Meta-Pixel (Verbindungen).'}>
          <Select value={spec.conversion_event ?? (spec.goal === 'leads' ? 'LEAD' : 'PURCHASE')} onChange={(v) => set({ conversion_event: v })} options={[['PURCHASE', 'Kauf'], ['LEAD', 'Lead'], ['COMPLETE_REGISTRATION', 'Registrierung'], ['ADD_TO_CART', 'In den Warenkorb'], ['INITIATE_CHECKOUT', 'Kasse gestartet'], ['SCHEDULE', 'Termin'], ['CONTACT', 'Kontakt']]} />
        </Field>
      )}
    </div>
  );
}

// --- 2: budget ----------------------------------------------------------------------------------------------

function StepBudget({ spec, set, ov, currency }: { spec: Spec; set: (p: Partial<Spec>) => void; ov: Overview | null | undefined; currency: string }) {
  const [amount, setAmount] = useState(fromCents(spec.budget.amount_cents));
  useEffect(() => setAmount(fromCents(spec.budget.amount_cents)), [spec.budget.type]);
  const limit = ov?.max_daily_budget_cents;
  return (
    <div className="card" data-tour="ads-budget">
      <div className="grid2">
        <Field label="Budget">
          <Select value={spec.budget.type} onChange={(v) => set({ budget: { ...spec.budget, type: v as 'daily' | 'lifetime' } })} options={[['daily', 'Tagesbudget'], ['lifetime', 'Gesamtbudget (mit Enddatum)']]} />
        </Field>
        <Field label={`Betrag (${currency})`} hint={limit ? `Tageslimit dieses Sub-Accounts: ${money(limit)} – änderbar unter Verbindungen.` : undefined}>
          <Input inputMode="decimal" value={amount} onChange={(v) => (setAmount(v), set({ budget: { ...spec.budget, amount_cents: toCents(v) } }))} placeholder="20" />
        </Field>
        <Field label="Start (optional)" hint="Leer = sobald du die Kampagne aktivierst.">
          <Input type="date" value={spec.schedule.start ?? ''} onChange={(v) => set({ schedule: { ...spec.schedule, start: v || undefined } })} />
        </Field>
        <Field label={spec.budget.type === 'lifetime' ? 'Ende (nötig)' : 'Ende (optional)'}>
          <Input type="date" value={spec.schedule.end ?? ''} onChange={(v) => set({ schedule: { ...spec.schedule, end: v || undefined } })} />
        </Field>
      </div>
      {spec.platform === 'google' && spec.budget.type === 'lifetime' && <p className="muted small">Google kennt nur Tagesbudgets: das Gesamtbudget wird auf die Tage bis zum Ende verteilt.</p>}
      {spec.budget.amount_cents > 0 && spec.budget.type === 'daily' && <p className="muted small">Das sind etwa {money(spec.budget.amount_cents * 30)} im Monat, wenn die Kampagne durchgehend läuft.</p>}
    </div>
  );
}

// --- 3: audience --------------------------------------------------------------------------------------------

/** Type-ahead against the platform's targeting search (interests, places). */
function Search<T extends { key?: string; id?: string }>({ url, onPick, render, placeholder }: { url: (q: string) => string; onPick: (x: T) => void; render: (x: T) => ReactNode; placeholder: string }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<T[]>([]);
  const [err, setErr] = useState('');
  const seq = useRef(0);
  useEffect(() => {
    if (q.trim().length < 2) return setList([]);
    const n = ++seq.current;
    const t = setTimeout(() => api.get<T[]>(url(q.trim())).then((r) => n === seq.current && (setList(r), setErr(''))).catch((e) => n === seq.current && (setList([]), setErr(e.message))), 300);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="ads-search">
      <Input value={q} onChange={setQ} placeholder={placeholder} />
      {err && <small style={{ color: 'var(--red)' }}>{err}</small>}
      {list.length > 0 && (
        <div className="ads-results">
          {list.map((x) => (
            <button key={x.key ?? x.id} type="button" onClick={() => (onPick(x), setQ(''), setList([]))}>
              {render(x)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const Chips = ({ items, onRemove }: { items: { label: string; key: string }[]; onRemove: (key: string) => void }) => (
  <div className="tag-input" style={{ border: 0, padding: 0 }}>
    {items.map((i) => (
      <span key={i.key} className="tag">
        {i.label}
        <button type="button" onClick={() => onRemove(i.key)} aria-label={`${i.label} entfernen`}>
          ×
        </button>
      </span>
    ))}
  </div>
);

function StepAudience({ spec, setAud }: { spec: Spec; setAud: (p: Partial<Spec['audience']>) => void }) {
  const a = spec.audience;
  // The keyword boxes keep what is typed; the parsed lists go into the spec.
  const [kwRaw, setKwRaw] = useState(() => (a.keywords ?? []).map((k) => (k.match === 'EXACT' ? `[${k.text}]` : k.match === 'BROAD' ? `+${k.text}` : `"${k.text}"`)).join('\n'));
  const [negRaw, setNegRaw] = useState(() => (a.negative_keywords ?? []).join('\n'));
  const audiences = useLoad(() => api.get<any[]>('/api/ads/audiences').catch(() => []), []);
  const mine = (audiences.data ?? []).filter((x) => x.platform === spec.platform && x.status === 'ready');
  const toggle = (key: 'audience_ids' | 'exclude_audience_ids', aid: string) => {
    const cur = a[key] ?? [];
    setAud({ [key]: cur.includes(aid) ? cur.filter((x) => x !== aid) : [...cur, aid] });
  };
  const AudienceList = (
    <>
      <h3>Eigene Zielgruppen</h3>
      {mine.length === 0 ? (
        <p className="muted small">
          Noch keine. Unter <Link to="ads/audiences">Zielgruppen</Link> machst du aus einer Smart List eine Kundenliste{spec.platform === 'meta' ? ' (und daraus Lookalikes)' : ''}.
        </p>
      ) : (
        <div className="grid2">
          <div>
            <small className="muted">Ansprechen</small>
            {mine.map((x) => (
              <Check key={x.id} checked={(a.audience_ids ?? []).includes(x.id)} onChange={() => toggle('audience_ids', x.id)} label={`${x.name}${x.kind === 'lookalike' ? ' (Lookalike)' : ''}`} />
            ))}
          </div>
          {spec.platform === 'meta' && (
            <div>
              <small className="muted">Ausschließen</small>
              {mine.map((x) => (
                <Check key={x.id} checked={(a.exclude_audience_ids ?? []).includes(x.id)} onChange={() => toggle('exclude_audience_ids', x.id)} label={x.name} />
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
  if (spec.platform === 'meta') {
    return (
      <div className="card" data-tour="ads-audience">
        <h3>Wo?</h3>
        <Field label="Länder" hint="Zweistellige Codes, z. B. DE, AT, CH">
          <TagInput value={a.countries ?? []} onChange={(v) => setAud({ countries: v.map((x) => x.toUpperCase().slice(0, 2)) })} suggestions={COUNTRY_HINTS} placeholder="Land + Enter" />
        </Field>
        <Field label="Oder genauer: Stadt, Region, PLZ">
          <Search<any> url={(q) => `/api/ads/targeting/locations?platform=meta&q=${encodeURIComponent(q)}`} placeholder="Stadt oder PLZ suchen …" render={(x) => `${x.name} (${x.type})`} onPick={(x) => setAud({ locations: [...(a.locations ?? []).filter((l) => l.key !== x.key), { ...x, radius: x.type === 'city' ? 25 : undefined }] })} />
        </Field>
        <Chips items={(a.locations ?? []).map((l) => ({ key: l.key, label: l.radius ? `${l.name} +${l.radius} km` : l.name }))} onRemove={(k) => setAud({ locations: (a.locations ?? []).filter((l) => l.key !== k) })} />
        <h3>Wer?</h3>
        <div className="grid3">
          <Field label="Alter von">
            <Select value={String(a.age_min ?? 18)} onChange={(v) => setAud({ age_min: Number(v) })} options={Array.from({ length: 48 }, (_, i) => String(18 + i))} />
          </Field>
          <Field label="bis">
            <Select value={String(a.age_max ?? 65)} onChange={(v) => setAud({ age_max: Number(v) })} options={Array.from({ length: 48 }, (_, i) => String(18 + i))} />
          </Field>
          <Field label="Geschlecht">
            <Select value={a.genders?.length === 1 ? a.genders[0] : ''} onChange={(v) => setAud({ genders: v ? [v] : [] })} options={[['', 'Alle'], ['female', 'Frauen'], ['male', 'Männer']]} />
          </Field>
        </div>
        <MoreFields id="ads-audience-meta" label="Interessen & eigene Zielgruppen" values={[a.interests, a.audience_ids, a.exclude_audience_ids]}>
          <Field label="Interessen (optional)">
            <Search<any> url={(q) => `/api/ads/targeting/interests?q=${encodeURIComponent(q)}`} placeholder="Interesse suchen, z. B. Yoga …" render={(x) => `${x.name}${x.path ? ` – ${x.path}` : ''}`} onPick={(x) => setAud({ interests: [...(a.interests ?? []).filter((i) => i.id !== x.id), { id: x.id, name: x.name }] })} />
          </Field>
          <Chips items={(a.interests ?? []).map((i) => ({ key: i.id, label: i.name }))} onRemove={(k) => setAud({ interests: (a.interests ?? []).filter((i) => i.id !== k) })} />
          {AudienceList}
        </MoreFields>
      </div>
    );
  }
  return (
    <div className="card" data-tour="ads-audience">
      <h3>Wo & in welcher Sprache?</h3>
      <Field label="Zielgebiete">
        <Search<any> url={(q) => `/api/ads/targeting/locations?platform=google&q=${encodeURIComponent(q)}`} placeholder="Land, Region oder Stadt suchen …" render={(x) => x.name} onPick={(x) => setAud({ locations: [...(a.locations ?? []).filter((l) => l.key !== x.key), x] })} />
      </Field>
      <Chips items={(a.locations ?? []).map((l) => ({ key: l.key, label: l.name }))} onRemove={(k) => setAud({ locations: (a.locations ?? []).filter((l) => l.key !== k) })} />
      <div className="ads-langs">
        {LANGS.map(([k, label]) => (
          <Check key={k} checked={(a.languages ?? []).includes(k)} onChange={(v) => setAud({ languages: v ? [...(a.languages ?? []), k] : (a.languages ?? []).filter((x) => x !== k) })} label={label} />
        ))}
      </div>
      {spec.kind === 'search' && (
        <>
          <h3>Keywords</h3>
          <Field label="Suchbegriffe, einer pro Zeile" hint={'Ohne Zeichen oder in "Anführungszeichen" = Wortgruppe · [eckige Klammern] = genau · +Plus = weitgehend passend'}>
            <Textarea
              rows={6}
              value={kwRaw}
              onChange={(v) => (
                setKwRaw(v),
                setAud({
                  keywords: v
                    .split('\n')
                    .map((l) => l.trim())
                    .filter(Boolean)
                    .map((l) => (l.startsWith('[') ? { text: l.replace(/^\[|\]$/g, ''), match: 'EXACT' } : l.startsWith('+') ? { text: l.slice(1), match: 'BROAD' } : { text: l.replace(/^"|"$/g, ''), match: 'PHRASE' })),
                })
              )}
              placeholder={'yoga köln\n[yogakurs anfänger]'}
            />
          </Field>
        </>
      )}
      <MoreFields id="ads-audience-google" values={[a.negative_keywords, a.audience_ids]}>
        {spec.kind === 'search' && (
          <Field label="Ausschließende Suchbegriffe, einer pro Zeile">
            <Textarea rows={3} value={negRaw} onChange={(v) => (setNegRaw(v), setAud({ negative_keywords: v.split('\n').map((l) => l.trim()).filter(Boolean) }))} placeholder={'kostenlos\njobs'} />
          </Field>
        )}
        {AudienceList}
      </MoreFields>
    </div>
  );
}

// --- 4: creative ----------------------------------------------------------------------------------------------

function ListEditor({ label, hint, values, onChange, max, perItem, min }: { label: string; hint?: string; values: string[]; onChange: (v: string[]) => void; max: number; perItem: number; min: number }) {
  const rows = values.length >= min ? values : [...values, ...Array(min - values.length).fill('')];
  const upd = (i: number, v: string) => onChange(rows.map((x, j) => (j === i ? v : x)));
  return (
    <Field label={label} hint={hint}>
      <div className="ads-list">
        {rows.map((v, i) => (
          <div key={i} className="ads-list-row">
            <Input value={v} onChange={(x) => upd(i, x)} />
            <Counter value={v} max={perItem} />
            {rows.length > min && (
              <button type="button" className="icon-btn" aria-label="Entfernen" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                ✕
              </button>
            )}
          </div>
        ))}
        {rows.length < max && (
          <button type="button" className="btn small secondary" onClick={() => onChange([...rows, ''])}>
            + weitere
          </button>
        )}
      </div>
    </Field>
  );
}

function StepCreative({ spec, set, setCre, ov }: { spec: Spec; set: (p: Partial<Spec>) => void; setCre: (p: Partial<Spec['creative']>) => void; ov: Overview | null | undefined }) {
  const c = spec.creative;
  const meta = spec.platform === 'meta';
  const funnels = useLoad(() => api.get<any[]>('/api/funnels').catch(() => []), []);
  const funnel = useLoad(() => (c.link?.funnel_id ? api.get<any>(`/api/funnels/${c.link.funnel_id}`).catch(() => null) : Promise.resolve(null)), [c.link?.funnel_id]);
  const uploads = useLoad(() => api.get<any[]>('/api/uploads').catch(() => []), []);
  const forms = useLoad(() => (meta ? api.get<any[]>('/api/ads/leadforms').catch(() => []) : Promise.resolve([])), [meta]);
  const [newForm, setNewForm] = useState(false);
  const pmax = spec.kind === 'pmax';
  const media = (uploads.data ?? []).filter((u) => (pmax ? /^image\//.test(u.mime) : /^(image|video)\//.test(u.mime)));
  const picked = c.media ?? [];
  const isPicked = (uid: string) => picked.some((m) => m.upload_id === uid);
  const kindOf = (uid: string) => (/^video\//.test((uploads.data ?? []).find((x) => x.id === uid)?.mime ?? '') ? 'video' : 'image');
  // Meta: one image and/or one video (a video needs an image as its preview); Google Performance Max: several images with a role each.
  const toggle = (u: any) => {
    if (isPicked(u.id)) return setCre({ media: picked.filter((m) => m.upload_id !== u.id) });
    if (!meta) return setCre({ media: [...picked, { upload_id: u.id, role: 'marketing' }] });
    const k = /^video\//.test(u.mime) ? 'video' : 'image';
    setCre({ media: [...picked.filter((m) => kindOf(m.upload_id) !== k), { upload_id: u.id }] });
  };
  const usesMedia = meta || pmax;
  return (
    <div data-tour="ads-creative">
      <div className="card">
        <h3>Ziel-Link</h3>
        <div className="grid2">
          <Field label="Funnel / Website von HyperLevel">
            <Select value={c.link?.funnel_id ?? ''} onChange={(v) => setCre({ link: { funnel_id: v || undefined, url: v ? undefined : c.link?.url } })} placeholder="– keiner (eigene Adresse) –" options={(funnels.data ?? []).map((f) => [f.id, f.name] as [string, string])} />
          </Field>
          {c.link?.funnel_id ? (
            <Field label="Seite">
              <Select value={c.link?.page_id ?? ''} onChange={(v) => setCre({ link: { ...c.link, page_id: v || undefined } })} placeholder="Startseite" options={(funnel.data?.pages ?? []).map((p: any) => [p.id, p.name] as [string, string])} />
            </Field>
          ) : (
            <Field label="Eigene Adresse" hint="Beginnt mit https://">
              <Input value={c.link?.url ?? ''} onChange={(v) => setCre({ link: { url: v || undefined } })} placeholder="https://" />
            </Field>
          )}
        </div>
        <MoreFields id="ads-link" values={[c.utm === false]}>
          <Check checked={c.utm !== false} onChange={(v) => setCre({ utm: v })} label="UTM-Parameter automatisch anhängen (so ordnet HyperLevel Leads und Umsatz der Kampagne zu)" />
        </MoreFields>
      </div>

      {usesMedia && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>{meta ? 'Bild oder Video' : 'Bilder'}</h3>
            <GenImageButton aspect={meta ? '1:1' : '16:9'} onPick={(u) => (uploads.reload(), setCre({ media: meta ? [{ upload_id: u.id }] : [...picked, { upload_id: u.id, role: 'marketing' }] }))} />
          </div>
          {media.length === 0 ? (
            <Empty>Die Mediathek ist leer. Lade Bilder in einem Funnel hoch oder erzeuge eines mit dem KI-Studio.</Empty>
          ) : (
            <div className="ads-media">
              {media.map((u) => (
                <button key={u.id} type="button" className={isPicked(u.id) ? 'on' : ''} onClick={() => toggle(u)} title={u.name} aria-pressed={isPicked(u.id)}>
                  {/^image\//.test(u.mime) ? <img src={u.url} alt={u.name} loading="lazy" /> : <span className="ads-video">▶ {u.name}</span>}
                </button>
              ))}
            </div>
          )}
          {pmax &&
            picked.map((m) => (
              <div key={m.upload_id} className="ads-role">
                <span className="small">{media.find((x) => x.id === m.upload_id)?.name ?? m.upload_id}</span>
                <Select value={m.role ?? 'marketing'} onChange={(v) => setCre({ media: picked.map((x) => (x.upload_id === m.upload_id ? { ...x, role: v } : x)) })} options={[['marketing', 'Querformat 1,91:1'], ['square', 'Quadrat 1:1'], ['logo', 'Logo 1:1']]} />
              </div>
            ))}
          {meta && media.some((u) => /^video\//.test(u.mime)) && <p className="muted small">Bei einem Video wähle zusätzlich ein Bild als Vorschau. Meta holt das Video über die öffentliche Adresse dieser Installation.</p>}
        </div>
      )}

      <div className="card">
        <h3>Texte</h3>
        <Suggest spec={spec} onUse={(patch) => setCre(patch)} />
        {meta ? (
          <>
            <Field label="Haupttext" hint="Wird nach etwa 125 Zeichen mit „… mehr“ gekürzt">
              <Textarea rows={3} value={c.primary_text ?? ''} onChange={(v) => setCre({ primary_text: v })} />
              <Counter value={c.primary_text} max={125} />
            </Field>
            <div className="grid2">
              <Field label="Überschrift">
                <Input value={c.headline ?? ''} onChange={(v) => setCre({ headline: v })} />
                <Counter value={c.headline} max={40} />
              </Field>
              <Field label="Beschreibung (optional)">
                <Input value={c.description ?? ''} onChange={(v) => setCre({ description: v })} />
                <Counter value={c.description} max={30} />
              </Field>
              <Field label="Button">
                <Select value={c.cta ?? (spec.kind === 'lead_form' ? 'SIGN_UP' : 'LEARN_MORE')} onChange={(v) => setCre({ cta: v })} options={CTAS} />
              </Field>
              {spec.kind === 'lead_form' && (
                <Field label="Sofortformular">
                  <div className="row" style={{ gap: 6 }}>
                    <Select value={spec.lead_form_id ?? ''} onChange={(v) => set({ lead_form_id: v || undefined })} placeholder="– wählen –" options={(forms.data ?? []).map((f) => [f.id, f.name] as [string, string])} />
                    <button type="button" className="btn small secondary" onClick={() => setNewForm(true)}>
                      + Neu
                    </button>
                  </div>
                </Field>
              )}
            </div>
            <details className="ads-more">
              <summary>EU-Angaben (Begünstigter und Zahler der Anzeige)</summary>
              <p className="muted small">Für Ziele in der EU verlangt Meta diese Angaben. Leer = Name der Facebook-Seite{ov?.meta.page ? ` („${ov.meta.page.name}“)` : ''}.</p>
              <div className="grid2">
                <Field label="Begünstigter">
                  <Input value={spec.dsa?.beneficiary ?? ''} onChange={(v) => set({ dsa: { ...spec.dsa, beneficiary: v || undefined } })} />
                </Field>
                <Field label="Zahler">
                  <Input value={spec.dsa?.payor ?? ''} onChange={(v) => set({ dsa: { ...spec.dsa, payor: v || undefined } })} />
                </Field>
              </div>
            </details>
          </>
        ) : (
          <>
            <ListEditor label="Überschriften" hint="Mindestens 3, höchstens 15 – jede bis 30 Zeichen. Google kombiniert sie." values={c.headlines ?? []} onChange={(v) => setCre({ headlines: v })} max={15} perItem={30} min={3} />
            {pmax && <ListEditor label="Lange Überschriften" hint="Mindestens 1, bis 90 Zeichen" values={c.long_headlines ?? []} onChange={(v) => setCre({ long_headlines: v })} max={5} perItem={90} min={1} />}
            <ListEditor label="Beschreibungen" hint={pmax ? 'Mindestens 2 (eine bis 60 Zeichen, die anderen bis 90)' : 'Mindestens 2, höchstens 4 – je bis 90 Zeichen'} values={c.descriptions ?? []} onChange={(v) => setCre({ descriptions: v })} max={pmax ? 5 : 4} perItem={90} min={2} />
            {pmax && (
              <Field label="Firmenname">
                <Input value={c.business_name ?? ''} onChange={(v) => setCre({ business_name: v })} maxLength={25} />
              </Field>
            )}
            <MoreFields id="ads-paths" values={[c.path1, c.path2]}>
              <div className="grid2">
                <Field label="Pfad 1 (optional)" hint="Wird an die Anzeigen-Adresse angehängt, bis 15 Zeichen">
                  <Input value={c.path1 ?? ''} onChange={(v) => setCre({ path1: v || undefined })} maxLength={15} />
                </Field>
                <Field label="Pfad 2 (optional)">
                  <Input value={c.path2 ?? ''} onChange={(v) => setCre({ path2: v || undefined })} maxLength={15} />
                </Field>
              </div>
            </MoreFields>
          </>
        )}
      </div>
      {newForm && (
        <LeadFormModal
          onClose={() => setNewForm(false)}
          onCreated={(f) => {
            setNewForm(false);
            forms.reload();
            set({ lead_form_id: f.id });
          }}
        />
      )}
    </div>
  );
}

/** AI suggestions (Claude via the sub-account's AI assistant): fills the fields on click. */
function Suggest({ spec, onUse }: { spec: Spec; onUse: (p: Partial<Spec['creative']>) => void }) {
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState('');
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    const r = await act(() => api.post('/api/ads/suggest', { platform: spec.platform, goal: spec.goal, kind: spec.kind, brief, funnel_id: spec.creative.link?.funnel_id, page_id: spec.creative.link?.page_id }));
    setBusy(false);
    if (r) setRes(r);
  };
  const meta = spec.platform === 'meta';
  const Pick = ({ items, onPick, label }: { items: string[]; onPick: (v: string) => void; label: string }) =>
    items?.length ? (
      <div className="ads-sugg">
        <small className="muted">{label}</small>
        {items.map((t) => (
          <button key={t} type="button" onClick={() => onPick(t)} title="Übernehmen">
            {t}
          </button>
        ))}
      </div>
    ) : null;
  return (
    <div className="ads-ai">
      <button type="button" className="btn small secondary" data-tour="ads-ai" onClick={() => setOpen(!open)}>
        <Icon name="sparkles" size={14} /> KI-Vorschläge {open ? 'ausblenden' : 'holen'}
      </button>
      {open && (
        <div className="ads-ai-box">
          <Field label="Was bewirbst du? (leer = Text der Funnel-Seite)">
            <Textarea rows={2} value={brief} onChange={setBrief} placeholder="z. B. Yoga-Probestunde für Anfänger in Köln, kleine Gruppen, erste Stunde gratis" />
          </Field>
          <button type="button" className="btn small" disabled={busy} onClick={run}>
            {busy ? 'Schreibt …' : 'Vorschläge erstellen'}
          </button>
          {res && meta && (
            <>
              <Pick label="Haupttexte – Klick übernimmt" items={res.primary_texts} onPick={(v) => onUse({ primary_text: v })} />
              <Pick label="Überschriften" items={res.headlines} onPick={(v) => onUse({ headline: v })} />
              <Pick label="Beschreibungen" items={res.descriptions} onPick={(v) => onUse({ description: v })} />
            </>
          )}
          {res && !meta && (
            <>
              <Pick label="Überschriften – Klick fügt hinzu" items={res.headlines} onPick={(v) => onUse({ headlines: [...new Set([...(spec.creative.headlines ?? []).filter(Boolean), v])].slice(0, 15) })} />
              {spec.kind === 'pmax' && <Pick label="Lange Überschriften" items={res.long_headlines} onPick={(v) => onUse({ long_headlines: [...new Set([...(spec.creative.long_headlines ?? []).filter(Boolean), v])].slice(0, 5) })} />}
              <Pick label="Beschreibungen" items={res.descriptions} onPick={(v) => onUse({ descriptions: [...new Set([...(spec.creative.descriptions ?? []).filter(Boolean), v])].slice(0, 5) })} />
              {res.keywords?.length > 0 && <p className="muted small">Keyword-Ideen: {res.keywords.join(', ')} (unter „Zielgruppe“ eintragen)</p>}
            </>
          )}
          <p className="muted small">Die KI schreibt Entwürfe – prüfe Aussagen und Werberichtlinien selbst. Die Anfrage zählt aufs KI-Limit des Sub-Accounts.</p>
        </div>
      )}
    </div>
  );
}

// --- 5: review -------------------------------------------------------------------------------------------------

function StepReview({ review: r, loading, error }: { review?: Review; loading: boolean; error: string }) {
  if (loading && !r) return <Spinner />;
  if (error) return <p style={{ color: 'var(--red)' }}>{error}</p>;
  if (!r) return null;
  return (
    <div className="ads-review" data-tour="ads-review">
      {r.errors.length > 0 && (
        <div className="card ads-errors" role="alert">
          <strong>Das muss noch behoben werden:</strong>
          <ul>
            {r.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {r.warnings.length > 0 && (
        <div className="card ads-warn">
          <strong>Zum Prüfen:</strong>
          <ul>
            {r.warnings.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="ads-review-grid">
        <div className="card">
          <h3>Zusammenfassung</h3>
          <dl className="ads-dl">
            {r.rows.map((x) => (
              <div key={x.label}>
                <dt>{x.label}</dt>
                <dd>{x.value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="card">
          <h3>So sieht die Anzeige aus</h3>
          <div className="ads-preview">
            {r.preview.media.length > 0 && <div className="ads-preview-media">{r.preview.media.join(', ')}</div>}
            {r.preview.primary_text && <p>{r.preview.primary_text}</p>}
            {r.preview.headline && <strong>{r.preview.headline}</strong>}
            {r.preview.description && <div className="muted small">{r.preview.description}</div>}
            {r.preview.headlines && r.preview.headlines.length > 0 && <p>{r.preview.headlines.filter(Boolean).slice(0, 3).join(' | ')}</p>}
            {r.preview.descriptions && r.preview.descriptions.length > 0 && <p className="muted small">{r.preview.descriptions.filter(Boolean)[0]}</p>}
            {r.preview.cta && <span className="badge blue">{r.preview.cta}</span>}
          </div>
          {r.preview.example_link && <p className="muted small ads-url">Klick landet auf: {r.preview.example_link}</p>}
        </div>
      </div>
      <div className="card">
        <Badge tone="green">Pausiert</Badge> {r.note}
      </div>
    </div>
  );
}
