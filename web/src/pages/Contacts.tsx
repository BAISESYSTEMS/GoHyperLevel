import { useEffect, useState, type ReactNode } from 'react';
import { Icon, channelIcon } from '../icons';
import { api, d, dt, euro, msgStatus, name } from '../api';
import { ElsewhereHint } from './AgencyLists';
import { AiComposerAddon } from './AiAssistant';
import { MessageMedia, useMetaComposer, type ExtraChannel } from './MetaInbox';
import { CallButton, CallInfo } from './Calls';
import { ContactCourses } from './Courses';
import { AttributionFilter, ContactAttribution, attrQs, pickAttr, type AttrFilter } from './Attribution';
import { CanvasPin } from '../canvas/pin';
import { act, Badge, Check, confirmAsk, Empty, Field, Input, Link, Modal, navigate, PageHead, pressable, Select, Spinner, Tabs, Textarea, toast, useLoad, useRoute } from '../ui';
import { messageText } from './EmailBuilder';
import { MailEngagement } from './MailEngagement';
import { PluginPanels } from '../werkstatt/PluginFrame';
import { AssociationsPanel, CompanyFilter, companyQs, pickCompany, type CompanyFilterValue } from './ObjectKit';
import { ContactLeadScore, LeadScoreFilter, ScoreBadge, pickScore, scoreQs, useLeadScores, type ScoreFilterValue } from './LeadScoring';
import { ContactService, HealthBadge, HealthFilter, useHealthScores } from './HealthScore';
import { useTags } from '../tags';
import { ContactTagInput, TagChips } from '../tag-chip';
import { NotesPanel } from './NotesPlus';
import { Later, PageSuspense, lazyPages } from '../lazy';
import { IMPORT_CONSENT_DEFAULT, ImportConsentFields, type ImportConsent } from './ConsentKit';
import { useT } from '../i18n';
import { readCsvFile } from '../csv-file';
import { MoreFields, useSimple, useSimpleColumns } from '../areas/fields';
import { CONTACT_COLUMNS, CONTACT_ESSENTIAL, CONTACT_MAIN_FIELDS } from '../areas/easy-core';
import '../areas/easy-core.css';
import { ContactBulkOwner } from './ContactBulkOwner';
import { DraftNote, DraftOffer, finishDraft, useDraftFill, type ComposerDraft } from './MsgDrafts';
import { ColumnsButton, ExtraCells, ExtraHeads, SmartListBar, SortTh, useColumnFields, type ContactView, type SmartList } from './SmartLists';

const { ContactConsent } = lazyPages(() => import('./ConsentContact'), 'ContactConsent');
const { ContactDupeBanner, ContactSequences } = lazyPages(() => import('./ContactSales'), 'ContactDupeBanner', 'ContactSequences');

/** [field, German label] – the labels are message ids of the contacts catalog (shown through t()). */
const FIELDS: [string, string][] = [
  ['first_name', 'Vorname'],
  ['last_name', 'Nachname'],
  ['email', 'E-Mail'],
  ['phone', 'Telefon'],
  ['company', 'Firma'],
  ['website', 'Webseite'],
  ['address', 'Adresse'],
  ['postal_code', 'PLZ'],
  ['city', 'Ort'],
  ['country', 'Land'],
  ['date_of_birth', 'Geburtstag'],
  ['source', 'Quelle'],
];

const OPP_STATUS: Record<string, string> = { open: 'offen', won: 'gewonnen', lost: 'verloren', abandoned: 'aufgegeben' };
const APPT_STATUS: Record<string, string> = { confirmed: 'bestätigt', cancelled: 'abgesagt', showed: 'erschienen', noshow: 'nicht erschienen', blocked: 'blockiert' };

export { useTags };

function NewContact({ onClose, onSaved }: { onClose: () => void; onSaved: (c: any) => void }) {
  const t = useT('contacts');
  const [c, setC] = useState<any>({ tags: [] });
  const tags = useTags();
  const save = async () => {
    const r = await act(() => api.post('/api/contacts', c), t('Kontakt gespeichert'));
    if (r) onSaved(r);
  };
  return (
    <Modal title={t('Neuer Kontakt')} onClose={onClose} footer={<button className="btn" onClick={save}>{t('Speichern')}</button>}>
      <div className="grid2">
        {FIELDS.slice(0, 5).map(([k, l]) => (
          <Field key={k} label={t(l)} tour={`contact-${k}`}>
            <Input value={c[k]} onChange={(v) => setC({ ...c, [k]: v })} type={k === 'email' ? 'email' : 'text'} />
          </Field>
        ))}
      </div>
      {/* Einfach-Modus: website and tags behind "Weitere Felder" (inline in Profi) */}
      <MoreFields id="contact-new" values={[c.website, c.tags]} count={2}>
        <Field label={t('Webseite')} tour="contact-website">
          <Input value={c.website} onChange={(v) => setC({ ...c, website: v })} />
        </Field>
        <Field label={t('Tags')}>
          <ContactTagInput value={c.tags} onChange={(v) => setC({ ...c, tags: v })} suggestions={tags} />
        </Field>
      </MoreFields>
    </Modal>
  );
}

function ImportCsv({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useT('contacts');
  const [csv, setCsv] = useState('');
  const [tags, setTags] = useState('');
  const [wf, setWf] = useState(false);
  const [cons, setCons] = useState<ImportConsent>(IMPORT_CONSENT_DEFAULT);
  const [res, setRes] = useState<any>();
  return (
    <Modal
      title={t('Kontakte importieren (CSV)')}
      onClose={onClose}
      footer={
        res ? (
          <button className="btn" onClick={() => (onDone(), onClose())}>
            {t('Fertig')}
          </button>
        ) : (
          <button className="btn" disabled={!csv || (cons.consent === 'confirmed' && !cons.consent_note.trim())} onClick={async () => setRes(await act(() => api.post('/api/contacts/import', { csv, tags, triggerWorkflows: wf, ...cons })))}>
            {t('Importieren')}
          </button>
        )
      }
    >
      {res ? (
        <p>
          {t('{created} neu, {updated} aktualisiert, {skipped} übersprungen.', { created: res.created, updated: res.updated, skipped: res.skipped })}
          {res.consent && (
            <>
              <br />
              <span className="muted">
                {t('Einwilligung:')} {res.consent.mode === 'doi' ? t('Bestätigungs-Mails werden verschickt') : res.consent.mode === 'confirmed' ? t('als nachgewiesen vermerkt') : t('Altbestand ohne Nachweis vermerkt')} ({t.plural(res.consent.contacts, { one: '{n} Kontakt', other: '{n} Kontakte' })}).
              </span>
            </>
          )}
          <br />
          <span className="muted">{t('Erkannte Spalten: {list}', { list: res.mapped.join(', ') })}</span>
        </p>
      ) : (
        <>
          <p className="muted">{t('Kopfzeile mit z. B. Vorname, Nachname, E-Mail, Telefon, Firma, Tags. GHL-Exporte werden erkannt. Doppelte E-Mails/Telefonnummern werden zusammengeführt.')}</p>
          <Field label={t('Datei')}>
            <input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; setCsv(f ? await readCsvFile(f) : ''); }} />
          </Field>
          <Field label={t('…oder einfügen')}>
            <Textarea value={csv} onChange={setCsv} rows={6} placeholder={t('Vorname,Nachname,E-Mail')} />
          </Field>
          <Field label={t('Allen diese Tags geben (Komma-getrennt)')}>
            <Input value={tags} onChange={setTags} placeholder="import-2026" />
          </Field>
          <Check checked={wf} onChange={setWf} label={t('Workflows auslösen (z. B. Willkommens-Mail)')} />
          <ImportConsentFields value={cons} onChange={setCons} />
        </>
      )}
    </Modal>
  );
}

function BulkBar({ ids, onDone, workflows }: { ids: string[]; onDone: () => void; workflows: any[] }) {
  const t = useT('contacts');
  const [tag, setTag] = useState('');
  const [wf, setWf] = useState('');
  const bulk = async (action: string, extra: any = {}) => {
    const r = await act(() => api.post('/api/contacts/bulk', { ids, action, tag, ...extra }));
    if (r) {
      toast(t.plural(r.count, { one: '{n} Kontakt aktualisiert', other: '{n} Kontakte aktualisiert' }));
      onDone();
    }
  };
  return (
    <div className="card row" style={{ marginBottom: 12, alignItems: 'center' }}>
      <strong>{t('{n} ausgewählt', { n: ids.length })}</strong>
      <div style={{ width: 160 }}>
        <Input value={tag} onChange={setTag} placeholder={t('Tag')} aria-label={t('Tag')} />
      </div>
      <button className="btn small secondary" disabled={!tag} onClick={() => bulk('add_tag')}>
        + {t('Tag')}
      </button>
      <button className="btn small secondary" disabled={!tag} onClick={() => bulk('remove_tag')}>
        − {t('Tag')}
      </button>
      {/* Einfach-Modus: workflow and "Nicht stören" behind one "Mehr" */}
      <span className="filter-fold">
        <MoreFields id="contacts-bulk" label={t('Mehr')}>
          <div style={{ width: 200 }}>
            <Select value={wf} onChange={setWf} placeholder={t('In Workflow aufnehmen…')} options={workflows.filter((w) => w.status === 'active').map((w) => [w.id, w.name])} />
          </div>
          <button
            className="btn small secondary"
            disabled={!wf}
            onClick={async () => {
              const r = await act(() => api.post(`/api/workflows/${wf}/enroll`, { contact_ids: ids }));
              if (r) toast(t('{n} aufgenommen', { n: r.enrolled }));
            }}
          >
            {t('Starten')}
          </button>
          <ContactBulkOwner ids={ids} onDone={onDone} />
          <button className="btn small secondary" onClick={() => bulk('dnd', { value: true })}>
            {t('Nicht stören')}
          </button>
        </MoreFields>
      </span>
      <button className="btn small danger" onClick={() => confirmAsk(t.plural(ids.length, { one: '{n} Kontakt löschen?', other: '{n} Kontakte löschen?' })) && bulk('delete')}>
        {t('Löschen')}
      </button>
    </div>
  );
}

export function Contacts() {
  const t = useT('contacts');
  // The contact that is open next to the list (iPad): its row is marked.
  const route = useRoute();
  const openId = route[0] === 'contacts' ? route[1] : undefined;
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [attr, setAttr] = useState<AttrFilter>({});
  const [company, setCompany] = useState<CompanyFilterValue>({});
  const [score, setScore] = useState<ScoreFilterValue>({});
  const [sort, setSort] = useState('');
  const [dir, setDir] = useState('');
  // Smart Lists 2.0 (pages/SmartLists.tsx): the open list and its columns (null = the page's own column choice).
  const [active, setActive] = useState('');
  const [cols, setCols] = useState<string[] | null>(null);
  const [health, setHealth] = useState('');
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<string[]>([]);
  const [modal, setModal] = useState<'' | 'new' | 'import'>('');
  const tags = useTags();
  const workflows = useLoad(() => api.get<any[]>('/api/workflows'), []);
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(timer);
  }, [q]);
  const qs = `q=${encodeURIComponent(debounced)}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}${attrQs(attr)}${companyQs(company)}${scoreQs(score)}${health ? `&health=${health}` : ''}${sort ? `&sort=${encodeURIComponent(sort)}${dir ? `&dir=${dir}` : ''}` : ''}`;
  const { data, loading, reload } = useLoad(() => api.get(`/api/contacts?${qs}&limit=50&offset=${page * 50}`), [qs, page]);
  const all = data?.contacts ?? [];
  const leadScores = useLeadScores(all.map((c: any) => c.id));
  const scores = useHealthScores(all.map((c: any) => c.id));
  // Einfach-Modus: name, e-mail, phone and tags; the rest via the "Spalten" picker (web/src/areas/easy-core.ts).
  const columns = useSimpleColumns(
    'contacts',
    CONTACT_COLUMNS.filter((k) => k !== 'score' || leadScores.enabled),
    CONTACT_ESSENTIAL,
    { name: t('Name'), email: t('E-Mail'), phone: t('Telefon'), tags: t('Tags'), score: t('Lead-Score'), source: t('Quelle'), health: t('Health'), created: t('Angelegt') },
  );
  const fields = useColumnFields(
    { name: t('Name'), email: t('E-Mail'), phone: t('Telefon'), tags: t('Tags'), score: t('Lead-Score'), source: t('Quelle'), health: t('Health'), created: t('Angelegt') },
    CONTACT_COLUMNS.filter((k) => k !== 'score' || leadScores.enabled),
  );
  const visible = cols ?? columns.visible;
  const col = (k: string) => visible.includes(k);
  const onSort = (s: string, way: string) => (setSort(s), setDir(way), setPage(0));
  const filter = { q, tags: tag ? [tag] : [], ...attr, ...company, ...score, ...(health ? { health } : {}) };
  const view: ContactView = { filter, columns: visible, sort, sort_dir: dir };
  const apply = (l: SmartList | null) => {
    const f = l?.filter ?? {};
    setActive(l?.id ?? '');
    setQ(f.q ?? '');
    setTag(f.tags?.[0] ?? '');
    setAttr(pickAttr(f));
    setCompany(pickCompany(f));
    setScore(pickScore(f));
    setHealth(f.health ?? '');
    setSort(l?.sort ?? '');
    setDir(l?.sort_dir ?? '');
    setCols(l ? l.columns : null);
    setPage(0);
  };
  // Filters beyond search and tag: one "Weitere Filter" in Einfach-Modus – open when one is set, its count shown when folded.
  const extraFilters = [attrQs(attr), companyQs(company), scoreQs(score), health].filter(Boolean).length;

  return (
    <>
      <PageHead title={t('Kontakte')} sub={data ? t.plural(data.total, { one: '{n} Kontakt', other: '{n} Kontakte' }) : undefined}>
        <button className="btn secondary" data-tour="contacts-import" onClick={() => setModal('import')}>
          {t('Import')}
        </button>
        <a className="btn secondary" data-tour="contacts-export" href={`/api/contacts/export.csv?${qs}&locationId=${encodeURIComponent(localStorage.getItem('pghl.location') ?? '')}`}>
          {t('Export')}
        </a>
        <button className="btn" data-tour="contacts-new" onClick={() => setModal('new')}>
          + {t('Kontakt')}
        </button>
      </PageHead>
      <SmartListBar active={active} base={{ filter: { q: '', tags: [] }, columns: columns.visible, sort: '', sort_dir: '' }} current={view} onApply={apply} />
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="grow" data-tour="contacts-search">
          <Input value={q} onChange={(v) => (setQ(v), setPage(0))} placeholder={t('Name, E-Mail, Telefon, Firma…')} aria-label={t('Kontakte durchsuchen')} />
        </div>
        <div style={{ width: 200 }} data-tour="contacts-tags">
          <Select value={tag} onChange={(v) => (setTag(v), setPage(0))} placeholder={t('Alle Tags')} aria={t('Nach Tag filtern')} options={tags} />
        </div>
        <span className="filter-fold">
          <MoreFields id="contacts-filters" label={t('Weitere Filter')} values={[extraFilters || '']} count={extraFilters}>
            <AttributionFilter value={attr} onChange={(v) => (setAttr(v), setPage(0))} />
            <CompanyFilter value={company} onChange={(v) => (setCompany(v), setPage(0))} />
            <LeadScoreFilter value={score} onChange={(v) => (setScore(v), setPage(0))} />
            <HealthFilter value={health} onChange={(v) => (setHealth(v), setPage(0))} />
          </MoreFields>
        </span>
        {cols || !columns.picker ? <ColumnsButton fields={fields} value={visible} onChange={setCols} /> : columns.picker}
      </div>
      {sel.length > 0 && <BulkBar ids={sel} workflows={workflows.data ?? []} onDone={() => (setSel([]), reload())} />}
      {loading && !data ? (
        <Spinner />
      ) : all.length ? (
        <div className="table-wrap" data-tour="contacts-table">
          <table className="t">
            <thead>
              <tr>
                <th style={{ width: 30 }}>
                  <input type="checkbox" checked={sel.length === all.length} onChange={(e) => setSel(e.target.checked ? all.map((c: any) => c.id) : [])} aria-label={t('Alle wählen')} />
                </th>
                <SortTh k="name" label={t('Name')} sort={sort} dir={dir} onSort={onSort} />
                {col('email') && <SortTh k="email" label={t('E-Mail')} sort={sort} dir={dir} onSort={onSort} />}
                {col('phone') && <SortTh k="phone" label={t('Telefon')} sort={sort} dir={dir} onSort={onSort} />}
                {col('tags') && <th>{t('Tags')}</th>}
                {col('score') && (
                  <th>
                    <button type="button" className={`th-sort${sort === 'score' ? ' on' : ''}`} onClick={() => onSort(sort === 'score' ? '' : 'score', '')}>
                      {t('Lead-Score')} {sort === 'score' ? '↓' : ''}
                    </button>
                  </th>
                )}
                {col('source') && <SortTh k="source" label={t('Quelle')} sort={sort} dir={dir} onSort={onSort} />}
                {col('health') && <th>{t('Health')}</th>}
                {col('created') && <SortTh k="created" label={t('Angelegt')} sort={sort} dir={dir} onSort={onSort} />}
                <ExtraHeads keys={visible} fields={fields} sort={sort} dir={dir} onSort={onSort} />
              </tr>
            </thead>
            <tbody>
              {all.map((c: any) => (
                <tr key={c.id} className={`click${c.id === openId ? ' on' : ''}`} aria-selected={c.id === openId || undefined} {...pressable(() => navigate(`contacts/${c.id}`))}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={sel.includes(c.id)} onChange={(e) => setSel(e.target.checked ? [...sel, c.id] : sel.filter((x) => x !== c.id))} aria-label={t('Wählen')} />
                  </td>
                  <td>
                    <strong>{name(c)}</strong> {c.dnd ? <Badge tone="red">DND</Badge> : null}
                    {c.company && <div className="muted small">{c.company}</div>}
                    {/* only shown in the narrow list next to an open contact (web/src/ios/ios.css) */}
                    {c.email && <div className="muted small md-sub">{c.email}</div>}
                  </td>
                  {col('email') && <td>{c.email}</td>}
                  {col('phone') && <td>{c.phone}</td>}
                  {col('tags') && (
                    <td>
                      <TagChips tags={c.tags} max={4} />
                    </td>
                  )}
                  {col('score') && <td>{leadScores.map[c.id] ? <ScoreBadge score={leadScores.map[c.id].score} label={leadScores.map[c.id].label} /> : <span className="muted">–</span>}</td>}
                  {col('source') && <td className="muted">{c.source}</td>}
                  {col('health') && <td>{scores[c.id] ? <HealthBadge {...scores[c.id]} compact /> : <span className="muted">–</span>}</td>}
                  {col('created') && <td className="muted">{d(c.created_at)}</td>}
                  <ExtraCells keys={visible} contact={c} fields={fields} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <Empty learn action={<button className="btn" onClick={() => setModal('new')}>{t('Ersten Kontakt anlegen')}</button>}>{t('Keine Kontakte gefunden.')}</Empty>
          <ElsewhereHint kind="contacts" />
        </>
      )}
      {data && data.total > 50 && (
        <div className="row" style={{ marginTop: 12, justifyContent: 'center' }}>
          <button className="btn small secondary" disabled={!page} onClick={() => setPage(page - 1)}>
            ← {t('Zurück')}
          </button>
          <span className="muted">{t('Seite {page} von {pages}', { page: page + 1, pages: Math.ceil(data.total / 50) })}</span>
          <button className="btn small secondary" disabled={(page + 1) * 50 >= data.total} onClick={() => setPage(page + 1)}>
            {t('Weiter')} →
          </button>
        </div>
      )}
      {modal === 'new' && <NewContact onClose={() => setModal('')} onSaved={(c) => (setModal(''), navigate(`contacts/${c.id}`))} />}
      {modal === 'import' && <ImportCsv onClose={() => setModal('')} onDone={reload} />}
    </>
  );
}

export function Composer({ contact, onSent, templates, chat, addon, extra, initial, draft }: { contact: any; onSent: () => void; templates?: any[]; chat?: boolean; addon?: (a: { channel: string; setDraft: (body: string, subject?: string) => void }) => ReactNode; extra?: ExtraChannel[]; initial?: string; draft?: ComposerDraft }) {
  const t = useT('contacts');
  // An SMS/WhatsApp draft (agent, MCP) opens in its channel when that channel is offered here (MsgDrafts.tsx).
  const draftOk = !!draft && (draft.channel === 'sms' || !!extra?.some((x) => x.key === draft.channel));
  const [channel, setChannel] = useState<string>((draftOk && draft!.channel) || initial || (chat ? 'chat' : contact.email ? 'email' : 'sms'));
  // Channels from other modules (WhatsApp, Messenger, Instagram) bring their own editor.
  const ext = extra?.find((x) => x.key === channel);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  // A new draft fills the composer only when nothing of one's own is typed, else it is offered (useDraftFill). A WhatsApp draft
  // in the open WhatsApp tab is the panel's business; with another module's tab open its text is unknown, so it only offers.
  const fill = useDraftFill(draftOk && !(ext && draft!.channel === channel) ? draft : undefined, ext ? ' ' : body, (d) => {
    setChannel(d.channel);
    if (d.channel === 'sms') setBody(d.body);
  });
  const [busy, setBusy] = useState(false);
  const tpl = (templates ?? []).filter((x) => x.channel === channel);
  const send = async () => {
    setBusy(true);
    const r = await act(() => api.post('/api/messages', { contact_id: contact.id, channel, subject, body, ignoreDnd: contact.dnd && channel !== 'chat' ? confirmAsk(t('Kontakt hat „Nicht stören“. Trotzdem senden?')) : false }));
    setBusy(false);
    if (r) {
      if (r.status === 'failed') toast(t('Nicht gesendet: {error}', { error: r.error }));
      else {
        toast(r.status === 'logged' ? t('Gespeichert (kein Versand-Anbieter eingerichtet)') : t('Gesendet'));
        if (draft && draft.channel === channel) await finishDraft(draft.id);
      }
      setBody('');
      setSubject('');
      onSent();
    }
  };
  return (
    <div className="composer" data-tour="composer">
      {draft && <DraftNote draft={draft} available={draftOk} onDiscarded={onSent} />}
      {fill.offer && <DraftOffer onTake={fill.take} />}
      <div className="row" style={{ alignItems: 'center' }}>
        <Tabs tabs={[...(chat ? [['chat', t('Chat')] as [string, string]] : []), ['email', t('E-Mail')], ['sms', t('SMS')], ...(extra ?? []).map((x) => [x.key, x.label] as [string, string])]} value={channel} onChange={setChannel} />
        {tpl.length > 0 && (
          <div style={{ width: 200 }}>
            <Select
              value=""
              placeholder={t('Vorlage einfügen…')}
              options={tpl.map((x) => [x.id, x.name])}
              onChange={(v) => {
                const hit = tpl.find((x) => x.id === v);
                if (hit) {
                  setSubject(hit.subject);
                  setBody(hit.body);
                }
              }}
            />
          </div>
        )}
        {!ext && addon?.({ channel, setDraft: (b, s) => (setBody(b), s && setSubject(s)) })}
      </div>
      {channel === 'email' && <Input value={subject} onChange={setSubject} placeholder={t('Betreff')} aria-label={t('Betreff')} />}
      {ext?.render(onSent, draft?.channel === channel ? draft : undefined)}
      {!ext && <Textarea value={body} onChange={setBody} placeholder={channel === 'chat' ? t('Antwort im Website-Chat') : channel === 'email' ? t('Nachricht an {to}', { to: contact.email || t('(keine E-Mail)') }) : t('SMS an {to}', { to: contact.phone || t('(keine Nummer)') })} aria-label={t('Nachricht')} rows={4} />}
      {!ext && <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        {/* the placeholder warning only when someone actually types one */}
        <small className="muted">{channel === 'sms' ? t('{chars} Zeichen · {sms} SMS', { chars: body.length, sms: Math.max(1, Math.ceil(body.length / 160)) }) : body.includes('{{') ? t('Platzhalter wie {{contact.first_name}} gehen hier nicht – nur in Workflows/Kampagnen.') : null}</small>
        <button className="btn" disabled={!body || busy} onClick={send}>
          {t('Senden')}
        </button>
      </div>}
    </div>
  );
}

/** GDPR erasure: everything about the person in every area; invoices, signed contracts, sent reminders and the agency's projects stay (unlinked). */
function PrivacyErase({ contact, onClose }: { contact: any; onClose: () => void }) {
  const t = useT('contacts');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const want = String(contact.email || contact.id).toLowerCase();
  const run = async () => {
    setBusy(true);
    const r = await act(() => api.post(`/api/contacts/${contact.id}/erase`, { confirm }), t('Kontakt nach DSGVO gelöscht'));
    setBusy(false);
    if (r) {
      onClose();
      navigate('contacts');
    }
  };
  return (
    <Modal
      title={t('Kontakt nach DSGVO löschen')}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
          <button className="btn danger" disabled={busy || confirm.trim().toLowerCase() !== want} onClick={run}>
            {t('Endgültig löschen')}
          </button>
        </>
      }
    >
      <p>{t('Löscht {name} in allen Bereichen: Nachrichten, Termine, Formulare und hochgeladene Dateien, Tickets, Community, Kurse, Partnerdaten, Tracking. Das lässt sich nicht rückgängig machen.', { name: contact.name })}</p>
      <p className="muted">{t('Rechnungen, unterschriebene Verträge und versandte Mahnungen bleiben erhalten (gesetzliche Aufbewahrung), ebenso Projekte, Retainer und Ratenpläne – nur ohne Verknüpfung zum Kontakt.')}</p>
      <Field label={contact.email ? t('Zur Bestätigung die E-Mail-Adresse eingeben') : t('Zur Bestätigung die Kontakt-ID eingeben')} hint={want}>
        <Input value={confirm} onChange={setConfirm} autoFocus />
      </Field>
    </Modal>
  );
}

export function ContactDetail({ id }: { id: string }) {
  const t = useT('contacts');
  const { data: c, reload, setData } = useLoad(() => api.get(`/api/contacts/${id}`), [id]);
  const fields = useLoad(() => api.get<any[]>('/api/custom-fields'), []);
  const msgs = useLoad(() => api.get<any[]>(`/api/contacts/${id}/messages`), [id]);
  const opps = useLoad(() => api.get<any[]>(`/api/opportunities?contact_id=${id}&status=all`), [id]);
  const appts = useLoad(() => api.get<any[]>(`/api/appointments?contact_id=${id}&from=2000-01-01&to=2100-01-01`), [id]);
  const workflows = useLoad(() => api.get<any[]>('/api/workflows'), []);
  const pipelines = useLoad(() => api.get<any[]>('/api/pipelines'), []);
  const templates = useLoad(() => api.get<any[]>('/api/templates'), []);
  const tags = useTags();
  const [tab, setTab] = useState('activity');
  const [task, setTask] = useState({ title: '', due_at: '' });
  const [wf, setWf] = useState('');
  const [edit, setEdit] = useState<any>(null);
  const [erase, setErase] = useState(false);
  const meta = useMetaComposer(c, msgs.data);
  const simple = useSimple();
  if (!c) return <Spinner />;

  const save = async (patch: any) => {
    const r = await act(() => api.patch(`/api/contacts/${id}`, patch), t('Gespeichert'));
    if (r) setData({ ...c, ...r });
  };
  const isMain = (k: string) => (CONTACT_MAIN_FIELDS as readonly string[]).includes(k);
  const fieldInput = (k: string, l: string) => (
    <Field key={k} label={t(l)}>
      <Input value={edit[k]} onChange={(v) => setEdit({ ...edit, [k]: v })} type={k === 'date_of_birth' ? 'date' : 'text'} />
    </Field>
  );

  return (
    <>
      <PageHead title={c.name} sub={t('Angelegt {date} · Quelle: {source}', { date: dt(c.created_at), source: c.source || '–' })}>
        <Link to="contacts" className="btn secondary">
          ← {t('Kontakte')}
        </Link>
        <CanvasPin kind="contact" id={id} name={c.name} />
        <a className="btn secondary" data-tour="contact-privacy-export" href={`/api/contacts/${encodeURIComponent(id)}/privacy-export?locationId=${encodeURIComponent(localStorage.getItem('pghl.location') ?? '')}`} title={t('Alle gespeicherten Daten dieser Person als Datei (Art. 15 DSGVO)')}>
          {t('DSGVO-Auskunft')}
        </a>
        <button className="btn secondary" data-tour="contact-privacy-erase" onClick={() => setErase(true)} title={t('In allen Bereichen löschen (Art. 17 DSGVO)')}>
          {t('DSGVO-Löschung')}
        </button>
        <button
          className="btn danger"
          onClick={async () => {
            if (confirmAsk(t('Kontakt endgültig löschen?')) && (await act(() => api.del(`/api/contacts/${id}`), t('Gelöscht')))) navigate('contacts');
          }}
        >
          {t('Löschen')}
        </button>
      </PageHead>
      {erase && <PrivacyErase contact={c} onClose={() => setErase(false)} />}
      <Later>
        <ContactDupeBanner contactId={id} />
      </Later>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="card" style={{ flex: '1 1 300px', maxWidth: 380 }} data-tour="contact-card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>{t('Kontaktdaten')}</h2>
            {edit ? (
              <div className="actions">
                <button className="btn small secondary" onClick={() => setEdit(null)}>
                  {t('Abbrechen')}
                </button>
                <button className="btn small" onClick={async () => (await save(edit), setEdit(null))}>
                  {t('Speichern')}
                </button>
              </div>
            ) : (
              <button className="btn small secondary" onClick={() => setEdit({ ...Object.fromEntries(FIELDS.map(([k]) => [k, c[k] ?? ''])), custom: { ...c.custom } })}>
                {t('Bearbeiten')}
              </button>
            )}
          </div>
          {edit ? (
            <>
              {FIELDS.filter(([k]) => isMain(k)).map(([k, l]) => fieldInput(k, l))}
              {/* Einfach-Modus: address, birthday, source and custom fields behind "Weitere Felder" – open when one holds a value
                  (the source does not count: forms and imports set it, and the page head shows it anyway) */}
              <MoreFields id="contact-edit" values={[...FIELDS.filter(([k]) => !isMain(k) && k !== 'source').map(([k]) => edit[k]), ...Object.values(edit.custom ?? {})]} count={FIELDS.filter(([k]) => !isMain(k)).length + (fields.data ?? []).length}>
                {FIELDS.filter(([k]) => !isMain(k)).map(([k, l]) => fieldInput(k, l))}
                {(fields.data ?? []).length > 0 && <hr />}
                {(fields.data ?? []).map((f) => (
                  <Field key={f.id} label={f.label}>
                    {f.type === 'select' ? (
                      <Select value={edit.custom[f.key]} onChange={(v) => setEdit({ ...edit, custom: { ...edit.custom, [f.key]: v } })} placeholder="–" options={f.options} />
                    ) : f.type === 'textarea' ? (
                      <Textarea value={edit.custom[f.key]} onChange={(v) => setEdit({ ...edit, custom: { ...edit.custom, [f.key]: v } })} />
                    ) : (
                      <Input value={edit.custom[f.key]} type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} onChange={(v) => setEdit({ ...edit, custom: { ...edit.custom, [f.key]: v } })} />
                    )}
                  </Field>
                ))}
              </MoreFields>
            </>
          ) : (
            <>
              {FIELDS.map(([k, l]) =>
                c[k] ? (
                  <div key={k} style={{ marginBottom: 8 }}>
                    <div className="muted small">{t(l)}</div>
                    <div>{k === 'email' ? <a href={`mailto:${c[k]}`}>{c[k]}</a> : k === 'phone' ? <a href={`tel:${c[k]}`}>{c[k]}</a> : c[k]}</div>
                  </div>
                ) : null,
              )}
              {(fields.data ?? []).some((f) => c.custom?.[f.key] !== undefined && c.custom?.[f.key] !== '') && <hr />}
              {(fields.data ?? []).map((f) =>
                c.custom?.[f.key] !== undefined && c.custom?.[f.key] !== '' ? (
                  <div key={f.id} style={{ marginBottom: 8 }}>
                    <div className="muted small">{f.label}</div>
                    <div>{String(c.custom[f.key])}</div>
                  </div>
                ) : null,
              )}
            </>
          )}
          <hr />
          <Field label={t('Tags')} tour="contact-tags">
            <ContactTagInput value={c.tags} onChange={(v) => save({ tags: v })} suggestions={tags} />
          </Field>
          <Check checked={!!c.dnd} onChange={(v) => save({ dnd: v })} label={t('Nicht stören (keine Kampagnen/Workflows)')} />
          <hr />
          <MoreFields id="contact-automation" label={t('Workflows & Sequenzen')}>
          <Field label={t('In Workflow aufnehmen')} tour="contact-workflow">
            <div className="row">
              <div className="grow">
                <Select value={wf} onChange={setWf} placeholder={t('Workflow wählen…')} options={(workflows.data ?? []).filter((w) => w.status === 'active').map((w) => [w.id, w.name])} />
              </div>
              <button className="btn secondary" disabled={!wf} onClick={() => act(() => api.post(`/api/workflows/${wf}/enroll`, { contact_ids: [id] }), t('Aufgenommen')).then(reload)}>
                {t('Start')}
              </button>
            </div>
          </Field>
          <Later>
            <ContactSequences contactId={id} />
          </Later>
          </MoreFields>
          <div className="actions" data-tour="contact-actions">
            <CallButton contactId={id} phone={c.phone} onStarted={() => (msgs.reload(), reload())} />
            <button className="btn small secondary" onClick={() => act(() => api.post('/api/reviews/request', { contact_id: id }), t('Bewertungsanfrage gesendet')).then(() => msgs.reload())}>
              <Icon name="reviews" /> {t('Bewertung anfragen')}
            </button>
            <button className="btn small secondary" onClick={async () => {
              const inv = await act(() => api.post('/api/invoices', { contact_id: id, items: [{ name: t('Leistung'), qty: 1, price_cents: 0 }] }));
              if (inv) navigate(`invoices/${inv.id}`);
            }}>
              <Icon name="invoices" /> {t('Rechnung')}
            </button>
          </div>
        </div>

        <div style={{ flex: '2 1 420px', minWidth: 0 }}>
          <div className="card" style={{ padding: 0 }} data-tour="contact-timeline">
            <div style={{ padding: '6px 14px 0' }}>
              <Tabs
                tabs={[
                  ['activity', t('Aktivität')],
                  ['messages', t('Nachrichten ({n})', { n: msgs.data?.length ?? 0 })],
                  ['notes', t('Notizen ({n})', { n: c.notes.length })],
                  ['tasks', t('Aufgaben ({n})', { n: c.tasks.filter((x: any) => !x.done).length })],
                  ['consent', t('Einwilligung')],
                ]}
                value={tab}
                onChange={setTab}
              />
            </div>
            <div style={{ padding: '0 14px 14px' }}>
              {tab === 'activity' && (
                <ul className="timeline">
                  {c.activities.map((a: any) => (
                    <li key={a.id}>
                      <span className="muted small" style={{ minWidth: 110 }}>
                        {dt(a.created_at)}
                      </span>
                      <span>{a.summary}</span>
                    </li>
                  ))}
                </ul>
              )}
              {tab === 'messages' && (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 420, overflowY: 'auto', padding: '8px 0' }}>
                    {(msgs.data ?? []).map((m) => (
                      <div key={m.id} className={`bubble ${m.direction}${m.channel === 'call' ? ` call ${m.status}` : ''}`}>
                        {m.subject && (
                          <>
                            <strong>{m.subject}</strong>
                            <br />
                          </>
                        )}
                        {messageText(m.body)}
                        <MessageMedia m={m} />
                        {m.channel === 'call' && <CallInfo m={m} />}
                        <div className="meta">
                          <Icon name={channelIcon(m.channel)} size={12} /> {dt(m.created_at)} · {msgStatus(m.status)}
                          <MailEngagement m={m} />
                          {m.error ? ` – ${m.error}` : ''}
                        </div>
                      </div>
                    ))}
                    {!msgs.data?.length && <p className="muted">{t('Noch keine Nachrichten.')}</p>}
                  </div>
                  {meta.ready && <Composer key={c.id} contact={c} onSent={() => (msgs.reload(), reload())} templates={templates.data} extra={meta.extra} initial={meta.initial} addon={(a) => <AiComposerAddon contactId={c.id} {...a} />} />}
                </>
              )}
              {tab === 'notes' && <NotesPanel contactId={id} onChanged={reload} />}
              {tab === 'consent' && (
                <PageSuspense>
                  <ContactConsent contactId={id} />
                </PageSuspense>
              )}
              {tab === 'tasks' && (
                <>
                  <div className="row">
                    <div className="grow">
                      <Input value={task.title} onChange={(v) => setTask({ ...task, title: v })} placeholder={t('Neue Aufgabe')} aria-label={t('Neue Aufgabe')} />
                    </div>
                    <div style={{ width: 170 }}>
                      <Input type="date" value={task.due_at} onChange={(v) => setTask({ ...task, due_at: v })} aria-label={t('Fällig am')} />
                    </div>
                    <button className="btn" disabled={!task.title} aria-label={t('Aufgabe anlegen')} onClick={() => act(() => api.post('/api/tasks', { ...task, contact_id: id, due_at: task.due_at ? new Date(task.due_at).toISOString() : null })).then(() => (setTask({ title: '', due_at: '' }), reload()))}>
                      +
                    </button>
                  </div>
                  {c.tasks.map((x: any) => (
                    <Check key={x.id} checked={!!x.done} onChange={(v) => act(() => api.patch(`/api/tasks/${x.id}`, { done: v })).then(reload)} label={<span style={{ textDecoration: x.done ? 'line-through' : '' }}>{x.title} {x.due_at && <span className="muted small">{t('bis {date}', { date: d(x.due_at) })}</span>}</span>} />
                  ))}
                </>
              )}
            </div>
          </div>
        </div>

        <div style={{ flex: '1 1 260px', maxWidth: 340 }}>
          <PluginPanels on="contact" entityId={id} />
          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2>{t('Opportunities')}</h2>
              {pipelines.data?.[0] && (
                <button className="btn small secondary" aria-label={t('Opportunity anlegen')} onClick={() => act(() => api.post('/api/opportunities', { pipeline_id: pipelines.data![0].id, contact_id: id }), t('Angelegt')).then(() => opps.reload())}>
                  +
                </button>
              )}
            </div>
            {(opps.data ?? []).map((o) => {
              const p = pipelines.data?.find((x) => x.id === o.pipeline_id);
              return (
                <div key={o.id} style={{ marginBottom: 10 }}>
                  <Link to={`/app/opportunities?pipeline=${o.pipeline_id}`}>{o.name}</Link> <Badge tone={o.status === 'won' ? 'green' : o.status === 'lost' ? 'red' : 'blue'}>{OPP_STATUS[o.status] ? t(OPP_STATUS[o.status]) : o.status}</Badge>
                  <div className="muted small">
                    {p?.name} · {p?.stages.find((s: any) => s.id === o.stage_id)?.name} · {euro(o.value)}
                  </div>
                </div>
              );
            })}
            {!opps.data?.length && <p className="muted">{t('Keine.')}</p>}
          </div>
          {/* no appointments: no card saying so */}
          {(appts.data ?? []).length > 0 && (
            <div className="card">
              <h2>{t('Termine')}</h2>
              {(appts.data ?? []).map((a) => (
                <div key={a.id} style={{ marginBottom: 8 }}>
                  {dt(a.start_at)} <Badge tone={a.status === 'cancelled' || a.status === 'noshow' ? 'red' : a.status === 'showed' ? 'green' : 'blue'}>{APPT_STATUS[a.status] ? t(APPT_STATUS[a.status]) : a.status}</Badge>
                  <div className="muted small">{a.calendar_name}</div>
                </div>
              ))}
            </div>
          )}
          {!simple && <ContactLeadScore contactId={id} />}
          <AssociationsPanel type="contact" id={id} title={t('Firmen & Verknüpfungen')} exclude={['opportunity', 'task']} onChange={reload} />
          {/* Einfach-Modus: lead score, service, courses and origin behind one toggle (Profi: in place, as always) */}
          <MoreFields id="contact-side" label={t('Mehr zum Kontakt')}>
            {simple && <ContactLeadScore contactId={id} />}
            <ContactService contactId={id} />
            <ContactCourses contactId={id} />
            <ContactAttribution contactId={id} />
          </MoreFields>
        </div>
      </div>
    </>
  );
}
