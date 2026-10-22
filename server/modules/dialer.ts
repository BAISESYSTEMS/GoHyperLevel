import { smartListById, type ListReader } from '../services/smart-lists.js';
import type { Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, notFound, num, str, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { CALL_SID } from '../services/browser-phone.js';
import { gateDecision } from '../services/consent-model.js';
import { addTags, contactName, findContacts, getContact, logActivity } from '../services/contacts.js';
import {
  applyDisposition,
  callingWindow,
  cleanDialerSettings,
  dialVerdict,
  pickNext,
  withDialerDefaults,
  type DialerSettings,
  type Disposition,
  type QueueItem,
  type Verdict,
} from '../services/dialer.js';
import { STATES } from '../services/ivr.js';
import { twiml, xml } from '../services/twilio.js';
import { registerTriggers, type TriggerMeta } from '../services/wfx-kit.js';
import { telephonyConfig, twilioRequest } from './telephony.js';
import { audioOf, audioUrl } from './telephony-audio.js';

/**
 * Power dialer: work through a call list contact after contact. A list comes from a smart list, from tags or from picked
 * contacts; the dialer offers the next entry when the last one is done (auto-advance), places nothing by itself – the call
 * runs through the browser phone or click-to-call, so the person talking is always a person. Every entry ends with an
 * outcome code (interested, callback, not reached, wrong number, "nicht mehr anrufen" …) with a note; callbacks become tasks
 * and are offered first when due; a pre-recorded message can be left on a voicemail with one click. The rules are enforced
 * here, on the server, at the moment of every call: "Nicht stören", the consent ledger, calling hours and days (also public
 * holidays) and the number of attempts – the browser cannot talk its way around them.
 */

interface ListRow {
  id: string;
  location_id: string;
  name: string;
  source: 'smart_list' | 'tags' | 'manual';
  smart_list_id: string | null;
  tags: string[];
  contact_ids: string[];
  status: 'active' | 'paused' | 'archived';
  from_number: string;
  drop_id: string | null;
  notes: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}
interface ItemRow extends QueueItem {
  location_id: string;
  list_id: string;
  contact_id: string;
  attempts: number;
  last_call_id: string | null;
  last_attempt_at: string | null;
  disposition: string;
  note: string;
  blocked_reason: string;
  task_id: string | null;
}

const MAX_ITEMS = 5000;
const LOCK_MS = 10 * 60_000;

const TRIGGERS: TriggerMeta[] = [
  {
    type: 'dialer.disposition',
    label: 'Power-Dialer: Anruf abgeschlossen',
    category: 'messages',
    summary: 'Ein Anruf aus einer Anrufliste wurde mit einem Ergebnis abgeschlossen (interessiert, Rückruf, nicht erreicht, nicht mehr anrufen …).',
    doc: 'Startet nach jedem abgeschlossenen Anruf im Power-Dialer. {{event.disposition}} ist der Schlüssel des Ergebnisses, {{event.label}} sein Name, {{event.positive}} ob es ein gutes Gespräch war, {{event.note}} die Notiz. Typisch: bei „Termin vereinbart“ eine Bestätigungs-SMS, bei „Interessiert“ eine Aufgabe oder Opportunity, bei „Falsche Nummer“ ein Tag.',
    fields: [{ key: 'disposition', label: 'Ergebnis (Schlüssel)', type: 'text', placeholder: 'z. B. booked – leer = jedes' }],
    sample: { disposition: 'booked', label: 'Termin vereinbart', positive: true, note: 'Termin am Donnerstag', listId: 'l1' },
    keywords: 'anruf power dialer ergebnis disposition rückruf vertrieb telefon',
  },
];

export const dialerModule: Module = {
  name: 'dialer',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE dialer_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );
      CREATE TABLE dialer_lists (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual', smart_list_id TEXT, tags TEXT NOT NULL DEFAULT '[]',
        contact_ids TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active', from_number TEXT NOT NULL DEFAULT '',
        drop_id TEXT, notes TEXT NOT NULL DEFAULT '', created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX dialer_lists_loc ON dialer_lists(location_id, status);
      CREATE TABLE dialer_items (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        list_id TEXT NOT NULL REFERENCES dialer_lists(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_call_id TEXT, last_attempt_at TEXT,
        next_at TEXT, disposition TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', callback_user TEXT,
        locked_by TEXT, locked_until TEXT, blocked_reason TEXT NOT NULL DEFAULT '', task_id TEXT, position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(list_id, contact_id)
      );
      CREATE INDEX dialer_items_list ON dialer_items(list_id, status, position);
      CREATE INDEX dialer_items_contact ON dialer_items(contact_id);
      CREATE INDEX dialer_items_due ON dialer_items(location_id, status, next_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    registerTriggers(app, TRIGGERS);
    app.services.workflowTriggerFilters = {
      ...(app.services.workflowTriggerFilters ?? {}),
      'dialer.disposition': (c: any, d: any) => !c.disposition || c.disposition === d.disposition,
    };

    // --- settings ---------------------------------------------------------------------------------------------------
    const settingsOf = (locationId: string): DialerSettings => withDialerDefaults(parseJson(db.get<any>('SELECT data FROM dialer_settings WHERE location_id = ?', locationId), ['data'])?.data);
    const tzOf = (locationId: string) => app.location(locationId)?.timezone || 'Europe/Berlin';
    router.get('/api/dialer/settings', 'location', (ctx) => ({ settings: settingsOf(ctx.locationId), window: callingWindow(settingsOf(ctx.locationId), tzOf(ctx.locationId)), states: STATES.map(([code, name]) => ({ code, name })), consent_module: !!app.services.consent?.status, timezone: tzOf(ctx.locationId) }));
    router.put('/api/dialer/settings', 'location', (ctx) => {
      const next = cleanDialerSettings(ctx.body ?? {}, settingsOf(ctx.locationId));
      db.run('INSERT INTO dialer_settings (location_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', ctx.locationId, JSON.stringify(next), now());
      return { settings: next, window: callingWindow(next, tzOf(ctx.locationId)) };
    });

    // --- the rules ------------------------------------------------------------------------------------------------------
    /** Whether `contactId` may be called now: the compliance gate of the sub-account (nothing is written). */
    const verdictFor = (locationId: string, contactId: string, item: { attempts: number; next_at: string | null }, s: DialerSettings, at = new Date()): Verdict => {
      const c = getContact(app, locationId, contactId);
      if (!c) return { ok: false, code: 'no_phone', reason: 'Kontakt nicht gefunden' };
      let consent: { allow: boolean; reason: string; confirmed: boolean } | null = null;
      const svc = app.services.consent;
      if (svc?.status && svc.settings) {
        const state = svc.status(locationId, c.id).phone;
        const r = gateDecision(state, svc.settings(locationId).policy);
        consent = { allow: r.allow, reason: r.reason, confirmed: state.status === 'confirmed' };
      }
      return dialVerdict({
        phone: c.phone,
        dnd: !!c.dnd,
        channelDnd: app.services.channelDnd?.(locationId, c.id, 'phone') ?? '',
        consent,
        consentPolicy: s.consent_policy,
        attempts: item.attempts,
        maxAttempts: s.max_attempts,
        notBefore: item.next_at ?? '',
        window: callingWindow(s, tzOf(locationId), at),
        at,
      });
    };

    // --- lists ----------------------------------------------------------------------------------------------------------
    const listRow = (locationId: string, key: string): ListRow | undefined => parseJson(db.get<any>('SELECT * FROM dialer_lists WHERE id = ? AND location_id = ?', key, locationId), ['tags', 'contact_ids']);
    const itemRow = (locationId: string, key: string): ItemRow | undefined => db.get<ItemRow>('SELECT * FROM dialer_items WHERE id = ? AND location_id = ?', key, locationId);

    const counts = (listId: string) => {
      const rows = db.all<{ status: string; n: number }>('SELECT status, COUNT(*) n FROM dialer_items WHERE list_id = ? GROUP BY status', listId);
      const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
      const total = rows.reduce((n, r) => n + r.n, 0);
      return { total, pending: by.pending ?? 0, callback: by.callback ?? 0, done: by.done ?? 0, blocked: by.blocked ?? 0 };
    };
    const listOut = (l: ListRow, who: ListReader) => ({
      id: l.id,
      name: l.name,
      source: l.source,
      smart_list_id: l.smart_list_id,
      smart_list_name: l.smart_list_id ? (smartListById(app, l.location_id, l.smart_list_id, who)?.name ?? '(gelöscht)') : null,
      tags: l.tags,
      status: l.status,
      from_number: l.from_number,
      drop_id: l.drop_id,
      notes: l.notes,
      counts: counts(l.id),
      created_at: l.created_at,
      updated_at: l.updated_at,
    });

    /** The contacts a list's source gives right now (only those with a phone number count). */
    const resolve = (l: ListRow, who: ListReader): { ids: string[]; no_phone: number } => {
      let contacts: { id: string; phone: string }[] = [];
      if (l.source === 'smart_list' && l.smart_list_id) {
        // A deleted list – or another person's private one – selects nobody (never everybody).
        const sl = smartListById(app, l.location_id, l.smart_list_id, who);
        if (!sl) throw notFound('Smart List nicht gefunden');
        const f = sl.filter;
        contacts = findContacts(app, l.location_id, { tags: f.tags ?? [], anyTags: f.anyTags ?? [], excludeTags: f.excludeTags ?? [], q: f.q ?? '', limit: MAX_ITEMS, extra: f }).contacts;
      } else if (l.source === 'tags' && l.tags.length) {
        contacts = findContacts(app, l.location_id, { tags: l.tags, limit: MAX_ITEMS }).contacts;
      } else if (l.source === 'manual') {
        contacts = l.contact_ids.map((cid) => getContact(app, l.location_id, cid)).filter(Boolean) as { id: string; phone: string }[];
      }
      const withPhone = contacts.filter((c) => c.phone);
      return { ids: withPhone.map((c) => c.id), no_phone: contacts.length - withPhone.length };
    };

    /** Adds contacts that are new to the list, re-checks the blocked ones. */
    const sync = (l: ListRow, who: ListReader) => {
      const { ids, no_phone } = resolve(l, who);
      const have = new Set(db.all<{ contact_id: string }>('SELECT contact_id FROM dialer_items WHERE list_id = ?', l.id).map((r) => r.contact_id));
      let pos = db.get<{ p: number }>('SELECT COALESCE(MAX(position), 0) p FROM dialer_items WHERE list_id = ?', l.id)!.p;
      let added = 0;
      const room = MAX_ITEMS - have.size;
      db.tx(() => {
        for (const cid of ids) {
          if (have.has(cid) || added >= room) continue;
          db.insert('dialer_items', { id: id(), location_id: l.location_id, list_id: l.id, contact_id: cid, position: ++pos, created_at: now(), updated_at: now() });
          added++;
        }
      });
      // Somebody who was blocked (no consent yet, "Nicht stören") may be callable now.
      const s = settingsOf(l.location_id);
      let released = 0;
      for (const b of db.all<ItemRow>(`SELECT * FROM dialer_items WHERE list_id = ? AND status = 'blocked'`, l.id)) {
        const v = verdictFor(l.location_id, b.contact_id, { attempts: b.attempts, next_at: null }, { ...s, days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '00:00', to: '23:59', skip_holidays: false });
        if (v.ok) {
          db.run(`UPDATE dialer_items SET status = 'pending', blocked_reason = '', updated_at = ? WHERE id = ?`, now(), b.id);
          released++;
        }
      }
      db.run('UPDATE dialer_lists SET updated_at = ? WHERE id = ?', now(), l.id);
      return { added, no_phone, released, total: counts(l.id).total };
    };

    const cleanList = (b: any, cur?: ListRow) => {
      const out: Record<string, unknown> = {};
      if (b.name !== undefined || !cur) out.name = str(b.name ?? cur?.name, 'Name', { required: true, max: 100 });
      if (b.status !== undefined) {
        if (!['active', 'paused', 'archived'].includes(b.status)) throw bad('Status: aktiv, pausiert oder archiviert');
        out.status = b.status;
      }
      if (b.notes !== undefined) out.notes = str(b.notes, 'Notiz', { max: 2000 });
      if (b.from_number !== undefined) out.from_number = str(b.from_number, 'Absender', { max: 30 });
      return out;
    };

    router.get('/api/dialer/lists', 'location', (ctx) => db.all<any>(`SELECT * FROM dialer_lists WHERE location_id = ? AND status <> 'archived' ORDER BY created_at DESC`, ctx.locationId).map((r) => listOut(parseJson(r, ['tags', 'contact_ids']), ctx)));
    router.post('/api/dialer/lists', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const source = b.source;
      if (!['smart_list', 'tags', 'manual'].includes(source)) throw bad('Quelle: Smart List, Tags oder ausgewählte Kontakte');
      const row: Record<string, unknown> = { id: id(), location_id: ctx.locationId, source, tags: [], contact_ids: [], created_by: ctx.user?.id ?? null, created_at: now(), updated_at: now(), ...cleanList(b) };
      if (source === 'smart_list') {
        const sid = str(b.smart_list_id, 'Smart List', { required: true, max: 64 });
        if (!smartListById(app, ctx.locationId, sid, ctx)) throw bad('Smart List nicht gefunden');
        row.smart_list_id = sid;
      } else if (source === 'tags') {
        const tags = (Array.isArray(b.tags) ? b.tags : []).map((t: unknown) => String(t).trim()).filter(Boolean).slice(0, 10);
        if (!tags.length) throw bad('Bitte mindestens einen Tag wählen');
        row.tags = tags;
      } else {
        const ids = [...new Set((Array.isArray(b.contact_ids) ? b.contact_ids : []).map(String))].slice(0, 2000) as string[];
        const ok = ids.filter((cid) => getContact(app, ctx.locationId, cid));
        if (!ok.length) throw bad('Bitte mindestens einen Kontakt wählen');
        row.contact_ids = ok;
      }
      if (b.drop_id) {
        if (!audioOf(app, ctx.locationId, String(b.drop_id))) throw bad('Voicemail-Nachricht nicht gefunden');
        row.drop_id = String(b.drop_id);
      }
      db.insert('dialer_lists', row);
      const l = listRow(ctx.locationId, row.id as string)!;
      const synced = sync(l, ctx);
      return { ...listOut(l, ctx), sync: synced };
    });
    router.get('/api/dialer/lists/:id', 'location', (ctx) => {
      const l = listRow(ctx.locationId, ctx.params.id);
      if (!l) throw notFound('Anrufliste nicht gefunden');
      const by = db.all<{ disposition: string; n: number }>(`SELECT disposition, COUNT(*) n FROM dialer_items WHERE list_id = ? AND disposition <> '' GROUP BY disposition`, l.id);
      const s = settingsOf(ctx.locationId);
      return { ...listOut(l, ctx), dispositions: by.map((r) => ({ key: r.disposition, label: s.dispositions.find((d) => d.key === r.disposition)?.label ?? r.disposition, n: r.n })), window: callingWindow(s, tzOf(ctx.locationId)) };
    });
    router.patch('/api/dialer/lists/:id', 'location', (ctx) => {
      const l = listRow(ctx.locationId, ctx.params.id);
      if (!l) throw notFound('Anrufliste nicht gefunden');
      const patch = cleanList(ctx.body ?? {}, l);
      if (ctx.body?.drop_id !== undefined) {
        if (ctx.body.drop_id && !audioOf(app, ctx.locationId, String(ctx.body.drop_id))) throw bad('Voicemail-Nachricht nicht gefunden');
        patch.drop_id = ctx.body.drop_id || null;
      }
      db.update('dialer_lists', l.id, { ...patch, updated_at: now() }, ctx.locationId);
      return listOut(listRow(ctx.locationId, l.id)!, ctx);
    });
    router.delete('/api/dialer/lists/:id', 'location', (ctx) => {
      const l = listRow(ctx.locationId, ctx.params.id);
      if (!l) throw notFound('Anrufliste nicht gefunden');
      // Open callback tasks of this list go with it.
      for (const t of db.all<{ task_id: string }>('SELECT task_id FROM dialer_items WHERE list_id = ? AND task_id IS NOT NULL AND status = ?', l.id, 'callback')) db.run('DELETE FROM tasks WHERE id = ? AND location_id = ? AND done = 0', t.task_id, ctx.locationId);
      db.run('DELETE FROM dialer_lists WHERE id = ?', l.id);
      return { ok: true };
    });
    router.post('/api/dialer/lists/:id/sync', 'location', (ctx) => {
      const l = listRow(ctx.locationId, ctx.params.id);
      if (!l) throw notFound('Anrufliste nicht gefunden');
      return sync(l, ctx);
    });
    router.get('/api/dialer/lists/:id/items', 'location', (ctx) => {
      const l = listRow(ctx.locationId, ctx.params.id);
      if (!l) throw notFound('Anrufliste nicht gefunden');
      const st = ctx.query.get('status');
      const rows = db.all<any>(
        `SELECT i.*, k.first_name, k.last_name, k.phone, k.company FROM dialer_items i JOIN contacts k ON k.id = i.contact_id WHERE i.list_id = ? ${st ? 'AND i.status = ?' : ''} ORDER BY i.position LIMIT ?`,
        l.id,
        ...(st ? [st] : []),
        Math.min(Math.max(1, num(ctx.query.get('limit'), 200)), 500),
      );
      const s = settingsOf(ctx.locationId);
      return rows.map((r) => ({ id: r.id, contact_id: r.contact_id, name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.phone, company: r.company, phone: r.phone, status: r.status, attempts: r.attempts, next_at: r.next_at, disposition: r.disposition, disposition_label: s.dispositions.find((d) => d.key === r.disposition)?.label ?? '', note: r.note, blocked_reason: r.blocked_reason, last_attempt_at: r.last_attempt_at }));
    });

    // --- working a list ---------------------------------------------------------------------------------------------------
    const me = (ctx: Ctx) => ctx.user?.id ?? 'api';
    const itemOut = (i: ItemRow, s: DialerSettings) => {
      const c = getContact(app, i.location_id, i.contact_id)!;
      const notes = db.all<{ body: string; created_at: string }>('SELECT body, created_at FROM notes WHERE contact_id = ? AND location_id = ? ORDER BY created_at DESC LIMIT 3', c.id, i.location_id);
      const calls = db.all<{ id: string; direction: string; status: string; duration: number; started_at: string; disposition: string }>('SELECT id, direction, status, duration, started_at, disposition FROM calls WHERE contact_id = ? AND location_id = ? ORDER BY started_at DESC LIMIT 5', c.id, i.location_id);
      return {
        id: i.id,
        list_id: i.list_id,
        status: i.status,
        attempts: i.attempts,
        max_attempts: s.max_attempts,
        next_at: i.next_at,
        note: i.note,
        contact: { id: c.id, name: contactName(c), first_name: c.first_name, company: c.company, phone: c.phone, email: c.email, tags: c.tags, city: c.city },
        notes,
        calls,
      };
    };

    /**
     * The next entry for this person (callbacks due first). Entries that must not be called are marked – "Nicht stören" and missing
     * consent block them until a sync finds them callable, used-up ones are done – and the next candidate is tried.
     */
    router.post('/api/dialer/lists/:id/next', 'location', (ctx) => {
      const l = listRow(ctx.locationId, ctx.params.id);
      if (!l) throw notFound('Anrufliste nicht gefunden');
      if (l.status !== 'active') return { item: null, done: false, paused: true, reason: 'Die Liste ist pausiert.', counts: counts(l.id) };
      const s = settingsOf(ctx.locationId);
      const w = callingWindow(s, tzOf(ctx.locationId));
      if (!w.open) return { item: null, done: false, waiting: true, reason: `Außerhalb der Anrufzeiten: ${w.reason}.`, next_window: w.next, counts: counts(l.id) };
      // Record access (modules/record-access.ts): a person who sees only part of the contacts is handed only those.
      const visible = app.services.recordAccess?.contactFilter?.(ctx) as ((contactId: string) => boolean) | undefined;
      for (let n = 0; n < 60; n++) {
        const items = db.all<ItemRow>(`SELECT * FROM dialer_items WHERE list_id = ? AND status IN ('pending', 'callback') ORDER BY position LIMIT 2000`, l.id).filter((i) => !visible || visible(i.contact_id));
        const pick = pickNext(items, me(ctx));
        if (!pick) {
          const later = items.find((i) => i.next_at && i.next_at > now());
          return { item: null, done: !later, waiting: !!later, reason: later ? 'Die übrigen Kontakte sind erst später dran (Rückruf oder Pause nach einem Versuch).' : 'Alle Kontakte sind abgearbeitet.', next_window: later?.next_at ?? null, counts: counts(l.id) };
        }
        const item = items.find((i) => i.id === pick.id)!;
        const v = verdictFor(ctx.locationId, item.contact_id, item, s);
        if (!v.ok) {
          if (v.code === 'attempts') db.run(`UPDATE dialer_items SET status = 'done', blocked_reason = ?, updated_at = ? WHERE id = ?`, v.reason, now(), item.id);
          else if (v.code === 'hours') return { item: null, done: false, waiting: true, reason: v.reason, counts: counts(l.id) };
          else db.run(`UPDATE dialer_items SET status = 'blocked', blocked_reason = ?, locked_by = NULL, locked_until = NULL, updated_at = ? WHERE id = ?`, v.reason, now(), item.id);
          continue;
        }
        db.run('UPDATE dialer_items SET locked_by = ?, locked_until = ?, updated_at = ? WHERE id = ?', me(ctx), new Date(Date.now() + LOCK_MS).toISOString(), now(), item.id);
        return { item: itemOut(itemRow(ctx.locationId, item.id)!, s), counts: counts(l.id), wrap_seconds: s.wrap_seconds };
      }
      return { item: null, done: false, reason: 'Es ließ sich gerade kein anrufbarer Kontakt finden.', counts: counts(l.id) };
    });

    /** The server's yes or no before a call is placed from the dialer (the browser phone and click-to-call ask it again). */
    const authorize = (locationId: string, itemId: string, userId: string | null): { ok: boolean; reason?: string; itemId?: string; from?: string } => {
      const item = itemRow(locationId, itemId);
      if (!item) return { ok: false, reason: 'Eintrag der Anrufliste nicht gefunden' };
      const l = listRow(locationId, item.list_id);
      if (!l || l.status !== 'active') return { ok: false, reason: 'Die Anrufliste ist nicht aktiv' };
      if (item.status === 'done') return { ok: false, reason: 'Dieser Kontakt ist in der Liste schon abgeschlossen' };
      if (item.locked_by && userId && item.locked_by !== userId && item.locked_until && item.locked_until > now()) return { ok: false, reason: 'Dieser Kontakt wird gerade von jemand anderem angerufen' };
      const v = verdictFor(locationId, item.contact_id, { attempts: item.attempts, next_at: null }, settingsOf(locationId));
      // `from`: the list's caller ID (a Twilio number or a verified own number – checked again by modules/caller-ids.ts).
      return v.ok ? { ok: true, itemId: item.id, from: l.from_number || undefined } : { ok: false, reason: v.reason };
    };
    app.services.dialer = { authorize, verdict: verdictFor, settings: settingsOf };

    router.post('/api/dialer/items/:id/dial', 'location', (ctx) => {
      const item = itemRow(ctx.locationId, ctx.params.id);
      if (!item) throw notFound('Eintrag nicht gefunden');
      const a = authorize(ctx.locationId, item.id, me(ctx));
      if (!a.ok) throw bad(a.reason ?? 'Nicht erlaubt');
      const c = getContact(app, ctx.locationId, item.contact_id)!;
      const l = listRow(ctx.locationId, item.list_id)!;
      db.run('UPDATE dialer_items SET locked_by = ?, locked_until = ?, updated_at = ? WHERE id = ?', me(ctx), new Date(Date.now() + LOCK_MS).toISOString(), now(), item.id);
      return { ok: true, item_id: item.id, contact_id: c.id, name: contactName(c), number: c.phone, from_number: l.from_number || null, drop_id: l.drop_id };
    });

    router.post('/api/dialer/items/:id/skip', 'location', (ctx) => {
      const item = itemRow(ctx.locationId, ctx.params.id);
      if (!item) throw notFound('Eintrag nicht gefunden');
      const last = db.get<{ p: number }>('SELECT MAX(position) p FROM dialer_items WHERE list_id = ?', item.list_id)!.p;
      db.run('UPDATE dialer_items SET locked_by = NULL, locked_until = NULL, position = ?, updated_at = ? WHERE id = ?', last + 1, now(), item.id);
      return { ok: true };
    });

    /** The outcome of a call: what happens to the entry, the contact and (for a callback) the calendar of the person. */
    const finish = (locationId: string, userId: string | null, item: ItemRow, d: Disposition, o: { note: string; callbackAt?: string; callbackUser?: string | null; callId?: string | null }): ItemRow => {
      const s = settingsOf(locationId);
      const r = applyDisposition(d, { attempts: item.attempts, maxAttempts: s.max_attempts, retryMinutes: s.retry_minutes, callbackAt: o.callbackAt });
      const contact = getContact(app, locationId, item.contact_id)!;
      const callId = o.callId ?? db.get<{ id: string }>('SELECT id FROM calls WHERE dialer_item_id = ? ORDER BY started_at DESC LIMIT 1', item.id)?.id ?? null;
      let taskId = item.task_id;
      db.tx(() => {
        // A callback becomes a task for the person (and an earlier open one of this entry is replaced).
        if (taskId) db.run('DELETE FROM tasks WHERE id = ? AND location_id = ? AND done = 0', taskId, locationId);
        taskId = null;
        if (d.kind === 'callback') {
          taskId = id();
          db.insert('tasks', {
            id: taskId,
            location_id: locationId,
            contact_id: contact.id,
            title: `Rückruf: ${contactName(contact)} (${contact.phone})`.slice(0, 200),
            description: `Vereinbart im Power-Dialer.${o.note ? `\n${o.note}` : ''}`.slice(0, 4000),
            due_at: r.next_at,
            assigned_to: o.callbackUser ?? userId ?? null,
            done: 0,
            created_at: now(),
          });
        }
        db.run(
          `UPDATE dialer_items SET status = ?, attempts = ?, next_at = ?, disposition = ?, note = ?, last_attempt_at = ?, last_call_id = ?, callback_user = ?, locked_by = NULL, locked_until = NULL, task_id = ?, blocked_reason = ?, updated_at = ? WHERE id = ?`,
          r.status,
          r.attempts,
          r.next_at,
          d.key,
          o.note,
          now(),
          callId,
          d.kind === 'callback' ? (o.callbackUser ?? userId ?? null) : null,
          taskId,
          r.exhausted ? `Nach ${r.attempts} Versuchen nicht erreicht` : '',
          now(),
          item.id,
        );
        if (callId) db.run('UPDATE calls SET disposition = ?, updated_at = ? WHERE id = ? AND location_id = ?', d.key, now(), callId, locationId);
        if (o.note) db.insert('notes', { id: id(), location_id: locationId, contact_id: contact.id, body: `Anruf (Power-Dialer) – ${d.label}\n${o.note}`.slice(0, 20_000), user_id: userId, created_at: now() });
        logActivity(app, locationId, contact.id, 'dialer.disposition', `Power-Dialer: ${d.label}${o.note ? ` – ${o.note.slice(0, 120)}` : ''}`, { itemId: item.id, listId: item.list_id, disposition: d.key, callId });
      });
      if (d.tag) addTags(app, locationId, contact.id, [d.tag]);
      if (d.dnd) {
        // "Nicht mehr anrufen": the phone consent is withdrawn in the ledger (or, without the module, the contact gets "Nicht stören").
        if (app.services.consent?.revoke) app.services.consent.revoke({ locationId, contactId: contact.id, channel: 'phone', source: { kind: 'manual', label: 'Power-Dialer' }, note: o.note || 'Will nicht mehr angerufen werden', actor: userId ?? '' });
        else db.update('contacts', contact.id, { dnd: 1, updated_at: now() }, locationId);
        // Every other open entry of this contact in any list stops too.
        db.run(`UPDATE dialer_items SET status = 'blocked', blocked_reason = 'Will nicht mehr angerufen werden', updated_at = ? WHERE contact_id = ? AND status IN ('pending', 'callback')`, now(), contact.id);
      }
      app.events.emit(locationId, 'dialer.disposition', { contactId: contact.id, listId: item.list_id, itemId: item.id, callId, disposition: d.key, label: d.label, positive: d.positive, kind: d.kind, note: o.note, callbackAt: r.status === 'callback' ? r.next_at : null, attempts: r.attempts });
      return itemRow(locationId, item.id)!;
    };

    router.post('/api/dialer/items/:id/disposition', 'location', (ctx) => {
      const item = itemRow(ctx.locationId, ctx.params.id);
      if (!item) throw notFound('Eintrag nicht gefunden');
      const s = settingsOf(ctx.locationId);
      const d = s.dispositions.find((x) => x.key === String(ctx.body?.code ?? ''));
      if (!d) throw bad('Ergebnis unbekannt');
      const note = str(ctx.body?.note, 'Notiz', { max: 4000 });
      let callbackAt: string | undefined;
      if (d.kind === 'callback') {
        const t = Date.parse(String(ctx.body?.callback_at ?? ''));
        if (!Number.isFinite(t)) throw bad('Bitte Datum und Uhrzeit des Rückrufs angeben');
        if (t < Date.now() - 60_000) throw bad('Der Rückruf liegt in der Vergangenheit');
        if (t > Date.now() + 365 * 864e5) throw bad('Der Rückruf liegt mehr als ein Jahr in der Zukunft');
        callbackAt = new Date(t).toISOString();
      }
      let callbackUser: string | null = null;
      if (d.kind === 'callback' && ctx.body?.callback_user) {
        callbackUser = str(ctx.body.callback_user, 'Person', { max: 64 });
        const u = db.get<{ locations: string; role: string }>('SELECT locations, role FROM users WHERE id = ?', callbackUser);
        if (!u || (u.role !== 'admin' && !JSON.parse(u.locations || '[]').includes(ctx.locationId))) throw bad('Person nicht gefunden');
      }
      const done = finish(ctx.locationId, ctx.user?.id ?? null, item, d, { note, callbackAt, callbackUser, callId: ctx.body?.call_id ? String(ctx.body.call_id) : null });
      return { ok: true, item: { id: done.id, status: done.status, attempts: done.attempts, next_at: done.next_at, disposition: done.disposition }, counts: counts(item.list_id) };
    });

    // --- voicemail drop ---------------------------------------------------------------------------------------------------
    /** Plays the recorded message to the person who has just been reached (an answering machine) and hangs up on them. */
    router.post('/api/dialer/calls/:callId/drop', 'location', async (ctx) => {
      const call = db.get<any>('SELECT * FROM calls WHERE id = ? AND location_id = ?', ctx.params.callId, ctx.locationId);
      if (!call) throw notFound('Anruf nicht gefunden');
      if (call.ended_at) throw bad('Der Anruf ist schon beendet');
      if (call.direction !== 'out') throw bad('Eine Nachricht lässt sich nur bei ausgehenden Anrufen hinterlassen');
      if (call.user_id && ctx.user && call.user_id !== ctx.user.id && ctx.user.role !== 'admin') throw new HttpError(403, 'Das ist nicht dein Anruf');
      const item = call.dialer_item_id ? itemRow(ctx.locationId, call.dialer_item_id) : undefined;
      const list = item ? listRow(ctx.locationId, item.list_id) : undefined;
      const audio = audioOf(app, ctx.locationId, String(ctx.body?.drop_id ?? list?.drop_id ?? ''));
      if (!audio || audio.kind !== 'drop') throw bad('Bitte eine Voicemail-Nachricht wählen (Anrufe → Audio, Art „Voicemail-Drop“)');
      const cfg = telephonyConfig(app, ctx.locationId);
      // The other party's leg: known from the browser phone, else the child of the call that rang the person's own phone.
      let remote: string | null = db.get<{ remote_sid: string | null }>('SELECT remote_sid FROM phone_calls WHERE call_id = ?', call.id)?.remote_sid ?? null;
      if (!remote && call.sid && CALL_SID.test(call.sid)) {
        const j = await twilioRequest(app, cfg, 'GET', `/Calls.json?ParentCallSid=${call.sid}&Status=in-progress&PageSize=5`);
        remote = j.calls?.[0]?.sid ?? null;
      }
      if (!remote || !CALL_SID.test(remote)) throw bad('Die Gegenstelle ist (noch) nicht verbunden');
      await twilioRequest(app, cfg, 'POST', `/Calls/${remote}.json`, [['Twiml', twiml(`<Play>${xml(audioUrl(app, audio))}</Play><Hangup/>`)]]);
      db.run('UPDATE calls SET disposition = ?, updated_at = ? WHERE id = ?', 'voicemail_drop', now(), call.id);
      if (call.contact_id) logActivity(app, ctx.locationId, call.contact_id, 'call.voicemail_drop', `Nachricht auf der Mailbox hinterlassen („${audio.name}“)`);
      app.events.emit(ctx.locationId, 'dialer.voicemail_drop', { contactId: call.contact_id ?? undefined, callId: call.id, audioId: audio.id });
      const s = settingsOf(ctx.locationId);
      const d = s.dispositions.find((x) => x.key === 'voicemail_drop');
      let result: ItemRow | undefined;
      if (item && d && item.status !== 'done') result = finish(ctx.locationId, ctx.user?.id ?? null, item, d, { note: '', callId: call.id });
      return { ok: true, item: result ? { id: result.id, status: result.status, attempts: result.attempts, next_at: result.next_at, disposition: result.disposition } : null };
    });

    // --- callbacks and numbers --------------------------------------------------------------------------------------------
    router.get('/api/dialer/callbacks', 'location', (ctx) => {
      const mine = ctx.query.get('mine') === '1' && ctx.user ? ctx.user.id : null;
      const rows = db.all<any>(
        `SELECT i.id, i.list_id, i.contact_id, i.next_at, i.note, i.callback_user, k.first_name, k.last_name, k.phone, l.name list_name FROM dialer_items i
         JOIN contacts k ON k.id = i.contact_id JOIN dialer_lists l ON l.id = i.list_id
         WHERE i.location_id = ? AND i.status = 'callback' ${mine ? 'AND (i.callback_user = ? OR i.callback_user IS NULL)' : ''} ORDER BY i.next_at LIMIT 200`,
        ctx.locationId,
        ...(mine ? [mine] : []),
      );
      return rows.map((r) => ({ id: r.id, list_id: r.list_id, list_name: r.list_name, contact_id: r.contact_id, name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.phone, phone: r.phone, due_at: r.next_at, due: r.next_at <= now(), note: r.note, user_id: r.callback_user }));
    });

    router.get('/api/dialer/stats', 'location', (ctx) => {
      const days = Math.min(Math.max(1, num(ctx.query.get('days'), 7)), 90);
      const since = new Date(Date.now() - days * 864e5).toISOString();
      const s = settingsOf(ctx.locationId);
      const byDisposition = db.all<{ disposition: string; n: number }>(`SELECT disposition, COUNT(*) n FROM calls WHERE location_id = ? AND started_at >= ? AND dialer_item_id IS NOT NULL AND disposition <> '' GROUP BY disposition`, ctx.locationId, since);
      const totals = db.get<{ calls: number; answered: number; talk: number }>(`SELECT COUNT(*) calls, COALESCE(SUM(answered), 0) answered, COALESCE(SUM(CASE WHEN answered = 1 THEN duration END), 0) talk FROM calls WHERE location_id = ? AND started_at >= ? AND dialer_item_id IS NOT NULL`, ctx.locationId, since)!;
      const positive = byDisposition.filter((r) => s.dispositions.find((d) => d.key === r.disposition)?.positive).reduce((n, r) => n + r.n, 0);
      return { days, calls: totals.calls, answered: totals.answered, talk_seconds: totals.talk, positive, dispositions: byDisposition.map((r) => ({ key: r.disposition, label: s.dispositions.find((d) => d.key === r.disposition)?.label ?? r.disposition, n: r.n })) };
    });

    // A callback that comes due is a task for the person; the task list and the app already remind of due tasks. Entries a person
    // left locked (browser closed) are freed after the lock ran out.
    let last = 0;
    app.onTick(() => {
      if (Date.now() - last < 60_000) return;
      last = Date.now();
      db.run(`UPDATE dialer_items SET locked_by = NULL, locked_until = NULL WHERE locked_until IS NOT NULL AND locked_until < ?`, now());
    });
  },
};
