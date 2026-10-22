import { useState } from 'react';
import { Icon } from '../icons';
import { api, currentLocation, dt, name } from '../api';
import { act, Check, CodeBox, confirmAsk, Empty, Field, Input, Link, Modal, navigate, PageHead, pressable, Select, Spinner, Tabs, TagInput, Textarea, useLoad } from '../ui';
import { useTags } from '../tags';
import { FormConsentSetting } from './FormConsent';
import { FormTicketSetting } from './HelpdeskSettings';
import { Later, PageSuspense, lazyPages } from '../lazy';
import { useT } from '../i18n';
import { MoreFields } from '../areas/fields';
import { WordPressPluginCard } from './WordPressPlugin';

// Typeform depth (field options, jumps, templates, design, scoring, analytics) loads when the editor needs it.
const { FieldOptions, JumpsEditor, TemplateGallery } = lazyPages(() => import('./FormFields'), 'FieldOptions', 'JumpsEditor', 'TemplateGallery');
// Company/deal/object mapping of a field (behind "Weitere Felder" in Einfach-Modus).
const { FormMapPicker } = lazyPages(() => import('./FormMapping'), 'FormMapPicker');
const { FlowPanel, ScoringPanel, DesignPanel, SecurityPanel, FormAnalytics, SubmissionExtras } = lazyPages(() => import('./FormDesign'), 'FlowPanel', 'ScoringPanel', 'DesignPanel', 'SecurityPanel', 'FormAnalytics', 'SubmissionExtras');

// German labels (message ids of the forms catalog), shown through t()
const TYPES: [string, string][] = [
  ['text', 'Text'],
  ['email', 'E-Mail'],
  ['phone', 'Telefon'],
  ['textarea', 'Mehrzeilig'],
  ['select', 'Auswahl (Dropdown)'],
  ['radio', 'Auswahl (Radio)'],
  ['checkbox', 'Checkbox(en)'],
  ['date', 'Datum'],
  ['number', 'Zahl'],
  ['consent', 'Einwilligung (DSGVO)'],
  ['file', 'Datei-Upload'],
  ['hidden', 'Verstecktes Feld'],
  ['heading', 'Überschrift'],
  ['page_break', '— Seitenumbruch (Umfrage) —'],
  ['rating', 'Bewertung (Sterne)'],
  ['nps', 'Weiterempfehlung (NPS 0–10)'],
  ['scale', 'Skala / Schieberegler'],
  ['picture_choice', 'Bildauswahl'],
  ['ranking', 'Rangfolge (sortieren)'],
  ['date_range', 'Zeitraum (von – bis)'],
  ['signature', 'Unterschrift'],
  ['payment', 'Zahlung (Stripe)'],
  ['calculator', 'Rechner (berechnetes Ergebnis)'],
];
const ONLY_NAMED = ['rating', 'nps', 'scale', 'signature', 'date_range', 'ranking', 'picture_choice', 'payment', 'calculator'];
function Answer({ v }: { v: any }) {
  const t = useT('forms');
  const text = Array.isArray(v) ? v.join(', ') : String(v);
  if (!/\/api\/form-files\//.test(text)) return <>{text}</>;
  return (
    <>
      {text.split('\n').map((u, i) => (
        <a key={i} href={u} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>
          <Icon name="file" size={13} /> {t('Datei')} {i + 1}
        </a>
      ))}
    </>
  );
}

const OPS: [string, string][] = [
  ['eq', 'ist'],
  ['neq', 'ist nicht'],
  ['contains', 'enthält'],
  ['gt', 'ist größer als'],
  ['gte', 'ist mindestens'],
  ['lt', 'ist kleiner als'],
  ['lte', 'ist höchstens'],
  ['filled', 'ist ausgefüllt'],
  ['empty', 'ist leer'],
];

function ShowIf({ field, fields, onChange }: { field: any; fields: any[]; onChange: (v: any) => void }) {
  const t = useT('forms');
  const c = field.show_if;
  const others = fields.filter((x) => x.id !== field.id && !['heading', 'page_break', 'file', 'signature', 'payment', 'calculator'].includes(x.type));
  const src = others.find((x) => x.name === c?.field);
  if (!c)
    return (
      <p>
        <button className="btn small secondary" disabled={!others.length} onClick={() => onChange({ field: others[0]?.name, op: 'eq', value: others[0]?.options?.[0] ?? '' })}>
          {t('+ Nur anzeigen, wenn…')}
        </button>
      </p>
    );
  return (
    <Field label={t('Nur anzeigen, wenn')}>
      <div className="row" style={{ alignItems: 'center' }}>
        <Select value={c.field} onChange={(v) => onChange({ ...c, field: v })} options={others.map((x) => [x.name, x.label || x.name])} />
        <Select value={c.op} onChange={(v) => onChange({ ...c, op: v })} options={OPS.map(([k, l]) => [k, t(l)] as [string, string])} />
        {!['filled', 'empty'].includes(c.op) &&
          (src?.options?.length ? (
            <Select value={c.value} onChange={(v) => onChange({ ...c, value: v })} options={src.options} />
          ) : (
            <Input value={c.value} onChange={(v) => onChange({ ...c, value: v })} placeholder={t('Wert')} />
          ))}
        <button className="btn small secondary" onClick={() => onChange(null)} title={t('Bedingung entfernen')}>
          ✕
        </button>
      </div>
    </Field>
  );
}

const MAP: [string, string][] = [
  ['first_name', 'Kontakt: Vorname'],
  ['last_name', 'Kontakt: Nachname'],
  ['name', 'Kontakt: voller Name'],
  ['email', 'Kontakt: E-Mail'],
  ['phone', 'Kontakt: Telefon'],
  ['company', 'Kontakt: Firma'],
  ['address', 'Kontakt: Adresse'],
  ['city', 'Kontakt: Ort'],
  ['postal_code', 'Kontakt: PLZ'],
  ['website', 'Kontakt: Webseite'],
];

export function Forms() {
  const t = useT('forms');
  const forms = useLoad(() => api.get<any[]>('/api/forms'), []);
  const [modal, setModal] = useState(false);
  const [gallery, setGallery] = useState(false);
  const [n, setN] = useState('');
  const [kind, setKind] = useState('form');
  return (
    <>
      <PageHead title={t('Formulare & Umfragen')} sub={t('Leads landen direkt im CRM und starten Workflows')}>
        <button className="btn secondary" data-tour="forms-templates" onClick={() => setGallery(true)}>
          {t('Vorlagen')}
        </button>
        <button className="btn" data-tour="forms-new" onClick={() => setModal(true)}>
          {t('+ Formular')}
        </button>
      </PageHead>
      {forms.loading && !forms.data ? (
        <Spinner />
      ) : forms.data?.length ? (
        <div className="table-wrap" data-tour="forms-list">
          <table className="t">
            <thead>
              <tr>
                <th>Name</th>
                <th>{t('Typ')}</th>
                <th>{t('Felder')}</th>
                <th>{t('Einsendungen')}</th>
                <th>{t('Geändert')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {forms.data.map((f) => (
                <tr key={f.id} className="click" {...pressable(() => navigate(`forms/${f.id}`))}>
                  <td>
                    <strong>{f.name}</strong>
                  </td>
                  <td>{f.kind === 'survey' ? t('Umfrage') : t('Formular')}</td>
                  <td>{f.fields.length}</td>
                  <td>{f.submissions}</td>
                  <td className="muted">{dt(f.updated_at)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <a className="btn small secondary" href={f.url} target="_blank" rel="noreferrer">
                      {t('Öffnen ↗')}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty learn action={<><button className="btn" onClick={() => setGallery(true)}>{t('Aus Vorlage starten')}</button> <button className="btn secondary" onClick={() => setModal(true)}>{t('Leeres Formular')}</button></>}>{t('Noch keine Formulare. Es gibt über zwanzig fertige Vorlagen – vom Kontaktformular über NPS-Umfrage und Quiz bis zur Angebotsanfrage.')}</Empty>
      )}
      {gallery && (
        <PageSuspense>
          <TemplateGallery onClose={() => setGallery(false)} />
        </PageSuspense>
      )}
      {modal && (
        <Modal
          title={t('Neues Formular')}
          onClose={() => setModal(false)}
          footer={
            <button
              className="btn"
              onClick={async () => {
                const f = await act(() => api.post('/api/forms', { name: n || t('Kontaktformular'), kind }));
                if (f) navigate(`forms/${f.id}`);
              }}
            >
              {t('Anlegen')}
            </button>
          }
        >
          <Field label="Name" tour="form-name">
            <Input value={n} onChange={setN} placeholder={t('Kontaktformular')} autoFocus />
          </Field>
          <Field label={t('Typ')} tour="form-kind">
            <Select value={kind} onChange={setKind} options={[['form', t('Formular')], ['survey', t('Umfrage (mehrstufig)')]]} />
          </Field>
        </Modal>
      )}
      <WordPressPluginCard />
    </>
  );
}

export function FormEditor({ id }: { id: string }) {
  const t = useT('forms');
  const form = useLoad(() => api.get(`/api/forms/${id}`), [id]);
  const subs = useLoad(() => api.get<any[]>(`/api/forms/${id}/submissions`), [id]);
  const fields = useLoad(() => api.get<any[]>('/api/custom-fields'), []);
  const pipelines = useLoad(() => api.get<any[]>('/api/pipelines'), []);
  const tags = useTags();
  const [tab, setTab] = useState('fields');
  const [sel, setSel] = useState(0);
  const [preview, setPreview] = useState(0);
  if (!form.data) return <Spinner />;
  const f = form.data;
  const set = (patch: any) => form.setData({ ...f, ...patch });
  const setField = (i: number, patch: any) => set({ fields: f.fields.map((x: any, j: number) => (j === i ? { ...x, ...patch } : x)) });
  const s = f.settings ?? {};
  const setS = (patch: any) => set({ settings: { ...s, ...patch } });
  const save = async () => {
    const r = await act(() => api.patch(`/api/forms/${id}`, { name: f.name, fields: f.fields, settings: f.settings }), t('Gespeichert'));
    if (r) {
      form.setData(r);
      setPreview(preview + 1);
    }
  };
  const field = f.fields[sel];
  const mapOptions: [string, string][] = [...MAP.map(([k, l]) => [k, t(l)] as [string, string]), ...(fields.data ?? []).map((c: any) => [`custom.${c.key}`, t('Eigenes Feld: {label}', { label: c.label })] as [string, string])];
  const move = (i: number, dir: number) => {
    const a = [...f.fields];
    [a[i], a[i + dir]] = [a[i + dir], a[i]];
    set({ fields: a });
    setSel(i + dir);
  };
  const pipe = pipelines.data?.find((p) => p.id === s.pipeline_id);

  return (
    <>
      <PageHead title={f.name}>
        <Link to="forms" className="btn secondary">
          {t('← Formulare')}
        </Link>
        <button className="btn danger" onClick={async () => confirmAsk(t('Formular löschen?')) && (await act(() => api.del(`/api/forms/${id}`))) && navigate('forms')}>
          {t('Löschen')}
        </button>
        <button className="btn" data-tour="form-save" onClick={save}>
          {t('Speichern')}
        </button>
      </PageHead>
      <Tabs tabs={[['fields', t('Felder')], ['design', t('Design & Ablauf')], ['logic', t('Punkte & Ergebnis')], ['settings', t('Einstellungen')], ['analytics', t('Auswertung')], ['share', t('Teilen / Einbetten')], ['subs', t('Einsendungen ({n})', { n: subs.data?.length ?? 0 })]]} value={tab} onChange={setTab} />
      {tab === 'fields' && (
        <div className="builder">
          <div>
            <div className="blocklist" data-tour="form-fields">
              {f.fields.map((x: any, i: number) => (
                <div key={x.id + i} className={`blk${i === sel ? ' on' : ''}`} {...pressable(() => setSel(i))}>
                  <span className="grow">
                    {x.type === 'page_break' ? t('— Seitenumbruch —') : x.label || x.name} <span className="muted small">{t(TYPES.find((ty) => ty[0] === x.type)?.[1] ?? '')}</span>
                  </span>
                  <button className="icon-btn" disabled={!i} onClick={(e) => (e.stopPropagation(), move(i, -1))} aria-label={t('Hoch')}>
                    ↑
                  </button>
                  <button className="icon-btn" disabled={i === f.fields.length - 1} onClick={(e) => (e.stopPropagation(), move(i, 1))} aria-label={t('Runter')}>
                    ↓
                  </button>
                </div>
              ))}
            </div>
            <button className="btn small secondary" data-tour="form-add-field" onClick={() => (set({ fields: [...f.fields, { id: `f${Date.now()}`, type: 'text', label: t('Neues Feld'), name: `feld_${f.fields.length + 1}` }] }), setSel(f.fields.length))}>
              {t('+ Feld')}
            </button>
            {field && (
              <div className="card" style={{ marginTop: 12 }}>
                <Field label={t('Typ')}>
                  <Select value={field.type} onChange={(v) => setField(sel, { type: v })} options={TYPES.map(([k, l]) => [k, t(l)] as [string, string])} />
                </Field>
                {field.type !== 'page_break' && (
                  <Field label={field.type === 'heading' ? t('Text') : t('Beschriftung')}>
                    <Input value={field.label} onChange={(v) => setField(sel, { label: v })} />
                  </Field>
                )}
                {!['page_break', 'heading'].includes(field.type) && (
                  <>
                    <Field label={t('Speichern in')} hint={t('Kontaktfeld, eigenes Feld – oder nur in der Einsendung')}>
                      <Select value={mapOptions.some((m) => m[0] === field.name) ? field.name : ''} onChange={(v) => setField(sel, { name: v || `feld_${sel + 1}` })} placeholder={t('Nur Einsendung')} options={mapOptions} />
                    </Field>
                    {['select', 'radio', 'checkbox', 'ranking', 'picture_choice'].includes(field.type) && (
                      <Field label={t('Optionen (eine pro Zeile)')}>
                        <Textarea value={(field.options ?? []).join('\n')} onChange={(v) => setField(sel, { options: v.split('\n') })} />
                      </Field>
                    )}
                    {field.type === 'hidden' && (
                      <Field label={t('Wert')}>
                        <Input value={field.value} onChange={(v) => setField(sel, { value: v })} />
                      </Field>
                    )}
                    {!['calculator', 'payment'].includes(field.type) && <Check checked={!!field.required} onChange={(v) => setField(sel, { required: v })} label={t('Pflichtfeld')} />}
                    <PageSuspense key={field.id}>
                      <FieldOptions field={field} setField={(p) => setField(sel, p)} capabilities={f.capabilities} fields={f.fields} variables={s.variables} />
                    </PageSuspense>
                  </>
                )}
                {field.type !== 'page_break' && (
                  // Einfach-Modus: placeholder, key, conditions and jumps of the field behind one toggle
                  <MoreFields key={field.id} id="form-field" values={[field.type !== 'hidden' && field.placeholder, field.show_if, field.jumps, s.mapping?.fields?.[field.id]]}>
                    {!['heading'].includes(field.type) && !mapOptions.some((m) => m[0] === field.name) && (
                      <Field label={t('Feld-Schlüssel')}>
                        <Input value={field.name} onChange={(v) => setField(sel, { name: v })} />
                      </Field>
                    )}
                    {!['heading', 'hidden'].includes(field.type) && !ONLY_NAMED.includes(field.type) && (
                      <Field label={field.type === 'file' ? t('Erlaubte Dateitypen (leer = Bilder, PDF, Office, ZIP)') : t('Platzhalter')}>
                        <Input value={field.placeholder} onChange={(v) => setField(sel, { placeholder: v })} />
                      </Field>
                    )}
                    {!['heading'].includes(field.type) && (
                      <PageSuspense key={`m${field.id}`}>
                        <FormMapPicker formId={id} field={field} s={s} setS={setS} />
                      </PageSuspense>
                    )}
                    <ShowIf field={field} fields={f.fields} onChange={(show_if) => setField(sel, { show_if })} />
                    <PageSuspense key={`j${field.id}`}>
                      <JumpsEditor field={field} index={sel} fields={f.fields} mode={s.mode === 'typeform' ? 'typeform' : 'classic'} onChange={(jumps) => setField(sel, { jumps })} />
                    </PageSuspense>
                  </MoreFields>
                )}
                <button className="btn small danger" onClick={() => (set({ fields: f.fields.filter((_: any, j: number) => j !== sel) }), setSel(Math.max(0, sel - 1)))}>
                  {t('Feld entfernen')}
                </button>
              </div>
            )}
          </div>
          <div>
            <p className="muted small">{t('Vorschau (nach dem Speichern aktualisiert)')}</p>
            <iframe key={preview} className="preview-frame" data-tour="form-preview" src={`/f/${id}`} title={t('Vorschau')} />
          </div>
        </div>
      )}
      {tab === 'design' && (
        <PageSuspense key="design">
          <div style={{ display: 'grid', gap: 14 }}>
            <FlowPanel s={s} setS={setS} />
            <DesignPanel f={f} s={s} setS={setS} previewKey={preview} />
          </div>
          <div className="actions" style={{ marginTop: 12 }}>
            <button className="btn" onClick={save}>
              {t('Speichern')}
            </button>
          </div>
        </PageSuspense>
      )}
      {tab === 'logic' && (
        <PageSuspense key="logic">
          <div style={{ maxWidth: 820 }}>
            <ScoringPanel s={s} setS={setS} fields={f.fields} />
            <div className="actions" style={{ marginTop: 12 }}>
              <button className="btn" onClick={save}>
                {t('Speichern')}
              </button>
            </div>
          </div>
        </PageSuspense>
      )}
      {tab === 'analytics' && (
        <PageSuspense key="analytics">
          <FormAnalytics id={id} />
        </PageSuspense>
      )}
      {tab === 'settings' && (
        <div className="card" style={{ maxWidth: 720 }}>
          <Field label={t('Name (intern)')}>
            <Input value={f.name} onChange={(v) => set({ name: v })} />
          </Field>
          <Field label={t('Überschrift (öffentlich)')}>
            <Input value={s.title} onChange={(v) => setS({ title: v })} />
          </Field>
          <Field label={t('Danke-Text')}>
            <Textarea value={s.thank_you} onChange={(v) => setS({ thank_you: v })} />
          </Field>
          <Field label={t('Tags für neue Leads')}>
            <TagInput value={s.tags ?? []} onChange={(v) => setS({ tags: v })} suggestions={tags} />
          </Field>
          <Check checked={s.notify_team !== false} onChange={(v) => setS({ notify_team: v })} label={t('Team bei jeder Einsendung per E-Mail benachrichtigen')} />
          <MoreFields id="form-settings" values={[s.description, s.submit_text !== 'Absenden' && s.submit_text, s.color, s.redirect_url, s.pipeline_id, s.notify_email, s.consent, s.create_ticket]}>
            <Field label={t('Beschreibung')}>
              <Textarea value={s.description} onChange={(v) => setS({ description: v })} />
            </Field>
            <div className="grid2">
              <Field label={t('Button-Text')}>
                <Input value={s.submit_text} onChange={(v) => setS({ submit_text: v })} />
              </Field>
              <Field label={t('Farbe')}>
                <input type="color" value={s.color || '#2563eb'} onChange={(e) => setS({ color: e.target.value })} />
              </Field>
            </div>
            <Field label={t('…oder weiterleiten zu')}>
              <Input value={s.redirect_url} onChange={(v) => setS({ redirect_url: v })} placeholder="https://…" />
            </Field>
            <div className="grid2">
              <Field label={t('Opportunity anlegen in')}>
                <Select value={s.pipeline_id} onChange={(v) => setS({ pipeline_id: v, stage_id: '' })} placeholder={t('– keine –')} options={(pipelines.data ?? []).map((p) => [p.id, p.name])} />
              </Field>
              {pipe && (
                <Field label={t('Stufe')}>
                  <Select value={s.stage_id} onChange={(v) => setS({ stage_id: v })} options={pipe.stages.map((x: any) => [x.id, x.name])} />
                </Field>
              )}
            </div>
            {s.notify_team !== false && (
              <Field label={t('Benachrichtigung an (leer = Firmen-E-Mail)')}>
                <Input value={s.notify_email} onChange={(v) => setS({ notify_email: v })} />
              </Field>
            )}
            <FormConsentSetting s={s} setS={setS} fields={f.fields} />
            <FormTicketSetting s={s} setS={setS} />
          </MoreFields>
          <button className="btn" onClick={save}>
            {t('Speichern')}
          </button>
        </div>
      )}
      {tab === 'settings' && (
        <div style={{ maxWidth: 720, marginTop: 14 }}>
          <MoreFields id="form-security" label={t('Spam-Schutz')} values={[s.captcha?.enabled]}>
            <PageSuspense key="security">
              <SecurityPanel s={s} setS={setS} onKeys={() => void form.reload()} />
            </PageSuspense>
          </MoreFields>
          <div className="actions" style={{ marginTop: 12 }}>
            <button className="btn" onClick={save}>
              {t('Speichern')}
            </button>
          </div>
        </div>
      )}
      {tab === 'share' && (
        <div className="card" style={{ maxWidth: 820 }} data-tour="form-share">
          <Field label={t('Direkter Link')}>
            <CodeBox text={f.url} />
          </Field>
          <Field label={t('In jede Webseite einbetten (WordPress, Wix…)')} hint={t('Höhe passt sich automatisch an')}>
            <CodeBox text={f.embed} />
          </Field>
          <p className="muted">{t('In eigenen Funnels: Block „Formular“ wählen. UTM-Parameter der Seite werden mitgespeichert.')}</p>
        </div>
      )}
      {tab === 'subs' && (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>{t('Datum')}</th>
                <th>{t('Kontakt')}</th>
                <th>{t('Antworten')}</th>
                <th>{t('Quelle')}</th>
              </tr>
            </thead>
            <tbody>
              {(subs.data ?? []).map((x) => (
                <tr key={x.id}>
                  <td className="muted">
                    {dt(x.created_at)}
                    <br />
                    <a className="small" href={`/api/forms/${id}/submissions/${x.id}/pdf?locationId=${currentLocation()}`} target="_blank" rel="noreferrer">
                      {t('PDF')}
                    </a>
                  </td>
                  <td>{x.contact_id ? <Link to={`contacts/${x.contact_id}`}>{name(x)}</Link> : '–'}</td>
                  <td className="small">
                    {Object.entries(x.data).map(([k, v]) => (
                      <div key={k}>
                        <strong>{k}:</strong> <Answer v={v} />
                      </div>
                    ))}
                    <Later>
                      <SubmissionExtras meta={x.meta} />
                    </Later>
                  </td>
                  <td className="muted small">{[x.meta.utm_source, x.meta.utm_campaign].filter(Boolean).join(' / ') || x.meta.page}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!subs.data?.length && <Empty>{t('Noch keine Einsendungen.')}</Empty>}
        </div>
      )}
    </>
  );
}
