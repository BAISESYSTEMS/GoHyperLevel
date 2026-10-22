import type { RWorkflow } from './umzug-core.js';
import { clip, convertMergeTags } from './umzug-text.js';

/**
 * Best-effort translation of other tools' automations into HyperLevel workflow drafts. Common triggers and
 * actions are mapped; everything else becomes a note step that carries the original JSON, so nothing is
 * lost silently. Branches (if/else, splits, goals) are not rebuilt: the steps are laid out in a row and
 * the draft says so. The writer always saves these as drafts labelled "bitte prüfen".
 */

type Json = Record<string, any>;
export type Vendor = 'activecampaign' | 'kit' | 'keap';

export interface Lookup {
  tag?: (id: unknown) => string | undefined;
  list?: (id: unknown) => string | undefined;
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');
const params = (b: Json): Json => (b.params && typeof b.params === 'object' ? b.params : b.data && typeof b.data === 'object' ? b.data : b.settings && typeof b.settings === 'object' ? b.settings : b.config && typeof b.config === 'object' ? b.config : b);
const text = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

const TRIGGERS: [RegExp, string][] = [
  [/(tagadded|tagapplied|taggedwith|addedtag|tagisadded)/, 'contact.tag_added'],
  [/(tagremoved|removedtag)/, 'contact.tag_removed'],
  [/(subscribes?|listsubscribe|joinslist|addedtolist|subscribedtolist|newsubscriber|subscribed)/, 'contact.created'],
  [/(formsubmit|submitsform|submitsaform|formsubmitted)/, 'form.submitted'],
  [/(emailopen|opensemail|opensacampaign|emailopened)/, 'email.opened'],
  [/(clicklink|linkclick|clicksemail|clicksalink|linkclicked)/, 'email.clicked'],
  [/(dealstage|stagechanged|dealmoved)/, 'opportunity.stage_changed'],
  [/(dealcreated|newdeal|opportunitycreated)/, 'opportunity.created'],
  [/(purchase|orderplaced|productpurchased|paid)/, 'product.purchased'],
  [/(date|anniversary|birthday)/, 'date.reached'],
  [/(webhook|api)/, 'webhook'],
];

export function mapTrigger(raw: Json | undefined, look: Lookup = {}): { trigger: { type: string; config: Json }; warning?: string } {
  if (!raw) return { trigger: { type: 'manual', config: {} }, warning: 'Auslöser unbekannt – auf „Manuell“ gesetzt' };
  const p = params(raw);
  // The block says "start"/"trigger"; what starts the automation is named in its parameters (or in the block itself).
  const kinds = [p.type, p.event, p.kind, p.trigger, p.name, raw.event, raw.name, raw.type, raw.kind].map(norm).filter((k) => k && !/^(start|trigger)$/.test(k));
  for (const [re, type] of TRIGGERS) {
    const kind = kinds.find((k) => re.test(k));
    if (!kind) continue;
    const config: Json = {};
    if (type === 'contact.tag_added' || type === 'contact.tag_removed') {
      const tag = text(p.tag) || text(p.tagName) || text(p.tag_name) || look.tag?.(p.tagid ?? p.tag_id ?? p.tagId);
      if (tag) config.tag = tag;
    }
    return { trigger: { type, config }, warning: type === 'contact.created' && (p.list || p.listid) ? `Auslöser „Zu Liste hinzugefügt“ wurde zu „Kontakt angelegt“ – die Listen-Bedingung (${look.list?.(p.list ?? p.listid) ?? p.list ?? p.listid}) bitte als Tag-Filter nachbauen` : undefined };
  }
  return { trigger: { type: 'manual', config: {} }, warning: `Auslöser „${clip(raw.type ?? raw.name ?? '?', 40)}“ hat keine Entsprechung – auf „Manuell“ gesetzt` };
}

function waitStep(p: Json): Json {
  const raw = Number(p.duration ?? p.amount ?? p.value ?? p.delay ?? p.days ?? 1) || 1;
  const unit = norm(p.unit ?? p.period ?? p.interval ?? (p.days !== undefined ? 'days' : 'days'));
  if (/^min/.test(unit)) return { type: 'wait', amount: raw, unit: 'minutes' };
  if (/^h/.test(unit)) return { type: 'wait', amount: raw, unit: 'hours' };
  if (/^w/.test(unit)) return { type: 'wait', amount: raw * 7, unit: 'days' };
  if (/^mo/.test(unit)) return { type: 'wait', amount: raw * 30, unit: 'days' };
  return { type: 'wait', amount: raw, unit: 'days' };
}

const note = (vendor: string, what: string, original: unknown): Json => ({ type: 'add_note', body: `Nicht übernommen (${vendor}: ${what}). Original: ${clip(JSON.stringify(original), 3000)}` });

/** One block → one step (or a note step); returns warnings for the report. */
export function mapBlock(vendor: Vendor, b: Json, look: Lookup = {}): { steps: Json[]; warnings: string[] } {
  const kind = norm(b.type ?? b.kind ?? b.action ?? b.name);
  const p = params(b);
  const tagName = () => text(p.tag) || text(p.tagName) || text(p.tag_name) || look.tag?.(p.tagid ?? p.tag_id ?? p.tagId) || '';
  const fail = (why: string) => ({ steps: [note(vendor, why, b)], warnings: [`Schritt „${clip(b.type ?? b.name ?? '?', 40)}“ nicht übernommen (${why})`] });
  if (/^(start|trigger)$/.test(kind)) return { steps: [], warnings: [] };
  if (/^(sendemail|email|campaign|sendcampaign|sendanemail|sendmessage)$/.test(kind)) {
    const subject = text(p.subject) || text(p.subjectline) || text(p.name) || text(b.name) || 'E-Mail aus dem Umzug';
    const html = text(p.html) || text(p.content) || text(p.body) || '';
    const v = vendor === 'keap' || vendor === 'kit' || vendor === 'activecampaign' ? vendor : undefined;
    const body = html ? (v ? convertMergeTags(v, html).text : html) : `[Inhalt der E-Mail „${subject}“ bitte aus ${vendor === 'activecampaign' ? 'ActiveCampaign' : vendor === 'kit' ? 'Kit' : 'Keap'} einfügen]`;
    return { steps: [{ type: 'send_email', subject: v ? convertMergeTags(v, subject).text : subject, body, isHtml: /<[a-z][\s\S]*>/i.test(body) }], warnings: html ? [] : [`E-Mail „${subject}“: Inhalt liefert die API nicht – Platzhaltertext eingesetzt`] };
  }
  if (/^(sendsms|sms|text)$/.test(kind)) return { steps: [{ type: 'send_sms', body: text(p.message) || text(p.body) || text(p.text) || '[SMS-Text einfügen]' }], warnings: [] };
  if (/^(wait|delay|waitfor|timedelay|waituntil)/.test(kind)) return { steps: [waitStep(p)], warnings: /until|date/.test(kind) ? ['„Warten bis Datum“ wurde als feste Wartezeit übernommen – bitte prüfen'] : [] };
  if (/^(addtag|tagadd|applytag|tag|addtags)$/.test(kind)) {
    const t = tagName();
    return t ? { steps: [{ type: 'add_tag', tags: [t] }], warnings: [] } : fail('Tag-Name unbekannt');
  }
  if (/^(removetag|tagremove|removetags)$/.test(kind)) {
    const t = tagName();
    return t ? { steps: [{ type: 'remove_tag', tags: [t] }], warnings: [] } : fail('Tag-Name unbekannt');
  }
  if (/^(updatefield|setfield|updatecontact|updatecustomfield)$/.test(kind)) return text(p.field) || text(p.fieldname) ? { steps: [{ type: 'update_field', field: text(p.field) || text(p.fieldname), value: text(p.value) }], warnings: ['Feldname aus der Quelle – bitte dem HyperLevel-Feld zuordnen'] } : fail('Feld unbekannt');
  if (/^(createtask|addtask|task)$/.test(kind)) return { steps: [{ type: 'create_task', title: text(p.title) || text(p.name) || 'Aufgabe', due_in_days: Number(p.days ?? 0) || 0 }], warnings: [] };
  if (/^(addnote|note)$/.test(kind)) return { steps: [{ type: 'add_note', body: text(p.note) || text(p.body) || text(p.text) || 'Notiz' }], warnings: [] };
  if (/^(notify|sendnotification|notifyteam|notification)$/.test(kind)) return { steps: [{ type: 'notify', subject: text(p.subject) || 'Benachrichtigung', body: text(p.body) || text(p.message) || '' }], warnings: [] };
  if (/^(webhook|posttourl|posttoaurl)$/.test(kind) && /^https?:\/\//.test(text(p.url))) return { steps: [{ type: 'webhook', url: text(p.url), method: 'POST' }], warnings: [] };
  if (/^(unsubscribe|unsubscribefromall|dnd)$/.test(kind)) return { steps: [{ type: 'set_dnd', value: true }], warnings: [] };
  if (/^(end|exit|stop|endautomation)$/.test(kind)) return { steps: [{ type: 'end' }], warnings: [] };
  if (/(if|else|condition|split|goal|branch|wait.?until.?cond)/.test(kind)) return { steps: [note(vendor, 'Verzweigung/Bedingung', b)], warnings: [`Verzweigung „${clip(b.type ?? b.name ?? '?', 40)}“ nicht nachgebaut – bitte als Wenn/Sonst-Schritt neu anlegen`] };
  return fail(`Typ „${clip(b.type ?? b.name ?? '?', 40)}“ hat keine Entsprechung`);
}

export function mapAutomation(vendor: Vendor, input: { id: string | number; name: string; blocks: Json[]; trigger?: Json; active?: boolean }, look: Lookup = {}): RWorkflow {
  const warnings: string[] = [];
  const blocks = input.blocks ?? [];
  const start = input.trigger ?? blocks.find((b) => /^(start|trigger)$/.test(norm(b.type ?? b.kind)));
  const t = mapTrigger(start, look);
  if (t.warning) warnings.push(t.warning);
  const steps: Json[] = [];
  for (const b of blocks) {
    if (b === start) continue;
    const r = mapBlock(vendor, b, look);
    steps.push(...r.steps);
    warnings.push(...r.warnings);
  }
  if (!blocks.length) {
    warnings.push('Die Schritte dieser Automation hat die API nicht geliefert – nur Name und Status wurden übernommen');
    steps.push({ type: 'add_note', body: `Die Schritte der ${vendor === 'activecampaign' ? 'ActiveCampaign' : vendor === 'kit' ? 'Kit' : 'Keap'}-Automation „${clip(input.name, 80)}“ wurden nicht geliefert. Bitte hier nachbauen.` });
  }
  if (blocks.some((b) => /(if|else|condition|split|goal|branch)/.test(norm(b.type ?? b.kind)))) warnings.push('Die Automation hatte Verzweigungen: HyperLevel-Entwurf läuft geradlinig, bitte prüfen');
  if (input.active === false) warnings.push('In der Quelle war die Automation inaktiv');
  return { kind: 'workflow', ext: `a:${input.id}`, name: clip(input.name, 160) || 'Automation', trigger: t.trigger, steps, warnings: [...new Set(warnings)] };
}

/** Kit sequences: emails with their delays (when the source delivers them) as a row of mail + wait steps. */
export function mapSequence(vendor: Vendor, input: { id: string | number; name: string; emails?: { subject?: string; content?: string; delay_days?: number; delay?: number }[]; hold?: boolean }): RWorkflow {
  const warnings: string[] = [];
  const steps: Json[] = [];
  const mails = input.emails ?? [];
  if (!mails.length) {
    warnings.push('Die E-Mails dieser Sequenz stellt die API nicht bereit – bitte die Texte aus dem Original einfügen');
    steps.push({ type: 'add_note', body: `Sequenz „${clip(input.name, 80)}“ – die E-Mails hat die API nicht geliefert. Hier die Schritte nachbauen: E-Mail → warten → E-Mail …` });
  }
  mails.forEach((m, i) => {
    const d = Number(m.delay_days ?? m.delay ?? 0) || 0;
    if (i > 0 || d > 0) steps.push({ type: 'wait', amount: Math.max(d, 0) || 1, unit: 'days' });
    const body = m.content ? convertMergeTags(vendor, m.content).text : `[Inhalt von „${m.subject ?? `E-Mail ${i + 1}`}“ einfügen]`;
    steps.push({ type: 'send_email', subject: convertMergeTags(vendor, m.subject ?? `E-Mail ${i + 1}`).text, body, isHtml: /<[a-z][\s\S]*>/i.test(body) });
    if (!m.content) warnings.push(`E-Mail „${m.subject ?? i + 1}“: kein Inhalt geliefert`);
  });
  if (input.hold) warnings.push('In der Quelle war die Sequenz angehalten');
  return { kind: 'workflow', ext: `q:${input.id}`, name: clip(`Sequenz: ${input.name}`, 160), trigger: { type: 'manual', config: {} }, steps, warnings: [...new Set(warnings)] };
}
