import { smartListById, type ListReader } from '../services/smart-lists.js';
import type { Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { HttpError, bad, html, notFound, num, redirect, str, type Ctx, type RawResult } from '../core/http.js';
import { escapeHtml, textToHtml } from '../core/template.js';
import { id, now } from '../core/util.js';
import { contactVars, findContacts, getContact, logActivity } from '../services/contacts.js';
import { sendToContact } from '../services/messaging.js';
import { sign, verifySig } from '../services/helpdesk.js';
import { addTicketEvent, getTicketRow, loadHelpdeskSettings, renderTicketText } from '../services/tickets.js';
import { render } from '../core/template.js';

/**
 * Customer satisfaction: after a ticket is solved the contact gets a signed CSAT link (1–5 + comment);
 * NPS campaigns (0–10) go to contacts by tags or a smart list. Results show on the ticket, the
 * contact, the helpdesk dashboard and in the survey reports; csat.received / nps.received feed
 * workflows and the health score.
 */

const FACES = ['😞', '🙁', '😐', '🙂', '😄'];
const CSAT_LABELS = ['Sehr unzufrieden', 'Unzufrieden', 'Neutral', 'Zufrieden', 'Sehr zufrieden'];
const PER_TICK = 50;
/** An NPS recipient stays 'sending' only while the message is on its way; one older than this was left behind by a restart. */
const NPS_SENDING_STALE_MS = 30 * 60_000;
const NPS_INTERRUPTED = 'Versand unterbrochen (Neustart) – nicht noch einmal gesendet, um keine doppelte Nachricht zu riskieren';

const CSS = `:root{--brand:#2563eb;--text:#0f172a;--muted:#64748b;--line:#e2e8f0;--bg:#f6f7fb;--panel:#fff;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--text:#e5e7eb;--muted:#94a3b8;--line:#1e293b;--bg:#0b1020;--panel:#111a2e;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text)}
.wrap{max-width:560px;margin:0 auto;padding:40px 16px}.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:28px}
h1{font-size:23px;margin:0 0 6px;line-height:1.25}.muted{color:var(--muted)}
.scale{display:flex;gap:8px;margin:20px 0 6px;flex-wrap:wrap}.scale label{flex:1 1 0;min-width:44px;cursor:pointer}
.scale input{position:absolute;opacity:0;pointer-events:none}.scale span{display:flex;flex-direction:column;align-items:center;gap:2px;border:2px solid var(--line);border-radius:12px;padding:10px 4px;font-size:13px;color:var(--muted);text-align:center}
.scale b{font-size:26px;line-height:1.1}.scale.nps b{font-size:18px;color:var(--text)}
.scale input:checked+span{border-color:var(--brand);background:color-mix(in srgb,var(--brand) 12%,transparent);color:var(--text)}
.scale input:focus-visible+span{outline:2px solid var(--brand);outline-offset:2px}
.ends{display:flex;justify-content:space-between;font-size:13px;color:var(--muted);margin-bottom:16px}
textarea{width:100%;min-height:100px;border:1px solid var(--line);border-radius:10px;padding:11px 12px;font:inherit;background:var(--panel);color:var(--text);resize:vertical}
button{margin-top:14px;width:100%;border:0;border-radius:10px;background:var(--brand);color:#fff;font:inherit;font-weight:600;padding:12px;cursor:pointer}
.ok{text-align:center}.ok .big{font-size:46px}.err{color:#dc2626;font-size:14px}
@media (max-width:480px){.card{padding:20px}.scale.nps label{min-width:38px}}`;

function surveyPage(title: string, body: string, color: string, status = 200): RawResult {
  const c = /^#[0-9a-f]{6}$/i.test(color) ? color : '#2563eb';
  const r = html(
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${CSS}:root{--brand:${c}}</style></head><body><div class="wrap"><div class="card">${body}</div></div></body></html>`,
    status,
  );
  Object.assign(r.headers, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
  return r;
}

export const csatModule: Module = {
  name: 'csat',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE nps_campaigns (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, question TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'email', subject TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', smart_list_id TEXT, status TEXT NOT NULL DEFAULT 'draft',
        sent_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE nps_sends (
        campaign_id TEXT NOT NULL REFERENCES nps_campaigns(id) ON DELETE CASCADE, contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending', error TEXT NOT NULL DEFAULT '', sent_at TEXT, PRIMARY KEY (campaign_id, contact_id)
      );
      CREATE TABLE nps_responses (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        campaign_id TEXT NOT NULL REFERENCES nps_campaigns(id) ON DELETE CASCADE, contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        score INTEGER NOT NULL, comment TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(campaign_id, contact_id)
      );
      CREATE INDEX nps_responses_contact ON nps_responses(contact_id, updated_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const secret = app.config.secret;
    const colorOf = (loc: string) => {
      const l = app.location(loc);
      return loadHelpdeskSettings(app, loc).help_center.color || l?.settings?.branding?.color || '#2563eb';
    };

    // --- CSAT ------------------------------------------------------------------------------------
    const csatToken = (ticketId: string) => `${ticketId}.${sign(secret, `csat:${ticketId}`)}`;
    const csatLink = (ticketId: string) => `${app.baseUrl()}/survey/csat/${csatToken(ticketId)}`;
    app.services.csatLink = csatLink;

    /** Surveys on their way right now (a forced send – "Umfrage senden" – clicked twice is refused the second time). */
    const csatSending = new Set<string>();

    /** Sends the CSAT request for a solved ticket (email with five buttons, or SMS with the link). */
    const sendCsat = async (loc: string, ticketId: string, force = false) => {
      const t = getTicketRow(app, loc, ticketId);
      if (!t || !t.contact_id || t.merged_into) return { status: 'skipped', reason: 'kein Kontakt' };
      if (csatSending.has(t.id)) {
        if (force) throw new HttpError(409, 'Die Umfrage wird gerade gesendet');
        return { status: 'skipped', reason: 'wird gerade gesendet' };
      }
      if (t.csat_sent_at && !force) return { status: 'skipped', reason: 'schon gesendet' };
      const s = loadHelpdeskSettings(app, loc);
      const contact = getContact(app, loc, t.contact_id);
      if (!contact) return { status: 'skipped', reason: 'kein Kontakt' };
      const pref = s.csat.channel === 'auto' ? (t.channel === 'sms' || t.channel === 'whatsapp' ? 'sms' : 'email') : s.csat.channel;
      const channel = pref === 'email' && contact.email ? 'email' : contact.phone ? 'sms' : contact.email ? 'email' : '';
      if (!channel) return { status: 'skipped', reason: 'keine E-Mail/Telefonnummer' };
      // A satisfaction survey is advertising in German law (BGH VI ZR 225/17), like the NPS: "Nicht stören", a withdrawal or a
      // missing consent (under the sub-account's policy) means no survey – also when it is sent again by hand.
      if (contact.dnd) return { status: 'skipped', reason: 'Kontakt hat „Nicht stören“ aktiv' };
      const verdict = app.services.consent?.allowMarketing?.(loc, contact, channel) as { allow: boolean; reason: string } | undefined;
      if (verdict && !verdict.allow) return { status: 'skipped', reason: verdict.reason };
      const link = csatLink(t.id);
      const textBody = renderTicketText(app, t, s.csat.body, null, { csat_link: link });
      let body = textBody;
      let isHtml = false;
      if (channel === 'email') {
        const marker = '\u0000CSAT\u0000';
        const buttons = `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:14px 0"><tr>${FACES.map((f, i) => `<td style="padding:0 4px"><a href="${escapeHtml(link)}?s=${i + 1}" title="${CSAT_LABELS[i]}" style="display:inline-block;width:48px;height:48px;line-height:48px;text-align:center;font-size:28px;text-decoration:none;border:1px solid #e5e7eb;border-radius:12px">${f}</a></td>`).join('')}</tr></table>`;
        body = textToHtml(renderTicketText(app, t, s.csat.body, null, { csat_link: marker })).replace(marker, buttons);
        isHtml = true;
      }
      // Claimed before the send (on the row as it is now, not the copy read above): the ticket solved again while the survey is
      // on its way – reopened by the customer's answer, solved by the agent – or the delayed job finds it asked already.
      const claim = now();
      if (!db.run(`UPDATE tickets SET csat_sent_at = ?, csat_due_at = NULL WHERE id = ? ${force ? '' : 'AND csat_sent_at IS NULL'}`, claim, t.id).changes) return { status: 'skipped', reason: 'schon gesendet' };
      csatSending.add(t.id);
      let msg;
      try {
        msg = await sendToContact(app, loc, { contactId: contact.id, channel, subject: renderTicketText(app, t, s.csat.subject), body, text: channel === 'email' ? textBody : undefined, isHtml, source: 'Zufriedenheit (CSAT)', purpose: 'marketing', bulk: true });
      } catch (e) {
        // nothing went out: the survey may be asked again later
        db.run('UPDATE tickets SET csat_sent_at = ?, csat_due_at = ? WHERE id = ? AND csat_sent_at = ?', t.csat_sent_at ?? null, t.csat_due_at ?? null, t.id, claim);
        throw e;
      } finally {
        csatSending.delete(t.id);
      }
      addTicketEvent(app, t, 'csat_sent', { body: 'Zufriedenheits-Umfrage gesendet', messageId: msg.id, data: { channel, status: msg.status } });
      return { status: msg.status, error: msg.error || undefined };
    };
    app.services.sendCsat = sendCsat;

    app.events.on('ticket.status_changed', async (e) => {
      if (e.data.kind !== 'resolved' && e.data.kind !== 'closed') return;
      if (e.data.previousKind === 'resolved' || e.data.previousKind === 'closed') return;
      const t = getTicketRow(app, e.locationId, e.data.ticketId);
      if (!t || t.csat_sent_at || t.csat_due_at || !t.contact_id || t.merged_into) return;
      const s = loadHelpdeskSettings(app, e.locationId);
      if (!s.csat.enabled) return;
      if (s.csat.delay_min > 0) db.run('UPDATE tickets SET csat_due_at = ? WHERE id = ?', new Date(Date.now() + s.csat.delay_min * 60_000).toISOString(), t.id);
      else await sendCsat(e.locationId, t.id);
    });

    app.onTick(async () => {
      const due = db.all(`SELECT id, location_id FROM tickets WHERE csat_due_at <= ? AND csat_sent_at IS NULL AND status_kind IN ('resolved','closed') LIMIT ?`, now(), PER_TICK);
      for (const t of due) {
        // One that may not go out (no address, "Nicht stören", no consent) is not tried again on every tick.
        if ((await sendCsat(t.location_id, t.id)).status === 'skipped') db.run('UPDATE tickets SET csat_due_at = NULL WHERE id = ? AND csat_sent_at IS NULL', t.id);
      }
      // A ticket that was reopened before the delay ran out doesn't get asked.
      db.run(`UPDATE tickets SET csat_due_at = NULL WHERE csat_due_at IS NOT NULL AND status_kind IN ('new','open','waiting')`);
      await npsTick();
    });

    const ticketFromToken = (tok: string) => {
      const [tid, sig] = String(tok ?? '').split('.');
      if (!tid || !sig || !verifySig(secret, `csat:${tid}`, sig)) return undefined;
      return parseJson(db.get('SELECT * FROM tickets WHERE id = ?', tid), ['tags']);
    };
    const invalid = () => surveyPage('Link ungültig', '<h1>Link ungültig</h1><p class="muted">Dieser Umfrage-Link ist nicht (mehr) gültig.</p>', '#2563eb', 404);
    const csatForm = (t: any, pre: number, err = '') => {
      const loc = app.location(t.location_id);
      return surveyPage(
        'Wie zufrieden warst du?',
        `<h1>Wie zufrieden warst du mit unserer Hilfe?</h1><p class="muted">Anfrage #${t.number}: ${escapeHtml(t.subject)} · ${escapeHtml(loc?.settings?.branding?.name || loc?.name || '')}</p>
<form method="post"><div class="scale" role="radiogroup" aria-label="Zufriedenheit">${FACES.map((f, i) => `<label><input type="radio" name="score" value="${i + 1}"${pre === i + 1 ? ' checked' : ''} required><span><b aria-hidden="true">${f}</b>${CSAT_LABELS[i]}</span></label>`).join('')}</div>
${err ? `<p class="err">${escapeHtml(err)}</p>` : ''}<label for="c" class="muted" style="display:block;margin:14px 0 6px">Möchtest du uns noch etwas sagen? (optional)</label><textarea id="c" name="comment" maxlength="2000">${escapeHtml(t.csat_comment || '')}</textarea><button>Absenden</button></form>`,
        colorOf(t.location_id),
      );
    };
    // Opening the link only shows the form (mail scanners that follow links don't vote).
    router.get('/survey/csat/:token', 'public', (ctx) => {
      const t = ticketFromToken(ctx.params.token);
      if (!t) return invalid();
      const s = Math.round(num(ctx.query.get('s'), t.csat_score ?? 0));
      return csatForm(t, s >= 1 && s <= 5 ? s : 0);
    });
    router.post('/survey/csat/:token', 'public', (ctx) => {
      const t = ticketFromToken(ctx.params.token);
      if (!t) return invalid();
      const score = Math.round(num(ctx.body?.score, 0));
      if (score < 1 || score > 5) return csatForm(t, 0, 'Bitte eine Bewertung wählen.');
      const comment = String(ctx.body?.comment ?? '').trim().slice(0, 2000);
      const first = t.csat_score === null || t.csat_score === undefined;
      db.run('UPDATE tickets SET csat_score = ?, csat_comment = ?, csat_at = ? WHERE id = ?', score, comment, now(), t.id);
      addTicketEvent(app, t, 'csat', { body: comment, data: { score, label: CSAT_LABELS[score - 1], updated: !first } });
      if (t.contact_id) {
        logActivity(app, t.location_id, t.contact_id, 'csat.received', `Zufriedenheit zu Ticket #${t.number}: ${score}/5`, { ticketId: t.id, score });
        app.events.emit(t.location_id, 'csat.received', { contactId: t.contact_id, ticketId: t.id, score, comment });
      }
      return redirect(`/survey/csat/${encodeURIComponent(ctx.params.token)}/danke`, 303);
    });
    router.get('/survey/csat/:token/danke', 'public', (ctx) => {
      const t = ticketFromToken(ctx.params.token);
      if (!t) return invalid();
      return surveyPage('Danke!', `<div class="ok"><div class="big">${FACES[(t.csat_score ?? 3) - 1] ?? '🙂'}</div><h1>Danke für dein Feedback!</h1><p class="muted">Das hilft uns, besser zu werden.</p></div>`, colorOf(t.location_id));
    });

    router.post('/api/surveys/csat/:ticketId/send', 'location', async (ctx) => {
      if (!getTicketRow(app, ctx.locationId, ctx.params.ticketId)) throw notFound('Ticket nicht gefunden');
      return sendCsat(ctx.locationId, ctx.params.ticketId, true);
    });

    const csatSummary = (loc: string, from: string) => {
      const rows = db.all('SELECT csat_score AS s FROM tickets WHERE location_id = ? AND csat_score IS NOT NULL AND csat_at >= ?', loc, from);
      const sent = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tickets WHERE location_id = ? AND csat_sent_at >= ?', loc, from)!.n;
      const dist = [1, 2, 3, 4, 5].map((v) => rows.filter((r) => r.s === v).length);
      return { count: rows.length, sent, response_rate: sent ? Math.round((rows.length / sent) * 100) : null, avg: rows.length ? Math.round((rows.reduce((a, r) => a + r.s, 0) / rows.length) * 10) / 10 : null, distribution: dist, satisfied_pct: rows.length ? Math.round(((dist[3] + dist[4]) / rows.length) * 100) : null };
    };
    router.get('/api/surveys/csat', 'location', (ctx) => {
      const days = Math.min(730, Math.max(1, Math.round(num(ctx.query.get('days'), 90))));
      const from = new Date(Date.now() - days * 864e5).toISOString();
      const score = Math.round(num(ctx.query.get('score'), 0));
      const list = db.all(
        `SELECT t.id, t.number, t.subject, t.csat_score, t.csat_comment, t.csat_at, t.owner_id, t.contact_id, c.first_name, c.last_name, c.email, (SELECT name FROM users u WHERE u.id = t.owner_id) AS owner_name
         FROM tickets t LEFT JOIN contacts c ON c.id = t.contact_id WHERE t.location_id = ? AND t.csat_score IS NOT NULL AND t.csat_at >= ? ${score ? 'AND t.csat_score = ?' : ''} ORDER BY t.csat_at DESC LIMIT 500`,
        ctx.locationId,
        from,
        ...(score ? [score] : []),
      );
      return { summary: csatSummary(ctx.locationId, from), responses: list };
    });

    // --- NPS -------------------------------------------------------------------------------------
    const npsToken = (campaignId: string, contactId: string) => `${campaignId}.${contactId}.${sign(secret, `nps:${campaignId}:${contactId}`)}`;
    const npsStats = (loc: string, from?: string, campaignId?: string) => {
      const rows = db.all(`SELECT score FROM nps_responses WHERE location_id = ? ${from ? 'AND updated_at >= ?' : ''} ${campaignId ? 'AND campaign_id = ?' : ''}`, loc, ...(from ? [from] : []), ...(campaignId ? [campaignId] : []));
      const promoters = rows.filter((r) => r.score >= 9).length;
      const detractors = rows.filter((r) => r.score <= 6).length;
      return { count: rows.length, promoters, passives: rows.length - promoters - detractors, detractors, score: rows.length ? Math.round(((promoters - detractors) / rows.length) * 100) : null };
    };
    app.services.npsStats = (loc: string, from?: string) => npsStats(loc, from);

    const campaignIn = (b: any, cur: any | null, who: ListReader) => {
      const out: Record<string, any> = {};
      if (b.name !== undefined || !cur) out.name = str(b.name, 'Name', { required: true, max: 120 });
      if (b.question !== undefined || !cur) out.question = str(b.question, 'Frage', { max: 300 }) || 'Wie wahrscheinlich ist es, dass du uns Freunden oder Kollegen empfiehlst?';
      if (b.channel !== undefined) {
        if (!['email', 'sms'].includes(b.channel)) throw bad('Kanal: email oder sms');
        out.channel = b.channel;
      }
      if (b.subject !== undefined || !cur) out.subject = str(b.subject, 'Betreff', { max: 300 }) || 'Kurze Frage: Würdest du uns weiterempfehlen?';
      if (b.body !== undefined || !cur) {
        const body = str(b.body, 'Text', { max: 10_000 }) || 'Hallo {{contact.first_name|}},\n\nwie wahrscheinlich ist es, dass du uns weiterempfiehlst? Eine Antwort dauert 10 Sekunden:\n\n{{nps_link}}\n\nDanke!\n{{location.name}}';
        if (!body.includes('{{nps_link}}')) throw bad('Der Text braucht den Platzhalter {{nps_link}}');
        out.body = body;
      }
      if (b.tags !== undefined) out.tags = (Array.isArray(b.tags) ? b.tags : String(b.tags).split(',')).map((t: unknown) => String(t).trim()).filter(Boolean).slice(0, 20);
      if (b.smart_list_id !== undefined) {
        const sl = str(b.smart_list_id, 'Smart List', { max: 40 }) || null;
        if (sl && !smartListById(app, cur?.location_id ?? b.__loc, sl, who)) throw bad('Unbekannte Smart List');
        out.smart_list_id = sl;
      }
      return out;
    };
    const audience = (loc: string, c: any, who: ListReader) => {
      let f: any = {};
      if (c.smart_list_id) {
        // A deleted list – or another person's private one – selects nobody (never everybody).
        const sl = smartListById(app, loc, c.smart_list_id, who);
        if (!sl) throw bad('Unbekannte Smart List');
        f = sl.filter;
      }
      const tags: string[] = JSON.parse(c.tags || '[]');
      if (!c.smart_list_id && !tags.length) throw bad('Bitte Tags oder eine Smart List wählen');
      return findContacts(app, loc, { tags: f.tags ?? [], anyTags: [...(f.anyTags ?? []), ...tags], excludeTags: f.excludeTags ?? [], q: f.q ?? '', limit: 20_000, extra: f }).contacts.filter((x) => !x.dnd);
    };
    const campaignOut = (c: any) => ({
      ...parseJson(c, ['tags']),
      stats: npsStats(c.location_id, undefined, c.id),
      sends: db.get(`SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('pending', 'sending') THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed FROM nps_sends WHERE campaign_id = ?`, c.id),
    });
    router.get('/api/surveys/nps', 'location', (ctx) => db.all('SELECT * FROM nps_campaigns WHERE location_id = ? ORDER BY created_at DESC', ctx.locationId).map(campaignOut));
    router.post('/api/surveys/nps', 'location', (ctx) => {
      const row = { id: id(), location_id: ctx.locationId, channel: 'email', tags: [], status: 'draft', created_at: now(), updated_at: now(), ...campaignIn({ ...ctx.body, __loc: ctx.locationId }, null, ctx) };
      db.insert('nps_campaigns', row);
      return campaignOut(db.get('SELECT * FROM nps_campaigns WHERE id = ?', row.id));
    });
    router.patch('/api/surveys/nps/:id', 'location', (ctx) => {
      const c = db.get('SELECT * FROM nps_campaigns WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!c) throw notFound();
      db.update('nps_campaigns', c.id, { ...campaignIn(ctx.body ?? {}, c, ctx), updated_at: now() }, ctx.locationId);
      return campaignOut(db.get('SELECT * FROM nps_campaigns WHERE id = ?', c.id));
    });
    router.delete('/api/surveys/nps/:id', 'location', (ctx) => {
      db.run('DELETE FROM nps_campaigns WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });
    /** Queues everyone in the audience who hasn't been asked in this campaign; the scheduler sends in batches. */
    router.post('/api/surveys/nps/:id/send', 'location', (ctx) => {
      const c = db.get('SELECT * FROM nps_campaigns WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!c) throw notFound();
      const people = audience(ctx.locationId, c, ctx);
      let queued = 0;
      for (const p of people) queued += db.run('INSERT OR IGNORE INTO nps_sends (campaign_id, contact_id) VALUES (?, ?)', c.id, p.id).changes;
      db.update('nps_campaigns', c.id, { status: 'sending', sent_at: c.sent_at ?? now(), updated_at: now() }, ctx.locationId);
      return { queued, audience: people.length };
    });
    router.get('/api/surveys/nps/:id/responses', 'location', (ctx) => {
      const c = db.get('SELECT * FROM nps_campaigns WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!c) throw notFound();
      return db.all(
        `SELECT r.*, k.first_name, k.last_name, k.email FROM nps_responses r JOIN contacts k ON k.id = r.contact_id WHERE r.campaign_id = ? ORDER BY r.updated_at DESC LIMIT 1000`,
        c.id,
      );
    });
    router.get('/api/surveys/summary', 'location', (ctx) => {
      const days = Math.min(730, Math.max(1, Math.round(num(ctx.query.get('days'), 90))));
      const from = new Date(Date.now() - days * 864e5).toISOString();
      return { days, csat: csatSummary(ctx.locationId, from), nps: npsStats(ctx.locationId, from) };
    });

    const npsTick = async () => {
      const sending = db.all(`SELECT * FROM nps_campaigns WHERE status = 'sending'`);
      for (const c of sending) {
        const loc = app.location(c.location_id);
        if (!loc) continue;
        // A send the process did not live to write down (restart, crash): the provider may well have taken it – not sent again.
        db.run(`UPDATE nps_sends SET status = 'failed', error = ? WHERE campaign_id = ? AND status = 'sending' AND sent_at < ?`, NPS_INTERRUPTED, c.id, new Date(Date.now() - NPS_SENDING_STALE_MS).toISOString());
        const pending = db.all(`SELECT * FROM nps_sends WHERE campaign_id = ? AND status = 'pending' LIMIT ?`, c.id, PER_TICK);
        for (const p of pending) {
          // Claimed before the send (sent_at = the claim's time while 'sending'): a second run at the same time skips this recipient.
          if (!db.run(`UPDATE nps_sends SET status = 'sending', sent_at = ? WHERE campaign_id = ? AND contact_id = ? AND status = 'pending'`, now(), c.id, p.contact_id).changes) continue;
          const contact = getContact(app, c.location_id, p.contact_id);
          if (!contact) {
            db.run(`UPDATE nps_sends SET status = 'skipped' WHERE campaign_id = ? AND contact_id = ?`, c.id, p.contact_id);
            continue;
          }
          const link = `${app.baseUrl()}/survey/nps/${npsToken(c.id, contact.id)}`;
          const vars = { contact: contactVars(contact), location: loc, nps_link: link };
          let msg: { status: string; error?: string | null };
          try {
            msg = await sendToContact(app, c.location_id, { contactId: contact.id, channel: c.channel === 'sms' ? 'sms' : 'email', subject: render(c.subject, vars), body: render(c.body, vars), source: `NPS: ${c.name}` });
          } catch (e) {
            msg = { status: 'failed', error: (e as Error).message.slice(0, 300) };
          }
          db.run(`UPDATE nps_sends SET status = ?, error = ?, sent_at = ? WHERE campaign_id = ? AND contact_id = ?`, msg.status === 'failed' ? 'failed' : 'sent', msg.error ?? '', now(), c.id, contact.id);
        }
        // Done when nothing waits and nothing is on its way (a run at the same time may still be sending its share).
        if (!db.get(`SELECT 1 FROM nps_sends WHERE campaign_id = ? AND status IN ('pending', 'sending') LIMIT 1`, c.id)) db.run(`UPDATE nps_campaigns SET status = 'sent', updated_at = ? WHERE id = ?`, now(), c.id);
      }
    };
    app.services.npsTick = npsTick;

    const npsFromToken = (tok: string) => {
      const [cid, kid, sig] = String(tok ?? '').split('.');
      if (!cid || !kid || !sig || !verifySig(secret, `nps:${cid}:${kid}`, sig)) return undefined;
      const c = db.get('SELECT * FROM nps_campaigns WHERE id = ?', cid);
      const contact = c && getContact(app, c.location_id, kid);
      return c && contact ? { c, contact } : undefined;
    };
    const npsForm = (x: { c: any; contact: any }, pre: number | null, err = '') => {
      const prev = db.get('SELECT * FROM nps_responses WHERE campaign_id = ? AND contact_id = ?', x.c.id, x.contact.id);
      const sel = pre ?? prev?.score ?? null;
      return surveyPage(
        x.c.name,
        `<h1>${escapeHtml(x.c.question)}</h1><p class="muted">0 = gar nicht wahrscheinlich, 10 = äußerst wahrscheinlich</p>
<form method="post"><div class="scale nps" role="radiogroup" aria-label="Bewertung 0 bis 10">${Array.from({ length: 11 }, (_, i) => `<label><input type="radio" name="score" value="${i}"${sel === i ? ' checked' : ''} required><span><b>${i}</b></span></label>`).join('')}</div>
${err ? `<p class="err">${escapeHtml(err)}</p>` : ''}<label for="c" class="muted" style="display:block;margin:14px 0 6px">Was ist der wichtigste Grund für deine Bewertung? (optional)</label><textarea id="c" name="comment" maxlength="2000">${escapeHtml(prev?.comment ?? '')}</textarea><button>Absenden</button></form>`,
        colorOf(x.c.location_id),
      );
    };
    router.get('/survey/nps/:token', 'public', (ctx) => {
      const x = npsFromToken(ctx.params.token);
      if (!x) return invalid();
      const s = ctx.query.get('s');
      return npsForm(x, s !== null && /^(10|\d)$/.test(s) ? Number(s) : null);
    });
    router.post('/survey/nps/:token', 'public', (ctx: Ctx) => {
      const x = npsFromToken(ctx.params.token);
      if (!x) return invalid();
      const raw = String(ctx.body?.score ?? '');
      if (!/^(10|\d)$/.test(raw)) return npsForm(x, null, 'Bitte einen Wert von 0 bis 10 wählen.');
      const score = Number(raw);
      const comment = String(ctx.body?.comment ?? '').trim().slice(0, 2000);
      db.run(
        `INSERT INTO nps_responses (id, location_id, campaign_id, contact_id, score, comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(campaign_id, contact_id) DO UPDATE SET score = excluded.score, comment = excluded.comment, updated_at = excluded.updated_at`,
        id(),
        x.c.location_id,
        x.c.id,
        x.contact.id,
        score,
        comment,
        now(),
        now(),
      );
      logActivity(app, x.c.location_id, x.contact.id, 'nps.received', `NPS „${x.c.name}“: ${score}/10`, { campaignId: x.c.id, score });
      app.events.emit(x.c.location_id, 'nps.received', { contactId: x.contact.id, campaignId: x.c.id, score, comment });
      return surveyPage('Danke!', `<div class="ok"><div class="big">🙏</div><h1>Danke für deine Antwort!</h1><p class="muted">Du hast ${score} von 10 gegeben.</p></div>`, colorOf(x.c.location_id));
    });

    // Rows for the contact page (latest answers first).
    app.services.surveysOfContact = (loc: string, contactId: string) => ({
      csat: db.all('SELECT id, number, subject, csat_score, csat_comment, csat_at FROM tickets WHERE location_id = ? AND contact_id = ? AND csat_score IS NOT NULL ORDER BY csat_at DESC LIMIT 20', loc, contactId),
      nps: parseRows(db.all('SELECT r.score, r.comment, r.updated_at, c.name AS campaign FROM nps_responses r JOIN nps_campaigns c ON c.id = r.campaign_id WHERE r.location_id = ? AND r.contact_id = ? ORDER BY r.updated_at DESC LIMIT 20', loc, contactId), []),
    });
  },
};
