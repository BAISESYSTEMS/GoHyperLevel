import { smartListById, type ListReader } from '../services/smart-lists.js';
import type { App, Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { appendCustomerMatch, googleApi, removeUserList, suggestLocations, uploadCustomerMatch } from '../services/ads-google.js';
import { googleIdentifiers, metaRow, type ListContact } from '../services/ads-hash.js';
import { addUsers, createCustomAudience, createLookalike, deleteAudience, metaApi, searchInterests, searchLocations } from '../services/ads-meta.js';
import { PLATFORM_LABEL, activity, audit, canManage, connected, fetcherOf, googleAuth, isHuman, loadConnection, metaCreds, relay, type Platform } from '../services/ads-store.js';
import { findContacts } from '../services/contacts.js';

/**
 * Audiences from HyperLevel smart lists: customer lists for Meta (Custom Audience) and Google (Customer Match), uploaded
 * as SHA-256 hashes normalised per the platforms' rules (services/ads-hash.ts), and lookalikes of them on Meta.
 * Contacts who opted out ("Nicht stören", e-mail unsubscribe) are never uploaded, and the person has to confirm that
 * the contacts agreed to ads based on their data. Also the targeting search (interests, places) for the wizard.
 */

const MAX_CONTACTS = 200_000;
const PAGE = 5000;

const out = (a: any) => {
  const { spec, ...rest } = parseJson({ ...a }, ['spec']) as Record<string, any>;
  return { ...rest, country: spec?.country ?? null, ratio: spec?.ratio ?? null };
};

interface Rows {
  total: number;
  usable: number;
  skipped: { no_identifier: number; opted_out: number };
  meta: string[][];
  google: Record<string, any>[][];
}

/** Hashed rows of a smart list's contacts for both platforms. Nothing leaves this function in clear text. */
export function audienceRows(app: App, locationId: string, smartListId: string, platform: Platform, who: ListReader): Rows {
  // Another person's private list is treated like a missing one (services/smart-lists.ts).
  const sl = smartListById(app, locationId, smartListId, who);
  if (!sl) throw notFound('Smart List nicht gefunden');
  const f = sl.filter ?? {};
  const rows: Rows = { total: 0, usable: 0, skipped: { no_identifier: 0, opted_out: 0 }, meta: [], google: [] };
  for (let offset = 0; offset < MAX_CONTACTS; offset += PAGE) {
    const { contacts } = findContacts(app, locationId, { tags: f.tags ?? [], anyTags: f.anyTags ?? [], excludeTags: f.excludeTags ?? [], q: f.q ?? '', limit: PAGE, offset, extra: f, noTotal: true });
    for (const c of contacts as (ListContact & { dnd?: number })[]) {
      rows.total++;
      if (c.dnd) {
        rows.skipped.opted_out++;
        continue;
      }
      if (platform === 'meta') {
        const r = metaRow(c);
        if (r) (rows.meta.push(r), rows.usable++);
        else rows.skipped.no_identifier++;
      } else {
        const ids = googleIdentifiers(c);
        if (ids.length) (rows.google.push(ids), rows.usable++);
        else rows.skipped.no_identifier++;
      }
    }
    if (contacts.length < PAGE) break;
  }
  return rows;
}

export const adsAudiencesModule: Module = {
  name: 'ads-audiences',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE ads_audiences (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        platform TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
        smart_list_id TEXT, source_id TEXT, platform_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending', spec TEXT NOT NULL DEFAULT '{}',
        sent INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
        last_error TEXT, last_sync_at TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX ads_audiences_loc ON ads_audiences(location_id, created_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;

    /** Contact data goes to an advertising platform (hashed): a person decides that in the app, with the consent confirmation. */
    const person = (ctx: Ctx) => {
      if (!isHuman(ctx)) throw new HttpError(403, 'Kundenlisten an Werbeplattformen überträgt nur eine Person in der Oberfläche');
    };
    const mine = (locationId: string, aid: string) => {
      const a = db.get('SELECT * FROM ads_audiences WHERE id = ? AND location_id = ?', aid, locationId);
      if (!a) throw notFound('Zielgruppe nicht gefunden');
      return a;
    };
    const usable = (locationId: string, platform: Platform) => {
      const conn = loadConnection(app, locationId, platform);
      if (!connected(app, platform, conn)) throw bad(`${PLATFORM_LABEL[platform]} ist nicht verbunden (Anzeigen → Verbindungen)`);
      if (!canManage(platform, conn)) throw bad('Der Zugang darf nur lesen – bitte neu verbinden und „Anzeigen verwalten“ erlauben');
      return conn!;
    };

    router.get('/api/ads/audiences', 'location', (ctx) =>
      db
        .all('SELECT * FROM ads_audiences WHERE location_id = ? ORDER BY created_at DESC', ctx.locationId)
        .map((a) => {
          const o = out(a);
          const sl = a.smart_list_id ? smartListById(app, ctx.locationId, a.smart_list_id, ctx) : undefined;
          return { ...o, smart_list_name: sl?.name ?? null };
        }),
    );

    /** How many contacts a smart list would send – before anything is uploaded. */
    router.get('/api/ads/audiences/preview', 'location', (ctx) => {
      const platform = (ctx.query.get('platform') === 'google' ? 'google' : 'meta') as Platform;
      const r = audienceRows(app, ctx.locationId, str(ctx.query.get('smart_list_id'), 'Smart List', { required: true }), platform, ctx);
      return { total: r.total, usable: r.usable, skipped: r.skipped };
    });

    router.post('/api/ads/audiences', 'location', async (ctx) => {
      person(ctx);
      const b = ctx.body ?? {};
      const platform = String(b.platform) as Platform;
      if (platform !== 'meta' && platform !== 'google') throw bad('Plattform: meta oder google');
      const name = str(b.name, 'Name', { required: true, max: 100 });
      const listId = str(b.smart_list_id, 'Smart List', { required: true });
      if (b.consent !== true) throw bad('Bitte bestätigen, dass die Kontakte der Nutzung ihrer Daten für Werbung zugestimmt haben (consent)');
      const conn = usable(ctx.locationId, platform);
      const rows = audienceRows(app, ctx.locationId, listId, platform, ctx);
      if (!rows.usable) throw bad('Kein Kontakt der Liste hat eine E-Mail-Adresse oder Telefonnummer, die sich übertragen lässt');
      const aid = id();
      db.insert('ads_audiences', { id: aid, location_id: ctx.locationId, platform, kind: 'customer_list', name, smart_list_id: listId, status: 'pending', skipped: rows.skipped.no_identifier + rows.skipped.opted_out, created_by: ctx.user?.id ?? null, created_at: now(), updated_at: now() });
      try {
        let platformId: string;
        let sent: number;
        if (platform === 'meta') {
          const c = metaCreds(conn);
          const api = metaApi(fetcherOf(app), c.version, c.token);
          platformId = await relay(() => createCustomAudience(api, c.adAccountId, name, `HyperLevel Smart List „${name}“`));
          sent = (await relay(() => addUsers(api, platformId, rows.meta))).received;
        } else {
          const api = googleApi(fetcherOf(app), await googleAuth(app, conn));
          const r = await relay(() => uploadCustomerMatch(api, { name, description: `HyperLevel Smart List „${name}“`, members: rows.google }));
          platformId = r.userList;
          sent = r.sent;
        }
        db.run(`UPDATE ads_audiences SET platform_id = ?, status = 'ready', sent = ?, last_sync_at = ?, updated_at = ?, last_error = NULL WHERE id = ?`, platformId, sent, now(), now(), aid);
        const summary = `Zielgruppe „${name}“: ${sent} Kontakte (nur als SHA-256-Hash, ${rows.skipped.opted_out} abgemeldete und ${rows.skipped.no_identifier} ohne E-Mail/Telefon ausgelassen) an ${PLATFORM_LABEL[platform]} übertragen`;
        audit(app, ctx, 'ads.audience.upload', summary, { locationId: ctx.locationId, entityId: aid });
        activity(app, ctx.locationId, { platform, kind: 'audience', summary, actor: ctx.user?.name, via: ctx.via });
        return out(db.get('SELECT * FROM ads_audiences WHERE id = ?', aid));
      } catch (e) {
        db.run(`UPDATE ads_audiences SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?`, (e as Error).message.slice(0, 500), now(), aid);
        throw e;
      }
    });

    /** Sends the list again (new contacts since the last upload). */
    router.post('/api/ads/audiences/:id/sync', 'location', async (ctx) => {
      person(ctx);
      const a = mine(ctx.locationId, ctx.params.id);
      if (a.kind !== 'customer_list' || !a.smart_list_id || !a.platform_id) throw bad('Nur Kundenlisten aus einer Smart List lassen sich aktualisieren');
      if (ctx.body?.consent !== true) throw bad('Bitte bestätigen, dass die Kontakte der Nutzung ihrer Daten für Werbung zugestimmt haben (consent)');
      const platform = a.platform as Platform;
      const conn = usable(ctx.locationId, platform);
      const rows = audienceRows(app, ctx.locationId, a.smart_list_id, platform, ctx);
      let sent: number;
      if (platform === 'meta') {
        const c = metaCreds(conn);
        sent = (await relay(() => addUsers(metaApi(fetcherOf(app), c.version, c.token), a.platform_id, rows.meta))).received;
      } else {
        const api = googleApi(fetcherOf(app), await googleAuth(app, conn));
        sent = (await relay(() => appendCustomerMatch(api, a.platform_id, rows.google))).sent;
      }
      db.run(`UPDATE ads_audiences SET sent = ?, skipped = ?, last_sync_at = ?, updated_at = ?, status = 'ready', last_error = NULL WHERE id = ?`, sent, rows.skipped.no_identifier + rows.skipped.opted_out, now(), now(), a.id);
      audit(app, ctx, 'ads.audience.upload', `Zielgruppe „${a.name}“ aktualisiert: ${sent} Kontakte (Hash) an ${PLATFORM_LABEL[platform]} übertragen`, { locationId: ctx.locationId, entityId: a.id });
      return out(db.get('SELECT * FROM ads_audiences WHERE id = ?', a.id));
    });

    router.post('/api/ads/audiences/:id/lookalike', 'location', async (ctx) => {
      const src = mine(ctx.locationId, ctx.params.id);
      if (src.platform !== 'meta' || src.kind !== 'customer_list' || src.status !== 'ready') throw bad('Lookalikes gibt es für fertige Meta-Kundenlisten');
      const b = ctx.body ?? {};
      const country = str(b.country, 'Land', { required: true, max: 2 }).toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) throw bad('Land: zweistelliger Code, z. B. DE');
      const ratio = Number(b.ratio ?? 0.01);
      if (!(ratio >= 0.01 && ratio <= 0.2)) throw bad('Ähnlichkeit: 1 % bis 20 % (0,01–0,2)');
      const name = str(b.name, 'Name', { max: 100 }) || `Lookalike ${Math.round(ratio * 100)} % ${country} – ${src.name}`;
      const conn = usable(ctx.locationId, 'meta');
      const c = metaCreds(conn);
      const lid = id();
      const platformId = await relay(() => createLookalike(metaApi(fetcherOf(app), c.version, c.token), c.adAccountId, { name, originId: src.platform_id, country, ratio }));
      db.insert('ads_audiences', { id: lid, location_id: ctx.locationId, platform: 'meta', kind: 'lookalike', name, source_id: src.id, platform_id: platformId, status: 'ready', spec: JSON.stringify({ country, ratio }), created_by: ctx.user?.id ?? null, created_at: now(), updated_at: now(), last_sync_at: now() });
      audit(app, ctx, 'ads.audience.lookalike', `Lookalike „${name}“ (${country}, ${Math.round(ratio * 100)} %) aus „${src.name}“ bei Meta angelegt`, { locationId: ctx.locationId, entityId: lid });
      return out(db.get('SELECT * FROM ads_audiences WHERE id = ?', lid));
    });

    router.delete('/api/ads/audiences/:id', 'location', async (ctx) => {
      const a = mine(ctx.locationId, ctx.params.id);
      for (const c of db.all<{ name: string; spec: string; status: string }>(`SELECT name, spec, status FROM ads_campaigns WHERE location_id = ? AND status != 'error'`, ctx.locationId)) {
        const s = JSON.parse(c.spec || '{}');
        if ([...(s.audience?.audience_ids ?? []), ...(s.audience?.exclude_audience_ids ?? [])].includes(a.id)) throw new HttpError(409, `Die Zielgruppe wird von der Kampagne „${c.name}“ verwendet`);
      }
      if (a.kind === 'lookalike' ? false : db.get('SELECT 1 FROM ads_audiences WHERE location_id = ? AND source_id = ?', ctx.locationId, a.id)) throw new HttpError(409, 'Von dieser Zielgruppe gibt es noch Lookalikes – zuerst diese löschen');
      let removed = false;
      if (a.platform_id) {
        try {
          const conn = loadConnection(app, ctx.locationId, a.platform);
          if (connected(app, a.platform, conn)) {
            if (a.platform === 'meta') {
              const c = metaCreds(conn);
              await deleteAudience(metaApi(fetcherOf(app), c.version, c.token), a.platform_id);
            } else await removeUserList(googleApi(fetcherOf(app), await googleAuth(app, conn)), a.platform_id);
            removed = true;
          }
        } catch {
          /* already gone at the platform, or in use there – the local entry goes anyway */
        }
      }
      db.run('DELETE FROM ads_audiences WHERE id = ? AND location_id = ?', a.id, ctx.locationId);
      audit(app, ctx, 'ads.audience.delete', `Zielgruppe „${a.name}“ gelöscht${removed ? ` (auch bei ${PLATFORM_LABEL[a.platform as Platform]})` : ''}`, { locationId: ctx.locationId, entityId: a.id });
      return { ok: true, removed_at_platform: removed };
    });

    // --- targeting search for the wizard ---------------------------------------------------------------------------
    router.get('/api/ads/targeting/interests', 'location', async (ctx) => {
      const q = str(ctx.query.get('q'), 'Suche', { required: true, max: 80 });
      if (q.length < 2) return [];
      const conn = loadConnection(app, ctx.locationId, 'meta');
      const c = metaCreds(conn);
      if (!c.token) throw bad('Meta ist noch nicht verbunden');
      return relay(() => searchInterests(metaApi(fetcherOf(app), c.version, c.token), q));
    });

    router.get('/api/ads/targeting/locations', 'location', async (ctx) => {
      const platform = (ctx.query.get('platform') === 'google' ? 'google' : 'meta') as Platform;
      const q = str(ctx.query.get('q'), 'Suche', { required: true, max: 80 });
      if (q.length < 2) return [];
      const conn = loadConnection(app, ctx.locationId, platform);
      if (platform === 'meta') {
        const c = metaCreds(conn);
        if (!c.token) throw bad('Meta ist noch nicht verbunden');
        return relay(() => searchLocations(metaApi(fetcherOf(app), c.version, c.token), q));
      }
      if (!connected(app, 'google', conn)) throw bad('Google Ads ist noch nicht verbunden');
      return relay(async () => suggestLocations(googleApi(fetcherOf(app), await googleAuth(app, conn)), q, ctx.query.get('country') ?? undefined));
    });
  },
};
