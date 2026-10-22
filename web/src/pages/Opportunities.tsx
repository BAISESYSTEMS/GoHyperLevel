import { useEffect, useState } from 'react';
import { ElsewhereHint } from './AgencyLists';
import { api, name } from '../api';
import { CanvasPin } from '../canvas/pin';
import { act, confirmAsk, Field, Input, Link, Modal, PageHead, Select, Spinner, Tabs, Textarea, toastError, useLoad } from '../ui';
import { lazyPages } from '../lazy';
import { AssociationsPanel, DealProperties } from './ObjectKit';
import { PluginPanels } from '../werkstatt/PluginFrame';
import './quickwins.css';
import { useT } from '../i18n';
import { ColorPick } from '../color-pick';
import { DealBoard, PipelineOrder } from './DealBoard';
import { DealList } from './DealList';
import { Icon } from '../icons';
import { sums } from './deal-kit';
import { MoreFields, useSimple } from '../areas/fields';
import '../areas/easy-core.css';
import { SmartTagsButton } from './DealSmartTags';
import { DealForecastPanel } from './DealForecast';

// Positions, quotes and call notes of a deal (Vertrieb): a chunk of its own, loaded when a deal is opened.
const { DealSales } = lazyPages(() => import('./SalesDeal'), 'DealSales');
const CURRENCIES = ['EUR', 'USD', 'CHF', 'GBP'];
const OTHER_REASON = '__other';

function PipelineEditor({ pipeline, onClose, onSaved }: { pipeline?: any; onClose: () => void; onSaved: () => void }) {
  const t = useT('deals');
  const [nameV, setName] = useState(pipeline?.name ?? '');
  // A new pipeline starts with three stages named in the UI language (they are data from then on).
  const [stages, setStages] = useState<{ id?: string; name: string; probability?: number | string; color?: string }[]>(pipeline?.stages ?? [{ name: t('Neu') }, { name: t('In Arbeit') }, { name: t('Gewonnen') }]);
  const [reasons, setReasons] = useState<string>((pipeline?.lost_reasons ?? []).join('\n'));
  const move = (i: number, dir: number) => {
    const s = [...stages];
    [s[i], s[i + dir]] = [s[i + dir], s[i]];
    setStages(s);
  };
  const save = async () => {
    const body = { name: nameV, stages, lost_reasons: reasons.trim() ? reasons.split('\n') : null };
    const r = await act(() => (pipeline ? api.patch(`/api/pipelines/${pipeline.id}`, body) : api.post('/api/pipelines', body)), t('Pipeline gespeichert'));
    if (r) onSaved();
  };
  return (
    <Modal
      title={pipeline ? t('Pipeline bearbeiten') : t('Neue Pipeline')}
      onClose={onClose}
      footer={
        <>
          {pipeline && (
            <button className="btn danger" onClick={async () => confirmAsk(t('Pipeline samt Opportunities löschen?')) && (await act(() => api.del(`/api/pipelines/${pipeline.id}`))) && onSaved()}>
              {t('Löschen')}
            </button>
          )}
          <button className="btn" onClick={save}>
            {t('Speichern')}
          </button>
        </>
      }
    >
      <Field label={t('Name')}>
        <Input value={nameV} onChange={setName} />
      </Field>
      <Field label={t('Stufen')} hint={t('Zahl rechts: Gewinn-Wahrscheinlichkeit in % für die Prognose (leer = automatisch).')}>
        {stages.map((s, i) => (
          <div className="row" key={s.id ?? i} style={{ marginBottom: 6, alignItems: 'center' }}>
            <span className="stage-color-row" title={t('Farbe der Stufe auf dem Board')}>
              <ColorPick value={s.color ?? ''} label={s.name} onChange={(c) => setStages(stages.map((x, j) => (j === i ? { ...x, color: c } : x)))} />
            </span>
            <div className="grow">
              <Input value={s.name} onChange={(v) => setStages(stages.map((x, j) => (j === i ? { ...x, name: v } : x)))} />
            </div>
            <div style={{ width: 84 }} title={t('Abschluss-Wahrscheinlichkeit für die gewichtete Umsatzprognose (Berichte)')}>
              <Input type="number" min={0} max={100} value={s.probability ?? ''} placeholder={`${Math.round(((i + 1) * 100) / (stages.length + 1))} %`} aria-label={t('Wahrscheinlichkeit in %')} onChange={(v) => setStages(stages.map((x, j) => (j === i ? { ...x, probability: v } : x)))} />
            </div>
            <button className="icon-btn" disabled={!i} onClick={() => move(i, -1)} aria-label={t('Hoch')}>
              ↑
            </button>
            <button className="icon-btn" disabled={i === stages.length - 1} onClick={() => move(i, 1)} aria-label={t('Runter')}>
              ↓
            </button>
            <button className="icon-btn" disabled={stages.length < 2} onClick={() => setStages(stages.filter((_, j) => j !== i))} aria-label={t('Entfernen')}>
              ✕
            </button>
          </div>
        ))}
        <button className="btn small secondary" onClick={() => setStages([...stages, { name: t('Neue Stufe') }])}>
          + {t('Stufe')}
        </button>
      </Field>
      {/* Einfach-Modus: the loss reasons behind "Weitere Felder" unless the pipeline has its own */}
      <MoreFields id="pipeline-edit" values={[reasons.trim()]}>
        <Field label={t('Verlustgründe')} tour="opps-lost-reasons" hint={t('Ein Grund pro Zeile, zur Auswahl bei „Verloren“ (leer = Standardliste).')}>
          <Textarea value={reasons} onChange={setReasons} rows={5} placeholder={t('Preis zu hoch\nKein Budget\nMitbewerber gewählt')} />
        </Field>
      </MoreFields>
    </Modal>
  );
}

function OppModal({ opp, pipeline, onClose, onSaved }: { opp?: any; pipeline: any; onClose: () => void; onSaved: () => void }) {
  const t = useT('deals');
  // A deal with positions gets its amount from them: the field is locked and the old amount is never sent back.
  const [locked, setLocked] = useState(false);
  const [o, setO] = useState<any>(opp ?? { stage_id: pipeline.stages[0].id, value: 0, currency: 'EUR', expected_close_date: '', contact: { first_name: '', email: '' } });
  // Reason of a lost deal: one of the pipeline's list, or free text behind "Anderer Grund".
  const reasonList: string[] = pipeline.lost_reason_options ?? [];
  const [reasonPick, setReasonPick] = useState<string>(opp?.lost_reason ? (reasonList.includes(opp.lost_reason) ? opp.lost_reason : OTHER_REASON) : '');
  const [reasonText, setReasonText] = useState<string>(opp?.lost_reason && !reasonList.includes(opp.lost_reason) ? opp.lost_reason : '');
  const lostReason = reasonPick === OTHER_REASON ? reasonText.trim() : reasonPick;
  const simple = useSimple();
  const [contactQ, setContactQ] = useState('');
  const [found, setFound] = useState<any[]>([]);
  useEffect(() => {
    if (opp || contactQ.length < 2) return setFound([]);
    const timer = setTimeout(() => api.get(`/api/contacts?q=${encodeURIComponent(contactQ)}&limit=6`).then((r) => setFound(r.contacts)), 200);
    return () => clearTimeout(timer);
  }, [contactQ, opp]);
  const save = async () => {
    // Moving a deal to lost needs a reason (the server insists, too); an already lost deal keeps its reason.
    if (opp && o.status === 'lost' && !lostReason && (opp.status !== 'lost' || opp.lost_reason)) return toastError(new Error(t('Bitte einen Verlustgrund wählen')));
    const common = { expected_close_date: o.expected_close_date || null, currency: o.currency || 'EUR' };
    const body = opp
      ? { name: o.name, ...(locked ? {} : { value: o.value }), stage_id: o.stage_id, status: o.status, ...common, ...(o.status === 'lost' && lostReason ? { lost_reason: lostReason } : {}) }
      : { pipeline_id: pipeline.id, stage_id: o.stage_id, value: Number(o.value) || 0, name: o.name, ...common, ...(o.contact_id ? { contact_id: o.contact_id } : { contact: o.contact }) };
    const r = await act(() => (opp ? api.patch(`/api/opportunities/${opp.id}`, body) : api.post('/api/opportunities', body)), t('Gespeichert'));
    if (r) onSaved();
  };
  return (
    <Modal
      title={opp ? opp.name : t('Neue Opportunity')}
      onClose={onClose}
      className="drawer"

      footer={
        <>
          {opp && (
            <button className="btn danger" onClick={async () => confirmAsk(t('Löschen?')) && (await act(() => api.del(`/api/opportunities/${opp.id}`))) && onSaved()}>
              {t('Löschen')}
            </button>
          )}
          <button className="btn" onClick={save}>
            {t('Speichern')}
          </button>
        </>
      }
    >
      {!opp && (
        <Field label={t('Kontakt')} tour="opp-contact" hint={o.contact_id ? <a href="#" onClick={(e) => (e.preventDefault(), setO({ ...o, contact_id: undefined, contactName: undefined }))}>{t('anderen wählen')}</a> : t('Bestehenden suchen oder unten neu anlegen')}>
          {o.contact_id ? (
            <strong>{o.contactName}</strong>
          ) : (
            <>
              <Input value={contactQ} onChange={setContactQ} placeholder={t('Kontakt suchen…')} aria-label={t('Kontakt suchen…')} />
              {found.map((c) => (
                <a key={c.id} href="#" onClick={(e) => (e.preventDefault(), setO({ ...o, contact_id: c.id, contactName: name(c) }))}>
                  {name(c)} <span className="muted">{c.email}</span>
                </a>
              ))}
              <div className="grid2" style={{ marginTop: 8 }}>
                <Input value={o.contact.first_name} onChange={(v) => setO({ ...o, contact: { ...o.contact, first_name: v } })} placeholder={t('Vorname (neu)')} aria-label={t('Vorname (neu)')} />
                <Input value={o.contact.email} onChange={(v) => setO({ ...o, contact: { ...o.contact, email: v } })} placeholder={t('E-Mail (neu)')} aria-label={t('E-Mail (neu)')} />
              </div>
            </>
          )}
        </Field>
      )}
      {opp && (
        <p>
          {t('Kontakt:')} <Link to={`contacts/${opp.contact_id}`}>{name(opp)}</Link>
        </p>
      )}
      <Field label={t('Name (optional)')} tour="opp-name">
        <Input value={o.name} onChange={(v) => setO({ ...o, name: v })} />
      </Field>
      {(() => {
        const value = (
          <Field label={t('Wert')} tour="opp-value" hint={locked ? t('Ergibt sich aus den Positionen (Nettosumme)') : undefined}>
            <Input type="number" value={o.value} onChange={(v) => setO({ ...o, value: v })} disabled={locked} />
          </Field>
        );
        const currency = (
          <Field label={t('Währung')} tour="opp-currency">
            <Select value={o.currency || 'EUR'} onChange={(v) => setO({ ...o, currency: v })} options={[...new Set([...CURRENCIES, o.currency || 'EUR'])]} />
          </Field>
        );
        const stage = (
          <Field label={t('Stufe')} tour="opp-stage">
            <Select value={o.stage_id} onChange={(v) => setO({ ...o, stage_id: v })} options={pipeline.stages.map((s: any) => [s.id, s.name])} />
          </Field>
        );
        const close = (
          <Field label={t('Erwarteter Abschluss')} tour="opp-close-date" hint={t('Für die Umsatzprognose nach Monat')}>
            <Input type="date" value={o.expected_close_date ?? ''} onChange={(v) => setO({ ...o, expected_close_date: v })} />
          </Field>
        );
        // Einfach-Modus: value and stage; currency and expected close behind "Weitere Felder" (open when set).
        return simple ? (
          <div className="grid2">
            {value}
            {stage}
            <MoreFields id="opp-edit" values={[o.currency && o.currency !== 'EUR' ? o.currency : '', o.expected_close_date]} count={2}>
              {currency}
              {close}
            </MoreFields>
          </div>
        ) : (
          <>
            <div className="grid2">
              {value}
              {currency}
            </div>
            <div className="grid2">
              {stage}
              {close}
            </div>
          </>
        );
      })()}
      {opp && (
        <Field label={t('Status')}>
          <Select value={o.status} onChange={(v) => setO({ ...o, status: v })} options={[['open', t('Offen')], ['won', t('Gewonnen')], ['lost', t('Verloren')], ['abandoned', t('Aufgegeben')]]} />
        </Field>
      )}
      {opp && o.status === 'lost' && (
        <Field label={t('Verlustgrund (Pflicht)')} tour="opp-lost-reason">
          <Select value={reasonPick} onChange={setReasonPick} placeholder={t('Grund wählen…')} options={[...reasonList, [OTHER_REASON, t('Anderer Grund…')] as [string, string]]} />
          {reasonPick === OTHER_REASON && <Input value={reasonText} onChange={setReasonText} maxLength={200} placeholder={t('Kurz beschreiben, warum der Deal verloren ging')} aria-label={t('Eigener Verlustgrund')} />}
        </Field>
      )}
      {opp && <DealProperties oppId={opp.id} />}
      {opp && (
        // Einfach-Modus: line items, quotes and call notes fold away – open by themselves when the deal has line items
        <MoreFields key={simple && locked ? 'lines' : 'none'} id="opp-sales" label={t('Positionen, Angebote & Notizen')} values={[locked]}>
          <DealSales deal={opp} onLock={setLocked} />
        </MoreFields>
      )}
      {opp && <PluginPanels on="deal" entityId={opp.id} />}
      {opp && <AssociationsPanel type="opportunity" id={opp.id} title={t('Firmen & Verknüpfungen')} compact />}
    </Modal>
  );
}

const PIPE_KEY = 'pghl_pipeline';
const VIEW_KEY = 'pghl_opps_view';
/** Board or list – the last choice in this browser. */
function lastView(): 'board' | 'list' {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'board';
  } catch {
    return 'board';
  }
}
function lastPipeline() {
  try {
    return localStorage.getItem(PIPE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function Opportunities() {
  const t = useT('deals');
  const pipelines = useLoad(() => api.get<any[]>('/api/pipelines'), []);
  const [pid, setPidState] = useState(new URLSearchParams(location.search).get('pipeline') ?? lastPipeline());
  const setPid = (v: string) => {
    setPidState(v);
    try {
      localStorage.setItem(PIPE_KEY, v);
    } catch {}
  };
  const [status, setStatus] = useState('open');
  const [q, setQ] = useState('');
  const [modal, setModal] = useState<any>(null);
  const [mode, setModeState] = useState<'board' | 'list'>(new URLSearchParams(location.search).get('view') === 'list' ? 'list' : lastView());
  const [version, setVersion] = useState(0);
  const setMode = (v: 'board' | 'list') => {
    setModeState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {}
  };
  // Without an explicit choice, open the pipeline that actually has deals in it.
  const pipeline = pipelines.data?.find((p) => p.id === pid) ?? [...(pipelines.data ?? [])].sort((a, b) => (b.open_count ?? 0) - (a.open_count ?? 0))[0];
  const opps = useLoad(() => (pipeline && mode === 'board' ? api.get<any[]>(`/api/opportunities?pipeline_id=${pipeline.id}&status=${status}&q=${encodeURIComponent(q)}`) : Promise.resolve([])), [pipeline?.id, status, q, mode]);
  if (!pipelines.data) return <Spinner />;
  if (!pipeline) return <p>{t('Keine Pipeline.')}</p>;
  const list = opps.data ?? [];

  const drop = async (stageId: string, oppId: string) => {
    const o = list.find((x) => x.id === oppId);
    if (!o || o.stage_id === stageId) return;
    opps.setData(list.map((x) => (x.id === oppId ? { ...x, stage_id: stageId } : x)));
    await act(() => api.patch(`/api/opportunities/${oppId}`, { stage_id: stageId }));
  };

  return (
    <>
      <PageHead title={t('Opportunities')} sub={mode === 'board' ? `${list.length} · ${sums(list)}` : undefined}>
        <div className="view-toggle" role="group" aria-label={t('Ansicht')} data-tour="opps-view">
          <button type="button" aria-pressed={mode === 'board'} onClick={() => setMode('board')}>
            <Icon name="kanban" size={15} /> {t('Board')}
          </button>
          <button type="button" aria-pressed={mode === 'list'} onClick={() => setMode('list')}>
            <Icon name="list" size={15} /> {t('Liste')}
          </button>
        </div>
        {mode === 'board' && (
          <div style={{ width: 200 }} data-tour="opps-pipeline">
            <Select value={pipeline.id} onChange={setPid} aria={t('Pipeline')} options={pipelines.data.map((p) => [p.id, `${p.name} (${p.open_count ?? 0})`])} />
          </div>
        )}
        <CanvasPin kind="pipeline" id={pipeline.id} name={pipeline.name} />
        {mode === 'board' && <SmartTagsButton />}
        <button className="btn secondary" data-tour="opps-edit-pipeline" onClick={() => setModal({ kind: 'pipeline', pipeline })}>
          {t('Pipeline bearbeiten')}
        </button>
        <button className="btn secondary" onClick={() => setModal({ kind: 'pipeline' })}>
          + {t('Pipeline')}
        </button>
        {pipelines.data.length > 1 && (
          <button className="btn secondary" data-tour="opps-sort-pipelines" onClick={() => setModal({ kind: 'order' })}>
            {t('Pipelines sortieren')}
          </button>
        )}
        <button className="btn" data-tour="opps-new" onClick={() => setModal({ kind: 'opp' })}>
          + {t('Opportunity')}
        </button>
      </PageHead>
      {mode === 'board' && (
        <div className="row" style={{ marginBottom: 12, alignItems: 'center' }}>
          <Tabs tabs={[['open', t('Offen')], ['won', t('Gewonnen')], ['lost', t('Verloren')], ['all', t('Alle')]]} value={status} onChange={setStatus} />
          <div style={{ width: 260 }}>
            <Input value={q} onChange={setQ} placeholder={t('Suchen…')} aria-label={t('Deals durchsuchen')} />
          </div>
        </div>
      )}
      <DealForecastPanel pipelineId={mode === 'board' ? pipeline.id : ''} />
      {pipelines.data.every((p) => !p.open_count) && <ElsewhereHint kind="opportunities" />}
      {mode === 'board' ? <DealBoard pipeline={pipeline} list={list} onOpen={(o) => setModal({ kind: 'opp', opp: o })} onMove={drop} /> : <DealList pipelines={pipelines.data} version={version} onOpen={(o) => setModal({ kind: 'opp', opp: o })} />}
      {modal?.kind === 'pipeline' && <PipelineEditor pipeline={modal.pipeline} onClose={() => setModal(null)} onSaved={() => (setModal(null), pipelines.reload(), opps.reload())} />}
      {modal?.kind === 'order' && <PipelineOrder pipelines={pipelines.data} onClose={() => setModal(null)} onSaved={() => (setModal(null), pipelines.reload())} />}
      {modal?.kind === 'opp' && <OppModal opp={modal.opp} pipeline={pipelines.data.find((p) => p.id === modal.opp?.pipeline_id) ?? pipeline} onClose={() => (setModal(null), opps.reload(), setVersion(version + 1))} onSaved={() => (setModal(null), opps.reload(), setVersion(version + 1))} />}
    </>
  );
}
