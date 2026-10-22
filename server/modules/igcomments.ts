import type { Module } from '../core/app.js';
import { bad, clampLimit, notFound, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { addTags, getContact, logActivity, upsertContact } from '../services/contacts.js';
import { auditLog, clip, json } from '../services/creator-kit.js';
import { CHANNEL_LABEL, externalId, type MetaChannel } from '../services/meta.js';
import { POLICY_NOTES, appliesTo, channelOf, cleanButtons, cleanRule, describeButtons, dmContent, matchKeyword, messengerMessage, parseComments, parseStoryReplies, replyAt, whatsappInteractive, type CommentEvent, type RuleInput } from '../services/igcomments.js';
import { getOrCreateConversation } from '../services/messaging.js';
import { processRun, startWorkflow } from '../services/workflow-engine.js';
import { registerActions, registerTriggers, requireText, text as fill } from '../services/wfx-kit.js';
import type { Tool } from './mcp.js';

/**
 * Kommentar-zu-DM (ManyChat style) for Instagram and Facebook pages. A rule says: when a comment (on all posts or one post/reel)
 * contains a keyword, answer publicly with one of several rotating texts and send a private reply – a direct message with a
 * lead magnet link and buttons –, create or update the contact, tag it and start a workflow. Story replies with a keyword work
 * the same way. Comments arrive on the Meta webhook (`comments` for Instagram, `feed` for pages) through
 * app.services.metaWebhookHooks; every comment is handled once, private replies follow Meta's rules, and rate limits keep the
 * account safe. Also here: the workflow action for messages with buttons / quick replies. Docs: docs/comment-to-dm.md.
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Record<string, any>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
/** Hard cap of private replies per account and hour, below Meta's own limit. */
const ACCOUNT_DMS_PER_HOUR = 200;
const HOUR = 3600_000;

const TOOLS: Tool[] = [
  {
    name: 'ghl_ig_comment_rules',
    title: 'Kommentar-zu-DM-Regeln',
    description:
      'Verwaltet die Regeln für Instagram-/Facebook-Kommentare und Story-Antworten: action list (Standard), create, update, delete, events (letzte Treffer) oder test (prüft einen Beispieltext, ohne etwas zu senden). Eine Regel: name, kind comment|story_reply, platform instagram|facebook|both, scope all|post (+ media_id), keywords [..], match_mode contains|exact|any, public_replies [..] (rotieren), dm_text, link_url, link_label, buttons [{type: url|reply, title, value}], tags [..], workflow_id, max_per_hour, enabled. Meta erlaubt eine private Antwort je Kommentar.',
    inputSchema: obj(
      {
        ...LOC,
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete', 'events', 'test'] },
        rule_id: { type: 'string' },
        rule: { type: 'object', description: 'Felder der Regel (bei create/update)' },
        text: { type: 'string', description: 'Beispielkommentar (bei test)' },
        platform: { type: 'string', enum: ['instagram', 'facebook'] },
        media_id: { type: 'string' },
      },
      ['location_id'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    klassFor: (a) => (!a.action || a.action === 'list' || a.action === 'events' || a.action === 'test' ? 'read' : a.action === 'delete' ? 'sensitive' : 'write'),
    run: (call, a) => {
      const L = a.location_id;
      const rid = a.rule_id ? encodeURIComponent(a.rule_id) : '';
      switch (a.action ?? 'list') {
        case 'list':
          return call.api('GET', '/api/ig-comments/rules', { location: L });
        case 'create':
          return call.api('POST', '/api/ig-comments/rules', { body: a.rule ?? {}, location: L });
        case 'update':
          return call.api('PATCH', `/api/ig-comments/rules/${rid}`, { body: a.rule ?? {}, location: L });
        case 'delete':
          return call.api('DELETE', `/api/ig-comments/rules/${rid}`, { location: L });
        case 'events':
          return call.api('GET', `/api/ig-comments/events${a.rule_id ? `?rule_id=${rid}` : ''}`, { location: L });
        case 'test':
          return call.api('POST', '/api/ig-comments/test', { body: { text: a.text, platform: a.platform, media_id: a.media_id }, location: L });
        default:
          throw new Error('action: list, create, update, delete, events oder test');
      }
    },
  },
];

interface Rule extends RuleInput {
  id: string;
  location_id: string;
  reply_index: number;
  once_per_person: number;
}

interface EventRow {
  id: string;
  location_id: string;
  rule_id: string | null;
  platform: 'instagram' | 'facebook';
  kind: string;
  comment_id: string;
  media_id: string;
  from_id: string;
  from_name: string;
  from_username: string;
  text: string;
  keyword: string;
  status: string;
  public_status: string;
  dm_status: string;
  contact_id: string | null;
  error: string;
  attempts: number;
  created_at: string;
}

export const igCommentsModule: Module = {
  name: 'igcomments',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE igc_rules (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, name TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'comment', platform TEXT NOT NULL DEFAULT 'instagram', scope TEXT NOT NULL DEFAULT 'all',
        media_id TEXT NOT NULL DEFAULT '', media_label TEXT NOT NULL DEFAULT '', keywords TEXT NOT NULL DEFAULT '[]', match_mode TEXT NOT NULL DEFAULT 'contains',
        public_replies TEXT NOT NULL DEFAULT '[]', reply_index INTEGER NOT NULL DEFAULT 0, dm_text TEXT NOT NULL DEFAULT '', link_url TEXT NOT NULL DEFAULT '',
        link_label TEXT NOT NULL DEFAULT '', buttons TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]', workflow_id TEXT NOT NULL DEFAULT '',
        max_per_hour INTEGER NOT NULL DEFAULT 60, once_per_person INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX igc_rules_loc ON igc_rules(location_id, enabled);
      CREATE TABLE igc_events (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, rule_id TEXT REFERENCES igc_rules(id) ON DELETE SET NULL,
        platform TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'comment', comment_id TEXT NOT NULL, media_id TEXT NOT NULL DEFAULT '', from_id TEXT NOT NULL DEFAULT '',
        from_name TEXT NOT NULL DEFAULT '', from_username TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', keyword TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'queued', public_status TEXT NOT NULL DEFAULT '', dm_status TEXT NOT NULL DEFAULT '', contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        error TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, done_at TEXT, UNIQUE(location_id, comment_id)
      );
      CREATE INDEX igc_events_loc ON igc_events(location_id, created_at);
      CREATE INDEX igc_events_rule ON igc_events(rule_id, created_at);
      CREATE INDEX igc_events_status ON igc_events(status, created_at);
      CREATE TABLE igc_story_pending (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, external_id TEXT NOT NULL, story_id TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
        from_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, PRIMARY KEY (location_id, external_id)
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    const kit = () => app.services.metaKit as
      | { accountFor(hook: string, secret: string, ch: MetaChannel, accountId: string): string | undefined; ids(loc: string): any; graph(loc: string, ch: MetaChannel, method: string, path: string, body?: unknown): Promise<any>; windowState(loc: string, contactId: string, ch: MetaChannel): { open: boolean } }
      | undefined;

    const rulesOf = (loc: string): Rule[] =>
      db.all<any>('SELECT * FROM igc_rules WHERE location_id = ? ORDER BY priority DESC, created_at', loc).map((r) => ({ ...r, keywords: json(r.keywords, []), public_replies: json(r.public_replies, []), buttons: json(r.buttons, []), tags: json(r.tags, []), enabled: !!r.enabled }));
    const ruleOf = (loc: string, rid: string): Rule | undefined => rulesOf(loc).find((r) => r.id === rid);

    registerTriggers(app, [
      {
        type: 'igcomment.matched',
        label: 'Kommentar-Stichwort getroffen (Instagram/Facebook)',
        category: 'marketing',
        summary: 'Ein Kommentar oder eine Story-Antwort trifft eine Regel unter Kommentar-zu-DM.',
        doc: 'Der Kontakt ist der Kommentierende (wird angelegt oder wiedererkannt). {{event.text}} ist der Kommentar, {{event.keyword}} das getroffene Stichwort, {{event.dm_sent}} ob die private Nachricht rausging, {{event.platform}} instagram oder facebook. Die Regel startet die gewählte Workflow-Vorlage selbst – dieser Auslöser ist für zusätzliche Abläufe.',
        fields: [{ key: 'rule_id', label: 'Nur Regel (ID)', type: 'text' }, { key: 'platform', label: 'Nur Plattform', type: 'select', options: [['instagram', 'Instagram'], ['facebook', 'Facebook']] }],
        sample: { ruleId: 'r1', rule: { id: 'r1', name: 'Stichwort „guide“' }, kind: 'comment', platform: 'instagram', commentId: '178…', mediaId: '179…', text: 'Guide bitte 🙏', keyword: 'guide', dm_sent: true, public_reply_sent: true },
        keywords: 'instagram facebook kommentar manychat stichwort keyword dm lead magnet story',
      },
    ]);
    app.services.workflowTriggerFilters = {
      ...(app.services.workflowTriggerFilters ?? {}),
      'igcomment.matched': (c: any, d: any) => (!c.rule_id || c.rule_id === d.ruleId) && (!c.platform || c.platform === d.platform),
    };

    // --- contacts ---------------------------------------------------------------------------------------------------
    const identityOf = (loc: string, ch: MetaChannel, ext: string) => db.get<any>('SELECT * FROM meta_identities WHERE location_id = ? AND channel = ? AND external_id = ?', loc, ch, ext);
    function contactFor(loc: string, ev: Pick<EventRow, 'platform' | 'from_id' | 'from_name' | 'from_username'>, alt?: string): { id: string; created: boolean } {
      const ch = channelOf(ev.platform);
      const known = [ev.from_id, alt].filter(Boolean).map((x) => identityOf(loc, ch, x!)).find((x) => x && getContact(app, loc, x.contact_id));
      if (known) return { id: known.contact_id, created: false };
      const name = ev.from_username ? `@${ev.from_username}` : ev.from_name || `${CHANNEL_LABEL[ch]}-Kontakt`;
      const c = upsertContact(app, loc, { name, ...(ev.from_username ? { custom: { instagram: `@${ev.from_username}` } } : {}) }, { source: 'Kommentar-zu-DM', tags: [ch] }).contact;
      for (const ext of new Set([ev.from_id, alt].filter(Boolean) as string[])) db.run('INSERT OR IGNORE INTO meta_identities (location_id, channel, external_id, contact_id, name, created_at) VALUES (?, ?, ?, ?, ?, ?)', loc, ch, ext, c.id, name.slice(0, 120), now());
      return { id: c.id, created: true };
    }

    /** The private reply shows up in the conversation like any other message. */
    function recordOutbound(loc: string, contactId: string, ch: MetaChannel, body: string, providerId: string | null, source: string) {
      const conversationId = getOrCreateConversation(app, loc, contactId);
      const msg = { id: id(), location_id: loc, conversation_id: conversationId, contact_id: contactId, channel: ch, direction: 'out', subject: '', body, status: 'sent', error: '', source, created_at: now(), provider_id: providerId, external_id: providerId ? externalId(ch, providerId) : null };
      db.insert('messages', msg);
      db.run('UPDATE conversations SET last_message_at = ?, last_message = ? WHERE id = ?', msg.created_at, body.replace(/\s+/g, ' ').slice(0, 140), conversationId);
    }

    // --- one matched comment ---------------------------------------------------------------------------------------------
    const overLimit = (rule: Rule, exceptEvent: string) => {
      const since = new Date(Date.now() - HOUR).toISOString();
      const perRule = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM igc_events WHERE rule_id = ? AND created_at > ? AND id != ? AND status IN ('processing', 'done', 'failed')`, rule.id, since, exceptEvent)!.n;
      if (perRule >= rule.max_per_hour) return `Grenze der Regel erreicht (${rule.max_per_hour} pro Stunde)`;
      const perAccount = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM igc_events WHERE location_id = ? AND created_at > ? AND dm_status = 'sent'`, rule.location_id, since)!.n;
      if (perAccount >= ACCOUNT_DMS_PER_HOUR) return `Grenze des Kontos erreicht (${ACCOUNT_DMS_PER_HOUR} private Antworten pro Stunde)`;
      return '';
    };

    async function startFlow(rule: Rule, contactId: string, data: Record<string, unknown>) {
      if (!rule.workflow_id) return;
      const wf = db.get<any>('SELECT * FROM workflows WHERE id = ? AND location_id = ?', rule.workflow_id, rule.location_id);
      if (!wf || wf.status !== 'active') return;
      wf.steps = json(wf.steps, []);
      wf.trigger = json(wf.trigger, {});
      wf.settings = json(wf.settings, {});
      const rid = startWorkflow(app, wf, contactId, { ...data, igcomment: data });
      if (rid) await processRun(app, rid);
    }

    /** Public reply (rotating text), private reply with link and buttons, contact, tags, workflow – each step on its own, so one failing never blocks the rest. */
    async function handle(eventId: string): Promise<void> {
      if (!db.run(`UPDATE igc_events SET status = 'processing', attempts = attempts + 1 WHERE id = ? AND status = 'queued'`, eventId).changes) return;
      const ev = db.get<EventRow>('SELECT * FROM igc_events WHERE id = ?', eventId)!;
      const loc = ev.location_id;
      const rule = ev.rule_id ? ruleOf(loc, ev.rule_id) : undefined;
      const finish = (patch: Partial<EventRow>): void => void db.update('igc_events', ev.id, { ...patch, done_at: now() });
      if (!rule) return finish({ status: 'skipped', error: 'Regel nicht mehr vorhanden' });
      const limited = overLimit(rule, ev.id);
      if (limited) {
        db.run('UPDATE igc_events SET status = ? WHERE id = ?', 'rate_limited', ev.id);
        return finish({ status: 'rate_limited', error: limited });
      }
      const ch = channelOf(ev.platform);
      const errors: string[] = [];
      let dm = '';
      let recipient = '';
      let providerId: string | null = null;
      const content = dmContent(rule);
      const repeat = rule.once_per_person && db.get(`SELECT 1 FROM igc_events WHERE location_id = ? AND rule_id = ? AND from_id = ? AND dm_status = 'sent' AND id != ?`, loc, rule.id, ev.from_id, ev.id);
      if (repeat) dm = 'skipped';
      else {
        try {
          const r = await kit()!.graph(loc, ch, 'POST', 'me/messages', { recipient: { comment_id: ev.comment_id }, message: messengerMessage(content.text, content.buttons) });
          dm = 'sent';
          recipient = String(r?.recipient_id ?? '');
          providerId = r?.message_id ? String(r.message_id) : null;
        } catch (e) {
          dm = 'failed';
          errors.push(`DM: ${(e as Error).message}`);
        }
      }
      let publicStatus = '';
      if (rule.public_replies.length) {
        const text = replyAt(rule.public_replies, rule.reply_index);
        db.run('UPDATE igc_rules SET reply_index = reply_index + 1 WHERE id = ?', rule.id);
        try {
          await kit()!.graph(loc, ch, 'POST', ev.platform === 'instagram' ? `${ev.comment_id}/replies` : `${ev.comment_id}/comments`, { message: text });
          publicStatus = 'sent';
        } catch (e) {
          publicStatus = 'failed';
          errors.push(`Antwort: ${(e as Error).message}`);
        }
      }
      // the person becomes a contact whatever happened to the messages
      const c = contactFor(loc, ev, recipient);
      if (rule.tags.length) addTags(app, loc, c.id, rule.tags);
      if (dm === 'sent') recordOutbound(loc, c.id, ch, describeButtons(content.text, content.buttons), providerId, 'Kommentar-zu-DM');
      logActivity(app, loc, c.id, 'igcomment.matched', `${CHANNEL_LABEL[ch]}-Kommentar „${ev.text.slice(0, 80)}“ traf ${rule.name}${dm === 'sent' ? ' – Direktnachricht gesendet' : dm === 'failed' ? ' – Direktnachricht fehlgeschlagen' : ''}`);
      const data = { contactId: c.id, ruleId: rule.id, rule: { id: rule.id, name: rule.name }, kind: ev.kind, platform: ev.platform, commentId: ev.comment_id, mediaId: ev.media_id, text: ev.text, keyword: ev.keyword, dm_sent: dm === 'sent', public_reply_sent: publicStatus === 'sent' };
      finish({ status: dm === 'failed' && publicStatus !== 'sent' ? 'failed' : 'done', dm_status: dm, public_status: publicStatus, contact_id: c.id, error: errors.join(' · ').slice(0, 500) });
      app.events.emit(loc, 'igcomment.matched', data);
      await startFlow(rule, c.id, data).catch((e) => console.error('[igcomments] Workflow', (e as Error).message));
    }

    // --- the webhook ---------------------------------------------------------------------------------------------------
    function pickRule(loc: string, ev: { platform: 'instagram' | 'facebook'; mediaId: string; text: string }): { rule: Rule; keyword: string } | undefined {
      const list = rulesOf(loc).filter((r) => r.enabled && r.kind === 'comment' && appliesTo(r, ev));
      // a rule for one post beats a rule for all posts, then priority and age
      list.sort((a, b) => Number(b.scope === 'post') - Number(a.scope === 'post') || b.priority - a.priority);
      for (const rule of list) {
        const keyword = matchKeyword(rule, ev.text);
        if (keyword) return { rule, keyword };
      }
      return undefined;
    }

    function intake(hookLoc: string, secret: string, c: CommentEvent): string | undefined {
      const k = kit();
      if (!k) return undefined;
      const loc = k.accountFor(hookLoc, secret, channelOf(c.platform), c.accountId);
      if (!loc) return undefined;
      // our own answers come back as comments of the account itself
      if (c.fromId === c.accountId) return undefined;
      const hit = pickRule(loc, { platform: c.platform, mediaId: c.mediaId, text: c.text });
      if (!hit) return undefined;
      const eid = id();
      const fresh = db.run(
        `INSERT OR IGNORE INTO igc_events (id, location_id, rule_id, platform, kind, comment_id, media_id, from_id, from_name, from_username, text, keyword, status, created_at) VALUES (?, ?, ?, ?, 'comment', ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
        eid, loc, hit.rule.id, c.platform, c.commentId, c.mediaId, c.fromId, c.fromName, c.fromUsername, c.text, hit.keyword, now(),
      ).changes;
      return fresh ? eid : undefined;
    }

    app.services.metaWebhookHooks = [
      ...(app.services.metaWebhookHooks ?? []),
      async ({ payload, secret, locationId }: { payload: any; secret: string; locationId: string }) => {
        const jobs: Promise<void>[] = [];
        for (const c of parseComments(payload)) {
          const eid = intake(locationId, secret, c);
          if (eid) jobs.push(handle(eid).catch((e) => void db.run(`UPDATE igc_events SET status = 'failed', error = ? WHERE id = ?`, String((e as Error).message).slice(0, 300), eid)));
        }
        // Story replies: the message itself arrives through the normal channel code; remember which of them answer a story.
        for (const s of parseStoryReplies(payload)) {
          const loc = kit()?.accountFor(locationId, secret, 'instagram', s.accountId);
          if (loc && s.fromId !== s.accountId && !db.get('SELECT 1 FROM messages WHERE location_id = ? AND external_id = ?', loc, externalId('instagram', s.mid))) db.run('INSERT OR IGNORE INTO igc_story_pending (location_id, external_id, story_id, text, from_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', loc, externalId('instagram', s.mid), s.storyId, s.text, s.fromId, now());
        }
        // Meta wants an answer within seconds: what takes longer carries on in the background (and a sweeper picks up what got stuck).
        if (jobs.length) await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, 8000))]);
      },
    ];

    // A story reply has been stored as a message: if a rule wants its text, the contact gets the direct message (the 24-hour window is open now).
    app.events.on('message.inbound', async (e) => {
      const m = e.data.message;
      if (m?.channel !== 'instagram' || !m.external_id || !e.data.contactId) return;
      const pending = db.get<any>('SELECT * FROM igc_story_pending WHERE location_id = ? AND external_id = ?', e.locationId, m.external_id);
      if (!pending) return;
      db.run('DELETE FROM igc_story_pending WHERE location_id = ? AND external_id = ?', e.locationId, m.external_id);
      const rules = rulesOf(e.locationId).filter((r) => r.enabled && r.kind === 'story_reply');
      const rule = rules.map((r) => ({ r, k: matchKeyword(r, pending.text) })).find((x) => x.k);
      if (!rule) return;
      const commentId = `story:${String(m.external_id).slice(3)}`;
      const contact = getContact(app, e.locationId, e.data.contactId);
      const eid = id();
      const fresh = db.run(
        `INSERT OR IGNORE INTO igc_events (id, location_id, rule_id, platform, kind, comment_id, media_id, from_id, from_name, from_username, text, keyword, status, contact_id, created_at) VALUES (?, ?, ?, 'instagram', 'story_reply', ?, ?, ?, ?, '', ?, ?, 'processing', ?, ?)`,
        eid, e.locationId, rule.r.id, commentId, pending.story_id, pending.from_id, contact?.first_name ?? '', pending.text, rule.k, contact?.id ?? null, now(),
      ).changes;
      if (!fresh) return;
      const limited = overLimit(rule.r, eid);
      const finish = (patch: Record<string, unknown>): void => void db.update('igc_events', eid, { ...patch, done_at: now() });
      if (limited) return finish({ status: 'rate_limited', error: limited });
      if (rule.r.once_per_person && db.get(`SELECT 1 FROM igc_events WHERE location_id = ? AND rule_id = ? AND from_id = ? AND dm_status = 'sent' AND id != ?`, e.locationId, rule.r.id, pending.from_id, eid)) return finish({ status: 'done', dm_status: 'skipped' });
      const content = dmContent(rule.r);
      let dm = 'sent';
      let error = '';
      try {
        const r = await app.services.metaSend(e.locationId, { contactId: e.data.contactId, channel: 'instagram', body: describeButtons(content.text, content.buttons), source: 'Story-Antwort', payload: (to: string) => ({ recipient: { id: to }, messaging_type: 'RESPONSE', message: messengerMessage(content.text, content.buttons) }) });
        if (r.status === 'failed') throw new Error(r.error);
      } catch (err) {
        dm = 'failed';
        error = (err as Error).message.slice(0, 300);
      }
      if (rule.r.tags.length) addTags(app, e.locationId, e.data.contactId, rule.r.tags);
      finish({ status: dm === 'sent' ? 'done' : 'failed', dm_status: dm, error });
      const data = { contactId: e.data.contactId, ruleId: rule.r.id, rule: { id: rule.r.id, name: rule.r.name }, kind: 'story_reply', platform: 'instagram', commentId, mediaId: pending.story_id, text: pending.text, keyword: rule.k, dm_sent: dm === 'sent', public_reply_sent: false };
      app.events.emit(e.locationId, 'igcomment.matched', data);
      await startFlow(rule.r, e.data.contactId, data).catch((err) => console.error('[igcomments] Workflow', (err as Error).message));
    });

    // Comments whose handling was cut off (restart, slow Meta) are tried again a few times; old story hints are dropped.
    app.onTick(async () => {
      for (const r of db.all<{ id: string; attempts: number }>(`SELECT id, attempts FROM igc_events WHERE status = 'queued' AND created_at < ? AND created_at > ? LIMIT 20`, new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 6 * 24 * HOUR).toISOString())) {
        if (r.attempts >= 3) db.run(`UPDATE igc_events SET status = 'failed', error = 'Nach drei Versuchen aufgegeben' WHERE id = ?`, r.id);
        else await handle(r.id).catch(() => undefined);
      }
      db.run(`UPDATE igc_events SET status = 'failed', error = 'Abgebrochen (Neustart?)' WHERE status = 'processing' AND created_at < ?`, new Date(Date.now() - 10 * 60_000).toISOString());
      db.run('DELETE FROM igc_story_pending WHERE created_at < ?', new Date(Date.now() - 864e5).toISOString());
      db.run('DELETE FROM igc_events WHERE created_at < ?', new Date(Date.now() - 90 * 864e5).toISOString());
    });

    // --- admin API -----------------------------------------------------------------------------------------------------------
    const ruleOut = (r: Rule) => {
      const s = db.get<any>(`SELECT COUNT(*) AS total, SUM(dm_status = 'sent') AS dms, SUM(public_status = 'sent') AS replies, SUM(status = 'failed') AS failed, MAX(created_at) AS last_at FROM igc_events WHERE rule_id = ?`, r.id)!;
      return { ...r, once_per_person: !!r.once_per_person, stats: { matches: Number(s.total) || 0, dms: Number(s.dms) || 0, replies: Number(s.replies) || 0, failed: Number(s.failed) || 0, last_at: s.last_at ?? null } };
    };
    const checkRefs = (loc: string, f: RuleInput) => {
      if (f.workflow_id && !db.get('SELECT 1 FROM workflows WHERE id = ? AND location_id = ?', f.workflow_id, loc)) throw bad('Workflow nicht gefunden');
    };
    const onceFrom = (b: any, cur?: Rule) => (b?.once_per_person === undefined ? (cur ? cur.once_per_person : 1) : b.once_per_person ? 1 : 0);

    router.get('/api/ig-comments/status', 'location', (ctx) => {
      const ids = kit()?.ids(ctx.locationId);
      const since = new Date(Date.now() - 7 * 24 * HOUR).toISOString();
      const c = db.get<any>(`SELECT COUNT(*) AS total, SUM(dm_status = 'sent') AS dms, SUM(status = 'failed') AS failed, SUM(status = 'rate_limited') AS limited FROM igc_events WHERE location_id = ? AND created_at > ?`, ctx.locationId, since)!;
      return {
        instagram: { configured: !!ids?.instagram, account_id: ids?.ig_account_id ?? '', username: ids?.ig_username ?? '' },
        facebook: { configured: !!ids?.messenger, page_id: ids?.page_id ?? '', page_name: ids?.page_name ?? '' },
        webhook_url: `${app.baseUrl()}/hooks/meta/${ctx.locationId}`,
        permissions: { instagram: ['instagram_basic', 'instagram_manage_comments', 'instagram_manage_messages', 'pages_show_list', 'pages_manage_metadata', 'pages_read_engagement'], facebook: ['pages_manage_engagement', 'pages_read_engagement', 'pages_messaging', 'pages_manage_metadata', 'pages_show_list'] },
        webhook_fields: { instagram: ['comments', 'messages'], page: ['feed', 'messages', 'messaging_postbacks'] },
        policy: POLICY_NOTES,
        last_7_days: { matches: Number(c.total) || 0, dms: Number(c.dms) || 0, failed: Number(c.failed) || 0, rate_limited: Number(c.limited) || 0 },
        limits: { account_dms_per_hour: ACCOUNT_DMS_PER_HOUR },
      };
    });
    router.get('/api/ig-comments/rules', 'location', (ctx) => rulesOf(ctx.locationId).map(ruleOut));
    router.post('/api/ig-comments/rules', 'location', (ctx) => {
      const f = cleanRule(ctx.body);
      checkRefs(ctx.locationId, f);
      if (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM igc_rules WHERE location_id = ?', ctx.locationId)!.n >= 100) throw bad('Höchstens 100 Regeln je Sub-Account');
      const row = { id: id(), location_id: ctx.locationId, ...f, once_per_person: onceFrom(ctx.body), reply_index: 0, enabled: f.enabled ? 1 : 0, created_at: now(), updated_at: now() };
      db.insert('igc_rules', row);
      return ruleOut(ruleOf(ctx.locationId, row.id)!);
    });
    router.post('/api/ig-comments/test', 'location', (ctx) => {
      const platform = ctx.body?.platform === 'facebook' ? 'facebook' : 'instagram';
      const hit = pickRule(ctx.locationId, { platform, mediaId: clip(ctx.body?.media_id, 80), text: String(ctx.body?.text ?? '') });
      if (!hit) return { match: false };
      const content = dmContent(hit.rule);
      return { match: true, rule: { id: hit.rule.id, name: hit.rule.name }, keyword: hit.keyword, public_reply: replyAt(hit.rule.public_replies, hit.rule.reply_index), dm: { text: content.text, buttons: content.buttons }, tags: hit.rule.tags, workflow_id: hit.rule.workflow_id };
    });
    router.get('/api/ig-comments/events', 'location', (ctx) => {
      const where = ['e.location_id = ?'];
      const args: any[] = [ctx.locationId];
      for (const [k, col] of [['rule_id', 'e.rule_id'], ['status', 'e.status']] as const) {
        const v = ctx.query.get(k);
        if (v) (where.push(`${col} = ?`), args.push(v));
      }
      return db.all<any>(`SELECT e.*, r.name AS rule_name FROM igc_events e LEFT JOIN igc_rules r ON r.id = e.rule_id WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC LIMIT ?`, ...args, clampLimit(ctx.query.get('limit'), 50, 300));
    });
    /** The account's recent posts, reels and Facebook posts – to pick one for a rule. */
    router.get('/api/ig-comments/media', 'location', async (ctx) => {
      const platform = ctx.query.get('platform') === 'facebook' ? 'facebook' : 'instagram';
      const ids = kit()?.ids(ctx.locationId);
      if (!kit() || !ids) throw bad('Meta ist nicht eingerichtet (Einstellungen → Kanäle)');
      if (platform === 'instagram') {
        if (!ids.instagram) throw bad('Instagram ist nicht eingerichtet (Einstellungen → Kanäle)');
        const r = await kit()!.graph(ctx.locationId, 'instagram', 'GET', `${ids.ig_account_id}/media?fields=id,caption,media_type,permalink,timestamp&limit=25`);
        return (r?.data ?? []).map((m: any) => ({ id: String(m.id), label: String(m.caption ?? m.media_type ?? 'Beitrag').replace(/\s+/g, ' ').slice(0, 90), type: String(m.media_type ?? ''), url: String(m.permalink ?? ''), at: m.timestamp ?? null }));
      }
      if (!ids.messenger) throw bad('Facebook ist nicht eingerichtet (Einstellungen → Kanäle)');
      const r = await kit()!.graph(ctx.locationId, 'messenger', 'GET', `${ids.page_id}/posts?fields=id,message,permalink_url,created_time&limit=25`);
      return (r?.data ?? []).map((m: any) => ({ id: String(m.id), label: String(m.message ?? 'Beitrag').replace(/\s+/g, ' ').slice(0, 90), type: 'post', url: String(m.permalink_url ?? ''), at: m.created_time ?? null }));
    });
    /** Subscribes the Facebook page to `feed` (keeping the message fields) and the Instagram account to `comments`. */
    router.post('/api/ig-comments/subscribe', 'location', async (ctx) => {
      const ids = kit()?.ids(ctx.locationId);
      if (!kit() || !ids) throw bad('Meta ist nicht eingerichtet (Einstellungen → Kanäle)');
      const res: Record<string, { ok: boolean; info?: string; error?: string }> = {};
      if (ids.messenger) {
        try {
          await kit()!.graph(ctx.locationId, 'messenger', 'POST', `${ids.page_id}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_deliveries,message_reads,message_reactions,feed`);
          res.facebook = { ok: true, info: 'Seite abonniert: Kommentare (feed) und Nachrichten' };
        } catch (e) {
          res.facebook = { ok: false, error: (e as Error).message };
        }
      }
      if (ids.instagram) {
        try {
          await kit()!.graph(ctx.locationId, 'instagram', 'POST', `${ids.ig_account_id}/subscribed_apps?subscribed_fields=comments,messages`);
          res.instagram = { ok: true, info: 'Instagram-Konto abonniert: Kommentare (comments) und Nachrichten' };
        } catch (e) {
          res.instagram = { ok: false, error: `${(e as Error).message} – das Feld „comments“ lässt sich auch in der Meta-App unter Webhooks → Instagram abonnieren` };
        }
      }
      if (!Object.keys(res).length) throw bad('Weder Facebook-Seite noch Instagram-Konto sind eingerichtet (Einstellungen → Kanäle)');
      auditLog(app, ctx, ctx.locationId, 'igcomments.subscribe', `Webhook-Abo für Kommentare gesetzt (${Object.entries(res).map(([k, v]) => `${k}: ${v.ok ? 'ok' : 'Fehler'}`).join(', ')})`);
      return { results: res };
    });
    const mustRule = (ctx: Ctx) => {
      const r = ruleOf(ctx.locationId, ctx.params.id);
      if (!r) throw notFound('Regel nicht gefunden');
      return r;
    };
    router.patch('/api/ig-comments/rules/:id', 'location', (ctx) => {
      const cur = mustRule(ctx);
      const f = cleanRule(ctx.body, cur);
      checkRefs(ctx.locationId, f);
      db.update('igc_rules', cur.id, { ...f, once_per_person: onceFrom(ctx.body, cur), enabled: f.enabled ? 1 : 0, updated_at: now() }, ctx.locationId);
      return ruleOut(ruleOf(ctx.locationId, cur.id)!);
    });
    router.delete('/api/ig-comments/rules/:id', 'location', (ctx) => {
      const r = mustRule(ctx);
      db.run('DELETE FROM igc_rules WHERE id = ?', r.id);
      return { ok: true };
    });

    // --- messages with buttons and quick replies (Instagram, Messenger, WhatsApp) --------------------------------------------------------
    registerActions(app, [
      {
        meta: {
          type: 'meta_buttons_send',
          label: 'Nachricht mit Buttons senden (Instagram/Messenger/WhatsApp)',
          category: 'messaging',
          icon: 'chat',
          summary: 'Sendet eine Nachricht mit Antwort-Buttons, Link-Button oder Quick-Replies.',
          doc: 'Nur innerhalb von 24 Stunden nach der letzten Nachricht des Kontakts. Instagram/Messenger: bis zu 3 Buttons (Link oder Antwort) – nur Antworten gehen auch als Quick-Replies (bis 13). WhatsApp: bis zu 3 Antwort-Buttons oder ein Link-Button. Tippt jemand einen Button an, kommt sein Titel als Nachricht zurück („Nachricht empfangen“ mit Filter auf den Text).',
          needs: 'Einstellungen → Kanäle (Meta)',
          fields: [
            { key: 'channel', label: 'Kanal', type: 'select', options: [['instagram', 'Instagram'], ['messenger', 'Messenger'], ['whatsapp', 'WhatsApp']], default: 'instagram' },
            { key: 'text', label: 'Text', type: 'textarea', required: true, default: 'Wie möchtest du weitermachen?' },
            { key: 'buttons', label: 'Buttons', type: 'rows', addLabel: '+ Button', rows: [{ key: 'type', label: 'Art', type: 'select', options: [['reply', 'Antwort'], ['url', 'Link']] }, { key: 'title', label: 'Beschriftung (max. 20)', type: 'text' }, { key: 'value', label: 'Link oder Antworttext', type: 'text' }] },
            { key: 'style', label: 'Instagram/Messenger: Darstellung', type: 'select', options: [['auto', 'Automatisch'], ['buttons', 'Buttons'], ['quick', 'Quick-Replies']], default: 'auto' },
          ],
          sample: { channel: 'instagram', text: 'Welchen Guide möchtest du?', buttons: [{ type: 'reply', title: 'Anfänger', value: 'anfaenger' }, { type: 'reply', title: 'Profi', value: 'profi' }] },
        },
        run: async (run, step, vars) => {
          const channel: MetaChannel = ['instagram', 'messenger', 'whatsapp'].includes(step.channel) ? step.channel : 'instagram';
          const text = fill(requireText(step.text, 'Text'), vars);
          const rows = (Array.isArray(step.buttons) ? step.buttons : []).map((b: any) => ({ type: b?.type, title: fill(b?.title ?? '', vars), value: fill(b?.value ?? '', vars) }));
          let buttons;
          try {
            buttons = cleanButtons(rows);
          } catch (e) {
            throw new Error((e as Error).message);
          }
          if (!buttons.length) throw new Error('Mindestens ein Button');
          const style = ['buttons', 'quick'].includes(step.style) ? step.style : 'auto';
          // validate the shape for the channel before anything is stored
          if (channel === 'whatsapp') whatsappInteractive('0', text, buttons);
          const r = await app.services.metaSend(run.location_id, {
            contactId: run.contact_id,
            channel,
            body: describeButtons(text, buttons),
            source: 'Workflow',
            payload: (to: string) => (channel === 'whatsapp' ? whatsappInteractive(to, text, buttons) : { recipient: { id: to }, messaging_type: 'RESPONSE', message: messengerMessage(text, buttons, style) }),
          });
          if (r.status === 'failed') throw new Error(r.error);
          return `Nachricht mit ${buttons.length} Button${buttons.length === 1 ? '' : 's'} gesendet (${CHANNEL_LABEL[channel]})`;
        },
      },
    ]);

    app.services.igComments = { handle, pickRule };
  },
};
