import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str, text } from '../core/http.js';
import { id, normalizePhone, now } from '../core/util.js';
import { E164, twiml } from '../services/twilio.js';
import { telephonyConfig, twilioRequest, verifyTwilio } from './telephony.js';

/**
 * Your own existing number as caller ID: Twilio "Verified Caller IDs". Adding a number starts Twilio's verification call – Twilio
 * rings that number and the person types the six-digit code HyperLevel shows; Twilio reports the result to a signed status callback
 * (and "Prüfen" asks Twilio's list as a fallback). Verified numbers – and the sub-account's Twilio numbers – can be chosen as the
 * caller ID of the browser phone, the power dialer, click-to-call and the outbound AI calls: `app.services.callerIds.pick()` is the
 * one place that decides, everything else falls back to the first Twilio number. Docs: docs/telephony.md#your-own-number-as-caller-id.
 */

interface CallerId {
  id: string;
  location_id: string;
  number: string;
  friendly_name: string;
  status: 'pending' | 'verified' | 'failed';
  twilio_sid: string | null;
  call_sid: string | null;
  validation_code: string;
  error: string;
  created_at: string;
  verified_at: string | null;
}

export const callerIdsModule: Module = {
  name: 'caller-ids',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE caller_ids (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        number TEXT NOT NULL, friendly_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
        twilio_sid TEXT, call_sid TEXT, validation_code TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, verified_at TEXT, updated_at TEXT NOT NULL, UNIQUE(location_id, number)
      );
      CREATE TABLE caller_id_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE, default_number TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const hook = (loc: string, rowId: string) => `${app.baseUrl()}/hooks/twilio/caller-id-status/${loc}?id=${rowId}`;

    const verified = (loc: string) => db.all<{ number: string }>(`SELECT number FROM caller_ids WHERE location_id = ? AND status = 'verified' ORDER BY created_at`, loc).map((r) => r.number);
    /** The sub-account's Twilio numbers: configured ones and every active number bought or tracked here. */
    const twilioNumbers = (loc: string) => {
      const list = [...telephonyConfig(app, loc).numbers];
      try {
        for (const r of db.all<{ number: string }>(`SELECT number FROM phone_numbers WHERE location_id = ? AND status = 'active'`, loc)) if (!list.includes(r.number)) list.push(r.number);
      } catch {
        /* the numbers module is not loaded */
      }
      return list;
    };
    const allowed = (loc: string) => [...new Set([...twilioNumbers(loc), ...verified(loc)])];
    const defaultOf = (loc: string) => db.get<{ default_number: string }>('SELECT default_number FROM caller_id_settings WHERE location_id = ?', loc)?.default_number ?? '';
    /** The caller ID of a call: the one asked for (if allowed), else the sub-account's default, else the first Twilio number. */
    const pick = (loc: string, want?: string | null): string | undefined => {
      const ok = allowed(loc);
      const w = want ? normalizePhone(String(want)) : '';
      if (w && ok.includes(w)) return w;
      const d = defaultOf(loc);
      if (d && ok.includes(d)) return d;
      return telephonyConfig(app, loc).numbers[0];
    };
    app.services.callerIds = { allowed, pick, verified };

    const rowOf = (loc: string, key: string) => {
      const r = db.get<CallerId>('SELECT * FROM caller_ids WHERE id = ? AND location_id = ?', key, loc);
      if (!r) throw notFound('Nummer nicht gefunden');
      return r;
    };
    const rowOut = (r: CallerId) => ({ id: r.id, number: r.number, name: r.friendly_name, status: r.status, validation_code: r.status === 'pending' ? r.validation_code : '', error: r.error, created_at: r.created_at, verified_at: r.verified_at });
    const listOut = (loc: string) => {
      const cfg = telephonyConfig(app, loc);
      return {
        telephony_ready: !!(cfg.accountSid && cfg.token),
        twilio_numbers: twilioNumbers(loc),
        caller_ids: db.all<CallerId>('SELECT * FROM caller_ids WHERE location_id = ? ORDER BY created_at', loc).map(rowOut),
        default: pick(loc) ?? '',
        default_set: defaultOf(loc),
      };
    };
    const markVerified = (r: CallerId, sid: string | null) =>
      db.run(`UPDATE caller_ids SET status = 'verified', twilio_sid = COALESCE(?, twilio_sid), validation_code = '', error = '', verified_at = ?, updated_at = ? WHERE id = ?`, sid, now(), now(), r.id);
    /** Twilio's own list – the fallback when the status callback did not arrive. */
    const lookup = async (loc: string, number: string): Promise<string | null> => {
      const j = await twilioRequest(app, telephonyConfig(app, loc), 'GET', `/OutgoingCallerIds.json?PhoneNumber=${encodeURIComponent(number)}`);
      const hit = (Array.isArray(j.outgoing_caller_ids) ? j.outgoing_caller_ids : []).find((x: any) => x?.phone_number === number);
      return hit ? String(hit.sid ?? '') || null : null;
    };

    router.get('/api/caller-ids', 'location', (ctx) => listOut(ctx.locationId));

    /** Starts Twilio's verification call: the number rings and the person types the code shown here. */
    router.post('/api/caller-ids', 'location', async (ctx) => {
      const number = normalizePhone(str(ctx.body?.number, 'Nummer', { required: true, max: 30 }));
      if (!E164.test(number)) throw bad('Nummer im Format +49… angeben');
      if (twilioNumbers(ctx.locationId).includes(number)) throw bad('Das ist schon eine Twilio-Nummer dieses Sub-Accounts – sie ist ohne Bestätigung nutzbar');
      const name = str(ctx.body?.name, 'Bezeichnung', { max: 64 }) || number;
      const cfg = telephonyConfig(app, ctx.locationId);
      if (!cfg.accountSid || !cfg.token) throw bad('Twilio-Zugangsdaten fehlen (Einstellungen → Telefonie)');
      let r = db.get<CallerId>('SELECT * FROM caller_ids WHERE location_id = ? AND number = ?', ctx.locationId, number);
      if (r?.status === 'verified') throw bad('Diese Nummer ist schon bestätigt');
      if (!r) {
        if (db.get<{ n: number }>('SELECT COUNT(*) n FROM caller_ids WHERE location_id = ?', ctx.locationId)!.n >= 20) throw bad('Höchstens 20 eigene Nummern je Sub-Account');
        db.insert('caller_ids', { id: id(), location_id: ctx.locationId, number, friendly_name: name, status: 'pending', created_at: now(), updated_at: now() });
        r = db.get<CallerId>('SELECT * FROM caller_ids WHERE location_id = ? AND number = ?', ctx.locationId, number)!;
      }
      try {
        const j = await twilioRequest(app, cfg, 'POST', '/OutgoingCallerIds.json', [
          ['PhoneNumber', number],
          ['FriendlyName', name],
          ['StatusCallback', hook(ctx.locationId, r.id)],
          ['StatusCallbackMethod', 'POST'],
        ]);
        const code = String(j.validation_code ?? '').replace(/\D/g, '').slice(0, 10);
        db.run(`UPDATE caller_ids SET status = 'pending', friendly_name = ?, validation_code = ?, call_sid = ?, error = '', updated_at = ? WHERE id = ?`, name, code, String(j.call_sid ?? '') || null, now(), r.id);
      } catch (e) {
        // Verified in the Twilio console already: take it over.
        const sid = /already|verified/i.test((e as Error).message) ? await lookup(ctx.locationId, number).catch(() => null) : null;
        if (sid) markVerified(r, sid);
        else {
          db.run(`UPDATE caller_ids SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`, (e as Error).message.slice(0, 300), now(), r.id);
          throw e;
        }
      }
      return rowOut(rowOf(ctx.locationId, r.id));
    });

    router.post('/api/caller-ids/:id/check', 'location', async (ctx) => {
      const r = rowOf(ctx.locationId, ctx.params.id);
      if (r.status !== 'verified') {
        const sid = await lookup(ctx.locationId, r.number);
        if (sid) markVerified(r, sid);
      }
      return rowOut(rowOf(ctx.locationId, r.id));
    });

    router.put('/api/caller-ids/default', 'location', (ctx) => {
      const n = ctx.body?.number ? normalizePhone(String(ctx.body.number)) : '';
      if (n && !allowed(ctx.locationId).includes(n)) throw bad('Nur eine Twilio-Nummer oder eine bestätigte eigene Nummer');
      db.run('INSERT INTO caller_id_settings (location_id, default_number, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET default_number = excluded.default_number, updated_at = excluded.updated_at', ctx.locationId, n, now());
      return listOut(ctx.locationId);
    });

    router.delete('/api/caller-ids/:id', 'location', async (ctx) => {
      const r = rowOf(ctx.locationId, ctx.params.id);
      if (r.twilio_sid && /^PN[0-9a-fA-F]{32}$/.test(r.twilio_sid)) {
        try {
          await twilioRequest(app, telephonyConfig(app, ctx.locationId), 'DELETE', `/OutgoingCallerIds/${r.twilio_sid}.json`);
        } catch (e) {
          if (!/404|not found/i.test((e as Error).message)) throw e instanceof HttpError ? e : new HttpError(502, (e as Error).message);
        }
      }
      db.run('DELETE FROM caller_ids WHERE id = ?', r.id);
      if (defaultOf(ctx.locationId) === r.number) db.run(`UPDATE caller_id_settings SET default_number = '' WHERE location_id = ?`, ctx.locationId);
      return { ok: true };
    });

    /** Twilio's result of the verification call (signed like every Twilio webhook). */
    router.post('/hooks/twilio/caller-id-status/:loc', 'public', (ctx) => {
      const loc = app.location(ctx.params.loc);
      if (!loc) throw notFound();
      verifyTwilio(app, ctx, telephonyConfig(app, loc.id).token);
      const r = db.get<CallerId>('SELECT * FROM caller_ids WHERE id = ? AND location_id = ?', ctx.query.get('id') ?? '', loc.id);
      const p = (ctx.body ?? {}) as Record<string, string>;
      if (r && r.status !== 'verified') {
        if (String(p.VerificationStatus) === 'success') markVerified(r, /^PN[0-9a-fA-F]{32}$/.test(String(p.OutgoingCallerIdSid ?? '')) ? String(p.OutgoingCallerIdSid) : null);
        else db.run(`UPDATE caller_ids SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`, 'Bestätigung fehlgeschlagen – Code nicht oder falsch eingegeben', now(), r.id);
      }
      return text(twiml(''), 'text/xml; charset=utf-8');
    });
  },
};
