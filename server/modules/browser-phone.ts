import type { LocationRow, Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, notFound, str, text, type Ctx } from '../core/http.js';
import { id, normalizePhone, now } from '../core/util.js';
import {
  API_KEY_SID,
  APP_SID,
  EDGES,
  PHONE_MODES,
  TWILIO_CSP_CONNECT,
  holdRoom,
  holdTwiml,
  identityFor,
  outgoingTwiml,
  parseIdentity,
  resumeTwiml,
  voiceAccessToken,
  type PhoneMode,
} from '../services/browser-phone.js';
import { contactName, getContact, logActivity, upsertContact } from '../services/contacts.js';
import { E164, hangup, twiml } from '../services/twilio.js';
import { openSecret, sealSecret } from './mail-sync.js';
import { finalizeCall, syncMessage, telephonyConfig, twilioRequest, verifyTwilio, type DialTargets } from './telephony.js';

/**
 * Browser phone: calls straight from the app over WebRTC (Twilio Voice JS SDK). The server hands out
 * short-lived Access Tokens (API key SID/secret, sealed), answers the TwiML app's voice URL for
 * outgoing calls (caller ID = the sub-account's Twilio number), adds available users' browsers to the
 * ring group of inbound calls (next to or instead of the mobile) and parks calls on hold in a
 * conference room. Calls land in the same call log, conversations and timeline as all others.
 */

export interface PhoneSettings {
  enabled: boolean;
  api_key_sid: string;
  twiml_app_sid: string;
  incoming: PhoneMode;
  edge: string;
}
const DEFAULTS: PhoneSettings = { enabled: false, api_key_sid: '', twiml_app_sid: '', incoming: 'parallel', edge: 'roaming' };
const MASK = '••••••';
/** A browser counts as available this long after its last presence ping. */
const PRESENCE_MS = 90_000;
const TOKEN_TTL = 3600;

type PhoneCall = Record<string, any>;

export const browserPhoneModule: Module = {
  name: 'browser-phone',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE phone_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        data TEXT NOT NULL DEFAULT '{}', api_secret TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE phone_presence (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        available INTEGER NOT NULL DEFAULT 1, seen_at TEXT NOT NULL,
        PRIMARY KEY (location_id, user_id)
      );
      CREATE TABLE phone_calls (
        call_id TEXT PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL, direction TEXT NOT NULL, agent_sid TEXT, remote_sid TEXT,
        hold INTEGER NOT NULL DEFAULT 0, hold_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const hook = (name: string, loc: string) => `${app.baseUrl()}/hooks/twilio/${name}/${loc}`;
    // The SDK talks to Twilio from the browser: allow exactly its hosts in the app's CSP.
    const csp = app.services.cspExtra ?? {};
    app.services.cspExtra = { ...csp, connect: [...(csp.connect ?? []), ...TWILIO_CSP_CONNECT] };

    // --- settings -----------------------------------------------------------------
    const config = (locId: string) => {
      const row = parseJson(db.get('SELECT * FROM phone_settings WHERE location_id = ?', locId), ['data']);
      const s: PhoneSettings = { ...DEFAULTS, ...(row?.data ?? {}) };
      let secret = '';
      if (row?.api_secret) {
        try {
          secret = openSecret(app, row.api_secret);
        } catch {
          secret = '';
        }
      }
      const tel = telephonyConfig(app, locId);
      const missing = [
        !tel.accountSid && 'Account SID',
        !tel.token && 'Auth Token',
        !tel.numbers.length && 'Twilio-Nummer',
        !s.api_key_sid && 'API Key SID',
        !secret && 'API Key Secret',
        !s.twiml_app_sid && 'TwiML App SID',
      ].filter(Boolean) as string[];
      return { s, secret, secretSet: !!row?.api_secret, tel, missing, ready: s.enabled && !missing.length };
    };
    const saveSettings = (locId: string, s: PhoneSettings, secret?: string | null) => {
      db.run(
        'INSERT INTO phone_settings (location_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
        locId,
        JSON.stringify(s),
        now(),
      );
      if (secret !== undefined) db.run('UPDATE phone_settings SET api_secret = ? WHERE location_id = ?', secret ? sealSecret(app, secret) : null, locId);
    };
    const settingsOut = (locId: string) => {
      const c = config(locId);
      return {
        ...c.s,
        api_secret: c.secretSet ? MASK : '',
        api_secret_set: c.secretSet,
        ready: c.ready,
        missing: c.missing,
        modes: PHONE_MODES,
        edges: EDGES,
        webhooks: { voice: hook('phone-out', locId), status: hook('voice-status', locId) },
      };
    };

    router.get('/api/phone/settings', 'location', (ctx) => settingsOut(ctx.locationId));
    router.put('/api/phone/settings', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const cur = config(ctx.locationId);
      const s: PhoneSettings = { ...cur.s };
      if (b.enabled !== undefined) s.enabled = b.enabled === true;
      if (b.api_key_sid !== undefined) {
        const v = str(b.api_key_sid, 'API Key SID', { max: 64 });
        if (v && !API_KEY_SID.test(v)) throw bad('API Key SID: beginnt mit SK und hat 34 Zeichen');
        s.api_key_sid = v;
      }
      if (b.twiml_app_sid !== undefined) {
        const v = str(b.twiml_app_sid, 'TwiML App SID', { max: 64 });
        if (v && !APP_SID.test(v)) throw bad('TwiML App SID: beginnt mit AP und hat 34 Zeichen');
        s.twiml_app_sid = v;
      }
      if (b.incoming !== undefined) {
        if (!PHONE_MODES.includes(b.incoming)) throw bad('Eingehende Anrufe: unbekannte Einstellung');
        s.incoming = b.incoming;
      }
      if (b.edge !== undefined) {
        if (!(EDGES as readonly string[]).includes(b.edge)) throw bad('Unbekannte Twilio-Region');
        s.edge = b.edge;
      }
      let secret: string | null | undefined;
      if (b.api_secret === null) secret = null;
      else if (typeof b.api_secret === 'string' && b.api_secret && b.api_secret !== MASK) {
        const v = b.api_secret.trim();
        if (!/^[A-Za-z0-9]{16,128}$/.test(v)) throw bad('API Key Secret ungültig');
        secret = v;
      }
      saveSettings(ctx.locationId, s, secret);
      return settingsOut(ctx.locationId);
    });

    /** Creates what's missing at Twilio with the account's credentials: an API key and a TwiML app pointing here. */
    router.post('/api/phone/setup', 'location', async (ctx) => {
      const c = config(ctx.locationId);
      const loc = app.location(ctx.locationId)!;
      if (!c.tel.accountSid || !c.tel.token) throw bad('Erst Account SID und Auth Token der Telefonie eintragen');
      const s = { ...c.s };
      let secret: string | undefined;
      if (!s.api_key_sid || !c.secret) {
        const k = await twilioRequest(app, c.tel, 'POST', '/Keys.json', [['FriendlyName', `HyperLevel Browser-Telefon (${loc.name})`.slice(0, 64)]]);
        if (!API_KEY_SID.test(k.sid ?? '') || !k.secret) throw new HttpError(502, 'Twilio hat keinen API-Schlüssel geliefert');
        s.api_key_sid = k.sid;
        secret = k.secret;
      }
      const appParams: [string, string][] = [
        ['VoiceUrl', hook('phone-out', loc.id)],
        ['VoiceMethod', 'POST'],
        ['StatusCallback', hook('voice-status', loc.id)],
        ['StatusCallbackMethod', 'POST'],
      ];
      if (s.twiml_app_sid) await twilioRequest(app, c.tel, 'POST', `/Applications/${s.twiml_app_sid}.json`, appParams);
      else {
        const a = await twilioRequest(app, c.tel, 'POST', '/Applications.json', [['FriendlyName', `HyperLevel – ${loc.name}`.slice(0, 64)], ...appParams]);
        if (!APP_SID.test(a.sid ?? '')) throw new HttpError(502, 'Twilio hat keine TwiML-App angelegt');
        s.twiml_app_sid = a.sid;
      }
      saveSettings(loc.id, s, secret);
      return settingsOut(loc.id);
    });

    // --- per user: status, token, presence ---------------------------------------------------
    const requireUser = (ctx: Ctx) => {
      if (!ctx.user) throw new HttpError(403, 'Das Browser-Telefon gibt es nur für angemeldete Nutzer');
      return ctx.user;
    };
    const presenceOf = (locId: string, userId: string) => db.get('SELECT available, seen_at FROM phone_presence WHERE location_id = ? AND user_id = ?', locId, userId);
    router.get('/api/phone/status', 'location', (ctx) => {
      const c = config(ctx.locationId);
      const p = ctx.user ? presenceOf(ctx.locationId, ctx.user.id) : undefined;
      return { enabled: c.s.enabled, ready: c.ready, missing: c.missing, incoming: c.s.incoming, available: p ? !!p.available : true, number: c.tel.numbers[0] ?? '' };
    });
    router.get('/api/phone/token', 'location', (ctx) => {
      const user = requireUser(ctx);
      const c = config(ctx.locationId);
      if (!c.ready) throw bad(c.s.enabled ? `Browser-Telefon ist nicht fertig eingerichtet – es fehlt: ${c.missing.join(', ')}` : 'Das Browser-Telefon ist aus');
      const identity = identityFor(user.id, ctx.locationId);
      const token = voiceAccessToken({ accountSid: c.tel.accountSid, apiKeySid: c.s.api_key_sid, apiSecret: c.secret, identity, appSid: c.s.twiml_app_sid, incoming: c.s.incoming !== 'off', ttl: TOKEN_TTL });
      return { token, identity, edge: c.s.edge, ttl: TOKEN_TTL, incoming: c.s.incoming !== 'off', number: c.tel.numbers[0] ?? '' };
    });
    router.post('/api/phone/presence', 'location', (ctx) => {
      const user = requireUser(ctx);
      const available = ctx.body?.available !== false;
      db.run(
        'INSERT INTO phone_presence (location_id, user_id, available, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(location_id, user_id) DO UPDATE SET available = excluded.available, seen_at = excluded.seen_at',
        ctx.locationId,
        user.id,
        available ? 1 : 0,
        now(),
      );
      return { available };
    });
    router.delete('/api/phone/presence', 'location', (ctx) => {
      const user = requireUser(ctx);
      db.run('DELETE FROM phone_presence WHERE location_id = ? AND user_id = ?', ctx.locationId, user.id);
      return { ok: true };
    });

    /** Users who may take calls of this sub-account (admin, or member with access to Konversationen). */
    const mayTakeCalls = (u: any, locId: string) => {
      if (!u) return false;
      if (u.role === 'admin') return true;
      if (!JSON.parse(u.locations || '[]').includes(locId)) return false;
      const perms = u.permissions ? JSON.parse(u.permissions) : null;
      return !perms || perms.includes('conversations');
    };

    // --- inbound: ring available browsers (hook from telephony) -------------------------------
    app.services.voiceDialTargets = (input: { locationId: string; call?: any; forward: string[] }): DialTargets => {
      const c = config(input.locationId);
      if (!c.ready || c.s.incoming === 'off') return { numbers: input.forward, clients: [] };
      const users = db
        .all('SELECT u.id, u.role, u.locations, u.permissions FROM phone_presence p JOIN users u ON u.id = p.user_id WHERE p.location_id = ? AND p.available = 1 AND p.seen_at > ? ORDER BY p.seen_at DESC LIMIT 10', input.locationId, new Date(Date.now() - PRESENCE_MS).toISOString())
        .filter((u) => mayTakeCalls(u, input.locationId));
      const contact = input.call?.contact_id ? getContact(app, input.locationId, input.call.contact_id) : undefined;
      const params: Record<string, string> = { callId: String(input.call?.id ?? ''), from: String(input.call?.from_number ?? ''), name: contact && (contact.first_name || contact.last_name) ? contactName(contact) : '' };
      const clients = users.map((u) => ({ identity: identityFor(u.id, input.locationId), params }));
      return { numbers: c.s.incoming === 'browser_only' && clients.length ? [] : input.forward, clients };
    };
    app.services.voiceDialHeld = (call: any) => !!db.get('SELECT 1 FROM phone_calls WHERE call_id = ? AND hold = 1', call?.id ?? '');
    /** The browser of one person as a dial target (ring groups, transfers): null when it is off, busy elsewhere or the person may not take calls. */
    app.services.voiceUserClient = (locationId: string, userId: string, call?: any): DialTargets['clients'][number] | null => {
      const c = config(locationId);
      if (!c.ready || c.s.incoming === 'off') return null;
      const u = db.get('SELECT u.id, u.role, u.locations, u.permissions FROM phone_presence p JOIN users u ON u.id = p.user_id WHERE p.location_id = ? AND p.user_id = ? AND p.available = 1 AND p.seen_at > ?', locationId, userId, new Date(Date.now() - PRESENCE_MS).toISOString());
      if (!u || !mayTakeCalls(u, locationId)) return null;
      const contact = call?.contact_id ? getContact(app, locationId, call.contact_id) : undefined;
      return { identity: identityFor(userId, locationId), params: { callId: String(call?.id ?? ''), from: String(call?.from_number ?? ''), name: contact && (contact.first_name || contact.last_name) ? contactName(contact) : '' } };
    };

    // --- calls from the browser -----------------------------------------------------------
    const getCall = (callId: string) => db.get('SELECT * FROM calls WHERE id = ?', callId);
    const phoneCall = (locId: string, callId: string | null) => (callId ? db.get<PhoneCall>('SELECT * FROM phone_calls WHERE call_id = ? AND location_id = ?', callId, locId) : undefined);
    const secondsSince = (iso: string | null | undefined) => (iso ? Math.max(0, (Date.now() - Date.parse(iso)) / 1000) : 0);
    const route = (name: string, fn: (loc: LocationRow, p: Record<string, string>, q: URLSearchParams) => string) =>
      router.post(`/hooks/twilio/${name}/:loc`, 'public', (ctx) => {
        const loc = app.location(ctx.params.loc);
        if (!loc) throw notFound();
        verifyTwilio(app, ctx, telephonyConfig(app, loc.id).token);
        const p: Record<string, string> = {};
        for (const [k, v] of Object.entries(ctx.body ?? {})) if (typeof v === 'string') p[k] = v;
        return text(fn(loc, p, ctx.query), 'text/xml; charset=utf-8');
      });

    /** TwiML app voice URL: a browser places a call (or resumes one it put on hold). */
    route('phone-out', (loc, p) => {
      const c = config(loc.id);
      if (!c.s.enabled) return hangup('Das Browser-Telefon ist ausgeschaltet.');
      if (p.AccountSid && p.AccountSid !== c.tel.accountSid) return hangup('Falsches Twilio-Konto.');
      if (p.ApplicationSid && c.s.twiml_app_sid && p.ApplicationSid !== c.s.twiml_app_sid) return hangup('Falsche TwiML-App.');
      const who = parseIdentity(p.From ?? p.Caller);
      const user = who && who.locationId === loc.id ? db.get('SELECT * FROM users WHERE id = ?', who.userId) : undefined;
      if (!user || !mayTakeCalls(user, loc.id)) return hangup('Dieser Browser darf hier nicht telefonieren.');
      if (!p.CallSid) return hangup();

      if (p.resume) {
        const pc = phoneCall(loc.id, p.resume);
        const call = pc ? getCall(pc.call_id) : undefined;
        if (!pc || !call || call.ended_at || !pc.hold || pc.user_id !== user.id) return hangup('Dieser Anruf wird nicht mehr gehalten.');
        db.run('UPDATE phone_calls SET hold = 0, agent_sid = ?, updated_at = ? WHERE call_id = ?', p.CallSid, now(), pc.call_id);
        return resumeTwiml(holdRoom(pc.call_id), `${hook('phone-dial', loc.id)}?call=${pc.call_id}`);
      }

      const to = normalizePhone(String(p.To ?? ''));
      if (!E164.test(to)) return hangup('Diese Nummer ist ungültig.');
      const tel = c.tel;
      if (tel.numbers.includes(to)) return hangup('Das ist eine eigene Nummer.');
      let contactId: string | null = null;
      if (p.contactId) contactId = getContact(app, loc.id, p.contactId)?.id ?? null;
      if (!contactId) contactId = db.get('SELECT id FROM contacts WHERE location_id = ? AND phone = ?', loc.id, to)?.id ?? upsertContact(app, loc.id, { phone: to }, { source: 'Anruf' }).contact.id;
      // A call from the power dialer: its rules (Nicht stören, consent, calling hours) are checked on the server, not in the browser.
      let dialerItem: string | null = null;
      let listFrom = '';
      if (p.dialerItem) {
        const v: { ok: boolean; reason?: string; itemId?: string; from?: string } | undefined = app.services.dialer?.authorize(loc.id, p.dialerItem, user.id);
        if (!v?.ok) return hangup(v?.reason || 'Dieser Kontakt darf gerade nicht angerufen werden.');
        dialerItem = v.itemId ?? null;
        listFrom = v.from ?? '';
      }
      // Caller ID: a Twilio number or a verified own number (modules/caller-ids.ts) – the browser's choice, the dialer list's or the default.
      const want = String(p.callerId ?? '') || listFrom;
      const from: string = app.services.callerIds?.pick(loc.id, want) ?? tel.numbers[0];
      const t = now();
      const callId = id();
      db.insert('calls', { id: callId, location_id: loc.id, contact_id: contactId, sid: p.CallSid, direction: 'out', from_number: from, to_number: to, status: 'initiated', user_id: user.id, dialer_item_id: dialerItem, consent_announced: tel.s.record_outbound && tel.s.record_announce ? 1 : 0, started_at: t, updated_at: t });
      db.insert('phone_calls', { call_id: callId, location_id: loc.id, user_id: user.id, direction: 'out', agent_sid: p.CallSid, created_at: t, updated_at: t });
      syncMessage(app, getCall(callId)!);
      if (contactId) logActivity(app, loc.id, contactId, 'call.started', `Anruf aus dem Browser von ${user.name}${tel.s.record_outbound ? ' (mit Aufzeichnung)' : ''}`);
      return outgoingTwiml({
        callerId: from,
        number: to,
        action: `${hook('phone-dial', loc.id)}?call=${callId}`,
        legCallback: `${hook('phone-leg', loc.id)}?call=${callId}`,
        record: tel.s.record_outbound,
        recordingCallback: `${hook('voice-recording', loc.id)}?kind=dial`,
        announceUrl: tel.s.record_announce ? hook('voice-announce', loc.id) : undefined,
      });
    });

    /** Status of the dialled party's leg: answered → talking; ended → the call is over (also while on hold). */
    route('phone-leg', (loc, p, q) => {
      const pc = phoneCall(loc.id, q.get('call'));
      const call = pc ? getCall(pc.call_id) : undefined;
      if (!pc || !call || call.ended_at) return twiml('');
      const st = String(p.CallStatus ?? '');
      if (st === 'in-progress' || st === 'answered') {
        db.run('UPDATE phone_calls SET remote_sid = ?, updated_at = ? WHERE call_id = ?', p.CallSid ?? null, now(), pc.call_id);
        db.run(`UPDATE calls SET answered = 1, answered_at = COALESCE(answered_at, ?), status = 'in-progress', updated_at = ? WHERE id = ?`, now(), now(), call.id);
        syncMessage(app, getCall(call.id)!);
      } else if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(st)) {
        if (call.answered) finalizeCall(app, call, 'completed', { duration: secondsSince(call.answered_at) });
        else finalizeCall(app, call, st === 'completed' ? 'no-answer' : st, { reason: 'contact' });
      }
      return twiml('');
    });

    /** The browser's <Dial> ended: on hold the browser leg just leaves, otherwise the call is over. */
    route('phone-dial', (loc, p, q) => {
      const pc = phoneCall(loc.id, q.get('call'));
      const call = pc ? getCall(pc.call_id) : undefined;
      if (!pc || !call) return hangup();
      if (pc.hold) return hangup();
      if (call.ended_at) return hangup();
      const st = String(p.DialCallStatus ?? '');
      if (st === 'completed' || st === 'answered' || call.answered) {
        db.run('UPDATE calls SET answered = 1, answered_at = COALESCE(answered_at, ?) WHERE id = ?', now(), call.id);
        const c = getCall(call.id)!;
        finalizeCall(app, c, 'completed', { duration: secondsSince(c.answered_at) });
      } else finalizeCall(app, call, ['busy', 'no-answer', 'failed', 'canceled'].includes(st) ? st : 'no-answer', { reason: 'contact' });
      return hangup();
    });

    /** The held party's room ended (the browser hung up after resuming): end of the call. */
    route('phone-held', (loc, _p, q) => {
      const pc = phoneCall(loc.id, q.get('call'));
      const call = pc ? getCall(pc.call_id) : undefined;
      if (pc && call && !call.ended_at && !pc.hold) finalizeCall(app, call, 'completed', { duration: secondsSince(call.answered_at) });
      return hangup();
    });

    // --- in-call actions from the browser -------------------------------------------------------
    /** Calls are addressed by our id or by a Twilio CallSid the browser knows (its own leg). */
    const resolveCallId = (locId: string, key: string): string =>
      db.get('SELECT call_id FROM phone_calls WHERE location_id = ? AND (call_id = ? OR agent_sid = ? OR remote_sid = ?)', locId, key, key, key)?.call_id ??
      db.get('SELECT id FROM calls WHERE location_id = ? AND (id = ? OR sid = ?)', locId, key, key)?.id ??
      key;
    const myCall = (ctx: Ctx) => {
      const user = requireUser(ctx);
      const pc = phoneCall(ctx.locationId, resolveCallId(ctx.locationId, ctx.params.id));
      if (!pc) throw notFound('Anruf nicht gefunden');
      if (pc.user_id !== user.id && user.role !== 'admin') throw new HttpError(403, 'Das ist nicht dein Anruf');
      const call = getCall(pc.call_id)!;
      return { user, pc, call };
    };
    const callState = (locId: string, key: string) => {
      const callId = resolveCallId(locId, key);
      const pc = phoneCall(locId, callId);
      const call = getCall(callId);
      if (!call || call.location_id !== locId) throw notFound('Anruf nicht gefunden');
      const contact = call.contact_id ? getContact(app, locId, call.contact_id) : undefined;
      return {
        call_id: call.id,
        direction: call.direction,
        number: call.direction === 'in' ? call.from_number : call.to_number,
        contact_id: call.contact_id,
        contact_name: contact ? contactName(contact) : '',
        status: call.status,
        ended: !!call.ended_at,
        hold: !!pc?.hold,
        answered_at: call.answered_at,
        duration: call.duration,
      };
    };

    /** The browser took an inbound call: remember who and which legs (needed for hold). */
    router.post('/api/phone/accepted', 'location', (ctx) => {
      const user = requireUser(ctx);
      const call = db.get('SELECT * FROM calls WHERE id = ? AND location_id = ?', str(ctx.body?.call_id, 'Anruf', { required: true }), ctx.locationId);
      if (!call) throw notFound('Anruf nicht gefunden');
      if (call.direction !== 'in' || call.ended_at) throw bad('Dieser Anruf läuft nicht mehr');
      const agentSid = str(ctx.body?.agent_sid, 'Verbindung', { max: 64 });
      const t = now();
      db.run(
        `INSERT INTO phone_calls (call_id, location_id, user_id, direction, agent_sid, remote_sid, created_at, updated_at) VALUES (?, ?, ?, 'in', ?, ?, ?, ?)
         ON CONFLICT(call_id) DO UPDATE SET user_id = excluded.user_id, agent_sid = excluded.agent_sid, updated_at = excluded.updated_at`,
        call.id,
        ctx.locationId,
        user.id,
        agentSid || null,
        call.sid,
        t,
        t,
      );
      db.run('UPDATE calls SET user_id = ?, answered = 1, answered_at = COALESCE(answered_at, ?), updated_at = ? WHERE id = ?', user.id, t, t, call.id);
      syncMessage(app, getCall(call.id)!);
      if (call.contact_id) logActivity(app, ctx.locationId, call.contact_id, 'call.answered', `Anruf im Browser angenommen von ${user.name}`);
      return callState(ctx.locationId, call.id);
    });
    router.get('/api/phone/calls/:id', 'location', (ctx) => callState(ctx.locationId, ctx.params.id));

    /** Hold: the other party goes into a conference room with hold music, the browser leg ends. Resume = connect with {resume}. */
    router.post('/api/phone/calls/:id/hold', 'location', async (ctx) => {
      const { pc, call } = myCall(ctx);
      if (call.ended_at) throw bad('Der Anruf ist schon beendet');
      if (pc.hold) return callState(ctx.locationId, call.id);
      const c = config(ctx.locationId);
      let remote: string | null = pc.remote_sid;
      if (!remote && pc.direction === 'out' && pc.agent_sid) {
        const j = await twilioRequest(app, c.tel, 'GET', `/Calls.json?ParentCallSid=${encodeURIComponent(pc.agent_sid)}&Status=in-progress&PageSize=5`);
        remote = j.calls?.[0]?.sid ?? null;
      }
      if (!remote) throw bad('Die Gegenstelle ist (noch) nicht verbunden');
      const prevSid = call.sid;
      db.run('UPDATE phone_calls SET hold = 1, hold_at = ?, remote_sid = ?, updated_at = ? WHERE call_id = ?', now(), remote, now(), call.id);
      // From now on the call is tracked by the held party's leg (the browser leg ends).
      db.run('UPDATE calls SET answered = 1, answered_at = COALESCE(answered_at, ?), sid = ?, updated_at = ? WHERE id = ?', now(), remote, now(), call.id);
      try {
        await twilioRequest(app, c.tel, 'POST', `/Calls/${encodeURIComponent(remote)}.json`, [['Twiml', holdTwiml(holdRoom(call.id), `${hook('phone-held', ctx.locationId)}?call=${call.id}`)]]);
      } catch (e) {
        db.run('UPDATE phone_calls SET hold = 0, hold_at = NULL, updated_at = ? WHERE call_id = ?', now(), call.id);
        db.run('UPDATE calls SET sid = ? WHERE id = ?', prevSid, call.id);
        throw e;
      }
      if (call.contact_id) logActivity(app, ctx.locationId, call.contact_id, 'call.hold', 'Anruf gehalten');
      return callState(ctx.locationId, call.id);
    });
    /** Ends a held call (the browser leg is already gone). */
    router.post('/api/phone/calls/:id/hangup', 'location', async (ctx) => {
      const { pc, call } = myCall(ctx);
      if (!call.ended_at && pc.remote_sid) {
        const c = config(ctx.locationId);
        await twilioRequest(app, c.tel, 'POST', `/Calls/${encodeURIComponent(pc.remote_sid)}.json`, [['Status', 'completed']]).catch((e) => {
          if (!String((e as Error).message).includes('404')) throw e;
        });
        db.run('UPDATE phone_calls SET hold = 0, updated_at = ? WHERE call_id = ?', now(), call.id);
        finalizeCall(app, getCall(call.id)!, call.answered ? 'completed' : 'canceled', { duration: secondsSince(call.answered_at) });
      }
      return callState(ctx.locationId, call.id);
    });

    // Presence rows of browsers that went away are cleaned up now and then.
    let lastSweep = 0;
    app.onTick(() => {
      if (Date.now() - lastSweep < 3600_000) return;
      lastSweep = Date.now();
      db.run('DELETE FROM phone_presence WHERE seen_at < ?', new Date(Date.now() - 7 * 864e5).toISOString());
    });
  },
};
