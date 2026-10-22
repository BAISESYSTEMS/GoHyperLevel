import { useEffect, useRef, useState } from 'react';
import { api, dt } from '../api';
import { Badge, Check, Empty, Field, Input, Link, Modal, Select, Spinner, act, confirmAsk, navigate, useLoad } from '../ui';
import { de, useDebounced } from './MarketingKit';
import { useT } from '../i18n';

/**
 * Behaviour segments: conditions on what contacts did (opened or clicked a campaign, visited a page, bought, submitted a form …),
 * what they are (tags, fields, consent) and when they were last active, combined in nested AND/OR groups. The count is live while
 * the conditions are edited. Saved segments are audiences of campaigns and can start workflows when somebody enters or leaves.
 */

type Cond = { type: string; negate?: boolean; [k: string]: any };
type Group = { type: 'group'; op: 'and' | 'or'; negate?: boolean; items: Node[] };
type Node = Group | Cond;

const MAX_DEPTH = 4;

// German labels (message ids of the campaigns catalog), shown through t()
const TYPE_LABEL: Record<string, string> = {
  email: 'E-Mail-Verhalten',
  purchase: 'Kauf',
  page: 'Seite besucht',
  form: 'Formular',
  tag: 'Tag',
  field: 'Kontaktfeld',
  consent: 'Einwilligung',
  activity: 'Letzte Aktivität',
  created: 'Kontakt angelegt',
  engagement: 'Interesse an Mails',
  email_check: 'Adressprüfung',
  dnd: 'Nicht stören',
  segment: 'Anderes Segment',
};
const ORDER = ['email', 'purchase', 'page', 'form', 'tag', 'field', 'consent', 'activity', 'created', 'engagement', 'email_check', 'dnd', 'segment'];

const blank = (type: string): Cond => {
  switch (type) {
    case 'tag':
      return { type, tag: '', has: true };
    case 'field':
      return { type, field: 'city', op: 'eq', value: '' };
    case 'email':
      return { type, event: 'opened', campaign_id: '', days: 90 };
    case 'page':
      return { type, url_contains: '', days: 30 };
    case 'purchase':
      return { type, bought: true, product_id: '', days: '' };
    case 'form':
      return { type, submitted: true, form_id: '', days: '' };
    case 'consent':
      return { type, channel: 'email', state: 'granted' };
    case 'activity':
      return { type, op: 'within', days: 30 };
    case 'created':
      return { type, op: 'within', days: 30 };
    case 'engagement':
      return { type, state: 'inactive', days: 180, min_received: 3 };
    case 'email_check':
      return { type, verdict: 'invalid' };
    case 'dnd':
      return { type, value: true };
    default:
      return { type, segment_id: '' };
  }
};

const emptyGroup = (): Group => ({ type: 'group', op: 'and', items: [] });

/** Ready-made starting points – what marketing people ask for most often. */
const STARTERS: { name: string; def: () => Group; text: string }[] = [
  { name: 'Geklickt, aber nicht gekauft', text: 'Haben in den letzten 30 Tagen auf einen Mail-Link geklickt und nichts gekauft', def: () => ({ type: 'group', op: 'and', items: [{ type: 'email', event: 'clicked', campaign_id: '', days: 30 }, { type: 'purchase', bought: false, product_id: '', days: 30 }] }) },
  { name: 'Lange nicht geöffnet', text: 'Bekommen Mails, öffnen oder klicken aber seit 6 Monaten nie', def: () => ({ type: 'group', op: 'and', items: [{ type: 'engagement', state: 'inactive', days: 180, min_received: 3 }, { type: 'dnd', value: false }] }) },
  { name: 'Neu im Verteiler', text: 'In den letzten 30 Tagen angelegt', def: () => ({ type: 'group', op: 'and', items: [{ type: 'created', op: 'within', days: 30 }] }) },
  { name: 'Preisseite besucht, nicht gekauft', text: 'Haben in den letzten 14 Tagen eine Seite mit „preis“ besucht und nichts gekauft', def: () => ({ type: 'group', op: 'and', items: [{ type: 'page', url_contains: 'preis', days: 14 }, { type: 'purchase', bought: false, product_id: '', days: 14 }] }) },
  { name: 'Aktive Leser', text: 'Haben in den letzten 30 Tagen eine Mail geöffnet', def: () => ({ type: 'group', op: 'and', items: [{ type: 'engagement', state: 'active', days: 30 }] }) },
];

interface Meta {
  fields: string[];
  custom_fields: { key: string; label: string; type: string }[];
  campaigns: { id: string; name: string; channel: string; status: string }[];
  forms: { id: string; name: string }[];
  products: { id: string; name: string }[];
  tags: string[];
  segments: { id: string; name: string }[];
  limits: { depth: number; nodes: number };
}

const FIELD_LABEL: Record<string, string> = { first_name: 'Vorname', last_name: 'Nachname', email: 'E-Mail', phone: 'Telefon', company: 'Firma', address: 'Adresse', city: 'Ort', postal_code: 'PLZ', country: 'Land', website: 'Website', source: 'Quelle', assigned_to: 'Zuständig', date_of_birth: 'Geburtstag' };
const OPS: [string, string][] = [['eq', 'ist'], ['neq', 'ist nicht'], ['contains', 'enthält'], ['not_contains', 'enthält nicht'], ['starts', 'beginnt mit'], ['empty', 'ist leer'], ['not_empty', 'ist ausgefüllt'], ['gt', 'größer als'], ['lt', 'kleiner als'], ['gte', 'mindestens'], ['lte', 'höchstens'], ['before', 'vor (Datum)'], ['after', 'nach (Datum)']];

function Days({ value, onChange, optional, label }: { value: any; onChange: (v: any) => void; optional?: boolean; label?: string }) {
  const t = useT('campaigns');
  return (
    <>
      <Input type="number" min={1} max={3650} value={value ?? ''} onChange={(v) => onChange(v === '' ? '' : Number(v))} placeholder={optional ? t('egal') : ''} aria-label={label ?? t('Tage')} />
      <span className="muted small">{t('Tage')}</span>
    </>
  );
}

function ConditionEditor({ c, onChange, meta, selfId }: { c: Cond; onChange: (c: Cond) => void; meta: Meta; selfId?: string }) {
  const t = useT('campaigns');
  const set = (patch: Record<string, any>) => onChange({ ...c, ...patch });
  const bool = (v: boolean) => (v ? 'yes' : 'no');
  switch (c.type) {
    case 'tag':
      return (
        <>
          <Select value={bool(c.has !== false)} onChange={(v) => set({ has: v === 'yes' })} options={[['yes', t('hat das Tag')], ['no', t('hat das Tag nicht')]]} />
          <Input list="mk-tags" value={c.tag} onChange={(v) => set({ tag: v })} placeholder="Tag" className="wide" aria-label="Tag" />
          <datalist id="mk-tags">
            {meta.tags.map((tag) => (
              <option key={tag} value={tag} />
            ))}
          </datalist>
        </>
      );
    case 'field': {
      const fields: [string, string][] = [...meta.fields.map((f) => [f, FIELD_LABEL[f] ? t(FIELD_LABEL[f]) : f] as [string, string]), ...meta.custom_fields.map((f) => [`custom.${f.key}`, f.label || f.key] as [string, string])];
      const noValue = c.op === 'empty' || c.op === 'not_empty';
      return (
        <>
          <Select value={c.field} onChange={(v) => set({ field: v })} options={fields} />
          <Select value={c.op} onChange={(v) => set({ op: v })} options={OPS.map(([k, l]) => [k, t(l)] as [string, string])} />
          {!noValue && <Input value={c.value} onChange={(v) => set({ value: v })} placeholder={c.op === 'before' || c.op === 'after' ? t('JJJJ-MM-TT') : t('Wert')} className="wide" aria-label={t('Wert')} />}
        </>
      );
    }
    case 'email':
      return (
        <>
          <Select value={c.event} onChange={(v) => set({ event: v })} options={[['opened', t('hat geöffnet')], ['clicked', t('hat geklickt')], ['not_opened', t('hat nicht geöffnet')], ['received', t('hat erhalten')]]} />
          <Select value={c.campaign_id} onChange={(v) => set({ campaign_id: v, days: v ? '' : c.days || 90 })} placeholder={t('irgendeine Kampagne')} options={meta.campaigns.map((k) => [k.id, k.name])} />
          <span className="muted small">{t('in den letzten')}</span>
          <Days value={c.days} optional={!!c.campaign_id} onChange={(v) => set({ days: v })} />
        </>
      );
    case 'page':
      return (
        <>
          <span className="muted small">{t('hat eine Seite besucht, deren Adresse')}</span>
          <Input value={c.url_contains} onChange={(v) => set({ url_contains: v })} placeholder={t('enthält z. B. /preise')} className="wide" aria-label={t('Teil der Seitenadresse')} />
          <Days value={c.days} optional onChange={(v) => set({ days: v })} />
        </>
      );
    case 'purchase':
      return (
        <>
          <Select value={bool(c.bought !== false)} onChange={(v) => set({ bought: v === 'yes' })} options={[['yes', t('hat gekauft')], ['no', t('hat nicht gekauft')]]} />
          <Select value={c.product_id} onChange={(v) => set({ product_id: v })} placeholder={t('irgendein Produkt')} options={meta.products.map((p) => [p.id, p.name])} />
          <span className="muted small">{t('in den letzten')}</span>
          <Days value={c.days} optional onChange={(v) => set({ days: v })} />
        </>
      );
    case 'form':
      return (
        <>
          <Select value={bool(c.submitted !== false)} onChange={(v) => set({ submitted: v === 'yes' })} options={[['yes', t('hat ausgefüllt')], ['no', t('hat nicht ausgefüllt')]]} />
          <Select value={c.form_id} onChange={(v) => set({ form_id: v })} placeholder={t('irgendein Formular')} options={meta.forms.map((f) => [f.id, f.name])} />
          <span className="muted small">{t('in den letzten')}</span>
          <Days value={c.days} optional onChange={(v) => set({ days: v })} />
        </>
      );
    case 'consent':
      return (
        <>
          <span className="muted small">{t('Einwilligung für')}</span>
          <Select value={c.channel} onChange={(v) => set({ channel: v })} options={[['email', t('E-Mail')], ['sms', 'SMS'], ['whatsapp', 'WhatsApp']]} />
          <Select value={c.state} onChange={(v) => set({ state: v })} options={[['granted', t('liegt vor')], ['missing', t('fehlt')]]} />
        </>
      );
    case 'activity':
      return (
        <>
          <span className="muted small">{t('Letzte Aktivität')}</span>
          <Select value={c.op} onChange={(v) => set({ op: v })} options={[['within', t('innerhalb der letzten')], ['older_than', t('länger her als')], ['never', t('noch nie')]]} />
          {c.op !== 'never' && <Days value={c.days} onChange={(v) => set({ days: v })} />}
        </>
      );
    case 'created':
      return (
        <>
          <span className="muted small">{t('Kontakt angelegt')}</span>
          <Select value={c.op} onChange={(v) => set({ op: v })} options={[['within', t('innerhalb der letzten')], ['older_than', t('länger her als')]]} />
          <Days value={c.days} onChange={(v) => set({ days: v })} />
        </>
      );
    case 'engagement':
      return (
        <>
          <Select value={c.state} onChange={(v) => set({ state: v })} options={[['active', t('hat Mails geöffnet oder geklickt')], ['inactive', t('öffnet und klickt nie, obwohl Mails ankamen')]]} />
          <span className="muted small">{t('in den letzten')}</span>
          <Days value={c.days} onChange={(v) => set({ days: v })} />
          {c.state === 'inactive' && (
            <>
              <span className="muted small">{t('bei mindestens')}</span>
              <Input type="number" min={1} max={100} value={c.min_received ?? 3} onChange={(v) => set({ min_received: Number(v) || 3 })} aria-label={t('Mindestens erhaltene Mails')} />
              <span className="muted small">{t('erhaltenen Mails')}</span>
            </>
          )}
        </>
      );
    case 'email_check':
      return (
        <>
          <span className="muted small">{t('E-Mail-Adresse ist')}</span>
          <Select value={c.verdict} onChange={(v) => set({ verdict: v })} options={[['ok', t('in Ordnung')], ['risky', t('riskant')], ['invalid', t('ungültig')], ['unchecked', t('noch nicht geprüft')]]} />
        </>
      );
    case 'dnd':
      return <Select value={bool(c.value !== false)} onChange={(v) => set({ value: v === 'yes' })} options={[['yes', t('hat „Nicht stören“')], ['no', t('hat kein „Nicht stören“')]]} />;
    default:
      return (
        <>
          <span className="muted small">{t('ist Mitglied in')}</span>
          <Select value={c.segment_id} onChange={(v) => set({ segment_id: v })} placeholder={t('Segment wählen …')} options={meta.segments.filter((s) => s.id !== selfId).map((s) => [s.id, s.name])} />
        </>
      );
  }
}

function GroupEditor({ g, onChange, onRemove, meta, depth, selfId }: { g: Group; onChange: (g: Group) => void; onRemove?: () => void; meta: Meta; depth: number; selfId?: string }) {
  const t = useT('campaigns');
  const setItem = (i: number, n: Node) => onChange({ ...g, items: g.items.map((x, j) => (j === i ? n : x)) });
  const removeItem = (i: number) => onChange({ ...g, items: g.items.filter((_, j) => j !== i) });
  const add = (type: string) => onChange({ ...g, items: [...g.items, blank(type)] });
  return (
    <div className="mk-group" data-tour={depth === 0 ? 'segment-builder' : undefined}>
      <div className="mk-group-head">
        <span>{depth === 0 ? t('Kontakte, bei denen') : t('Gruppe: gilt, wenn')}</span>
        <Select value={g.op} onChange={(v) => onChange({ ...g, op: v as 'and' | 'or' })} options={[['and', t('alle')], ['or', t('mindestens eine')]]} />
        <span>{g.op === 'and' ? t('dieser Bedingungen zutreffen') : t('dieser Bedingungen zutrifft')}</span>
        <label className="check" style={{ margin: 0 }}>
          <input type="checkbox" checked={!!g.negate} onChange={(e) => onChange({ ...g, negate: e.target.checked || undefined })} /> {t('umkehren (nicht)')}
        </label>
        {onRemove && (
          <button type="button" className="mk-x" onClick={onRemove} aria-label={t('Gruppe entfernen')}>
            ✕
          </button>
        )}
      </div>
      {g.items.length === 0 && <p className="muted small" style={{ margin: 0 }}>{t('Noch keine Bedingung – ohne Bedingung gehören alle Kontakte dazu.')}</p>}
      {g.items.map((n, i) => (
        <div key={i} className="mk-item">
          {n.type === 'group' ? (
            <GroupEditor g={n as Group} onChange={(x) => setItem(i, x)} onRemove={() => removeItem(i)} meta={meta} depth={depth + 1} selfId={selfId} />
          ) : (
            <>
              <div className="mk-cond">
                <span className="kind">{TYPE_LABEL[n.type] ? t(TYPE_LABEL[n.type]) : n.type}</span>
                <ConditionEditor c={n as Cond} onChange={(x) => setItem(i, x)} meta={meta} selfId={selfId} />
                <label className="neg">
                  <input type="checkbox" checked={!!n.negate} onChange={(e) => setItem(i, { ...n, negate: e.target.checked || undefined })} /> {t('nicht')}
                </label>
              </div>
              <button type="button" className="mk-x" onClick={() => removeItem(i)} aria-label={t('Bedingung entfernen')}>
                ✕
              </button>
            </>
          )}
        </div>
      ))}
      <div className="mk-add">
        <Select value="" onChange={(v) => v && add(v)} placeholder={t('+ Bedingung hinzufügen …')} options={ORDER.map((k) => [k, t(TYPE_LABEL[k])] as [string, string])} />
        {depth < Math.min(MAX_DEPTH, meta.limits.depth) - 1 && (
          <button type="button" className="btn secondary" onClick={() => onChange({ ...g, items: [...g.items, { ...emptyGroup(), op: g.op === 'and' ? 'or' : 'and' }] })}>
            {t('+ Gruppe')}
          </button>
        )}
      </div>
    </div>
  );
}

/** The count of the segment that is being edited, updated while the conditions change (nothing is saved). */
function LiveCount({ def }: { def: Group }) {
  const t = useT('campaigns');
  const d = useDebounced(def);
  const [r, setR] = useState<{ count: number; sample: { id: string; name: string; email: string }[]; summary: string } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    setBusy(true);
    api
      .post('/api/segments/count', { definition: d })
      .then((x) => n === seq.current && (setR(x), setErr('')))
      .catch((e) => n === seq.current && setErr((e as Error).message))
      .finally(() => n === seq.current && setBusy(false));
  }, [JSON.stringify(d)]);
  return (
    <div className="mk-live" data-tour="segment-count" aria-live="polite">
      {err ? (
        <span className="muted">{err}</span>
      ) : r ? (
        <>
          <div>
            <span className="big">{de(r.count)}</span> {t.plural(r.count, { other: 'Kontakte' })} {busy && <span className="muted small">{t('· zählt …')}</span>}
          </div>
          <div className="muted small">{r.summary || t('Alle Kontakte')}</div>
          {r.sample.length > 0 && (
            <div className="sample">
              {r.sample.map((s) => (
                <span key={s.id}>{s.name || s.email}</span>
              ))}
              {r.count > r.sample.length && <span>…</span>}
            </div>
          )}
        </>
      ) : (
        <Spinner />
      )}
    </div>
  );
}

function SegmentEditor({ seg, meta, onClose, onSaved }: { seg: any | null; meta: Meta; onClose: () => void; onSaved: () => void }) {
  const t = useT('campaigns');
  const [name, setName] = useState<string>(seg?.name ?? '');
  const [description, setDescription] = useState<string>(seg?.description ?? '');
  const [watch, setWatch] = useState(!!seg?.watch);
  const [def, setDef] = useState<Group>(seg?.definition ?? emptyGroup());
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const body = { name, description, definition: def, watch };
    const r = await act(() => (seg ? api.patch(`/api/segments/${seg.id}`, body) : api.post('/api/segments', body)), t('Segment gespeichert'));
    setBusy(false);
    if (r) {
      onSaved();
      onClose();
    }
  };
  return (
    <Modal
      title={seg ? t('Segment bearbeiten') : t('Neues Segment')}
      onClose={onClose}
      wide
      className="mk-modal"
      footer={
        <button className="btn" disabled={busy || !name.trim()} onClick={save} data-tour="segment-save">
          {t('Speichern')}
        </button>
      }
    >
      {!seg && (
        <div data-tour="segment-starters">
          <div className="muted small">{t('Schnellstart')}</div>
          <div className="mk-starters">
            {STARTERS.map((s) => (
              <button
                key={s.name}
                type="button"
                className="mk-chip"
                title={t(s.text)}
                onClick={() => {
                  setDef(s.def());
                  if (!name.trim()) setName(t(s.name));
                }}
              >
                {t(s.name)}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="grid2">
        <Field label="Name" tour="segment-name">
          <Input value={name} onChange={setName} placeholder={t('z. B. Interessenten ohne Kauf')} maxLength={120} />
        </Field>
        <Field label={t('Beschreibung (optional)')}>
          <Input value={description} onChange={setDescription} maxLength={500} />
        </Field>
      </div>
      <GroupEditor g={def} onChange={setDef} meta={meta} depth={0} selfId={seg?.id} />
      <Check checked={watch} onChange={setWatch} label={t('Beitritt und Austritt beobachten (startet Workflows mit „Kontakt tritt einem Segment bei / verlässt es“)')} tour="segment-watch" />
      <p className="muted small" style={{ marginTop: 0 }}>
        {t('Die Mitgliedschaft wird alle paar Minuten neu berechnet. Beim Einschalten werden die heutigen Mitglieder nur gemerkt, sie lösen nichts aus.')}
      </p>
      <LiveCount def={def} />
    </Modal>
  );
}

function Members({ seg, onClose }: { seg: any; onClose: () => void }) {
  const t = useT('campaigns');
  const r = useLoad(() => api.get(`/api/segments/${seg.id}/contacts?limit=100`), [seg.id]);
  return (
    <Modal title={t('Kontakte in „{name}“', { name: seg.name })} onClose={onClose} className="mk-modal">
      {!r.data ? (
        <Spinner />
      ) : (
        <>
          <p>
            <strong>{de(r.data.total)}</strong> {t.plural(r.data.total, { other: 'Kontakte' })} <span className="muted small">· {r.data.summary || t('Alle Kontakte')}</span>
          </p>
          {r.data.contacts.length ? (
            <table className="t">
              <tbody>
                {r.data.contacts.map((c: any) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={`contacts/${c.id}`}>{c.name || c.email || t('Ohne Namen')}</Link>
                    </td>
                    <td className="muted">{c.email}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>{t('Niemand erfüllt die Bedingungen im Moment.')}</Empty>
          )}
          {r.data.total > r.data.contacts.length && <p className="muted small">{t('Gezeigt werden die ersten {n}.', { n: r.data.contacts.length })}</p>}
        </>
      )}
    </Modal>
  );
}

export function Segments() {
  const t = useT('campaigns');
  const list = useLoad(() => api.get<any[]>('/api/segments'), []);
  const meta = useLoad(() => api.get<Meta>('/api/segments/meta'), []);
  const [edit, setEdit] = useState<any | 'new' | null>(null);
  const [members, setMembers] = useState<any>(null);
  const reload = () => {
    list.reload();
    meta.reload();
  };
  const remove = async (s: any) => {
    if (!confirmAsk(t('Segment „{name}“ löschen?', { name: s.name }))) return;
    if (await act(() => api.del(`/api/segments/${s.id}`), t('Segment gelöscht'))) reload();
  };
  const campaign = async (s: any) => {
    const r = await act(() => api.post('/api/campaigns', { name: t('Kampagne an „{name}“', { name: s.name }), filter: { segment_id: s.id } }));
    if (r) navigate(`campaigns/${r.id}`);
  };
  return (
    <div data-tour="segments-page">
      <div className="mk-actions" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <p className="muted mk-lead" style={{ margin: 0, flex: '1 1 320px' }}>
          {t('Segmente sind Zielgruppen nach Verhalten: wer hat geöffnet, geklickt, gekauft, ein Formular ausgefüllt oder lange nichts getan? Sie lassen sich in Kampagnen als Empfänger wählen und starten Workflows, wenn jemand dazukommt.')}
        </p>
        <button className="btn" disabled={!meta.data} onClick={() => setEdit('new')} data-tour="segment-new">
          {t('+ Segment')}
        </button>
      </div>
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.data?.length ? (
        <div className="mk-seg-list" data-tour="segments-list">
          {list.data.map((s) => (
            <div key={s.id} className="card mk-seg">
              <div>
                <strong>{s.name}</strong> {s.watch ? <Badge tone="blue">{t('beobachtet')}</Badge> : null}
                <p className="muted small sum">{s.summary || t('Alle Kontakte')}</p>
                {s.description && <p className="small" style={{ margin: '2px 0 0' }}>{s.description}</p>}
              </div>
              <div>
                <div className="count">{s.count === null || s.count === undefined ? '–' : de(s.count)}</div>
                <div className="muted small" style={{ textAlign: 'right' }}>{s.counted_at ? t('Stand {date}', { date: dt(s.counted_at) }) : t('noch nicht gezählt')}</div>
              </div>
              <div className="acts">
                <button className="btn secondary" disabled={!meta.data} onClick={() => setEdit(s)}>
                  {t('Bearbeiten')}
                </button>
                <button className="btn secondary" onClick={() => setMembers(s)}>
                  {t('Kontakte ansehen')}
                </button>
                <button className="btn secondary" onClick={() => act(() => api.post(`/api/segments/${s.id}/count`), t('Neu gezählt')).then(list.reload)}>
                  {t('Neu zählen')}
                </button>
                <button className="btn secondary" onClick={() => campaign(s)}>
                  {t('Kampagne starten')}
                </button>
                <button className="btn ghost" onClick={() => remove(s)}>
                  {t('Löschen')}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Empty tour="segments-list">{t('Noch keine Segmente. „+ Segment“ legt das erste an – mit Schnellstarts wie „Geklickt, aber nicht gekauft“.')}</Empty>
      )}
      {edit && meta.data && <SegmentEditor seg={edit === 'new' ? null : edit} meta={meta.data} onClose={() => setEdit(null)} onSaved={reload} />}
      {members && <Members seg={members} onClose={() => setMembers(null)} />}
    </div>
  );
}
