import type { LocationRow, Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { id, normalizePhone, now } from '../core/util.js';
import { CALL_SID, holdRoom, resumeTwiml } from '../services/browser-phone.js';
import { contactName, getContact, logActivity } from '../services/contacts.js';
import { peopleOf } from '../services/team-people.js';
import { E164, RECORDING_SID, attrs, hangup, say, twiml, xml } from '../services/twilio.js';
import { finalizeCall, isOwnNumber, syncMessage, telephonyConfig, twilioRequest, type Config } from './telephony.js';

/**
 * What a person does during and after a call: notes written while talking, handing the call over and the retention period of
 * recordings and voicemails.
 *
 * Hand-over, cold: the other party is redirected to the colleague at once. With announcement ("warm"): the call is on hold, the
 * colleague is rung, hears who it is and presses 1, and then joins the waiting party in the hold room. A call is handed over by
 * the person who is on it (or an administrator).
 */

type CallRow = Record<string, any>;
interface TransferRow {
  id: string;
  location_id: string;
  call_id: string;
  user_id: string | null;
  mode: 'cold' | 'warm';
  target_type: 'user' | 'number';
  target_id: string;
  target_label: string;
  note: string;
  status: 'ringing' | 'accepted' | 'declined' | 'failed' | 'done';
  error: string;
  created_at: string;
  updated_at: string;
}
const secondsSince = (iso: string | null | undefined) => (iso ? Math.max(0, (Date.now() - Date.parse(iso)) / 1000) : 0);
/** A transfer that rings for longer than this counts as unanswered. */
const RING_MS = 60_000;

export const telephonyCallsModule: Module = {
  name: 'telephony-calls',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE call_notes (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE, contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,
        user_id TEXT, note_id TEXT, body TEXT NOT NULL, at_second INTEGER, created_at TEXT NOT NULL
      );
      CREATE INDEX call_notes_call ON call_notes(call_id, created_at);
      CREATE TABLE call_transfers (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE, user_id TEXT, mode TEXT NOT NULL,
        target_type TEXT NOT NULL, target_id TEXT NOT NULL, target_label TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'ringing', error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX call_transfers_call ON call_transfers(call_id, created_at);
      `,
    ],
    [
      // Recordings of an erased contact still to be deleted at Twilio (the call rows are gone, the queue remembers the ids).
      '002-recording-purges',
      `
      CREATE TABLE call_recording_purges (
        recording_sid TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE INDEX call_recording_purges_loc ON call_recording_purges(location_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const kit = () => app.services.telephonyKit;
    const hook = (name: string, loc: string) => `${app.baseUrl()}/hooks/twilio/${name}/${loc}`;

    const getCall = (callId: string): CallRow => db.get<CallRow>('SELECT * FROM calls WHERE id = ?', callId)!;
    const callOf = (locationId: string, key: string): CallRow | undefined => db.get<CallRow>('SELECT * FROM calls WHERE location_id = ? AND (id = ? OR sid = ?)', locationId, key, key);
    /** Notes and the hand-over belong to the person on the call; administrators may help. */
    const own = (ctx: Ctx, userId: string | null | undefined) => {
      if (userId && ctx.user && userId !== ctx.user.id && ctx.user.role !== 'admin') throw new HttpError(403, 'Das ist nicht dein Anruf');
    };

    // --- notes while talking ------------------------------------------------------------------------------------------------
    const noteOut = (n: any) => ({
      id: n.id,
      body: n.body,
      user_id: n.user_id,
      user_name: n.user_id ? (db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', n.user_id)?.name ?? '') : '',
      at_second: n.at_second,
      created_at: n.created_at,
    });
    router.get('/api/calls/:id/notes', 'location', (ctx) => {
      const call = callOf(ctx.locationId, ctx.params.id);
      if (!call) throw notFound('Anruf nicht gefunden');
      return db.all('SELECT * FROM call_notes WHERE call_id = ? AND location_id = ? ORDER BY created_at', call.id, ctx.locationId).map(noteOut);
    });
    /** A note during or after the call: it stays with the call and also appears in the contact's notes. */
    router.post('/api/calls/:id/notes', 'location', (ctx) => {
      const call = callOf(ctx.locationId, ctx.params.id);
      if (!call) throw notFound('Anruf nicht gefunden');
      const body = str(ctx.body?.body, 'Notiz', { required: true, max: 4000 });
      if (!body) throw bad('Notiz fehlt');
      const nid = id();
      const at = call.answered_at && !call.ended_at ? Math.round(secondsSince(call.answered_at)) : null;
      let contactNote: string | null = null;
      if (call.contact_id && getContact(app, ctx.locationId, call.contact_id)) {
        contactNote = id();
        const when = at !== null ? ` (nach ${Math.floor(at / 60)}:${String(at % 60).padStart(2, '0')})` : '';
        db.insert('notes', { id: contactNote, location_id: ctx.locationId, contact_id: call.contact_id, body: `Anrufnotiz${when}: ${body}`, user_id: ctx.user?.id ?? null, created_at: now() });
        logActivity(app, ctx.locationId, call.contact_id, 'call.note', `Notiz zum Anruf: ${body.slice(0, 140)}`, { callId: call.id });
      }
      db.insert('call_notes', { id: nid, location_id: ctx.locationId, call_id: call.id, contact_id: call.contact_id ?? null, user_id: ctx.user?.id ?? null, note_id: contactNote, body, at_second: at, created_at: now() });
      return noteOut(db.get('SELECT * FROM call_notes WHERE id = ?', nid));
    });
    router.delete('/api/calls/:id/notes/:noteId', 'location', (ctx) => {
      const n = db.get<any>(
        'SELECT * FROM call_notes WHERE id = ? AND location_id = ? AND call_id IN (SELECT id FROM calls WHERE location_id = ? AND (id = ? OR sid = ?))',
        ctx.params.noteId,
        ctx.locationId,
        ctx.locationId,
        ctx.params.id,
        ctx.params.id,
      );
      if (!n) throw notFound('Notiz nicht gefunden');
      if (n.user_id && ctx.user && n.user_id !== ctx.user.id && ctx.user.role !== 'admin') throw new HttpError(403, 'Das ist nicht deine Notiz');
      if (n.note_id) db.run('DELETE FROM notes WHERE id = ? AND location_id = ?', n.note_id, ctx.locationId);
      db.run('DELETE FROM call_notes WHERE id = ?', n.id);
      return { ok: true };
    });

    // --- hand-over ----------------------------------------------------------------------------------------------------------------
    const phoneCall = (locationId: string, callId: string) => db.get<any>('SELECT * FROM phone_calls WHERE call_id = ? AND location_id = ?', callId, locationId);
    const transferRow = (locationId: string, key: string) => db.get<TransferRow>('SELECT * FROM call_transfers WHERE id = ? AND location_id = ?', key, locationId);
    const transferOut = (t: TransferRow) => ({ id: t.id, call_id: t.call_id, mode: t.mode, target_type: t.target_type, target_label: t.target_label, note: t.note, status: t.status, error: t.error, created_at: t.created_at });
    const setStatus = (t: TransferRow, status: TransferRow['status'], error = '') => db.run('UPDATE call_transfers SET status = ?, error = ?, updated_at = ? WHERE id = ?', status, error, now(), t.id);

    /** The other party's leg: known from the browser phone, else the child of the call that rang the person's browser. */
    async function remoteLeg(cfg: Config, pc: any): Promise<string> {
      let remote: string | null = pc.remote_sid;
      if (!remote && pc.direction === 'out' && pc.agent_sid) {
        const j = await twilioRequest(app, cfg, 'GET', `/Calls.json?ParentCallSid=${encodeURIComponent(pc.agent_sid)}&Status=in-progress&PageSize=5`);
        remote = j.calls?.[0]?.sid ?? null;
      }
      if (!remote || !CALL_SID.test(remote)) throw bad('Die Gegenstelle ist (noch) nicht verbunden');
      return remote;
    }

    router.post('/api/phone/calls/:id/transfer', 'location', async (ctx) => {
      const call = callOf(ctx.locationId, ctx.params.id);
      const pc = call ? phoneCall(ctx.locationId, call.id) : undefined;
      if (!call || !pc) throw notFound('Anruf nicht gefunden');
      own(ctx, pc.user_id);
      if (call.ended_at) throw bad('Der Anruf ist schon beendet');
      const b = ctx.body ?? {};
      const mode = b.mode === 'warm' ? 'warm' : 'cold';
      const note = str(b.note, 'Notiz', { max: 300 });
      const to = b.to ?? {};
      const cfg = telephonyConfig(app, ctx.locationId);
      if (!cfg.accountSid || !cfg.token) throw bad('Telefonie ist nicht eingerichtet');
      if (mode === 'warm' && !pc.hold) throw bad('Für die Übergabe mit Ansage erst das Gespräch halten – die Person am Telefon wartet dann mit Musik');
      if (db.get(`SELECT 1 FROM call_transfers WHERE call_id = ? AND status = 'ringing' AND created_at > ?`, call.id, new Date(Date.now() - RING_MS).toISOString())) throw bad('Eine Übergabe läuft bereits');
      // Who gets the call: a colleague's browser (only while it is open and free) or any phone number.
      let numbers: string[] = [];
      let client: { identity: string; params?: Record<string, string> } | null = null;
      let label = '';
      let targetId = '';
      if (to.type === 'user') {
        const person = peopleOf(app, ctx.locationId, 'conversations').find((u) => u.id === String(to.id));
        if (!person) throw bad('Person nicht gefunden');
        if (person.id === pc.user_id) throw bad('Das bist du selbst');
        client = app.services.voiceUserClient?.(ctx.locationId, person.id, call) ?? null;
        if (!client) throw bad(`${person.name} ist nicht erreichbar (Browser-Telefon geschlossen oder abwesend)`);
        label = person.name;
        targetId = person.id;
      } else if (to.type === 'number') {
        const n = normalizePhone(String(to.id ?? ''));
        if (!E164.test(n)) throw bad('Keine gültige Nummer (Format +49…)');
        if (isOwnNumber(app, ctx.locationId, n)) throw bad('Das ist eine eigene Nummer');
        numbers = [n];
        label = n;
        targetId = n;
      } else throw bad('Ziel: Person oder Nummer');
      const remote = await remoteLeg(cfg, pc);
      const t: TransferRow = { id: id(), location_id: ctx.locationId, call_id: call.id, user_id: ctx.user?.id ?? null, mode, target_type: to.type, target_id: targetId, target_label: label, note, status: 'ringing', error: '', created_at: now(), updated_at: now() };
      const q = (step: string) => `${hook('phone-transfer', ctx.locationId)}?${new URLSearchParams({ t: t.id, step })}`;

      if (mode === 'cold') {
        // The other party is redirected to the colleague; the person's own leg ends with it. The call stays open (marked as held, so the
        // browser phone's own hang-up hook leaves it alone) until the colleague's conversation is over; nobody there → voicemail.
        const callerId = call.direction === 'out' ? cfg.numbers[0] : undefined;
        const clientXml = client
          ? `<Client><Identity>${xml(client.identity)}</Identity>${Object.entries({ ...(client.params ?? {}), transfer: t.id })
              .filter(([, v]) => v)
              .map(([k, v]) => `<Parameter${attrs({ name: k, value: v })}/>`)
              .join('')}</Client>`
          : '';
        const dial = `<Dial${attrs({ timeout: 25, action: q('result'), method: 'POST', callerId })}>${numbers.map((n) => `<Number>${xml(n)}</Number>`).join('')}${clientXml}</Dial>`;
        db.insert('call_transfers', t);
        db.run('UPDATE phone_calls SET hold = 1, hold_at = ?, remote_sid = ?, updated_at = ? WHERE call_id = ?', now(), remote, now(), call.id);
        try {
          await twilioRequest(app, cfg, 'POST', `/Calls/${encodeURIComponent(remote)}.json`, [['Twiml', twiml(dial)]]);
        } catch (e) {
          db.run('UPDATE phone_calls SET hold = ?, updated_at = ? WHERE call_id = ?', pc.hold ? 1 : 0, now(), call.id);
          setStatus(t, 'failed', (e as Error).message.slice(0, 300));
          throw e;
        }
      } else {
        const contact = call.contact_id ? getContact(app, ctx.locationId, call.contact_id) : undefined;
        const who = contact && (contact.first_name || contact.last_name) ? contactName(contact) : (call.direction === 'in' ? call.from_number : call.to_number) || 'einer unbekannten Nummer';
        const screening = twiml(
          `<Gather${attrs({ input: 'dtmf', numDigits: 1, timeout: 10, action: q('accept'), method: 'POST' })}>${say(`Übergabe eines Anrufs ${call.direction === 'in' ? 'von' : 'an'} ${who}.${note ? ` ${note}.` : ''} Drücken Sie die 1, um das Gespräch anzunehmen.`)}</Gather>${say('Es wurde keine Taste gedrückt. Auf Wiederhören.')}<Hangup/>`,
        );
        db.insert('call_transfers', t);
        try {
          await twilioRequest(app, cfg, 'POST', '/Calls.json', [
            ['To', client ? `client:${client.identity}` : numbers[0]],
            ['From', cfg.numbers[0]],
            ['Twiml', screening],
            ['Timeout', '25'],
            ['StatusCallback', q('status')],
            ['StatusCallbackMethod', 'POST'],
            ['StatusCallbackEvent', 'completed'],
          ]);
        } catch (e) {
          setStatus(t, 'failed', (e as Error).message.slice(0, 300));
          throw e;
        }
      }
      if (call.contact_id) logActivity(app, ctx.locationId, call.contact_id, 'call.transfer', `Anruf ${mode === 'cold' ? 'weitergeleitet' : 'mit Ansage übergeben'} an ${label}${note ? ` – ${note}` : ''}`);
      app.events.emit(ctx.locationId, 'call.transferred', { contactId: call.contact_id ?? undefined, callId: call.id, mode, to: label, by: ctx.user?.id ?? null });
      return transferOut(transferRow(ctx.locationId, t.id)!);
    });

    /** The latest hand-over of a call (the browser phone polls it while "Übergabe läuft"). */
    router.get('/api/phone/calls/:id/transfer', 'location', (ctx) => {
      const call = callOf(ctx.locationId, ctx.params.id);
      if (!call) throw notFound('Anruf nicht gefunden');
      const t = db.get<TransferRow>('SELECT * FROM call_transfers WHERE call_id = ? AND location_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', call.id, ctx.locationId);
      if (!t) return { id: null };
      // A ring that nobody answered within a minute is over (the colleague's phone stopped ringing).
      if (t.status === 'ringing' && Date.now() - Date.parse(t.created_at) > RING_MS) {
        setStatus(t, 'failed', 'Niemand hat abgenommen');
        t.status = 'failed';
        t.error = 'Niemand hat abgenommen';
      }
      return transferOut(t);
    });

    /** The colleague's browser took a handed-over call (cold, to a person): from now on it is theirs (hold, notes, hang-up). */
    router.post('/api/phone/transfers/accepted', 'location', (ctx) => {
      const call = callOf(ctx.locationId, str(ctx.body?.call_id, 'Anruf', { required: true, max: 64 }));
      if (!call || !ctx.user) throw notFound('Anruf nicht gefunden');
      const t = db.get<TransferRow>(
        `SELECT * FROM call_transfers WHERE call_id = ? AND location_id = ? AND target_type = 'user' AND target_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1`,
        call.id,
        ctx.locationId,
        ctx.user.id,
        new Date(Date.now() - 5 * 60_000).toISOString(),
      );
      if (!t || call.ended_at) throw bad('Dieser Anruf wurde dir nicht übergeben');
      const sid = str(ctx.body?.agent_sid, 'Verbindung', { max: 64 });
      db.run('UPDATE phone_calls SET user_id = ?, agent_sid = ?, hold = 0, updated_at = ? WHERE call_id = ?', ctx.user.id, sid || null, now(), call.id);
      db.run(`UPDATE calls SET user_id = ?, answered = 1, answered_at = COALESCE(answered_at, ?), status = 'in-progress', updated_at = ? WHERE id = ?`, ctx.user.id, now(), now(), call.id);
      setStatus(t, 'accepted');
      syncMessage(app, getCall(call.id));
      return { call_id: call.id, contact_id: call.contact_id, ok: true };
    });

    /** People a call can be handed to: colleagues with their browser phone on. */
    router.get('/api/phone/colleagues', 'location', (ctx) =>
      peopleOf(app, ctx.locationId, 'conversations')
        .filter((u) => u.id !== ctx.user?.id)
        .map((u) => ({ id: u.id, name: u.name, online: !!app.services.voiceUserClient?.(ctx.locationId, u.id) })),
    );

    // Twilio's side of the hand-over (signed).
    kit().hookRoute('phone-transfer', (loc: LocationRow, p: Record<string, string>, cfg: Config, q: URLSearchParams) => {
      const t = transferRow(loc.id, q.get('t') ?? '');
      const call = t ? db.get<CallRow>('SELECT * FROM calls WHERE id = ?', t.call_id) : undefined;
      if (!t || !call) return hangup();
      const step = q.get('step');

      if (step === 'accept') {
        // The colleague pressed 1 – but only while the caller still waits on hold.
        const pc = phoneCall(loc.id, call.id);
        if (t.status !== 'ringing' || p.Digits !== '1') {
          if (t.status === 'ringing') setStatus(t, 'declined');
          return hangup();
        }
        if (call.ended_at || !pc?.hold) {
          setStatus(t, 'failed', 'Der Anruf wird nicht mehr gehalten');
          return hangup('Der Anruf wird nicht mehr gehalten. Auf Wiederhören.');
        }
        setStatus(t, 'accepted');
        // The caller leaves "hold": the colleague owns the call, and when the room ends the call ends.
        db.run('UPDATE phone_calls SET hold = 0, user_id = ?, agent_sid = ?, updated_at = ? WHERE call_id = ?', t.target_type === 'user' ? t.target_id : pc.user_id, p.CallSid || pc.agent_sid, now(), call.id);
        if (t.target_type === 'user') db.run('UPDATE calls SET user_id = ?, updated_at = ? WHERE id = ?', t.target_id, now(), call.id);
        return resumeTwiml(holdRoom(call.id), `${hook('phone-held', loc.id)}?call=${call.id}`);
      }

      if (step === 'status') {
        const st = String(p.CallStatus ?? '');
        if (t.status === 'ringing') {
          if (['busy', 'no-answer', 'failed', 'canceled'].includes(st)) setStatus(t, 'failed', st === 'busy' ? 'Besetzt' : st === 'no-answer' ? 'Niemand hat abgenommen' : 'Anruf nicht möglich');
          else if (st === 'completed') setStatus(t, 'declined');
        } else if (t.status === 'accepted' && st === 'completed') setStatus(t, 'done');
        return twiml('');
      }

      // Cold hand-over, the colleague's <Dial> ended.
      db.run('UPDATE phone_calls SET hold = 0, updated_at = ? WHERE call_id = ?', now(), call.id);
      const st = String(p.DialCallStatus ?? '');
      if (st === 'completed' || st === 'answered') {
        setStatus(t, 'done');
        db.run('UPDATE calls SET answered = 1, answered_at = COALESCE(answered_at, ?), updated_at = ? WHERE id = ?', now(), now(), call.id);
        finalizeCall(app, getCall(call.id), 'completed', { duration: secondsSince(getCall(call.id).answered_at) });
        return hangup();
      }
      setStatus(t, 'failed', st === 'busy' ? 'Besetzt' : 'Niemand hat abgenommen');
      // An inbound caller gets the usual voicemail; whom we called ourselves just hears that nobody is there.
      if (call.direction === 'in') return kit().unanswered(loc, cfg, call);
      finalizeCall(app, call, call.answered ? 'completed' : 'no-answer', { duration: call.answered ? secondsSince(call.answered_at) : 0 });
      return hangup('Leider ist gerade niemand erreichbar. Auf Wiederhören.');
    });

    // --- recordings: retention ------------------------------------------------------------------------------------------------
    const gone = (e: unknown) => (e as HttpError)?.data?.twilio_code === 20404 || /not found|nicht gefunden|404/i.test(String((e as Error)?.message ?? ''));
    /**
     * Deletes recordings (at Twilio as well) and voicemails that are older than the sub-account's retention period; the transcript
     * that belongs to a deleted recording goes with it. Returns how many were deleted.
     */
    async function sweep(locationId: string, limit = 25): Promise<number> {
      const cfg = telephonyConfig(app, locationId);
      if (!cfg.accountSid || !cfg.token) return 0;
      let n = 0;
      for (const [days, voicemail] of [[Number(cfg.s.retention_recordings_days) || 0, false], [Number(cfg.s.retention_voicemail_days) || 0, true]] as const) {
        if (days < 1) continue;
        const rows = db.all<CallRow>(
          `SELECT * FROM calls WHERE location_id = ? AND recording_sid IS NOT NULL AND started_at < ? AND ${voicemail ? `status = 'voicemail'` : `status <> 'voicemail'`} ORDER BY started_at LIMIT ?`,
          locationId,
          new Date(Date.now() - days * 864e5).toISOString(),
          limit,
        );
        for (const c of rows) {
          if (RECORDING_SID.test(c.recording_sid)) {
            try {
              await twilioRequest(app, cfg, 'DELETE', `/Recordings/${c.recording_sid}.json`);
            } catch (e) {
              if (!gone(e)) continue; // an outage must not lose the record that it still exists: try again next hour
            }
          }
          db.run(`UPDATE calls SET recording_sid = NULL, recording_url = NULL, transcription = '', updated_at = ? WHERE id = ?`, now(), c.id);
          syncMessage(app, getCall(c.id));
          n++;
        }
      }
      return n;
    }

    // --- recordings: GDPR erasure ---------------------------------------------------------------------------------------------
    // Recordings and voicemails live at Twilio; the call rows (with the only copy of their ids) go with an erased contact. The ids
    // are queued in the erase transaction and deleted at Twilio right after it, and again every hour until Twilio confirms.
    app.services.privacyErase = [
      ...(app.services.privacyErase ?? []),
      (_a: unknown, loc: string, c: { id: string }) => {
        db.run(`INSERT OR IGNORE INTO call_recording_purges (recording_sid, location_id, created_at) SELECT recording_sid, location_id, ? FROM calls WHERE location_id = ? AND contact_id = ? AND recording_sid IS NOT NULL AND recording_sid != ''`, now(), loc, c.id);
      },
    ];
    /** Deletes the queued recordings of a sub-account at Twilio. Returns how many are gone. */
    async function purge(locationId: string): Promise<number> {
      const cfg = telephonyConfig(app, locationId);
      if (!cfg.accountSid || !cfg.token) return 0;
      let n = 0;
      for (const r of db.all<{ recording_sid: string }>('SELECT recording_sid FROM call_recording_purges WHERE location_id = ? ORDER BY created_at LIMIT 100', locationId)) {
        if (RECORDING_SID.test(r.recording_sid)) {
          try {
            await twilioRequest(app, cfg, 'DELETE', `/Recordings/${r.recording_sid}.json`);
          } catch (e) {
            if (!gone(e)) {
              db.run('UPDATE call_recording_purges SET attempts = attempts + 1, last_error = ? WHERE recording_sid = ?', String((e as Error).message).slice(0, 300), r.recording_sid);
              continue;
            }
          }
        }
        db.run('DELETE FROM call_recording_purges WHERE recording_sid = ?', r.recording_sid);
        n++;
      }
      return n;
    }
    app.events.on('contact.deleted', (e) => {
      if (e.data?.erased && db.get('SELECT 1 AS x FROM call_recording_purges WHERE location_id = ? LIMIT 1', e.locationId)) void purge(e.locationId).catch(() => 0);
    });

    app.services.telephonyRetention = { sweep, purge };
    let last = 0;
    app.onTick(async () => {
      if (Date.now() - last < 3600_000) return;
      last = Date.now();
      for (const { location_id } of db.all<{ location_id: string }>(`SELECT DISTINCT location_id FROM calls WHERE recording_sid IS NOT NULL`)) await sweep(location_id).catch(() => 0);
      for (const { location_id } of db.all<{ location_id: string }>('SELECT DISTINCT location_id FROM call_recording_purges')) await purge(location_id).catch(() => 0);
    });
  },
};
