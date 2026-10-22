import type { Module } from '../core/app.js';
import { HttpError } from '../core/http.js';
import { getContact } from '../services/contacts.js';
import { cleanGroupAccess, getGroup } from '../services/community.js';
import { award, createPost, type Author } from '../services/community-actions.js';
import { TEAM, sendDm } from '../services/community-dm.js';
import { awardBadge, badgesOf } from '../services/community-gamify.js';
import { sendWelcome } from '../services/community-join.js';
import { activateMembership, endMembership, grants, membershipOf, openMembership, tiersOf } from '../services/community-tiers.js';
import { communityUi } from '../services/community-ui.js';
import { registerActions, registerTriggers, text, type ActionDef, type FieldDef, type TriggerMeta } from '../services/wfx-kit.js';
import type { Tool } from './mcp.js';

/**
 * Community in the automations and for AI agents: nine triggers (left, trial started/converted, join requested, challenge joined
 * and completed, badge earned, message received, call attended), four steps (grant a badge, send a message as the team, give points,
 * post as the team) and the memberships behind the older steps „In Community aufnehmen“ / „Aus Community entfernen“ and the MCP tools ghl_community_members / _post / _stats / _grant. The events
 * come from the community services; the data of each is listed in docs/community.md.
 */

const GROUP: FieldDef = { key: 'group_id', label: 'Community-Gruppe', type: 'group', help: 'Leer = jede Gruppe' };
const GROUP_REQUIRED: FieldDef = { ...GROUP, required: true, help: undefined };
const grp = { groupId: 'g1', group: { id: 'g1', name: 'Mein Club' } };

export const COMMUNITY_TRIGGERS: TriggerMeta[] = [
  { type: 'community.member_left', label: 'Mitglied hat die Community verlassen', category: 'content', summary: 'Eine Mitgliedschaft endet: Kündigung, fehlgeschlagene Zahlung, Entfernung oder Erstattung.', doc: 'Startet, sobald der Zugang weg ist. {{event.reason}} sagt warum (z. B. canceled, payment_failed, removed, refunded). Gut für Abschiedsmail, Umfrage oder „Zurückholen“-Angebot.', fields: [GROUP], sample: { ...grp, tier: { id: 't1', name: 'Pro' }, reason: 'payment_failed' }, keywords: 'kündigung abgemeldet churn austritt' },
  { type: 'community.trial_started', label: 'Testphase in der Community gestartet', category: 'content', summary: 'Jemand startet die kostenlose Testphase einer Stufe.', doc: 'Startet beim Beginn der Testphase. {{event.trial_ends_at}} ist das Ende – damit lässt sich eine Erinnerung kurz davor bauen.', fields: [GROUP, { key: 'tier_id', label: 'Stufe (ID)', type: 'text', placeholder: 'leer = jede' }], sample: { ...grp, tier: { id: 't1', name: 'Pro' }, trial_ends_at: '2026-11-11T12:00:00.000Z' }, keywords: 'probe trial test kostenlos' },
  { type: 'community.trial_converted', label: 'Testphase wurde zum Abo', category: 'content', summary: 'Die erste Zahlung nach der Testphase ist durch.', doc: 'Startet einmal je Person, sobald nach dem Test zum ersten Mal bezahlt wurde.', fields: [GROUP, { key: 'tier_id', label: 'Stufe (ID)', type: 'text', placeholder: 'leer = jede' }], sample: { ...grp, tier: { id: 't1', name: 'Pro' } }, keywords: 'conversion bezahlt abo' },
  { type: 'community.join_requested', label: 'Beitrittsanfrage gestellt', category: 'content', summary: 'Jemand fragt an, einer Community mit Freigabe beizutreten.', doc: 'Startet, wenn die Anfrage in der Warteschlange landet. {{event.answers}} enthält die Antworten auf deine Beitrittsfragen.', fields: [GROUP], sample: { ...grp, tier: { id: 't1', name: 'Mitglied' }, answers: { 'Was ist dein Ziel?': 'Mehr Kunden' } }, keywords: 'anfrage freigabe warteschlange' },
  { type: 'community.challenge_joined', label: 'Challenge gestartet', category: 'content', summary: 'Ein Mitglied macht bei einer Challenge mit.', doc: 'Startet beim ersten Mitmachen oder Einchecken.', fields: [GROUP, { key: 'challenge_id', label: 'Challenge (ID)', type: 'text', placeholder: 'leer = jede' }], sample: { ...grp, challenge: { id: 'c1', title: '30 Tage Schreiben' } }, keywords: 'challenge mitmachen' },
  { type: 'community.challenge_completed', label: 'Challenge geschafft', category: 'content', summary: 'Ein Mitglied erreicht das Ziel einer Challenge.', doc: 'Startet beim letzten nötigen Check-in. {{event.checkins}} ist die Zahl der Check-ins.', fields: [GROUP, { key: 'challenge_id', label: 'Challenge (ID)', type: 'text', placeholder: 'leer = jede' }], sample: { ...grp, challenge: { id: 'c1', title: '30 Tage Schreiben' }, checkins: 30 }, keywords: 'challenge ziel abgeschlossen' },
  { type: 'community.badge_earned', label: 'Abzeichen erhalten', category: 'content', summary: 'Ein Mitglied bekommt ein Abzeichen – von Hand oder nach Regel.', doc: '{{event.badge.name}} ist der Name, {{event.by}} wer es vergeben hat (leer = automatisch).', fields: [GROUP, { key: 'badge_id', label: 'Abzeichen (ID)', type: 'text', placeholder: 'leer = jedes' }], sample: { ...grp, badge: { id: 'b1', name: 'Gründungsmitglied', emoji: '🌟' }, by: '' }, keywords: 'badge auszeichnung' },
  { type: 'community.dm_received', label: 'Community-Nachricht erhalten', category: 'content', summary: 'Ein Mitglied bekommt eine Nachricht – oder schreibt dem Team.', doc: 'Mit „Richtung“ trennst du: „an das Team“ startet, wenn ein Mitglied dem Team schreibt (dann ist der Kontakt der Absender), „an ein Mitglied“, wenn jemand ihm schreibt. {{event.message.text}} ist der Anfang der Nachricht.', fields: [{ key: 'direction', label: 'Richtung', type: 'select', options: [['', 'beide'], ['to_team', 'an das Team'], ['to_member', 'an ein Mitglied']] }], sample: { from: { id: 'k1', name: 'Anna', team: false }, toTeam: true, message: { id: 'm1', text: 'Ich habe eine Frage zum Abo.' }, threadId: 't1' }, keywords: 'dm direktnachricht privat' },
  { type: 'community.event_attended', label: 'Live-Call besucht', category: 'content', summary: 'Ein Mitglied betritt den Raum eines Live-Calls.', doc: 'Startet einmal je Person und Call. {{event.event.title}} ist der Titel des Termins.', fields: [GROUP, { key: 'event_id', label: 'Termin (ID)', type: 'text', placeholder: 'leer = jeder' }], sample: { ...grp, event: { id: 'e1', title: 'Fragerunde' } }, keywords: 'live call teilnahme anwesend' },
];

type Filter = (c: Record<string, any>, d: Record<string, any>) => boolean;
const inGroup: Filter = (c, d) => !c.group_id || c.group_id === d.groupId;
const FILTERS: Record<string, Filter> = {
  'community.member_left': inGroup,
  'community.trial_started': (c, d) => inGroup(c, d) && (!c.tier_id || c.tier_id === d.tier?.id),
  'community.trial_converted': (c, d) => inGroup(c, d) && (!c.tier_id || c.tier_id === d.tier?.id),
  'community.join_requested': inGroup,
  'community.challenge_joined': (c, d) => inGroup(c, d) && (!c.challenge_id || c.challenge_id === d.challenge?.id),
  'community.challenge_completed': (c, d) => inGroup(c, d) && (!c.challenge_id || c.challenge_id === d.challenge?.id),
  'community.badge_earned': (c, d) => inGroup(c, d) && (!c.badge_id || c.badge_id === d.badge?.id),
  'community.dm_received': (c, d) => !c.direction || (c.direction === 'to_team' ? !!d.toTeam : !d.toTeam),
  'community.event_attended': (c, d) => inGroup(c, d) && (!c.event_id || c.event_id === d.event?.id),
};

const one = (v: unknown) => String(v ?? '').trim();

export const communityAutomationModule: Module = {
  name: 'community-automation',
  register(app) {
    const { db } = app;
    registerTriggers(app, COMMUNITY_TRIGGERS);
    app.services.workflowTriggerFilters = { ...(app.services.workflowTriggerFilters ?? {}), ...FILTERS };

    const groupOf = (locationId: string, v: unknown, required = true) => {
      const id = one(v);
      if (!id) {
        if (required) throw new Error('Bitte eine Community-Gruppe wählen');
        return undefined;
      }
      const g = getGroup(app, locationId, id);
      if (!g) throw new Error('Diese Community-Gruppe gibt es in diesem Sub-Account nicht');
      return g as unknown as { id: string; location_id: string; name: string; slug: string; access: any; [k: string]: any };
    };
    const contactOf = (run: { location_id: string; contact_id: string }) => {
      const c = run.contact_id ? getContact(app, run.location_id, run.contact_id) : undefined;
      if (!c) throw new Error('Dieser Schritt braucht einen Kontakt');
      return c;
    };
    const fail = <T>(fn: () => T): T => {
      try {
        return fn();
      } catch (e) {
        if (e instanceof HttpError) throw new Error(e.message);
        throw e;
      }
    };
    const tierByName = (g: { id: string }, v: string) => {
      const w = v.toLowerCase();
      return tiersOf(app, g.id).find((t) => t.id === v || t.name.toLowerCase() === w);
    };

    /** Puts a contact into a community that lets people in by joining: a free membership in the tier, with the welcome automation. */
    const addTo = (g: ReturnType<typeof groupOf> & object, contact: { id: string; email: string }, tierName: string, by: string) => {
      if (cleanGroupAccess(g.access).mode !== 'join') throw new Error('Diese Gruppe lässt Mitglieder nicht über die Community-Seite herein');
      const tier = tierName ? tierByName(g, tierName) : (tiersOf(app, g.id, true)[0] ?? undefined);
      if (tierName && !tier) throw new Error(`Stufe „${tierName}“ gibt es nicht`);
      const cur = membershipOf(app, g.id, contact.id);
      if (cur && grants(app, cur)) return 'War schon Mitglied';
      const full = getContact(app, g.location_id, contact.id)!;
      const m = openMembership(app, g, full, { tier_id: tier?.id ?? null, billing: 'free', source: 'workflow', status: 'pending', consent: 0 });
      activateMembership(app, g, m, { by });
      void sendWelcome(app, g, full);
      return `Mitglied geworden${tier ? ` (Stufe ${tier.name})` : ''}`;
    };

    // The existing steps "In Community aufnehmen" / "Aus Community entfernen" (modules/wfx-crm.ts) hand groups that let people in
    // by joining (memberships with tiers) over to these two functions.
    const removeFrom = (g: NonNullable<ReturnType<typeof groupOf>>, contact: { id: string }) => {
      const m = membershipOf(app, g.id, contact.id);
      if (!m || !grants(app, m)) return `War nicht Mitglied in „${g.name}“`;
      endMembership(app, g, m, 'workflow');
      return `Mitgliedschaft in „${g.name}“ beendet`;
    };
    // The step hands over the raw row of the group; the functions read it again with its settings parsed.
    const parsed = (g: { id: string; location_id: string }) => groupOf(g.location_id, g.id)!;
    app.services.communityMembers = {
      joinMode: (g: { id: string; location_id: string }) => cleanGroupAccess(parsed(g).access).mode === 'join',
      add: (g: { id: string; location_id: string }, contact: { id: string; email: string }, tier: string) => fail(() => addTo(parsed(g), contact, tier, 'Workflow')),
      remove: (g: { id: string; location_id: string }, contact: { id: string }) => fail(() => removeFrom(parsed(g), contact)),
    };

    const badgeBy = (g: { id: string }, v: string) => badgesOf(app, g.id).find((b) => b.id === v || b.name.toLowerCase() === v.toLowerCase());
    const grantBadge: ActionDef = {
      meta: {
        type: 'community_grant_badge',
        label: 'Community-Abzeichen vergeben',
        category: 'content',
        icon: 'trophy',
        summary: 'Gibt dem Mitglied ein Abzeichen (einmal – mit Benachrichtigung und eventuellen Bonuspunkten).',
        doc: 'Das Abzeichen wird über Name oder ID gewählt. Die Person muss Mitglied der Gruppe sein. Hat sie es schon, passiert nichts. Löst den Auslöser „Abzeichen erhalten“ aus.',
        fields: [GROUP_REQUIRED, { key: 'badge', label: 'Abzeichen (Name oder ID)', type: 'text', required: true }, { key: 'reason', label: 'Grund (optional)', type: 'text' }],
        keywords: 'badge abzeichen auszeichnung belohnung',
        needs: 'Ein Abzeichen unter Community → Abzeichen',
        sample: { group_id: '', badge: 'Gründungsmitglied' },
      },
      run: (run, step) => {
        const g = groupOf(run.location_id, step.group_id)!;
        const c = contactOf(run);
        const b = badgeBy(g, one(step.badge));
        if (!b) throw new Error(`Das Abzeichen „${one(step.badge)}“ gibt es in „${g.name}“ nicht`);
        const done = fail(() => awardBadge(app, g, c.id, b, 'Workflow', one(step.reason)));
        return { result: done ? `Abzeichen „${b.name}“ vergeben` : `Hatte „${b.name}“ schon` };
      },
    };
    const sendMessage: ActionDef = {
      meta: {
        type: 'community_send_dm',
        label: 'Community-Nachricht senden (als Team)',
        category: 'content',
        icon: 'chat',
        summary: 'Schreibt dem Mitglied eine private Nachricht in der Community – mit Hinweis und Push.',
        doc: 'Die Nachricht erscheint im Postfach der Community (Absender „Team“ oder der Name, den du angibst). Das Mitglied kann antworten; seine Antworten siehst du in der Community unter Nachrichten und als Auslöser „Community-Nachricht erhalten“. Merkfelder wie {{contact.first_name}} sind erlaubt.',
        fields: [{ key: 'from_name', label: 'Absender', type: 'text', placeholder: 'Team' }, { key: 'text', label: 'Nachricht', type: 'textarea', required: true }],
        keywords: 'community dm direktnachricht privat nachricht team',
        needs: 'Der Kontakt ist Mitglied einer Community-Gruppe',
        sample: { from_name: 'Team', text: 'Hallo {{contact.first_name}}, schön, dass du da bist!' },
      },
      run: (run, step, vars) => {
        const c = contactOf(run);
        const inAny = db.get('SELECT 1 FROM community_members WHERE location_id = ? AND contact_id = ? AND banned_at IS NULL', run.location_id, c.id);
        if (!inAny) throw new Error('Der Kontakt ist in keiner Community – die Nachricht würde ihn nicht erreichen');
        const body = text(step.text, vars);
        if (!body.trim()) throw new Error('Nachricht fehlt');
        fail(() => sendDm(app, run.location_id, TEAM, c.id, body, { fromName: text(step.from_name, vars).trim() || 'Team', skipLimits: true, via: run.workflow_id }));
        return { result: 'Nachricht gesendet' };
      },
    };
    const givePoints: ActionDef = {
      meta: {
        type: 'community_award_points',
        label: 'Community-Punkte vergeben',
        category: 'content',
        icon: 'trophy',
        summary: 'Schreibt dem Mitglied Punkte gut (oder zieht welche ab) – kann ein Level auslösen.',
        doc: 'Punkte zählen für Rangliste und Level der Gruppe. Eine negative Zahl zieht ab. Die Person muss Mitglied der Gruppe sein.',
        fields: [GROUP_REQUIRED, { key: 'points', label: 'Punkte', type: 'number', required: true, default: 10 }, { key: 'reason', label: 'Grund (optional)', type: 'text' }],
        keywords: 'punkte bonus level belohnung community',
        sample: { group_id: '', points: 10, reason: 'Kurs abgeschlossen' },
      },
      run: (run, step) => {
        const g = groupOf(run.location_id, step.group_id)!;
        const c = contactOf(run);
        const pts = Math.round(Number(step.points));
        if (!Number.isFinite(pts) || pts === 0 || Math.abs(pts) > 10_000) throw new Error('Punkte: eine Zahl zwischen -10000 und 10000 (nicht 0)');
        if (!db.get('SELECT 1 FROM community_members WHERE group_id = ? AND contact_id = ?', g.id, c.id)) throw new Error(`${c.email || 'Der Kontakt'} ist kein Mitglied von „${g.name}“`);
        award(app, g, c.id, pts, 'manual', one(step.reason).slice(0, 120), 'workflow');
        return { result: `${pts > 0 ? '+' : ''}${pts} Punkte in „${g.name}“` };
      },
    };
    const postAsTeam: ActionDef = {
      meta: {
        type: 'community_post',
        label: 'Community-Beitrag schreiben (als Team)',
        category: 'content',
        icon: 'chat',
        summary: 'Veröffentlicht einen Beitrag im Namen des Teams – auf Wunsch mit Benachrichtigung an alle.',
        doc: 'Der Beitrag erscheint in dem gewählten Kanal (leer = erster freier Kanal). Merkfelder wie {{contact.first_name}} sind erlaubt – z. B. „Willkommen, {{contact.first_name}}!“ bei einem neuen Mitglied.',
        fields: [GROUP_REQUIRED, { key: 'channel', label: 'Kanal (Name)', type: 'text', placeholder: 'leer = erster freier Kanal' }, { key: 'title', label: 'Titel', type: 'text', required: true }, { key: 'body', label: 'Text (Markdown)', type: 'textarea', required: true }, { key: 'pinned', label: 'Anheften', type: 'bool' }, { key: 'notify', label: 'Alle benachrichtigen', type: 'bool' }],
        keywords: 'community beitrag post veröffentlichen ankündigung',
        sample: { group_id: '', title: 'Neu im Club', body: 'Sagt Hallo!', notify: false },
      },
      run: (run, step, vars) => {
        const g = groupOf(run.location_id, step.group_id)!;
        const wanted = one(step.channel).toLowerCase();
        const channels = db.all<any>('SELECT * FROM community_channels WHERE group_id = ? ORDER BY position, created_at', g.id);
        const ch = wanted ? channels.find((c) => c.id === one(step.channel) || c.name.toLowerCase() === wanted || c.slug === wanted) : channels.find((c) => !c.admin_only) ?? channels[0];
        if (!ch) throw new Error(wanted ? `Kanal „${one(step.channel)}“ gibt es nicht` : 'Die Gruppe hat keinen Kanal');
        const author: Author = { kind: 'team', userId: 'workflow', name: 'Team' };
        const ui = communityUi(app);
        const post = fail(() => createPost(app, g, ch, author, { title: text(step.title, vars), body: text(step.body, vars) }, { pinned: step.pinned === true || step.pinned === 'true', notifyAll: step.notify === true || step.notify === 'true' }));
        ui.postExtras.forEach((h) => h.attach?.(post, g, undefined, 'team'));
        return { result: `Beitrag „${post.title}“ in ${ch.name}`, vars: { community_post_id: post.id } };
      },
    };
    registerActions(app, [grantBadge, sendMessage, givePoints, postAsTeam]);

    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...COMMUNITY_TOOLS];
  },
};

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const GROUP_ARG = { group_id: { type: 'string', description: 'ID der Community-Gruppe (aus ghl_community_members ohne group_id)' } };

export const COMMUNITY_TOOLS: Tool[] = [
  {
    name: 'ghl_community_members',
    title: 'Community-Mitglieder',
    description: 'Ohne group_id: die Community-Gruppen des Projekts (Name, Mitglieder, Zugang). Mit group_id: die Mitglieder der Gruppe mit Name, E-Mail, Punkten, Level, Beiträgen und Beitrittsdatum – Suche mit q (Name oder E-Mail), nur Gesperrte mit banned=true.',
    inputSchema: { type: 'object', properties: { ...LOC, ...GROUP_ARG, q: { type: 'string' }, banned: { type: 'boolean' }, limit: { type: 'number', description: 'höchstens 200, Standard 50' } }, required: ['location_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      if (!a.group_id) {
        const groups: any[] = await call.api('GET', '/api/community/groups', { location: a.location_id });
        return groups.map((g) => ({ id: g.id, name: g.name, slug: g.slug, status: g.status, members: g.stats?.members ?? g.members, access: g.access?.mode }));
      }
      const qs = new URLSearchParams();
      if (a.q) qs.set('q', String(a.q));
      if (a.banned) qs.set('banned', '1');
      const rows: any[] = await call.api('GET', `/api/community/groups/${encodeURIComponent(String(a.group_id))}/members?${qs}`, { location: a.location_id });
      const limit = Math.min(Math.max(Math.round(Number(a.limit) || 50), 1), 200);
      return rows.slice(0, limit).map((r) => ({ contact_id: r.contact_id, name: r.display_name || [r.first_name, r.last_name].filter(Boolean).join(' '), email: r.email, handle: r.handle, points: r.points, level: r.level, level_name: r.level_name, posts: r.posts, comments: r.comments, joined_at: r.joined_at, banned: !!r.banned_at }));
    },
  },
  {
    name: 'ghl_community_post',
    title: 'Community-Beitrag schreiben',
    description: 'Veröffentlicht einen Beitrag im Namen des Teams in einer Community-Gruppe (Markdown im Text). Optional: channel_id, anheften, alle benachrichtigen, Umfrage (poll {question, options[], days}), Video-Link (YouTube/Vimeo/Loom/MP4) oder GIF-Link.',
    inputSchema: {
      type: 'object',
      properties: { ...LOC, ...GROUP_ARG, title: { type: 'string' }, body: { type: 'string' }, channel_id: { type: 'string' }, pinned: { type: 'boolean' }, notify: { type: 'boolean', description: 'alle Mitglieder benachrichtigen' }, poll: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, days: { type: 'number' }, multi: { type: 'boolean' } } }, video_url: { type: 'string' }, gif_url: { type: 'string' } },
      required: ['location_id', 'group_id', 'title'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (call, a) => {
      const { location_id, group_id, ...body } = a;
      const p = await call.api('POST', `/api/community/groups/${encodeURIComponent(String(group_id))}/posts`, { location: String(location_id), body });
      return { id: p.id, title: p.title, channel_id: p.channel_id, url: p.url ?? null };
    },
  },
  {
    name: 'ghl_community_stats',
    title: 'Community-Zahlen',
    description: 'Kennzahlen einer Community-Gruppe: Mitglieder über die Zeit, MRR (netto), Abwanderung, Testphasen-Umwandlung, aktive Mitglieder pro Tag, Beiträge und Kommentare pro Tag, Top-Beitragende und Engagement-Rate. Ohne group_id: Überblick über alle Gruppen. days: 7 bis 366 (Standard 30).',
    inputSchema: { type: 'object', properties: { ...LOC, ...GROUP_ARG, days: { type: 'number' }, series: { type: 'boolean', description: 'auch die Tagesreihen ausgeben (sonst nur Summen)' } }, required: ['location_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      const days = Math.min(Math.max(Math.round(Number(a.days) || 30), 7), 366);
      if (!a.group_id) return call.api('GET', `/api/community/overview?days=${days}`, { location: a.location_id });
      const r = await call.api('GET', `/api/community/groups/${encodeURIComponent(String(a.group_id))}/analytics?days=${days}`, { location: a.location_id });
      if (a.series) return r;
      const { members: _m, dau: _d, activity: _a, ...rest } = r;
      return rest;
    },
  },
  {
    name: 'ghl_community_grant',
    title: 'Community: Zugang, Abzeichen, Punkte',
    description: 'Vergibt etwas an ein Mitglied: grant=member (in die Gruppe aufnehmen, optional tier_id), remove (Mitgliedschaft beenden), tier (Stufe wechseln, tier_id), badge (Abzeichen per Name oder ID) oder points (Punkte, auch negativ). Die Person wird über contact_id oder E-Mail gefunden.',
    inputSchema: {
      type: 'object',
      properties: { ...LOC, ...GROUP_ARG, grant: { type: 'string', enum: ['member', 'remove', 'tier', 'badge', 'points'] }, contact_id: { type: 'string' }, email: { type: 'string' }, tier_id: { type: 'string' }, badge: { type: 'string', description: 'Name oder ID des Abzeichens' }, points: { type: 'number' }, reason: { type: 'string' } },
      required: ['location_id', 'group_id', 'grant'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (call, a) => {
      const loc = String(a.location_id);
      const gid = encodeURIComponent(String(a.group_id));
      const contactId = async () => {
        if (a.contact_id) return String(a.contact_id);
        if (!a.email) throw new Error('contact_id oder email angeben');
        const found = await call.api('GET', `/api/contacts?q=${encodeURIComponent(String(a.email))}`, { location: loc });
        const c = (found.contacts ?? []).find((x: any) => String(x.email).toLowerCase() === String(a.email).trim().toLowerCase());
        if (!c) throw new Error(`Kein Kontakt mit der E-Mail ${a.email}`);
        return c.id as string;
      };
      const membership = async (cid: string) => {
        const rows: any[] = await call.api('GET', `/api/community/groups/${gid}/memberships`, { location: loc });
        const m = rows.find((r) => r.contact_id === cid);
        if (!m) throw new Error('Diese Person hat in der Gruppe keine Mitgliedschaft');
        return m;
      };
      switch (a.grant) {
        case 'member': {
          const body: Record<string, unknown> = { send_login_link: true, ...(a.tier_id ? { tier_id: a.tier_id } : {}) };
          if (a.contact_id) body.contact_id = a.contact_id;
          else if (a.email) body.email = a.email;
          else throw new Error('contact_id oder email angeben');
          const m = await call.api('POST', `/api/community/groups/${gid}/memberships`, { location: loc, body });
          return { ok: true, membership_id: m.id, status: m.status };
        }
        case 'remove': {
          const m = await membership(await contactId());
          await call.api('PATCH', `/api/community/memberships/${encodeURIComponent(m.id)}`, { location: loc, body: { action: 'end' } });
          return { ok: true };
        }
        case 'tier': {
          if (!a.tier_id) throw new Error('tier_id angeben');
          const m = await membership(await contactId());
          await call.api('PATCH', `/api/community/memberships/${encodeURIComponent(m.id)}`, { location: loc, body: { action: 'tier', tier_id: a.tier_id } });
          return { ok: true };
        }
        case 'badge': {
          if (!a.badge) throw new Error('badge angeben (Name oder ID)');
          const list = await call.api('GET', `/api/community/groups/${gid}/badges`, { location: loc });
          const b = (list.badges as any[]).find((x) => x.id === a.badge || String(x.name).toLowerCase() === String(a.badge).toLowerCase());
          if (!b) throw new Error(`Abzeichen „${a.badge}“ nicht gefunden`);
          return call.api('POST', `/api/community/badges/${encodeURIComponent(b.id)}/award`, { location: loc, body: { contact_id: await contactId(), reason: a.reason } });
        }
        case 'points':
          return call.api('POST', `/api/community/groups/${gid}/points`, { location: loc, body: { contact_id: await contactId(), points: a.points, reason: a.reason } });
        default:
          throw new Error('grant: member, remove, tier, badge oder points');
      }
    },
  },
];

