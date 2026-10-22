import { useEffect, useState } from 'react';
import { Icon } from '../icons';
import { api, dt, name } from '../api';
import { act, Badge, Check, confirmAsk, Empty, Field, Input, Link, MergeHint, Modal, navigate, PageHead, pressable, Select, Spinner, Tabs, TagInput, Textarea, toast, useLoad } from '../ui';
import { useTags } from '../tags';
import { EmailDesignField, designPlainText } from './EmailBuilder';
import { MailBanner, mailWarning } from './UmzugMailBanner';
import { MACHINE_HINT } from './MailEngagement';
import { ShareLink } from '../QrCode';
import { ThrottleBox } from './CampaignThrottle';
import { AbResults, AbSetup, ResendCard } from './CampaignAb';
import { SegmentPick, SenderField, SenderHealth, SendTimeCard, WhatsAppCard } from './CampaignExtras';
import { lazyPages } from '../lazy';
import './marketing.css';
import { fmtDateTime, useT } from '../i18n';
import { TagChips } from '../tag-chip';
import { MoreFields } from '../areas/fields';
import { campaignMoreValues } from '../areas/marketing-fields';

// The marketing pages are their own chunks: they load when their tab opens.
const { Segments } = lazyPages(() => import('./Segments'), 'Segments');
const { EmailGallery, GalleryPicker } = lazyPages(() => import('./EmailGallery'), 'EmailGallery', 'GalleryPicker');
const { Deliverability } = lazyPages(() => import('./Deliverability'), 'Deliverability');

// German labels (message ids of the campaigns catalog), shown through t()
const STATUS: Record<string, [string, any]> = { draft: ['Entwurf', 'gray'], scheduled: ['geplant', 'yellow'], testing: ['A/B-Test läuft', 'purple'], sending: ['wird gesendet', 'blue'], sent: ['gesendet', 'green'] };
const CHANNEL: Record<string, string> = { email: 'E-Mail', sms: 'SMS', whatsapp: 'WhatsApp' };
/** Recipient states of the sending loop: held = waits for the winner of an A/B test. */
const RECIPIENT: Record<string, [string, any]> = { sent: ['gesendet', 'green'], failed: ['Fehler', 'red'], pending: ['ausstehend', 'gray'], sending: ['wird gesendet', 'blue'], held: ['wartet auf Gewinner', 'purple'], skipped: ['übersprungen', 'gray'] };
const TABS: [string, string][] = [['campaigns', 'Kampagnen'], ['segments', 'Segmente'], ['gallery', 'Vorlagengalerie'], ['templates', 'Vorlagen'], ['deliverability', 'Zustellbarkeit'], ['links', 'Trigger-Links']];

function Templates() {
  const t = useT('campaigns');
  const list = useLoad(() => api.get<any[]>('/api/templates'), []);
  const [edit, setEdit] = useState<any>(null);
  const save = async () => {
    const r = await act(() => (edit.id ? api.patch(`/api/templates/${edit.id}`, edit) : api.post('/api/templates', edit)), t('Vorlage gespeichert'));
    if (r) {
      setEdit(null);
      list.reload();
    }
  };
  return (
    <>
      <p>
        <button className="btn" data-tour="templates-new" onClick={() => setEdit({ name: '', channel: 'email', subject: '', body: '' })}>
          {t('+ Vorlage')}
        </button>
      </p>
      {(list.data ?? []).map((tpl) => (
        <div key={tpl.id} className="card row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <strong>{tpl.name}</strong> <Badge>{t(CHANNEL[tpl.channel] ?? 'E-Mail')}</Badge> {tpl.design && <Badge tone="purple">{t('Designer')}</Badge>}
            <div className="muted small">{tpl.subject || tpl.body.slice(0, 80)}</div>
          </div>
          <div className="actions">
            <button className="btn small secondary" onClick={() => setEdit(tpl)}>
              {t('Bearbeiten')}
            </button>
            <button className="btn small ghost" onClick={() => confirmAsk(t('Löschen?')) && act(() => api.del(`/api/templates/${tpl.id}`)).then(list.reload)}>
              {t('Löschen')}
            </button>
          </div>
        </div>
      ))}
      {!list.data?.length && <Empty>{t('Vorlagen sparen Tipparbeit im Posteingang und in Workflows.')}</Empty>}
      {edit && (
        <Modal title={t('Vorlage')} onClose={() => setEdit(null)} footer={<button className="btn" onClick={save}>{t('Speichern')}</button>}>
          <div className="grid2">
            <Field label="Name" tour="template-name">
              <Input value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} />
            </Field>
            <Field label={t('Kanal')}>
              <Select value={edit.channel} onChange={(v) => setEdit({ ...edit, channel: v })} options={[['email', t('E-Mail')], ['sms', 'SMS']]} />
            </Field>
          </div>
          {edit.channel === 'email' && (
            <Field label={t('Betreff')}>
              <Input value={edit.subject} onChange={(v) => setEdit({ ...edit, subject: v })} />
            </Field>
          )}
          {edit.channel === 'email' && (
            <div className="field" data-tour="template-design">
              <span>{t('Inhalt')}</span>
              <EmailDesignField
                design={edit.design}
                subject={edit.subject ?? ''}
                mode="template"
                onChange={async (r) => {
                  const body = { name: edit.name || t('Neue Vorlage'), channel: 'email', subject: r.subject, design: r.design };
                  const saved = edit.id ? await api.patch(`/api/templates/${edit.id}`, body) : await api.post('/api/templates', body);
                  setEdit(saved);
                  list.reload();
                  toast(t('Vorlage gespeichert'));
                }}
                onRemove={() => setEdit({ ...edit, design: null, body: designPlainText(edit.body_text), is_html: 0 })}
              />
            </div>
          )}
          {(edit.channel === 'sms' || !edit.design) && (
            <Field label={t('Text')}>
              <Textarea value={edit.body} onChange={(v) => setEdit({ ...edit, body: v })} rows={8} />
            </Field>
          )}
          <MergeHint />
        </Modal>
      )}
    </>
  );
}

function Engagement({ id }: { id: string }) {
  const t = useT('campaigns');
  const e = useLoad(() => api.get(`/api/campaigns/${id}/engagement`), [id]);
  if (!e.data) return null;
  // What machines did (Apple Mail, Gmail proxy, link scanners) is listed apart and never counted as a person.
  const why = (e.data.machine ?? []).map((x: any) => `${x.label}: ${x.count}×`).join('\n');
  const hint = why ? `${t(MACHINE_HINT)}\n\n${why}` : t(MACHINE_HINT);
  const note = (n: number) =>
    n > 0 ? (
      <div className="muted small mail-machine" title={hint}>
        {t('+{n} maschinell', { n })}
      </div>
    ) : null;
  return (
    <div className="card" data-tour="campaign-engagement">
      <h2>{t('Öffnungen & Klicks')}</h2>
      <div className="row">
        <div className="grow">
          <div className="muted small">{t('Geöffnet')}</div>
          <div className="stat-value">{e.data.open_rate}%</div>
          <div className="muted small">{t('{n} von {total}', { n: e.data.opened, total: e.data.sent })}</div>
          {note(e.data.machine_opened)}
        </div>
        <div className="grow">
          <div className="muted small">{t('Geklickt')}</div>
          <div className="stat-value">{e.data.click_rate}%</div>
          <div className="muted small">{t.plural(e.data.clicked, { other: '{n} Personen' })}</div>
          {note(e.data.machine_clicked)}
        </div>
      </div>
      {e.data.links.length > 0 && (
        <table className="t" style={{ marginTop: 8 }}>
          <tbody>
            {e.data.links.map((l: any) => (
              <tr key={l.url}>
                <td className="small" style={{ wordBreak: 'break-all' }}>{l.url}</td>
                <td style={{ textAlign: 'right' }}>
                  {l.clicks}×
                  {l.machine_clicks > 0 && (
                    <span className="muted small mail-machine" title={t(MACHINE_HINT)}>
                      {' '}
                      {t('+{n} maschinell', { n: l.machine_clicks })}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small" title={t(MACHINE_HINT)}>
        {t('Nur Aufrufe von Personen; Apple Mail, Gmail-Proxy und Scanner zählen als „maschinell“. Richtwerte.')}
      </p>
    </div>
  );
}

function TriggerLinks() {
  const t = useT('campaigns');
  const list = useLoad(() => api.get<any[]>('/api/trigger-links'), []);
  const tags = useTags();
  const [f, setF] = useState<any>({ name: '', url: '', tags: [] });
  return (
    <>
      <p className="muted">
        {t('Kurzlinks, die bei Klick Tags vergeben und Workflows starten (Auslöser „Trigger-Link geklickt“).')}
      </p>
      <div className="card row" style={{ alignItems: 'flex-end' }}>
        <div className="grow">
          <Field label="Name">
            <Input value={f.name} onChange={(v) => setF({ ...f, name: v })} placeholder={t('Webinar-Anmeldung')} />
          </Field>
        </div>
        <div className="grow">
          <Field label={t('Ziel-URL')}>
            <Input value={f.url} onChange={(v) => setF({ ...f, url: v })} placeholder="https://…" />
          </Field>
        </div>
        <div className="grow">
          <Field label={t('Tags bei Klick')}>
            <TagInput value={f.tags} onChange={(v) => setF({ ...f, tags: v })} suggestions={tags} />
          </Field>
        </div>
        <button className="btn" style={{ marginBottom: 12 }} disabled={!f.name || !f.url} onClick={() => act(() => api.post('/api/trigger-links', f), t('Link angelegt')).then(() => (setF({ name: '', url: '', tags: [] }), list.reload()))}>
          {t('Anlegen')}
        </button>
      </div>
      {(list.data ?? []).map((l) => (
        <div key={l.id} className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <strong>{l.name}</strong> → <span className="muted small">{l.url}</span>
              <div className="small">
                <TagChips tags={l.tags} />
              </div>
            </div>
            <div className="muted">
              {[t.plural(l.clicks, { other: '{n} Klicks' }), t.plural(l.unique_contacts, { other: '{n} Kontakte' })].join(' · ')}{' '}
              <button className="btn small ghost" onClick={() => confirmAsk(t('Link löschen?')) && act(() => api.del(`/api/trigger-links/${l.id}`)).then(list.reload)}>
                {t('Löschen')}
              </button>
            </div>
          </div>
          <div style={{ marginTop: 8 }}>
            <ShareLink url={l.short_url} title={t('Trigger-Link {name}', { name: l.name })} />
          </div>
        </div>
      ))}
    </>
  );
}

export function Campaigns({ tab: initial }: { tab?: string }) {
  const t = useT('campaigns');
  const [tab, setTab] = useState(TABS.some(([k]) => k === initial) ? (initial as string) : 'campaigns');
  // The deep links campaigns/segments, campaigns/gallery and campaigns/deliverability open their tab.
  useEffect(() => {
    if (initial && TABS.some(([k]) => k === initial)) setTab(initial);
  }, [initial]);
  const list = useLoad(() => api.get<any[]>('/api/campaigns'), []);
  return (
    <>
      <PageHead title={t('Kampagnen')} sub={t('E-Mail-, SMS- und WhatsApp-Kampagnen an Tags, Smart Lists oder Segmente')}>
        <button
          className="btn"
          data-tour="campaigns-new"
          onClick={async () => {
            const r = await act(() => api.post('/api/campaigns', { name: t('Neue Kampagne') }));
            if (r) navigate(`campaigns/${r.id}`);
          }}
        >
          {t('+ Kampagne')}
        </button>
      </PageHead>
      <Tabs tabs={TABS.map(([k, l]) => [k, t(l)] as [string, string])} value={tab} onChange={setTab} />
      {tab === 'links' ? (
        <TriggerLinks />
      ) : tab === 'templates' ? (
        <Templates />
      ) : tab === 'segments' ? (
        <Segments />
      ) : tab === 'gallery' ? (
        <EmailGallery />
      ) : tab === 'deliverability' ? (
        <Deliverability />
      ) : list.loading && !list.data ? (
        <Spinner />
      ) : list.data?.length ? (
        <div className="table-wrap" data-tour="campaigns-list">
          <table className="t">
            <thead>
              <tr>
                <th>Name</th>
                <th>{t('Kanal')}</th>
                <th>Status</th>
                <th>{t('Gesendet / Fehler')}</th>
                <th>{t('Datum')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id} className="click" {...pressable(() => navigate(`campaigns/${c.id}`))}>
                  <td>
                    <strong>{c.name}</strong>
                    {c.ab?.variants ? (
                      <>
                        {' '}
                        <Badge tone="purple">{t('A/B')}</Badge>
                      </>
                    ) : null}
                    {c.parent_id ? (
                      <>
                        {' '}
                        <Badge>{t('Erinnerung')}</Badge>
                      </>
                    ) : null}
                  </td>
                  <td>{t(CHANNEL[c.channel] ?? 'E-Mail')}</td>
                  <td>
                    <Badge tone={STATUS[c.status]?.[1]}>{STATUS[c.status] ? t(STATUS[c.status][0]) : c.status}</Badge>
                  </td>
                  <td>
                    {c.stats.sent ?? 0} / {c.stats.failed ?? 0}
                    {c.stats.held ? <span className="muted small"> · {t('{n} warten', { n: c.stats.held })}</span> : null}
                  </td>
                  <td className="muted">{dt(c.sent_at || c.scheduled_at || c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty learn>{t('Noch keine Kampagnen.')}</Empty>
      )}
    </>
  );
}

export function CampaignEditor({ id }: { id: string }) {
  const t = useT('campaigns');
  const c = useLoad(() => api.get(`/api/campaigns/${id}`), [id]);
  const lists = useLoad(() => api.get<any[]>('/api/smart-lists'), []);
  const rec = useLoad(() => api.get<any[]>(`/api/campaigns/${id}/recipients`), [id]);
  const tags = useTags();
  const [aud, setAud] = useState<any>();
  const [testQ, setTestQ] = useState('');
  const [testVariant, setTestVariant] = useState('');
  const [when, setWhen] = useState('');
  const [waCat, setWaCat] = useState<string>();
  const [gallery, setGallery] = useState(false);
  const data = c.data;
  useEffect(() => {
    if (!data || data.status !== 'draft') return;
    const timer = setTimeout(() => api.post(`/api/campaigns/${id}/audience`, { filter: data.filter, channel: data.channel, ...(data.channel === 'whatsapp' && waCat ? { wa_category: waCat } : {}) }).then(setAud), 300);
    return () => clearTimeout(timer);
  }, [JSON.stringify(data?.filter), data?.channel, waCat]);
  // A test or follow-up in progress changes by itself: look again now and then (sending campaigns, A/B tests waiting for their winner).
  useEffect(() => {
    if (!data || !['sending', 'testing'].includes(data.status)) return;
    const timer = setInterval(() => (c.reload(), rec.reload()), 30_000);
    return () => clearInterval(timer);
  }, [data?.status]);
  if (!data) return <Spinner />;
  const locked = !['draft', 'scheduled'].includes(data.status);
  const set = (patch: any) => c.setData({ ...data, ...patch });
  const f = data.filter ?? {};
  const email = data.channel === 'email';
  /** What the server may change on a draft; everything else of the page is read-only data. */
  const save = () =>
    act(
      () =>
        api.patch(`/api/campaigns/${id}`, {
          name: data.name,
          channel: data.channel,
          subject: data.subject,
          body: data.body,
          is_html: data.is_html,
          filter: data.filter,
          speed_per_hour: data.speed_per_hour ?? null,
          design: email ? data.design ?? null : undefined,
          send_mode: email ? data.send_mode ?? 'now' : 'now',
          sender_name: email ? data.sender_name ?? '' : '',
          ab: email ? data.ab ?? null : null,
          resend: email ? data.resend ?? null : null,
          wa_template: data.channel === 'whatsapp' ? data.wa_template ?? null : null,
        }),
      t('Gespeichert'),
    );
  const stats = data.stats ?? {};
  const more = campaignMoreValues(data);

  return (
    <>
      <PageHead title={data.name} sub={<Badge tone={STATUS[data.status]?.[1]}>{STATUS[data.status] ? t(STATUS[data.status][0]) : data.status}</Badge>}>
        <Link to="campaigns" className="btn secondary">
          {t('← Kampagnen')}
        </Link>
        {!locked && (
          <button className="btn secondary" onClick={save}>
            {t('Speichern')}
          </button>
        )}
        {data.status === 'draft' && (
          <button className="btn danger" onClick={async () => confirmAsk(t('Entwurf löschen?')) && (await act(() => api.del(`/api/campaigns/${id}`))) && navigate('campaigns')}>
            {t('Löschen')}
          </button>
        )}
      </PageHead>
      {data.parent_id && (
        <p className="mk-note">
          {t('Das ist die Erinnerung an alle, die')} <Link to={`campaigns/${data.parent_id}`}>{t('die erste Kampagne')}</Link>
          {/* the English catalog moves "did not open" before the link */}
          {t(' nicht geöffnet haben.')}
        </p>
      )}
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: '2 1 420px', minWidth: 0 }}>
          <div className="card">
            <div className="grid2">
              <Field label="Name" tour="campaign-name">
                <Input value={data.name} onChange={(v) => set({ name: v })} disabled={locked} />
              </Field>
              <Field label={t('Kanal')} tour="campaign-channel">
                <Select value={data.channel} onChange={(v) => set({ channel: v })} options={[['email', t('E-Mail')], ['sms', 'SMS'], ['whatsapp', 'WhatsApp']]} />
              </Field>
            </div>
            {email && (
              <Field label={t('Betreff')} tour="campaign-subject">
                <Input value={data.subject} onChange={(v) => set({ subject: v })} disabled={locked} />
              </Field>
            )}
            {email && (
              <div className="field" data-tour="campaign-design">
                <span>{t('Inhalt')}</span>
                <EmailDesignField
                  design={data.design}
                  subject={data.subject}
                  mode="campaign"
                  disabled={locked}
                  onChange={async (r) => {
                    const res = await api.patch(`/api/campaigns/${id}`, { name: data.name, subject: r.subject, filter: data.filter, design: r.design });
                    // The page keeps what has not been saved yet (test setup, follow-up, send time).
                    c.setData({ ...data, ...res, ab: data.ab, resend: data.resend, send_mode: data.send_mode, sender_name: data.sender_name });
                    toast(t('Kampagne gespeichert'));
                  }}
                  onRemove={() => set({ design: null, body: designPlainText(data.body_text), is_html: 0 })}
                />
                {!locked && (
                  <div className="mk-actions" style={{ marginTop: 8 }}>
                    <button type="button" className="btn secondary" style={{ minHeight: 44 }} data-tour="campaign-gallery" onClick={async () => (await save()) && setGallery(true)}>
                      {t('Aus der Galerie wählen')}
                    </button>
                  </div>
                )}
              </div>
            )}
            {data.channel === 'whatsapp' && <WhatsAppCard data={data} set={set} locked={locked} onCategory={setWaCat} />}
            {data.channel !== 'whatsapp' && (data.channel !== 'email' || !data.design) && (
              <>
                <Field label={t('Text')}>
                  <Textarea value={data.body} onChange={(v) => set({ body: v })} rows={12} disabled={locked} />
                </Field>
                <MergeHint />
              </>
            )}
            {email && (
              <MoreFields id="campaign-content" values={more.content}>
                <SenderField data={data} set={set} locked={locked} />
                {!data.design && <Check checked={!!data.is_html} onChange={(v) => set({ is_html: v })} label={t('Text ist HTML')} />}
              </MoreFields>
            )}
            {email && (
              <p className="muted small">
                {data.design ? t('Im Designer ist ein Footer mit Firmenadresse und Abmeldelink Pflicht (DSGVO/UWG).') : t('Jede E-Mail bekommt automatisch Absender-Adresse und Abmeldelink (DSGVO/UWG).')} <Link to="settings/consent">{t('Einwilligung')}</Link>
              </p>
            )}
          </div>
          {email && !locked && (
            <MoreFields id="campaign-extras" label={t('A/B-Test & Erinnerung an Nicht-Öffner')} values={more.extras}>
              <AbSetup data={data} set={set} locked={locked} />
              <ResendCard data={data} set={set} locked={locked} reload={c.reload} />
            </MoreFields>
          )}
          {email && locked && <AbResults data={data} reload={() => (c.reload(), rec.reload())} />}
          {email && locked && <ResendCard data={data} set={set} locked={locked} reload={c.reload} />}
        </div>
        <div style={{ flex: '1 1 300px' }}>
          <div className="card" data-tour="campaign-audience">
            <h2>{t('Empfänger')}</h2>
            <Field label={t('Smart List')}>
              <Select value={f.smart_list_id} onChange={(v) => set({ filter: { ...f, smart_list_id: v } })} placeholder="–" options={(lists.data ?? []).map((l) => [l.id, l.name])} />
            </Field>
            <Field label={t('Mit allen Tags')}>
              <TagInput value={f.tags ?? []} onChange={(v) => set({ filter: { ...f, tags: v } })} suggestions={tags} />
            </Field>
            <MoreFields id="campaign-audience" values={more.audience}>
              <SegmentPick filter={f} onChange={(nf) => set({ filter: nf })} disabled={locked} />
              <Field label={t('Mit einem dieser Tags')}>
                <TagInput value={f.anyTags ?? []} onChange={(v) => set({ filter: { ...f, anyTags: v } })} suggestions={tags} />
              </Field>
              <Field label={t('Ohne Tags')}>
                <TagInput value={f.excludeTags ?? []} onChange={(v) => set({ filter: { ...f, excludeTags: v } })} suggestions={tags} />
              </Field>
            </MoreFields>
            {data.parent_id && <p className="muted small">{t('Empfänger: alle, die die erste Kampagne bekommen und nicht geöffnet haben (bei Versand ermittelt).')}</p>}
            {aud && (
              <p>
                <strong>{aud.reachable}</strong> {t('erreichbar')} <span className="muted">{t(email ? 'von {total} (ohne DND / fehlende E-Mail)' : 'von {total} (ohne DND / fehlende Nummer)', { total: aud.total })}</span>
                {aud.no_consent > 0 && (
                  <span className="muted" data-tour="campaign-no-consent">
                    {' '}
                    · <strong>{aud.no_consent}</strong> {t('ohne gültige Einwilligung werden übersprungen')} (<Link to="settings/consent">{t('Versandregel')}</Link>)
                  </span>
                )}
                {aud.bad_address > 0 && (
                  <span className="muted">
                    {' '}
                    · <strong>{aud.bad_address}</strong> {t('mit ungültiger Adresse werden übersprungen')} (<Link to="campaigns/deliverability">{t('Adressprüfung')}</Link>)
                  </span>
                )}
              </p>
            )}
          </div>
          {!locked && (
            <div className="card" data-tour="campaign-send">
              <h2>{t('Testen')}</h2>
              <Field label={t('Testkontakt (ID oder E-Mail suchen)')}>
                <Input value={testQ} onChange={setTestQ} placeholder={t('deine@email.de')} />
              </Field>
              {data.ab?.enabled && (
                <Field label={t('Variante')}>
                  <Select value={testVariant || 'A'} onChange={setTestVariant} options={data.ab.variants.map((v: any) => [v.key, v.key === 'A' ? t('A (Original)') : t('Variante {key}', { key: v.key })] as [string, string])} />
                </Field>
              )}
              <button
                className="btn secondary"
                disabled={!testQ}
                onClick={async () => {
                  if (!(await save())) return;
                  const r = await api.get(`/api/contacts?q=${encodeURIComponent(testQ)}&limit=1`);
                  if (!r.contacts[0]) return act(() => Promise.reject(new Error(t('Kontakt nicht gefunden – erst anlegen'))));
                  await act(() => api.post(`/api/campaigns/${id}/test`, { contact_id: r.contacts[0].id, ...(data.ab?.enabled ? { variant: testVariant || 'A' } : {}) }), t('Test an {name} gesendet', { name: name(r.contacts[0]) }));
                }}
              >
                {t('Test senden')}
              </button>
              <hr />
              <h2>{t('Versand')}</h2>
              {email && <MailBanner />}
              <SenderHealth data={data} reach={aud?.reachable} />
              <Field label={t('Geplant für (leer = sofort)')}>
                <Input type="datetime-local" value={when} onChange={setWhen} />
              </Field>
              <MoreFields id="campaign-sending" label={t('Sendezeit je Kontakt & Geschwindigkeit')} values={more.sending}>
                <SendTimeCard data={data} set={set} locked={locked} beforePreview={save} />
                <ThrottleBox data={data} remaining={aud?.reachable ?? data.throttle?.remaining ?? 0} onChange={(speed) => set({ speed_per_hour: speed })} />
              </MoreFields>
              <button
                className="btn"
                onClick={async () => {
                  const warn = email ? await mailWarning() : '';
                  const test = data.ab?.enabled ? `\n\n${t('A/B-Test: {pct} % bekommen die Varianten, der Rest die Gewinner-Variante nach {hours} Stunden.', { pct: data.ab.test_percent, hours: data.ab.wait_hours })}` : '';
                  const question = when ? t('Kampagne für {date} planen?', { date: fmtDateTime(when) }) : aud?.reachable != null ? t.plural(aud.reachable, { other: 'Jetzt an {n} Kontakte senden?' }) : t('Jetzt an {n} Kontakte senden?', { n: '?' });
                  if (!confirmAsk(`${warn ? `${warn}\n\n` : ''}${question}${test}`)) return;
                  if (!(await save())) return;
                  const r = await act(() => api.post(`/api/campaigns/${id}/send`, when ? { scheduled_at: new Date(when).toISOString() } : {}), when ? t('Geplant') : t('Versand gestartet'));
                  if (r) {
                    c.reload();
                    rec.reload();
                  }
                }}
              >
                {when ? t('Planen') : t('Jetzt senden')}
              </button>
              {data.status === 'scheduled' && (
                <p className="muted">
                  {t('Geplant:')} {dt(data.scheduled_at)}{' '}
                  <a href="#" onClick={(e) => (e.preventDefault(), act(() => api.post(`/api/campaigns/${id}/cancel`)).then(c.reload))}>
                    {t('abbrechen')}
                  </a>
                </p>
              )}
            </div>
          )}
          {locked && <Engagement id={id} />}
          {locked && (
            <div className="card">
              <h2>{t('Ergebnis')}</h2>
              <p>
                <Icon name="ok" color="var(--green)" /> {t('{n} gesendet', { n: stats.sent ?? 0 })} · <Icon name="fail" color="var(--red)" /> {t('{n} Fehler', { n: stats.failed ?? 0 })} · <Icon name="pending" /> {t('{n} ausstehend', { n: stats.pending ?? 0 })}
                {stats.held ? <> · {t('{n} warten auf den Gewinner', { n: stats.held })}</> : null}
              </p>
              {['sending', 'testing'].includes(data.status) && (
                <>
                  {data.status === 'sending' && <SenderHealth data={data} />}
                  {data.status === 'sending' && (
                    <ThrottleBox data={data} remaining={stats.pending ?? 0} live onChange={(speed) => act(() => api.put(`/api/campaigns/${id}/speed`, { speed_per_hour: speed }), speed ? t('Geschwindigkeit geändert') : t('Standard-Geschwindigkeit')).then((r) => r && c.setData({ ...data, ...r }))} />
                  )}
                  <button className="btn small secondary" onClick={() => act(() => api.post(`/api/campaigns/${id}/cancel`)).then(c.reload)}>
                    {t('Abbrechen')}
                  </button>
                </>
              )}
              <button className="btn small ghost" onClick={() => (c.reload(), rec.reload())}>
                {t('Aktualisieren')}
              </button>
            </div>
          )}
        </div>
      </div>
      {(rec.data ?? []).length > 0 && (
        <div className="table-wrap" style={{ marginTop: 14 }}>
          <table className="t">
            <thead>
              <tr>
                <th>{t('Empfänger')}</th>
                {data.ab?.enabled && <th>{t('Variante')}</th>}
                <th>Status</th>
                <th>{t('Zeit')}</th>
              </tr>
            </thead>
            <tbody>
              {rec.data!.slice(0, 300).map((r) => (
                <tr key={r.contact_id}>
                  <td>
                    <Link to={`contacts/${r.contact_id}`}>{name(r)}</Link>
                  </td>
                  {data.ab?.enabled && <td>{r.variant || '–'}</td>}
                  <td>
                    <Badge tone={RECIPIENT[r.status]?.[1] ?? 'gray'}>{RECIPIENT[r.status] ? t(RECIPIENT[r.status][0]) : r.status}</Badge> <span className="muted small">{r.error}</span>
                    {r.send_at && r.status === 'pending' && <span className="muted small"> · {t('geplant {date}', { date: dt(r.send_at) })}</span>}
                  </td>
                  <td className="muted">{dt(r.sent_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {gallery && <GalleryPicker campaignId={id} onClose={() => setGallery(false)} onUsed={c.reload} />}
    </>
  );
}
