import { useEffect, useState } from 'react';
import { Icon, type IconName } from '../icons';
import { api, dt, name } from '../api';
import { CanvasPin } from '../canvas/pin';
import { act, Badge, Check, CodeBox, confirmAsk, Empty, Field, Input, Link, MergeHint, Modal, navigate, PageHead, pressable, Select, Spinner, Tabs, TagInput, Textarea, toast, useLoad } from '../ui';
import { useTags } from '../tags';
import { EmailDesignField, designPlainText } from './EmailBuilder';
import { AiTextStep } from './AiAssistant';
import { AgentStep } from '../agent';
import { WhatsAppStep } from './MetaChannels';
import { DiscordStep, PushStep, TelegramStep, TelegramTriggerFilter } from './ChannelSettings';
import { ProductTriggerField } from './Stripe';
import { CourseStep, CourseTriggerFilter } from './Courses';
import { GooglePostStep } from './GoogleBusiness';
import { CommunityTriggerFilter } from './Community';
import { VoiceOutcomeFilter } from './VoiceAi';
import { ObjectStep, ObjectTriggerFilter } from './Objects';
import { LeadScoreTriggerFilter } from './LeadScoring';
import { TicketStep, TicketTriggerFilter } from './HelpdeskSettings';
import { InboundWebhookTrigger } from './InboundWebhook';
import { ShortsStep } from './VideoStudio';
import { RecycleStep } from './VideoRecycle';
import { GithubIssueStep } from './AiTools';
import { PluginActionStep } from '../werkstatt/WorkflowStep';
import { ComposioActionStep, ComposioAiStep, ComposioTriggerFilter } from './Composio';
import { ChatNotifyStep, NotionStep } from './Connectors';
import { NangoRequestStep } from './Nango';
import { McpToolStep } from './McpServers';
import { GenMediaStep } from './GenMediaKit';
import { ActionPicker, ConditionsEditor, GenericStepConfig, StepDoc, StepNameField, TriggerDoc, TriggerFilters, TriggerSelect, branchKeysOf, branchesOf, genericSummary, newStepFor, resetRemoteCache, stepInfo, useCatalog, useTriggerLabel, type Catalog, type ToolCtx } from './WorkflowTools';
import { ImportModal, RunLogModal, SplitStats, TestRunModal, VersionsTab, exportAll, exportWorkflow, flatSteps, runStatusLabel } from './WorkflowRuns';
import { PmStepEditor, PmTriggerFilter } from './PmWorkflow';
import { WorkflowAiButton } from './WorkflowAi';
import { ContinueOnError, ErrorSettings, RetryAll, RetryButton } from './WorkflowErrors';
import { ServiceMessageFlag } from './ConsentKit';
import { tr, useT } from '../i18n';
import { PageSuspense, lazyPages } from '../lazy';
import { EditorToggle, IssueNote, SlotTools, StepActions, StepOpsLayer, announceIssues, confirmActivate, useEditorMode, useIssues, useStepOps, type StepOps } from '../workflow-canvas/tools';
import type { Issue } from '../../../server/services/workflow-validate';

// The visual canvas (docs/workflow-actions.md → The canvas) is a chunk of its own, loaded when someone switches to it.
const { WorkflowCanvas } = lazyPages(() => import('../workflow-canvas/WorkflowCanvas'), 'WorkflowCanvas');
import { NoteStepFields } from './NotesPlus';
import { MoreFields, useSimple } from '../areas/fields';
import { changedFieldValues, hasStepMore, splitCatalogFields, stepMoreValues } from '../areas/marketing-fields';
import { ALL_FOLDERS, inWorkflowFolder, WorkflowFolderBar, type WorkflowFolderFilter } from './WorkflowFolders';

/** German labels (message ids of the workflows catalog); shown through t(). */
export const TRIGGER_LABELS: Record<string, string> = {
  'contact.created': 'Kontakt angelegt',
  'contact.tag_added': 'Tag hinzugefügt',
  'contact.tag_removed': 'Tag entfernt',
  'contact.updated': 'Kontakt geändert',
  'contact.unsubscribed': 'Kontakt hat sich abgemeldet',
  'form.submitted': 'Formular ausgefüllt',
  'appointment.booked': 'Termin gebucht',
  'appointment.status_changed': 'Terminstatus geändert',
  'opportunity.created': 'Opportunity angelegt',
  'opportunity.stage_changed': 'Pipeline-Stufe geändert',
  'opportunity.status_changed': 'Opportunity-Status geändert',
  'message.inbound': 'Nachricht empfangen',
  'invoice.paid': 'Rechnung bezahlt',
  'product.purchased': 'Produkt gekauft',
  'review.received': 'Bewertung erhalten',
  'email.opened': 'E-Mail geöffnet',
  'email.clicked': 'Link in E-Mail geklickt',
  'link.clicked': 'Trigger-Link geklickt',
  'date.reached': 'Geburtstag / Datum erreicht',
  'contract.signed': 'Vertrag unterschrieben',
  'contract.declined': 'Vertrag abgelehnt',
  'ai.handoff': 'KI-Assistent übergibt an Team',
  'call.missed': 'Anruf verpasst',
  'call.voicemail': 'Voicemail erhalten',
  'call.completed': 'Anruf beendet',
  'voice_ai.completed': 'KI-Anruf beendet',
  'google_review.received': 'Neue Google-Bewertung',
  'course.enrolled': 'Kurszugang erhalten',
  'course.started': 'Kurs begonnen',
  'lesson.completed': 'Lektion abgeschlossen',
  'course.completed': 'Kurs abgeschlossen',
  'community.post_created': 'Community-Beitrag erstellt',
  'community.member_joined': 'Mitglied ist Gruppe beigetreten',
  'community.level_reached': 'Level erreicht',
  'affiliate.created': 'Neuer Affiliate',
  'affiliate.commission_created': 'Provision erstellt',
  'company.created': 'Firma angelegt',
  'company.updated': 'Firma geändert',
  'company.property_changed': 'Firmen-Eigenschaft geändert',
  'record.created': 'Datensatz (eigenes Objekt) angelegt',
  'record.updated': 'Datensatz (eigenes Objekt) geändert',
  'record.property_changed': 'Eigenschaft eines Datensatzes geändert',
  'lead_score.threshold_reached': 'Lead-Score erreicht Schwelle',
  'lead_score.changed': 'Lead-Score geändert',
  'ticket.created': 'Ticket angelegt',
  'ticket.status_changed': 'Ticket-Status geändert',
  'ticket.assigned': 'Ticket zugewiesen',
  'sla.warning': 'SLA läuft bald ab',
  'sla.breached': 'SLA überschritten',
  'health_score.dropped': 'Health-Score gesunken',
  manual: 'Manuell (Kontakt / Massenaktion)',
  webhook: 'Eingehender Webhook',
  'webhook.received': 'Webhook empfangen (mit Feldzuordnung)',
  'task.completed': 'Aufgabe erledigt',
  'task.created': 'Aufgabe angelegt (Projektplanung)',
  'task.status_changed': 'Aufgaben-Status geändert (Projektplanung)',
  'task.overdue': 'Aufgabe überfällig (Projektplanung)',
  'task.assigned': 'Aufgabe zugewiesen (Projektplanung)',
  'shorts.ready': 'Shorts fertig (Video-Studio)',
  'composio.event': 'App-Ereignis (Composio)',
  'telegram.started': 'Telegram-Bot gestartet',
  'email.bounced': 'E-Mail unzustellbar (Bounce)',
  'email.complained': 'E-Mail als Spam gemeldet',
  'genmedia.completed': 'KI-Medium fertig (KI-Studio)',
  // Back-Office
  'stock.low': 'Mindestbestand unterschritten (Lager)',
  'purchase_order.received': 'Bestellung vollständig geliefert (Lager)',
  'receipt.received': 'Beleg eingegangen (Buchhaltung)',
  'receipt.booked': 'Beleg gebucht (Buchhaltung)',
  'absence.requested': 'Abwesenheit beantragt (Personal)',
  'absence.approved': 'Abwesenheit genehmigt (Personal)',
  'absence.rejected': 'Abwesenheit abgelehnt (Personal)',
  'ads.lead': 'Neuer Lead aus Anzeige (Meta Lead Ads)',
};

const STEP_LABELS: Record<string, [IconName, string]> = {
  send_email: ['email', 'E-Mail senden'],
  send_sms: ['sms', 'SMS senden'],
  wait: ['wait', 'Warten'],
  if: ['branch', 'Wenn / Sonst'],
  goal: ['goal', 'Ziel erreicht? → Ende'],
  add_tag: ['tag', 'Tag hinzufügen'],
  remove_tag: ['tag', 'Tag entfernen'],
  update_field: ['edit', 'Feld setzen'],
  set_dnd: ['dnd', 'Nicht stören'],
  create_opportunity: ['deal', 'Opportunity anlegen'],
  move_opportunity: ['move', 'Opportunity verschieben'],
  set_opportunity_status: ['flag', 'Opportunity-Status'],
  create_task: ['todo', 'Aufgabe anlegen'],
  pm_create_task: ['gantt', 'Aufgabe im Projekt anlegen'],
  pm_move_task: ['move', 'Aufgabe: Status setzen'],
  pm_assign_task: ['contact', 'Aufgabe zuweisen'],
  add_note: ['note', 'Notiz hinzufügen'],
  notify: ['notify', 'Team benachrichtigen'],
  webhook: ['webhook', 'Webhook aufrufen'],
  review_request: ['reviews', 'Bewertung anfragen'],
  add_to_workflow: ['workflows', 'In anderen Workflow'],
  remove_from_workflow: ['stop', 'Aus Workflow entfernen'],
  social_post: ['social', 'Social-Post erstellen'],
  google_post: ['place', 'Google-Beitrag erstellen'],
  ai_text: ['ai', 'KI-Text erzeugen'],
  agent_run: ['bot', 'KI-Agent ausführen'],
  whatsapp_send: ['whatsapp', 'WhatsApp senden'],
  telegram_send: ['telegram', 'Telegram senden'],
  discord_send: ['discord', 'Discord senden'],
  push_contact: ['push', 'Push an Kontakt'],
  course_grant: ['courses', 'Kurszugang geben'],
  course_revoke: ['courses', 'Kurszugang entziehen'],
  create_record: ['objects', 'Firma/Datensatz anlegen'],
  update_record: ['edit', 'Firma/Datensatz ändern'],
  associate_records: ['link', 'Datensätze verknüpfen'],
  ticket_create: ['ticket', 'Ticket anlegen'],
  ticket_update: ['ticket', 'Ticket ändern / eskalieren'],
  shorts_create: ['studio', 'Shorts aus Video erstellen'],
  video_recycle: ['studio', 'Video recyceln'],
  github_issue: ['github', 'GitHub-Issue für Codex anlegen'],
  plugin_action: ['puzzle', 'Plugin-Aktion ausführen'],
  composio_action: ['apps', 'App-Aktion ausführen (Composio)'],
  composio_ai: ['ai', 'KI-Agent mit Apps (Composio)'],
  chat_notify: ['chat', 'Benachrichtigung an Slack/Discord'],
  notion_append: ['doc', 'Notion-Seite ergänzen'],
  nango_request: ['link', 'API-Aufruf über Nango'],
  mcp_tool: ['bot', 'MCP-Werkzeug ausführen'],
  genmedia_image: ['sparkles', 'KI-Bild generieren'],
  genmedia_video: ['video', 'KI-Video generieren'],
  genmedia_tts: ['audio', 'Text in Sprache'],
  end: ['end', 'Ende'],
};

const COND_FIELDS: [string, string][] = [
  ['tag', 'Tag'],
  ['email', 'E-Mail'],
  ['phone', 'Telefon'],
  ['first_name', 'Vorname'],
  ['last_name', 'Nachname'],
  ['company', 'Firma'],
  ['city', 'Ort'],
  ['source', 'Quelle'],
  ['dnd', 'Nicht stören (1/0)'],
];

type Step = { id: string; type: string; then?: Step[]; else?: Step[]; [k: string]: any };
const newId = () => Math.random().toString(36).slice(2, 10);
/** A new step of a type with the defaults of its form (both editors). */
const makeStep = (type: string, cat?: Catalog): Step => ({ ...newStepFor(type, cat?.actions.find((a) => a.type === type), newId()), ...(type === 'if' ? { then: [], else: [], conditions: [{ field: 'tag', op: 'has', value: '' }], match: 'all' } : {}), ...(type === 'wait' ? { amount: 1, unit: 'days' } : {}) });

/** Applies fn to every step of the tree (containers: Ja/Nein, Split-Test-Pfade, Schleife) and drops the ones it returns null for. */
function mapSteps(steps: Step[], fn: (s: Step) => Step | null): Step[] {
  return steps.flatMap((s) => {
    const r = fn(s);
    if (!r) return [];
    const keys = branchKeysOf(r);
    return [keys.length ? { ...r, ...Object.fromEntries(keys.map((k) => [k, mapSteps(r[k] ?? [], fn)])) } : r];
  });
}
function findStep(steps: Step[], sid: string): Step | undefined {
  for (const s of steps) {
    if (s.id === sid) return s;
    for (const k of branchKeysOf(s)) {
      const inner = findStep(s[k] ?? [], sid);
      if (inner) return inner;
    }
  }
  return undefined;
}

function summary(s: Step, cat?: Catalog): string {
  const t = tr('workflows');
  switch (s.type) {
    case 'send_email':
      return s.subject || '';
    case 'send_sms':
    case 'add_note':
    case 'social_post':
    case 'google_post':
      return (s.body || '').slice(0, 50);
    case 'telegram_send':
    case 'discord_send':
      return (s.body || s.media_url || '').slice(0, 50);
    case 'push_contact':
      return (s.title || s.body || '').slice(0, 50);
    case 'whatsapp_send':
      return s.mode === 'template' ? t('Vorlage {name}', { name: s.template || '?' }) : (s.body || (s.template ? t('Vorlage {name}', { name: s.template }) : '')).slice(0, 50);
    case 'wait': {
      if (s.mode === 'date') return t('bis {date} {time}', { date: s.date || '?', time: s.time || '09:00' });
      if (s.mode === 'field') {
        const field = s.field === 'date_of_birth' ? t('Geburtstag') : s.field || '?';
        const off = Number(s.offset_days);
        return off ? t.plural(Math.abs(off), { other: 'bis {field} {offset} Tage' }, { field, offset: `${off > 0 ? '+' : ''}${s.offset_days}` }) : t('bis {field}', { field });
      }
      if (s.mode === 'weekday') return t('bis {date} {time}', { date: (s.days?.length ? s.days : ['mon', 'tue', 'wed', 'thu', 'fri']).map((d: string) => { const w = WEEKDAYS.find((x) => x[0] === d)?.[1]; return w && t(w); }).join(', '), time: s.time || '09:00' });
      const amount = Number(s.amount) || 0;
      const unit = s.unit === 'days' ? { other: '{n} Tage' } : s.unit === 'hours' ? { other: '{n} Stunden' } : { other: '{n} Minuten' };
      return t.plural(amount, unit, { n: s.amount || 0 });
    }
    case 'add_tag':
    case 'remove_tag':
      return (s.tags ?? []).join(', ');
    case 'if':
    case 'goal':
      return (s.conditions ?? []).map((c: any) => `${c.field} ${c.op} ${c.value ?? ''}`).join(` ${s.match === 'any' ? t('oder') : t('und')} `);
    case 'create_task':
    case 'pm_create_task':
      return s.title || '';
    case 'pm_move_task':
      return s.status || s.category || '';
    case 'ai_text':
    case 'agent_run':
    case 'composio_ai':
      return (s.prompt || '').slice(0, 50);
    case 'composio_action':
      return s.tool || '';
    case 'chat_notify':
      return `${s.service === 'discord' ? 'Discord' : 'Slack'}: ${(s.title || s.text || '').slice(0, 40)}`;
    case 'notion_append':
      return (s.heading || s.text || '').slice(0, 50);
    case 'nango_request':
      return s.integration ? `${s.integration}: ${s.method || 'GET'} ${s.path || ''}`.slice(0, 60) : '';
    case 'mcp_tool':
      return s.tool || '';
    case 'shorts_create':
      return s.url || '';
    case 'video_recycle':
      return s.url || s.job_id || '{{event.jobId}}';
    case 'github_issue':
      return [s.repo, s.title].filter(Boolean).join(': ').slice(0, 60);
    case 'plugin_action':
      return s.action || '';
    case 'genmedia_image':
    case 'genmedia_video':
      return (s.prompt || '').slice(0, 50);
    case 'genmedia_tts':
      return (s.text || '').slice(0, 50);
    case 'webhook':
      return s.url || '';
    case 'create_record':
    case 'update_record':
    case 'associate_records':
      return s.object === 'company' ? t('Firma') : s.object || '';
    default:
      return genericSummary(cat?.actions.find((a) => a.type === s.type), s);
  }
}

function AddStep({ onAdd }: { onAdd: (type: string) => void }) {
  const t = useT('workflows');
  const [open, setOpen] = useState(false);
  return (
    <div className="wf-add" data-tour="wf-add">
      <button className="btn small secondary" onClick={(e) => (e.stopPropagation(), setOpen(true))}>
        {t('+ Schritt')}
      </button>
      {open && <ActionPicker builtin={STEP_LABELS} onPick={onAdd} onClose={() => setOpen(false)} />}
    </div>
  );
}

function StepList({ steps, onChange, sel, onSel, counts, cat, ops, issues, parent = null, lane = 'steps' }: { steps: Step[]; onChange: (s: Step[]) => void; sel: string; onSel: (id: string) => void; counts: Record<string, number>; cat?: Catalog; ops: StepOps; issues: Record<string, Issue[]>; parent?: string | null; lane?: string }) {
  const t = useT('workflows');
  const insert = (at: number, type: string) => {
    const s = makeStep(type, cat);
    onChange([...steps.slice(0, at), s, ...steps.slice(at)]);
    onSel(s.id);
  };
  return (
    <div>
      <SlotTools ops={ops} slot={{ parent, key: lane, index: 0 }}>
        <AddStep onAdd={(type) => insert(0, type)} />
      </SlotTools>
      {steps.map((s, i) => {
        const [icon, label] = stepInfo(s.type, cat, STEP_LABELS);
        const lanes = branchesOf(s);
        return (
          <div key={s.id}>
            <div className="wf-line" />
            <div className={`wf-step${s.id === sel ? ' on' : ''}${s.disabled ? ' wfc-paused' : ''}${issues[s.id] ? ' wfc-bad' : ''}`} {...pressable((e) => (e.stopPropagation(), onSel(s.id)))}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>
                  <Icon name={icon} /> {t(label)}
                  {s.name ? <span className="wt-step-name"> – {s.name}</span> : null}
                </strong>
                <span className="actions">
                  {counts[s.id] ? <Badge tone="blue">{t('{n} hier', { n: counts[s.id] })}</Badge> : null}
                  <StepActions ops={ops} step={s} />
                  <button className="icon-btn" disabled={!i} onClick={(e) => (e.stopPropagation(), onChange(steps.map((x, j) => (j === i - 1 ? steps[i] : j === i ? steps[i - 1] : x))))} aria-label={t('Hoch')}>
                    ↑
                  </button>
                  <button className="icon-btn" onClick={(e) => (e.stopPropagation(), confirmAsk(t('Schritt entfernen?')) && onChange(steps.filter((_, j) => j !== i)))} aria-label={t('Entfernen')}>
                    ✕
                  </button>
                </span>
              </div>
              <div className="muted small">{summary(s, cat)}</div>
              <IssueNote issues={issues[s.id]} />
              {!!lanes.length && (
                <div className={`wf-branches${lanes.length > 2 || lanes.length === 1 ? ' many' : ''}`}>
                  {lanes.map((br) => (
                    <div className="wf-branch" key={br.key}>
                      <div className="small" style={{ fontWeight: 600, textAlign: 'center' }}>
                        {br.tone === 'yes' ? <><Icon name="ok" color="var(--green)" /> {br.label}</> : br.tone === 'no' ? <><Icon name="fail" color="var(--red)" /> {br.label}</> : br.label}
                      </div>
                      <StepList steps={s[br.key] ?? []} onChange={(next) => onChange(steps.map((x, j) => (j === i ? { ...x, [br.key]: next } : x)))} sel={sel} onSel={onSel} counts={counts} cat={cat} ops={ops} issues={issues} parent={s.id} lane={br.key} />
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="wf-line" />
            <SlotTools ops={ops} slot={{ parent, key: lane, index: i + 1 }}>
              <AddStep onAdd={(type) => insert(i + 1, type)} />
            </SlotTools>
          </div>
        );
      })}
    </div>
  );
}

function SocialStep({ step, set }: { step: Step; set: (p: any) => void }) {
  const t = useT('workflows');
  const s = useLoad(() => api.get<any>('/api/social'), []);
  if (!s.data) return <Spinner />;
  if (!s.data.configured || !s.data.channels.length) return <p className="muted">{t('Erst im Social Planner einen Kanal verbinden.')}</p>;
  const ids: string[] = step.integration_ids ?? [];
  return (
    <>
      <Field label={t('Kanäle')}>
        {s.data.channels
          .filter((c: any) => c.supported)
          .map((c: any) => (
            <Check key={c.id} checked={ids.includes(c.id)} onChange={(on) => set({ integration_ids: on ? [...ids, c.id] : ids.filter((x) => x !== c.id) })} label={`${c.name} (${c.label})`} />
          ))}
      </Field>
      <Field label={t('Text')}>
        <Textarea value={step.body} onChange={(v) => set({ body: v })} rows={5} />
      </Field>
      <MergeHint />
      <Field label={t('Veröffentlichen')}>
        <Select value={step.mode ?? 'draft'} onChange={(v) => set({ mode: v })} options={[['draft', t('Als Entwurf – erst nach Freigabe in Postiz')], ['now', t('Sofort veröffentlichen')]]} />
      </Field>
    </>
  );
}

const WEEKDAYS: [string, string][] = [
  ['mon', 'Mo'],
  ['tue', 'Di'],
  ['wed', 'Mi'],
  ['thu', 'Do'],
  ['fri', 'Fr'],
  ['sat', 'Sa'],
  ['sun', 'So'],
];

function DateFieldPicker({ c, set, customFields }: { c: any; set: (p: any) => void; customFields: any[] }) {
  const t = useT('workflows');
  return (
    <div className="grid2">
      <Field label={t('Datumsfeld')}>
        <Select value={c.field ?? 'date_of_birth'} onChange={(v) => set({ field: v })} options={[['date_of_birth', t('Geburtstag')], ...customFields.filter((f: any) => f.type === 'date' || f.type === 'text').map((f: any) => [`custom.${f.key}`, t('Feld: {name}', { name: f.label })] as [string, string])]} />
      </Field>
      <Field label={t('Tage davor (−) / danach (+)')}>
        <Input type="number" value={c.offset_days ?? 0} onChange={(v) => set({ offset_days: Number(v) })} />
      </Field>
    </div>
  );
}

/**
 * Secondary settings of the steps with their own editor (rules: web/src/areas/marketing-fields.ts → STEP_MORE) and, in
 * Einfach-Modus, the folded fields of catalogue-built steps. Rendered inside the step's "Weitere Felder".
 */
function StepMore({ step, set, ctx }: { step: Step; set: (p: any) => void; ctx: any }) {
  const t = useT('workflows');
  const simple = useSimple();
  switch (step.type) {
    case 'send_email':
      return (
        <>
          {!step.design && <Check checked={!!step.isHtml} onChange={(v) => set({ isHtml: v })} label={t('Text ist HTML')} />}
          <ServiceMessageFlag step={step} set={set} />
        </>
      );
    case 'send_sms':
      return <ServiceMessageFlag step={step} set={set} />;
    case 'if':
    case 'goal':
      return (
        <Field label={t('Oder ein Ausdruck (optional)')} hint={t('Wenn gesetzt, gilt nur der Ausdruck – z. B. contact.custom.budget > 1000 && \'vip\' in contact.tags')}>
          <Textarea className="wt-code" spellCheck={false} value={step.expression} onChange={(v) => set({ expression: v })} rows={2} />
        </Field>
      );
    case 'create_opportunity':
      return (
        <>
          <Field label={t('Name (optional)')}>
            <Input value={step.name} onChange={(v) => set({ name: v })} />
          </Field>
          <div className="grid2">
            <Field label={t('Währung (leer = EUR)')}>
              <Input value={step.currency} onChange={(v) => set({ currency: v })} placeholder="EUR" />
            </Field>
            <Field label={t('Erwarteter Abschluss in … Tagen (optional)')}>
              <Input type="number" value={step.expected_close_in_days} onChange={(v) => set({ expected_close_in_days: v })} />
            </Field>
          </div>
        </>
      );
    case 'move_opportunity':
      return <Check checked={step.create_if_missing !== false} onChange={(v) => set({ create_if_missing: v })} label={t('Anlegen, wenn keine offene existiert')} />;
    case 'set_opportunity_status':
      return (
        <Field label={t('Nur in Pipeline (optional)')}>
          <Select value={step.pipeline_id} onChange={(v) => set({ pipeline_id: v })} placeholder={t('jede')} options={ctx.pipelines.map((p: any) => [p.id, p.name])} />
        </Field>
      );
    case 'webhook':
      return (
        <Field label={t('Methode')}>
          <Select value={step.method ?? 'POST'} onChange={(v) => set({ method: v })} options={['POST', 'GET']} />
        </Field>
      );
    default:
      return simple ? <GenericStepConfig step={step} set={set} ctx={ctx} part="more" /> : null;
  }
}

function StepConfig({ step, set, ctx }: { step: Step; set: (p: any) => void; ctx: any }) {
  const t = useT('workflows');
  const simple = useSimple();
  const pipe = ctx.pipelines.find((p: any) => p.id === step.pipeline_id);
  const pipeFields = (
    <>
      <Field label="Pipeline">
        <Select value={step.pipeline_id} onChange={(v) => set({ pipeline_id: v, stage_id: '' })} placeholder={t('wählen…')} options={ctx.pipelines.map((p: any) => [p.id, p.name])} />
      </Field>
      {pipe && (
        <Field label={t('Stufe')}>
          <Select value={step.stage_id} onChange={(v) => set({ stage_id: v })} placeholder={t('erste Stufe')} options={pipe.stages.map((s: any) => [s.id, s.name])} />
        </Field>
      )}
    </>
  );
  switch (step.type) {
    case 'send_email':
      return (
        <>
          {ctx.templates.filter((x: any) => x.channel === 'email').length > 0 && (
            <Field label={t('Vorlage laden')}>
              <Select value="" placeholder="–" options={ctx.templates.filter((x: any) => x.channel === 'email').map((x: any) => [x.id, x.name])} onChange={(v) => { const tpl = ctx.templates.find((x: any) => x.id === v); if (tpl) set({ subject: tpl.subject, body: tpl.body, isHtml: !!tpl.is_html, design: tpl.design ?? null, text: tpl.body_text || undefined }); }} />
            </Field>
          )}
          <Field label={t('Betreff')}>
            <Input value={step.subject} onChange={(v) => set({ subject: v })} />
          </Field>
          <div className="field">
            <span>{t('Inhalt')}</span>
            <EmailDesignField
              design={step.design}
              subject={step.subject ?? ''}
              mode="workflow"
              onChange={(r) => {
                set({ design: r.design, body: r.html, text: r.text, isHtml: true, subject: r.subject });
                toast(t('Übernommen – Workflow speichern nicht vergessen'));
              }}
              onRemove={() => set({ design: null, body: designPlainText(step.text), text: undefined, isHtml: false })}
            />
          </div>
          {!step.design && (
            <Field label={t('Text')}>
              <Textarea value={step.body} onChange={(v) => set({ body: v })} rows={9} />
            </Field>
          )}
          <MergeHint />
        </>
      );
    case 'send_sms':
      return (
        <>
          <Field label={t('SMS-Text')} hint={t.plural((step.body ?? '').length, { other: '{n} Zeichen' })}>
            <Textarea value={step.body} onChange={(v) => set({ body: v })} />
          </Field>
          <MergeHint />
        </>
      );
    case 'wait': {
      const mode = step.mode ?? 'delay';
      return (
        <>
          <Field label={t('Warten')}>
            <Select value={mode} onChange={(v) => set({ mode: v })} options={[['delay', t('eine Zeit lang')], ['date', t('bis zu einem Datum')], ['field', t('bis zu einem Kontakt-Datum (z. B. Geburtstag)')], ['weekday', t('bis zum nächsten Wochentag/Uhrzeit')]]} />
          </Field>
          {mode === 'delay' && (
            <div className="grid2">
              <Field label={t('Dauer')}>
                <Input type="number" value={step.amount} onChange={(v) => set({ amount: Number(v) })} />
              </Field>
              <Field label={t('Einheit')}>
                <Select value={step.unit ?? 'days'} onChange={(v) => set({ unit: v })} options={[['minutes', t('Minuten')], ['hours', t('Stunden')], ['days', t('Tage')]]} />
              </Field>
            </div>
          )}
          {mode === 'date' && (
            <Field label={t('Datum')}>
              <Input type="date" value={step.date} onChange={(v) => set({ date: v })} />
            </Field>
          )}
          {mode === 'field' && <DateFieldPicker c={step} set={set} customFields={ctx.customFields} />}
          {mode === 'weekday' && (
            <Field label={t('Tage')}>
              <div className="row">
                {WEEKDAYS.map(([k, l]) => {
                  const days: string[] = step.days?.length ? step.days : ['mon', 'tue', 'wed', 'thu', 'fri'];
                  return <Check key={k} checked={days.includes(k)} onChange={(on) => set({ days: on ? [...days, k] : days.filter((d) => d !== k) })} label={t(l)} />;
                })}
              </div>
            </Field>
          )}
          {mode !== 'delay' && (
            <Field label={t('Uhrzeit (Zeitzone des Sub-Accounts)')} hint={t('Liegt der Zeitpunkt schon in der Vergangenheit, geht es sofort weiter.')}>
              <Input type="time" value={step.time ?? '09:00'} onChange={(v) => set({ time: v })} />
            </Field>
          )}
        </>
      );
    }
    case 'if':
    case 'goal':
      return (
        <>
          {step.type === 'goal' && <p className="muted">{t('Ist die Bedingung erfüllt (z. B. Tag „termin-gebucht“), endet der Workflow hier für den Kontakt.')}</p>}
          <ConditionsEditor conditions={step.conditions ?? []} match={step.match} onChange={set} customFields={ctx.customFields} />
        </>
      );
    case 'add_tag':
    case 'remove_tag':
      return (
        <Field label="Tags">
          <TagInput value={step.tags ?? []} onChange={(v) => set({ tags: v })} suggestions={ctx.tags} />
        </Field>
      );
    case 'update_field':
      return (
        <>
          <Field label={t('Feld')}>
            <Select value={step.field} onChange={(v) => set({ field: v })} placeholder={t('wählen…')} options={[...COND_FIELDS.filter(([k]) => !['tag', 'dnd'].includes(k)).map(([k, l]) => [k, t(l)] as [string, string]), ...ctx.customFields.map((f: any) => [`custom.${f.key}`, t('Feld: {name}', { name: f.label })])]} />
          </Field>
          <Field label={t('Wert (Platzhalter erlaubt)')}>
            <Input value={step.value} onChange={(v) => set({ value: v })} />
          </Field>
        </>
      );
    case 'set_dnd':
      return <Check checked={!!step.value} onChange={(v) => set({ value: v })} label={t('„Nicht stören“ einschalten')} />;
    case 'create_opportunity':
      return (
        <>
          {pipeFields}
          <Field label={t('Wert')}>
            <Input value={step.value} onChange={(v) => set({ value: v })} />
          </Field>
        </>
      );
    case 'move_opportunity':
      return pipeFields;
    case 'set_opportunity_status':
      return (
        <>
          <Field label="Status">
            <Select value={step.status} onChange={(v) => set({ status: v })} options={[['won', t('Gewonnen')], ['lost', t('Verloren')], ['abandoned', t('Aufgegeben')], ['open', t('Offen')]]} />
          </Field>
          {step.status === 'lost' && (
            <Field label={t('Verlustgrund')} hint={t('Platzhalter erlaubt. Leer = „Per Automation“.')}>
              <Input value={step.lost_reason} onChange={(v) => set({ lost_reason: v })} placeholder={t('Keine Rückmeldung')} />
            </Field>
          )}
        </>
      );
    case 'create_task':
      return (
        <>
          <Field label={t('Titel')}>
            <Input value={step.title} onChange={(v) => set({ title: v })} />
          </Field>
          <Field label={t('Beschreibung')}>
            <Textarea value={step.description} onChange={(v) => set({ description: v })} />
          </Field>
          <Field label={t('Fällig in (Tagen)')}>
            <Input type="number" value={step.due_in_days} onChange={(v) => set({ due_in_days: v })} />
          </Field>
        </>
      );
    case 'add_note':
      return <NoteStepFields step={step} set={set} />;
    case 'notify':
      return (
        <>
          <Field label={t('An (leer = Firmen-E-Mail)')}>
            <Input value={step.to} onChange={(v) => set({ to: v })} />
          </Field>
          <Field label={t('Betreff')}>
            <Input value={step.subject} onChange={(v) => set({ subject: v })} />
          </Field>
          <Field label={t('Text')}>
            <Textarea value={step.body} onChange={(v) => set({ body: v })} />
          </Field>
          <MergeHint />
        </>
      );
    case 'social_post':
      return <SocialStep step={step} set={set} />;
    case 'google_post':
      return <GooglePostStep step={step} set={set} />;
    case 'ai_text':
      return <AiTextStep step={step} set={set} customFields={ctx.customFields} />;
    case 'agent_run':
      return <AgentStep step={step} set={set} customFields={ctx.customFields} />;
    case 'whatsapp_send':
      return <WhatsAppStep step={step} set={set} />;
    case 'telegram_send':
      return <TelegramStep step={step} set={set} />;
    case 'discord_send':
      return <DiscordStep step={step} set={set} />;
    case 'push_contact':
      return <PushStep step={step} set={set} />;
    case 'course_grant':
    case 'course_revoke':
      return <CourseStep step={step} set={set} />;
    case 'create_record':
    case 'update_record':
    case 'associate_records':
      return <ObjectStep step={step} set={set} />;
    case 'ticket_create':
    case 'ticket_update':
      return <TicketStep step={step} set={set} />;
    case 'shorts_create':
      return <ShortsStep step={step} set={set} />;
    case 'video_recycle':
      return <RecycleStep step={step} set={set} />;
    case 'github_issue':
      return <GithubIssueStep step={step} set={set} />;
    case 'plugin_action':
      return <PluginActionStep step={step} set={set} />;
    case 'composio_action':
      return <ComposioActionStep step={step} set={set} customFields={ctx.customFields} />;
    case 'composio_ai':
      return <ComposioAiStep step={step} set={set} customFields={ctx.customFields} />;
    case 'chat_notify':
      return <ChatNotifyStep step={step} set={set} />;
    case 'notion_append':
      return <NotionStep step={step} set={set} />;
    case 'nango_request':
      return <NangoRequestStep step={step} set={set} customFields={ctx.customFields} />;
    case 'mcp_tool':
      return <McpToolStep step={step} set={set} customFields={ctx.customFields} />;
    case 'pm_create_task':
    case 'pm_move_task':
    case 'pm_assign_task':
      return <PmStepEditor step={step} set={set} />;
    case 'genmedia_image':
    case 'genmedia_video':
    case 'genmedia_tts':
      return <GenMediaStep type={step.type} step={step} set={set} customFields={ctx.customFields} />;
    case 'webhook':
      return (
        <Field label="URL" hint={t('Bekommt {contact, event, location} als JSON')}>
          <Input value={step.url} onChange={(v) => set({ url: v })} placeholder="https://…" />
        </Field>
      );
    case 'review_request':
      return (
        <Field label={t('Kanal')}>
          <Select value={step.channel ?? 'email'} onChange={(v) => set({ channel: v })} options={[['email', t('E-Mail')], ['sms', 'SMS']]} />
        </Field>
      );
    case 'add_to_workflow':
    case 'remove_from_workflow':
      return (
        <Field label={t('Workflow')}>
          <Select value={step.workflow_id} onChange={(v) => set({ workflow_id: v })} placeholder={t('wählen…')} options={ctx.workflows.map((w: any) => [w.id, w.name])} />
        </Field>
      );
    default:
      return <GenericStepConfig step={step} set={set} ctx={ctx} part={simple ? 'main' : 'all'} />;
  }
}

function TriggerConfig({ wf, set, ctx }: { wf: any; set: (trigger: any) => void; ctx: any }) {
  const t = useT('workflows');
  const trig = wf.trigger ?? { type: 'contact.tag_added', config: {} };
  const c = trig.config ?? {};
  const setC = (patch: any) => set({ ...trig, config: { ...c, ...patch } });
  const pipe = ctx.pipelines.find((p: any) => p.id === c.pipeline_id);
  return (
    <>
      <Field label={t('Auslöser')} tour="wf-trigger-type">
        <TriggerSelect value={trig.type} onChange={(v) => set({ type: v, config: {} })} labels={TRIGGER_LABELS} />
      </Field>
      <TriggerDoc type={trig.type} config={c} setC={setC} ctx={ctx} />
      {['contact.tag_added', 'contact.tag_removed'].includes(trig.type) && (
        <Field label={t('Tag (leer = jeder)')}>
          <Input value={c.tag} onChange={(v) => setC({ tag: v })} list="wf-tags" />
          <datalist id="wf-tags">
            {ctx.tags.map((x: string) => (
              <option key={x} value={x} />
            ))}
          </datalist>
        </Field>
      )}
      {trig.type === 'form.submitted' && (
        <Field label={t('Formular')}>
          <Select value={c.form_id} onChange={(v) => setC({ form_id: v })} placeholder={t('jedes Formular')} options={ctx.forms.map((f: any) => [f.id, f.name])} />
        </Field>
      )}
      {['appointment.booked', 'appointment.status_changed'].includes(trig.type) && (
        <Field label={t('Kalender')}>
          <Select value={c.calendar_id} onChange={(v) => setC({ calendar_id: v })} placeholder={t('jeder Kalender')} options={ctx.calendars.map((f: any) => [f.id, f.name])} />
        </Field>
      )}
      {trig.type === 'appointment.status_changed' && (
        <Field label={t('Neuer Status')}>
          <Select value={c.status} onChange={(v) => setC({ status: v })} placeholder={t('jeder')} options={[['confirmed', t('bestätigt')], ['cancelled', t('abgesagt')], ['showed', t('erschienen')], ['noshow', t('nicht erschienen')]]} />
        </Field>
      )}
      {trig.type.startsWith('opportunity.') && (
        <Field label="Pipeline">
          <Select value={c.pipeline_id} onChange={(v) => setC({ pipeline_id: v, stage_id: '' })} placeholder={t('jede')} options={ctx.pipelines.map((p: any) => [p.id, p.name])} />
        </Field>
      )}
      {trig.type === 'opportunity.stage_changed' && pipe && (
        <Field label={t('In Stufe')}>
          <Select value={c.stage_id} onChange={(v) => setC({ stage_id: v })} placeholder={t('jede')} options={pipe.stages.map((s: any) => [s.id, s.name])} />
        </Field>
      )}
      {trig.type === 'opportunity.status_changed' && (
        <Field label="Status">
          <Select value={c.status} onChange={(v) => setC({ status: v })} placeholder={t('jeder')} options={[['won', t('Gewonnen')], ['lost', t('Verloren')], ['abandoned', t('Aufgegeben')], ['open', t('Offen')]]} />
        </Field>
      )}
      {trig.type === 'message.inbound' && (
        <Field label={t('Kanal')}>
          <Select value={c.channel} onChange={(v) => setC({ channel: v })} placeholder={t('alle')} options={[['email', t('E-Mail')], ['sms', 'SMS'], ['chat', t('Live-Chat')], ['whatsapp', 'WhatsApp'], ['messenger', 'Messenger'], ['instagram', 'Instagram'], ['telegram', 'Telegram'], ['discord', 'Discord']]} />
        </Field>
      )}
      {trig.type === 'call.completed' && (
        <Field label={t('Richtung')}>
          <Select value={c.direction} onChange={(v) => setC({ direction: v })} placeholder={t('ein- und ausgehend')} options={[['in', t('Eingehend (angenommen)')], ['out', t('Ausgehend (verbunden)')]]} />
        </Field>
      )}
      {trig.type === 'telegram.started' && <TelegramTriggerFilter value={c.campaign} onChange={(v) => setC({ campaign: v })} />}
      {trig.type === 'voice_ai.completed' && <VoiceOutcomeFilter value={c.outcome} onChange={(v) => setC({ outcome: v })} />}
      {['review.received', 'google_review.received'].includes(trig.type) && (
        <Field label={t('Nur bis Sterne (z. B. 3 = schlechte Bewertungen)')}>
          <Input type="number" value={c.max_rating} onChange={(v) => setC({ max_rating: v })} />
        </Field>
      )}
      {trig.type === 'product.purchased' && <ProductTriggerField value={c.product_id} onChange={(v) => setC({ product_id: v })} />}
      {trig.type === 'link.clicked' && (
        <Field label={t('Trigger-Link')}>
          <Select value={c.link_id} onChange={(v) => setC({ link_id: v })} placeholder={t('jeder')} options={ctx.links.map((l: any) => [l.id, l.name])} />
        </Field>
      )}
      {trig.type === 'date.reached' && (
        <>
          <DateFieldPicker c={c} set={setC} customFields={ctx.customFields} />
          <div className="grid2">
            <Field label={t('Uhrzeit')}>
              <Input type="time" value={c.time ?? '09:00'} onChange={(v) => setC({ time: v })} />
            </Field>
            <Field label=" ">
              <Check checked={c.yearly ?? (c.field ?? 'date_of_birth') === 'date_of_birth'} onChange={(v) => setC({ yearly: v })} label={t('Jedes Jahr wiederholen')} />
            </Field>
          </div>
        </>
      )}
      {['course.enrolled', 'course.started', 'lesson.completed', 'course.completed'].includes(trig.type) && <CourseTriggerFilter value={c.course_id} onChange={(v) => setC({ course_id: v })} />}
      {['community.post_created', 'community.member_joined', 'community.level_reached'].includes(trig.type) && <CommunityTriggerFilter type={trig.type} config={c} set={setC} />}
      {(trig.type.startsWith('company.') || trig.type.startsWith('record.')) && <ObjectTriggerFilter type={trig.type} config={c} set={setC} />}
      {trig.type.startsWith('lead_score.') && <LeadScoreTriggerFilter type={trig.type} config={c} set={setC} />}
      {(trig.type.startsWith('ticket.') || trig.type.startsWith('sla.') || trig.type === 'health_score.dropped') && <TicketTriggerFilter type={trig.type} config={c} set={setC} />}
      {trig.type === 'email.clicked' && (
        <Field label={t('Nur wenn die URL enthält (optional)')}>
          <Input value={c.url_contains} onChange={(v) => setC({ url_contains: v })} placeholder="/angebot" />
        </Field>
      )}
      {trig.type.startsWith('task.') && <PmTriggerFilter type={trig.type} config={c} set={setC} />}
      {trig.type === 'webhook.received' && <InboundWebhookTrigger workflowId={wf.id} />}
      {trig.type === 'composio.event' && <ComposioTriggerFilter config={c} set={setC} />}
      {trig.type === 'webhook' && (
        <Field label={t('Webhook-URL (POST JSON mit email, phone, first_name…)')}>
          {wf.webhook_url ? <CodeBox text={wf.webhook_url} /> : <span className="muted">{t('Erst speichern.')}</span>}
        </Field>
      )}
      {trig.type !== 'manual' && <TriggerFilters type={trig.type} config={c} setC={setC} customFields={ctx.customFields} />}
    </>
  );
}

export function WorkflowEditor({ id }: { id: string }) {
  const t = useT('workflows');
  const wf = useLoad(() => api.get(`/api/workflows/${id}`), [id]);
  const runs = useLoad(() => api.get(`/api/workflows/${id}/runs`), [id]);
  const draft = useLoad(() => api.get<{ draft: any }>(`/api/workflows/${id}/draft`), [id]);
  const { cat } = useCatalog();
  const triggerLabel = useTriggerLabel(TRIGGER_LABELS);
  const info = (type: string): [IconName, string] => {
    const [icon, label] = stepInfo(type, cat, STEP_LABELS);
    return [icon, t(label)];
  };
  useEffect(() => resetRemoteCache(), [id]);
  const ctx = {
    pipelines: useLoad(() => api.get<any[]>('/api/pipelines'), []).data ?? [],
    forms: useLoad(() => api.get<any[]>('/api/forms'), []).data ?? [],
    calendars: useLoad(() => api.get<any[]>('/api/calendars'), []).data ?? [],
    workflows: (useLoad(() => api.get<any[]>('/api/workflows'), []).data ?? []).filter((w) => w.id !== id),
    templates: useLoad(() => api.get<any[]>('/api/templates'), []).data ?? [],
    customFields: useLoad(() => api.get<any[]>('/api/custom-fields'), []).data ?? [],
    links: useLoad(() => api.get<any[]>('/api/trigger-links'), []).data ?? [],
    tags: useTags(),
  };
  const [sel, setSel] = useState('trigger');
  const [tab, setTab] = useState('builder');
  const [dirty, setDirty] = useState(false);
  const [openRun, setOpenRun] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  // Builder tools of both editors: list ⇄ canvas, copy/paste/move/pause, validation issues on the steps (shown once saved).
  const [mode, setMode] = useEditorMode();
  const [checked, setChecked] = useState(false);
  const ops = useStepOps({ workflowId: id, steps: wf.data?.steps ?? [], onSteps: (steps) => (wf.setData({ ...wf.data, steps }), setDirty(true)), onSelect: setSel });
  const allIssues = useIssues(wf.data?.steps, cat?.actions, true);
  const issues = checked || wf.data?.issues?.length ? allIssues : {};
  if (!wf.data) return <Spinner />;
  const w = wf.data;
  const toolCtx: ToolCtx & typeof ctx = { ...ctx, steps: flatSteps(w.steps).map((s, i) => ({ id: s.id, label: `${i + 1}. ${info(s.type)[1]}${s.name ? ` – ${s.name}` : ''}` })) };
  const update = (patch: any) => {
    wf.setData({ ...w, ...patch });
    setDirty(true);
  };
  const save = async (extra: any = {}) => {
    const r = await act(() => api.patch(`/api/workflows/${id}`, { name: w.name, trigger: w.trigger, steps: w.steps, settings: w.settings, ...extra }), t('Gespeichert'));
    if (r) {
      wf.setData(r);
      setDirty(false);
      setChecked(true);
      announceIssues(r.issues?.length ?? 0);
    }
  };
  const step = sel !== 'trigger' ? findStep(w.steps, sel) : undefined;
  const setStep = (sid: string) => (p: any) => update({ steps: mapSteps(w.steps, (s) => (s.id === sid ? { ...s, ...p } : s)) });
  /** The settings of a step – the list's side panel and the canvas's drawer show the same form. */
  const stepForm = (s: Step, set: (p: any) => void) => {
    // Einfach-Modus: the action's own fields stay, its name, error handling and fine-tuning go behind "Weitere Felder".
    const meta = cat?.actions.find((a) => a.type === s.type);
    const folded = !hasStepMore(s.type) && meta && !meta.custom ? changedFieldValues(splitCatalogFields(meta.fields).more, s) : [];
    return (
      <>
        <StepDoc type={s.type} />
        <StepConfig step={s} set={set} ctx={toolCtx} />
        {s.type !== 'end' && (
          // keyed on the catalogue too: a changed fine-tuning field must open the toggle once the catalogue has loaded
          <MoreFields key={`${s.id}:${cat ? 1 : 0}`} id="wf-step" values={[...stepMoreValues(s), ...folded]}>
            <StepMore step={s} set={set} ctx={toolCtx} />
            {!['if', 'goal'].includes(s.type) && <StepNameField step={s} set={set} />}
            {!['if', 'goal', 'wait'].includes(s.type) && <ContinueOnError step={s} set={set} />}
          </MoreFields>
        )}
      </>
    );
  };

  return (
    <>
      <PageHead title={w.name} sub={<Badge tone={w.status === 'active' ? 'green' : w.status === 'paused' ? 'yellow' : 'gray'}>{w.status === 'active' ? t('aktiv') : w.status === 'paused' ? t('pausiert') : t('Entwurf')}</Badge>}>
        <Link to="workflows" className="btn secondary">
          {t('← Workflows')}
        </Link>
        <CanvasPin kind="workflow" id={w.id} name={w.name} />
        {w.status === 'active' ? (
          <button className="btn secondary" onClick={() => save({ status: 'paused' })}>
            {t('Pausieren')}
          </button>
        ) : (
          <button className="btn secondary" data-tour="wf-activate" onClick={() => confirmActivate(Object.keys(allIssues).length) && save({ status: 'active' })}>
            {t('▶ Aktivieren')}
          </button>
        )}
        <button className="btn secondary" data-tour="wf-test" onClick={() => setTesting(true)}>
          <Icon name="play" /> {t('Testlauf')}
        </button>
        <WorkflowAiButton mode="edit" workflowId={id} dirty={dirty} onApplied={() => (draft.reload(), setTab('versions'))} />
        <button className="btn" data-tour="wf-save" disabled={!dirty} onClick={() => save()}>
          {dirty ? t('Speichern') : t('Gespeichert ✓')}
        </button>
      </PageHead>
      <Tabs tabs={[['builder', t('Ablauf')], ['runs', t('Verlauf ({n})', { n: runs.data?.runs.length ?? 0 })], ['versions', t('Versionen')], ['settings', t('Einstellungen')]]} value={tab} onChange={setTab} />
      {tab === 'builder' && draft.data?.draft && (
        <div className="card" style={{ marginBottom: 12 }} data-tour="wf-draft-banner">
          {t('Es gibt einen Entwurf von')} <strong>{draft.data.draft.user_name || t('jemandem')}</strong> ({dt(draft.data.draft.updated_at)}).{' '}
          <button className="btn small secondary" onClick={() => setTab('versions')}>
            {t('Entwurf ansehen / veröffentlichen')}
          </button>
        </div>
      )}
      {tab === 'builder' && (
        <div className="wfc-builder-bar">
          <EditorToggle mode={mode} onChange={setMode} />
        </div>
      )}
      {tab === 'builder' && <StepOpsLayer ops={ops} banner={mode === 'list'} />}
      {tab === 'builder' && mode === 'canvas' && (
        <PageSuspense>
          <WorkflowCanvas
            workflowId={id}
            steps={w.steps}
            trigger={w.trigger}
            layout={w.settings?.layout}
            cat={cat}
            labels={STEP_LABELS}
            info={info}
            summary={(s: Step) => summary(s, cat)}
            triggerLabel={triggerLabel}
            newStep={(type: string) => makeStep(type, cat)}
            renderStep={stepForm}
            renderTrigger={(trigger: any, set: (trigger: any) => void) => <TriggerConfig wf={{ ...w, trigger }} set={set} ctx={toolCtx} />}
            onSteps={(steps: Step[]) => update({ steps })}
            onLayout={(layout: unknown) => update({ settings: { ...w.settings, layout } })}
            onCommit={async (patch: { steps?: Step[]; trigger?: any }) => (wf.setData({ ...w, ...patch }), save(patch))}
            issues={issues}
            runs={runs.data}
            ops={ops}
          />
        </PageSuspense>
      )}
      {tab === 'builder' && mode === 'list' && (
        <div className="builder" style={{ gridTemplateColumns: '1fr 380px' }}>
          <div className="card" style={{ background: 'var(--bg)' }} onClick={() => setSel('trigger')} data-tour="wf-flow">
            <div className={`wf-step${sel === 'trigger' ? ' on' : ''}`} style={{ borderColor: 'var(--green)' }} data-tour="wf-trigger" {...pressable((e) => (e.stopPropagation(), setSel('trigger')))}>
              <strong><Icon name="trigger" /> {t('Auslöser:')} {triggerLabel(w.trigger?.type)}</strong>
              <div className="muted small">{Object.values(w.trigger?.config ?? {}).filter(Boolean).length ? t('mit Filter') : t('ohne Filter')}</div>
            </div>
            <div className="wf-line" />
            <StepList steps={w.steps} onChange={(s) => update({ steps: s })} sel={sel} onSel={setSel} counts={runs.data?.at ?? {}} cat={cat} ops={ops} issues={issues} />
            <div className="wf-line" />
            <div style={{ textAlign: 'center' }} className="muted">
              <Icon name="end" /> {t('Ende')}
            </div>
          </div>
          <div className="card" style={{ position: 'sticky', top: 70 }} data-tour="wf-config">
            {sel === 'trigger' ? (
              <>
                <h2>{t('Auslöser')}</h2>
                <TriggerConfig wf={w} set={(trigger) => update({ trigger })} ctx={toolCtx} />
              </>
            ) : step ? (
              <>
                <h2>
                  <Icon name={info(step.type)[0]} /> {info(step.type)[1]}
                </h2>
                <IssueNote issues={issues[step.id]} />
                {stepForm(step, setStep(step.id))}
              </>
            ) : (
              <p className="muted">{t('Schritt wählen.')}</p>
            )}
          </div>
        </div>
      )}
      {tab === 'runs' && flatSteps(w.steps).some((x) => x.type === 'split_test') && <SplitStats workflowId={id} />}
      {tab === 'runs' && <RetryAll workflowId={id} count={(runs.data?.runs ?? []).filter((r: any) => r.status === 'failed').length} onDone={runs.reload} />}
      {tab === 'runs' && (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>{t('Kontakt')}</th>
                <th>Status</th>
                <th>{t('Gestartet')}</th>
                <th>{t('Weiter am')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(runs.data?.runs ?? []).map((r: any) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`contacts/${r.contact_id}`}>{name(r)}</Link>
                  </td>
                  <td>
                    <Badge tone={r.status === 'completed' ? 'green' : r.status === 'failed' ? 'red' : r.status === 'waiting' ? 'yellow' : 'blue'}>{runStatusLabel(r.status)}</Badge>
                  </td>
                  <td className="muted">{dt(r.created_at)}</td>
                  <td className="muted">{r.status === 'waiting' ? dt(r.next_run_at) : ''}</td>
                  <td className="actions">
                    <button className="btn small secondary" onClick={() => setOpenRun(r)}>
                      {t('Protokoll')}
                    </button>
                    {['waiting', 'active'].includes(r.status) && (
                      <button className="btn small ghost" onClick={() => act(() => api.post(`/api/workflow-runs/${r.id}/stop`)).then(runs.reload)}>
                        {t('Stoppen')}
                      </button>
                    )}
                    <RetryButton run={r} onDone={runs.reload} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!runs.data?.runs.length && <Empty>{t('Noch niemand in diesem Workflow.')}</Empty>}
        </div>
      )}
      {tab === 'settings' && (
        <div className="card" style={{ maxWidth: 640 }}>
          <Field label="Name">
            <Input value={w.name} onChange={(v) => update({ name: v })} />
          </Field>
          <Check checked={!!w.settings?.allow_reentry} onChange={(v) => update({ settings: { ...w.settings, allow_reentry: v } })} label={t('Kontakte dürfen den Workflow mehrfach durchlaufen')} />
          <Check checked={!!w.settings?.stop_on_error} onChange={(v) => update({ settings: { ...w.settings, stop_on_error: v } })} label={t('Bei Fehler anhalten (sonst nächster Schritt)')} />
          <MoreFields id="wf-settings" label={t('Fehlerbehandlung')} values={[w.settings?.on_error_workflow_id, w.settings?.error_bell, w.settings?.error_email]}>
            <ErrorSettings w={w} update={update} />
          </MoreFields>
          <hr />
          <button className="btn secondary" data-tour="wf-export" onClick={() => exportWorkflow(id, w.name)} style={{ marginRight: 8 }}>
            {t('Als JSON exportieren')}
          </button>
          <button className="btn danger" onClick={async () => confirmAsk(t('Workflow löschen?')) && (await act(() => api.del(`/api/workflows/${id}`))) && navigate('workflows')}>
            {t('Workflow löschen')}
          </button>
        </div>
      )}
      {openRun && <RunLogModal run={openRun} steps={w.steps} info={info} onClose={() => setOpenRun(null)} />}
      {tab === 'versions' && (
        <VersionsTab
          id={id}
          current={{ name: w.name, trigger: w.trigger, steps: w.steps, settings: w.settings }}
          dirty={dirty}
          info={info}
          triggerLabel={triggerLabel}
          onLoadDraft={(d) => {
            update({ ...(d.name ? { name: d.name } : {}), trigger: d.trigger, steps: d.steps, settings: d.settings });
            setSel('trigger');
            setTab('builder');
          }}
          onPublished={(saved) => {
            wf.setData(saved);
            setDirty(false);
            draft.reload();
          }}
        />
      )}
      {testing && <TestRunModal workflowId={id} draft={{ trigger: w.trigger, steps: w.steps, settings: w.settings }} dirty={dirty} sample={(cat?.triggers.find((x) => x.type === w.trigger?.type)?.sample ?? {}) as Record<string, any>} steps={w.steps} info={info} onClose={() => setTesting(false)} />}
    </>
  );
}

export function Workflows() {
  const t = useT('workflows');
  const list = useLoad(() => api.get<any[]>('/api/workflows'), []);
  const meta = useLoad(() => api.get('/api/workflows/meta'), []);
  const [modal, setModal] = useState(false);
  const [importing, setImporting] = useState(false);
  const [folder, setFolder] = useState<WorkflowFolderFilter>(ALL_FOLDERS);
  const triggerLabel = useTriggerLabel(TRIGGER_LABELS);
  const create = async (recipe?: string) => {
    const r = await act(() => api.post('/api/workflows', recipe ? { recipe } : { name: t('Neuer Workflow') }));
    if (r) navigate(`workflows/${r.id}`);
  };
  return (
    <>
      <PageHead title={t('Automationen')} sub={t('Workflows: Auslöser → Aktionen, mit Wartezeiten und Wenn/Sonst')}>
        <button className="btn secondary" data-tour="workflows-import" onClick={() => setImporting(true)}>
          {t('Importieren')}
        </button>
        {!!list.data?.length && (
          <button className="btn secondary" data-tour="workflows-export" onClick={() => exportAll()}>
            {t('Alle exportieren')}
          </button>
        )}
        <WorkflowAiButton mode="create" onApplied={(r) => navigate(`workflows/${r.workflow_id}`)} />
        <button className="btn" data-tour="workflows-new" onClick={() => setModal(true)}>
          {t('+ Workflow')}
        </button>
      </PageHead>
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.data?.length ? (
        <>
        <WorkflowFolderBar rows={list.data} value={folder} onChange={setFolder} onChanged={() => void list.reload()} />
        <div className="table-wrap" data-tour="workflows-list">
          <table className="t">
            <thead>
              <tr>
                <th>Name</th>
                <th>{t('Auslöser')}</th>
                <th>Status</th>
                <th>{t('Aktiv / Gesamt')}</th>
                <th>{t('Geändert')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.filter(inWorkflowFolder(folder)).map((w) => (
                <tr key={w.id} className="click" {...pressable(() => navigate(`workflows/${w.id}`))}>
                  <td>
                    <strong>{w.name}</strong>
                    <div className="muted small">{t.plural(w.steps.length, { other: '{n} Schritte' })}</div>
                  </td>
                  <td>{triggerLabel(w.trigger?.type)}</td>
                  <td>
                    <Badge tone={w.status === 'active' ? 'green' : w.status === 'paused' ? 'yellow' : 'gray'}>{w.status === 'active' ? t('aktiv') : w.status === 'paused' ? t('pausiert') : t('Entwurf')}</Badge>
                  </td>
                  <td>
                    {w.active_runs} / {w.enrolled}
                  </td>
                  <td className="muted">{dt(w.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      ) : (
        <Empty learn action={<button className="btn" onClick={() => setModal(true)}>{t('Ersten Workflow bauen')}</button>}>{t('Noch keine Automationen.')}</Empty>
      )}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={list.reload} />}
      {modal && (
        <Modal title={t('Neuer Workflow')} onClose={() => setModal(false)}>
          <button className="btn secondary" data-tour="workflows-blank" style={{ width: '100%', marginBottom: 8 }} onClick={() => create()}>
            {t('Leer starten')}
          </button>
          <p className="muted">{t('…oder mit einer Vorlage:')}</p>
          {(meta.data?.recipes ?? []).map((r: any) => (
            <button key={r.key} className="btn secondary" style={{ width: '100%', marginBottom: 6, justifyContent: 'flex-start' }} onClick={() => create(r.key)}>
              <Icon name="trigger" /> {r.name}
            </button>
          ))}
        </Modal>
      )}
    </>
  );
}
