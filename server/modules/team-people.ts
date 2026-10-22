import type { Ctx } from '../core/http.js';
import { HttpError, bad, notFound, str } from '../core/http.js';
import type { Module } from '../core/app.js';
import { isValidTz } from '../core/time.js';
import { id, now } from '../core/util.js';
import { availabilityOf, awayUntil, cleanWindows, isAway, peopleOf } from '../services/team-people.js';

/**
 * Team: who is around. Per sub-account every person can pause assignments, keep weekly working hours and enter
 * out-of-office periods (the Team-Posteingang and the Team-Kalender respect them; approved HR absences count too).
 * Everybody edits their own entry; agency admins and members with the settings area edit anybody's.
 */

export const teamPeopleModule: Module = {
  name: 'team-people',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE team_availability (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        paused INTEGER NOT NULL DEFAULT 0, hours TEXT, tz TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY (location_id, user_id)
      );
      CREATE TABLE team_away (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        start_at TEXT NOT NULL, end_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE INDEX team_away_user ON team_away(location_id, user_id, end_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;

    const mayEditOthers = (ctx: Ctx) => {
      const u = ctx.user;
      return !!u && (u.role === 'admin' || u.permissions === null || u.permissions.includes('settings'));
    };
    /** The person a route is about: "me" or an id of somebody who works in this sub-account. */
    const target = (ctx: Ctx): string => {
      const raw = ctx.params.userId;
      const me = ctx.user?.id;
      if (!me) throw new HttpError(403, 'Das geht nur mit Anmeldung');
      const uid = raw === 'me' ? me : raw;
      if (uid !== me && !mayEditOthers(ctx)) throw new HttpError(403, 'Nur die Person selbst oder Admins dürfen das ändern');
      if (!peopleOf(app, ctx.locationId, '').some((p) => p.id === uid)) throw notFound('Person nicht gefunden');
      return uid;
    };

    const out = (locationId: string, userId: string) => {
      const av = availabilityOf(app, locationId, userId);
      return { ...av, away_now: isAway(app, locationId, userId, new Date(), false), back_on: awayUntil(av) };
    };

    router.get('/api/team-people', 'location', (ctx) => {
      const tz = app.location(ctx.locationId)?.timezone;
      return peopleOf(app, ctx.locationId, '').map((p) => {
        const av = availabilityOf(app, ctx.locationId, p.id);
        return {
          id: p.id,
          name: p.name,
          email: p.email,
          role: p.role,
          paused: av.paused,
          has_hours: !!av.hours,
          away_now: isAway(app, ctx.locationId, p.id, new Date(), false),
          back_on: awayUntil(av),
          me: p.id === ctx.user?.id,
          timezone: av.tz || tz || 'Europe/Berlin',
        };
      });
    });

    router.get('/api/team-people/:userId', 'location', (ctx) => {
      const uid = target(ctx);
      return out(ctx.locationId, uid);
    });

    router.put('/api/team-people/:userId', 'location', (ctx) => {
      const uid = target(ctx);
      const cur = availabilityOf(app, ctx.locationId, uid);
      const b = ctx.body ?? {};
      const paused = b.paused === undefined ? cur.paused : b.paused === true || b.paused === 'true';
      let hours = cur.hours;
      if (b.hours !== undefined) {
        if (b.hours !== null && (typeof b.hours !== 'object' || Array.isArray(b.hours))) throw bad('Arbeitszeiten ungültig');
        hours = cleanWindows(b.hours);
      }
      let tz = cur.tz;
      if (b.tz !== undefined) {
        const t = str(b.tz, 'Zeitzone', { max: 60 });
        if (t && !isValidTz(t)) throw bad('Unbekannte Zeitzone');
        tz = t || null;
      }
      db.run(
        `INSERT INTO team_availability (location_id, user_id, paused, hours, tz, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(location_id, user_id) DO UPDATE SET paused = excluded.paused, hours = excluded.hours, tz = excluded.tz, updated_at = excluded.updated_at`,
        ctx.locationId,
        uid,
        paused ? 1 : 0,
        hours ? JSON.stringify(hours) : null,
        tz,
        now(),
      );
      return out(ctx.locationId, uid);
    });

    router.post('/api/team-people/:userId/away', 'location', (ctx) => {
      const uid = target(ctx);
      const start = Date.parse(String(ctx.body?.start_at ?? ''));
      const end = Date.parse(String(ctx.body?.end_at ?? ''));
      if (Number.isNaN(start) || Number.isNaN(end)) throw bad('Beginn und Ende der Abwesenheit angeben');
      if (end <= start) throw bad('Das Ende muss nach dem Beginn liegen');
      if (end - start > 400 * 864e5) throw bad('Höchstens ein Jahr am Stück');
      const row = { id: id(), location_id: ctx.locationId, user_id: uid, start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString(), note: str(ctx.body?.note, 'Notiz', { max: 200 }), created_at: now() };
      db.insert('team_away', row);
      return { ...out(ctx.locationId, uid), created: row };
    });

    router.delete('/api/team-people/away/:awayId', 'location', (ctx) => {
      const row = db.get<{ id: string; user_id: string }>('SELECT id, user_id FROM team_away WHERE id = ? AND location_id = ?', ctx.params.awayId, ctx.locationId);
      if (!row) throw notFound();
      if (row.user_id !== ctx.user?.id && !mayEditOthers(ctx)) throw new HttpError(403, 'Nur die Person selbst oder Admins dürfen das ändern');
      db.run('DELETE FROM team_away WHERE id = ?', row.id);
      return { ok: true };
    });

    // Old out-of-office entries are of no use after a while.
    let swept = 0;
    app.onTick(() => {
      if (Date.now() - swept < 6 * 3600_000) return;
      swept = Date.now();
      db.run('DELETE FROM team_away WHERE end_at < ?', new Date(Date.now() - 90 * 864e5).toISOString());
    });
  },
};
