import type { Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, notFound, num, str } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { id, normalizeEmail, now, slugify } from '../core/util.js';
import { ymdInTz } from '../core/time.js';
import { getContact, logActivity, upsertContact } from '../services/contacts.js';
import { cleanAccess, enrollmentProgress, getCourse, getEnrollment, grantAccess, portalUrl, revokeAccess, courseSettings, dripOrigin } from '../services/courses.js';
import { cleanYmd, cohortState, pathPercent, pathSteps, pickCohort } from '../services/course-paths.js';
import { deDate } from '../services/creator-kit.js';
import { registerTriggers } from '../services/wfx-kit.js';

/**
 * Bundles & learning paths (a sequence of courses with unlock rules, granted by tag, purchase or by hand) and cohorts of a course (a
 * start date everybody's drip counts from, capacity, a link into the community). Docs: docs/courses.md.
 */

const PATH_STATUS = ['draft', 'published'];
const NAME_MAX = 160;

const CSS = `<style>
.lp{margin-top:34px}.lp h2{display:flex;gap:8px;align-items:center}.lp .path{padding:18px 20px;margin:0 0 14px}.lp .path h3{margin:0 0 4px;font-size:18px}
.lp .steps{list-style:none;margin:12px 0 0;padding:0;display:grid;gap:6px}.lp .steps a,.lp .steps span.s{display:flex;gap:12px;align-items:center;min-height:48px;padding:6px 14px;border:1px solid var(--line);border-radius:12px;text-decoration:none;color:inherit;background:var(--panel)}
.lp .steps a:hover{border-color:var(--brand)}.lp .steps .st{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;flex:none;background:var(--soft);color:var(--brand);font-size:14px}
.lp .steps .done .st{background:var(--ok);color:#fff}.lp .steps .locked{color:var(--muted)}.lp .steps .t{flex:1;min-width:0}.lp .steps .d{font-size:13px;color:var(--muted)}
.ch{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;margin:0 0 18px;padding:14px 18px}.ch .btn{min-height:44px}
</style>`;

export const courseCohortModule: Module = {
  name: 'course-paths',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE course_paths (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        title TEXT NOT NULL, slug TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
        sequential INTEGER NOT NULL DEFAULT 1, unlock_percent INTEGER NOT NULL DEFAULT 100, access TEXT NOT NULL DEFAULT '{}',
        position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(location_id, slug)
      );
      CREATE TABLE course_path_items (
        path_id TEXT NOT NULL REFERENCES course_paths(id) ON DELETE CASCADE, course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (path_id, course_id)
      );
      CREATE INDEX course_path_items_course ON course_path_items(course_id);
      CREATE TABLE course_path_members (
        path_id TEXT NOT NULL REFERENCES course_paths(id) ON DELETE CASCADE, contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, source TEXT NOT NULL DEFAULT 'manual', source_ref TEXT NOT NULL DEFAULT '',
        enrolled_at TEXT NOT NULL, completed_at TEXT, PRIMARY KEY (path_id, contact_id)
      );
      CREATE INDEX course_path_members_contact ON course_path_members(contact_id);
      CREATE TABLE course_cohorts (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, name TEXT NOT NULL,
        starts_at TEXT NOT NULL, ends_at TEXT, capacity INTEGER NOT NULL DEFAULT 0, group_id TEXT, channel_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX course_cohorts_course ON course_cohorts(course_id, starts_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    registerTriggers(app, [
      {
        type: 'course.path_enrolled',
        label: 'Lernpfad freigeschaltet',
        category: 'content',
        summary: 'Jemand bekommt Zugang zu einem Lernpfad (per Tag, Kauf oder von Hand).',
        doc: '{{event.path.title}} nennt den Lernpfad, {{event.source}} wie der Zugang kam (tag, purchase, manual, api).',
        fields: [{ key: 'path_id', label: 'Nur für Lernpfad (ID)', type: 'text' }],
        sample: { contactId: 'c1', pathId: 'p1', path: { id: 'p1', title: 'Grundlagen bis Praxis' }, source: 'tag' },
        keywords: 'lernpfad kurs paket freigeschaltet zugang bundle',
      },
      {
        type: 'course.path_completed',
        label: 'Lernpfad abgeschlossen',
        category: 'content',
        summary: 'Jemand hat alle Kurse eines Lernpfads abgeschlossen.',
        doc: '{{event.path.title}} nennt den Lernpfad. Passend für Zertifikat, Glückwunsch-Mail oder ein Folgeangebot.',
        fields: [{ key: 'path_id', label: 'Nur für Lernpfad (ID)', type: 'text' }],
        sample: { contactId: 'c1', pathId: 'p1', path: { id: 'p1', title: 'Grundlagen bis Praxis' } },
        keywords: 'lernpfad abgeschlossen fertig programm zertifikat',
      },
      {
        type: 'course.cohort_joined',
        label: 'Cohort beigetreten',
        category: 'content',
        summary: 'Jemand wird einem Cohort eines Kurses zugewiesen (von Hand oder automatisch).',
        doc: '{{event.cohort.name}} nennt den Cohort, {{event.cohort.starts_at}} den Starttag (JJJJ-MM-TT).',
        fields: [{ key: 'course_id', label: 'Nur für Kurs', type: 'text' }],
        sample: { contactId: 'c1', courseId: 'k1', cohortId: 'h1', cohort: { id: 'h1', name: 'Herbst 2026', starts_at: '2026-10-12' } },
        keywords: 'cohort gruppe kursstart startdatum',
      },
    ]);
    app.services.workflowTriggerFilters = {
      ...(app.services.workflowTriggerFilters ?? {}),
      'course.path_enrolled': (c: any, d: any) => !c.path_id || c.path_id === d.pathId,
      'course.path_completed': (c: any, d: any) => !c.path_id || c.path_id === d.pathId,
      'course.cohort_joined': (c: any, d: any) => !c.course_id || c.course_id === d.courseId,
    };

    // --- paths: helpers ----------------------------------------------------------------------------------------------------------------
    const uniqueSlug = (loc: string, base: string, except = '') => {
      const root = slugify(base) || 'pfad';
      let slug = root;
      for (let i = 2; db.get('SELECT id FROM course_paths WHERE location_id = ? AND slug = ? AND id != ?', loc, slug, except); i++) slug = `${root}-${i}`;
      return slug;
    };
    const pathOf = (loc: string, pid: string) => parseJson(db.get('SELECT * FROM course_paths WHERE id = ? AND location_id = ?', pid, loc), ['access']);
    const mustPath = (loc: string, pid: string) => {
      const p = pathOf(loc, pid);
      if (!p) throw notFound('Lernpfad nicht gefunden');
      return p;
    };
    const itemsOf = (pid: string) => db.all<{ course_id: string; title: string; status: string; position: number }>(`SELECT i.course_id, i.position, c.title, c.status FROM course_path_items i JOIN courses c ON c.id = i.course_id WHERE i.path_id = ? ORDER BY i.position`, pid);
    const setItems = (loc: string, pid: string, courseIds: unknown) => {
      if (!Array.isArray(courseIds)) throw bad('Kurse: Liste erwartet');
      const ids = [...new Set(courseIds.map(String))].slice(0, 30);
      for (const cid of ids) if (!getCourse(app, loc, cid)) throw bad('Kurs nicht gefunden');
      db.tx(() => {
        db.run('DELETE FROM course_path_items WHERE path_id = ?', pid);
        ids.forEach((cid, i) => db.run('INSERT INTO course_path_items (path_id, course_id, position) VALUES (?, ?, ?)', pid, cid, i));
      });
    };
    const cleanUnlock = (v: unknown) => Math.min(Math.max(Math.round(num(v, 100)), 1), 100);
    const pathOut = (p: any) => ({
      ...p,
      sequential: !!p.sequential,
      items: itemsOf(p.id),
      members: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM course_path_members WHERE path_id = ?', p.id)!.n,
      completed: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM course_path_members WHERE path_id = ? AND completed_at IS NOT NULL', p.id)!.n,
      url: `${portalUrl(app, p.location_id)}`,
    });

    /** Gives a contact the path: every course in it (their access source is "path"), and the sequence rules apply to them. */
    function grantPath(loc: string, pid: string, contactId: string, source: string, ref = ''): { changed: boolean } {
      const p = pathOf(loc, pid);
      if (!p) throw new Error('Lernpfad nicht gefunden');
      if (!getContact(app, loc, contactId)) throw new Error('Kontakt nicht gefunden');
      const had = db.get('SELECT 1 FROM course_path_members WHERE path_id = ? AND contact_id = ?', pid, contactId);
      if (!had) db.insert('course_path_members', { path_id: pid, contact_id: contactId, location_id: loc, source, source_ref: ref, enrolled_at: now(), completed_at: null });
      for (const it of itemsOf(pid)) grantAccess(app, loc, it.course_id, contactId, 'path', pid);
      if (!had) {
        logActivity(app, loc, contactId, 'course.path_enrolled', `Lernpfad „${p.title}“ freigeschaltet (${source})`);
        app.events.emit(loc, 'course.path_enrolled', { contactId, pathId: pid, path: { id: pid, title: p.title }, source });
      }
      return { changed: !had };
    }
    function revokePath(loc: string, pid: string, contactId: string, why = ''): boolean {
      const m = db.get<any>('SELECT * FROM course_path_members WHERE path_id = ? AND contact_id = ? AND location_id = ?', pid, contactId, loc);
      if (!m) return false;
      db.run('DELETE FROM course_path_members WHERE path_id = ? AND contact_id = ?', pid, contactId);
      // Only access that came from this path goes with it.
      for (const it of itemsOf(pid)) {
        const e = getEnrollment(app, it.course_id, contactId);
        if (e?.status === 'active' && e.source === 'path' && e.source_ref === pid) revokeAccess(app, loc, it.course_id, contactId, why || 'Lernpfad entzogen');
      }
      return true;
    }
    const contactFrom = (loc: string, body: any, source: string): string => {
      let contactId = str(body?.contact_id, 'Kontakt');
      if (contactId && !getContact(app, loc, contactId)) throw notFound('Kontakt nicht gefunden');
      if (!contactId) {
        const email = normalizeEmail(body?.email);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Kontakt oder gültige E-Mail angeben');
        contactId = upsertContact(app, loc, { email, name: str(body?.name, 'Name', { max: 120 }) }, { source }).contact.id;
      }
      return contactId;
    };

    // --- paths: the team ----------------------------------------------------------------------------------------------------------------
    router.get('/api/courses/paths', 'location', (ctx) => db.all('SELECT * FROM course_paths WHERE location_id = ? ORDER BY position, created_at', ctx.locationId).map((p) => pathOut(parseJson(p, ['access']))));
    router.post('/api/courses/paths', 'location', (ctx) => {
      const title = str(ctx.body?.title, 'Titel', { required: true, max: NAME_MAX });
      const slug = uniqueSlug(ctx.locationId, ctx.body?.slug || title);
      const row = {
        id: id(),
        location_id: ctx.locationId,
        title,
        slug,
        description: str(ctx.body?.description, 'Beschreibung', { max: 3000 }),
        status: 'draft',
        sequential: ctx.body?.sequential === false ? 0 : 1,
        unlock_percent: cleanUnlock(ctx.body?.unlock_percent),
        access: cleanAccess({ tags: [`pfad:${slug}`], ...(ctx.body?.access ?? {}) }),
        position: db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM course_paths WHERE location_id = ?', ctx.locationId)!.n,
        created_at: now(),
        updated_at: now(),
      };
      for (const pid of row.access.product_ids) if (!db.get('SELECT id FROM products WHERE id = ? AND location_id = ?', pid, ctx.locationId)) throw bad('Produkt nicht gefunden');
      db.tx(() => {
        db.insert('course_paths', row);
        if (ctx.body?.items !== undefined) setItems(ctx.locationId, row.id, ctx.body.items);
      });
      return pathOut(pathOf(ctx.locationId, row.id));
    });
    router.get('/api/courses/paths/:pid', 'location', (ctx) => pathOut(mustPath(ctx.locationId, ctx.params.pid)));
    router.patch('/api/courses/paths/:pid', 'location', (ctx) => {
      const p = mustPath(ctx.locationId, ctx.params.pid);
      const b = ctx.body ?? {};
      const patch: Record<string, any> = { updated_at: now() };
      if (b.title !== undefined) patch.title = str(b.title, 'Titel', { required: true, max: NAME_MAX });
      if (b.slug !== undefined) patch.slug = uniqueSlug(ctx.locationId, String(b.slug || p.title), p.id);
      if (b.description !== undefined) patch.description = str(b.description, 'Beschreibung', { max: 3000 });
      if (b.status !== undefined) {
        if (!PATH_STATUS.includes(b.status)) throw bad('Unbekannter Status');
        patch.status = b.status;
      }
      if (b.sequential !== undefined) patch.sequential = b.sequential ? 1 : 0;
      if (b.unlock_percent !== undefined) patch.unlock_percent = cleanUnlock(b.unlock_percent);
      let added: string[] = [];
      if (b.access !== undefined) {
        patch.access = cleanAccess(b.access, p.access);
        added = patch.access.tags.filter((t: string) => !(p.access?.tags ?? []).includes(t));
        for (const pid of patch.access.product_ids) if (!db.get('SELECT id FROM products WHERE id = ? AND location_id = ?', pid, ctx.locationId)) throw bad('Produkt nicht gefunden');
      }
      db.tx(() => {
        db.update('course_paths', p.id, patch);
        if (b.items !== undefined) setItems(ctx.locationId, p.id, b.items);
      });
      // Contacts that already carry a newly added access tag get the path right away (published paths only).
      const now_ = pathOf(ctx.locationId, p.id);
      let synced = 0;
      if (now_?.status === 'published')
        for (const tag of added)
          for (const r of db.all<{ id: string }>(`SELECT id FROM contacts WHERE location_id = ? AND EXISTS (SELECT 1 FROM json_each(contacts.tags) WHERE value = ?)`, ctx.locationId, tag)) if (grantPath(ctx.locationId, p.id, r.id, 'tag', tag).changed) synced++;
      // New courses on a path reach the people already on it.
      if (b.items !== undefined) for (const m of db.all<{ contact_id: string }>('SELECT contact_id FROM course_path_members WHERE path_id = ?', p.id)) for (const it of itemsOf(p.id)) grantAccess(app, ctx.locationId, it.course_id, m.contact_id, 'path', p.id);
      return { ...pathOut(pathOf(ctx.locationId, p.id)), synced };
    });
    router.delete('/api/courses/paths/:pid', 'location', (ctx) => {
      if (!db.run('DELETE FROM course_paths WHERE id = ? AND location_id = ?', ctx.params.pid, ctx.locationId).changes) throw notFound('Lernpfad nicht gefunden');
      return { ok: true };
    });
    router.get('/api/courses/paths/:pid/members', 'location', (ctx) => {
      const p = mustPath(ctx.locationId, ctx.params.pid);
      const items = itemsOf(p.id);
      return db
        .all<any>(`SELECT m.*, k.first_name, k.last_name, k.email FROM course_path_members m JOIN contacts k ON k.id = m.contact_id WHERE m.path_id = ? ORDER BY m.enrolled_at DESC LIMIT 2000`, p.id)
        .map((m) => {
          const steps = pathSteps(
            items.map((it) => {
              const e = getEnrollment(app, it.course_id, m.contact_id);
              return { course_id: it.course_id, title: it.title, percent: e?.status === 'active' ? enrollmentProgress(app, e).percent : undefined };
            }),
            { sequential: !!p.sequential, unlockPercent: p.unlock_percent },
          );
          return { ...m, percent: pathPercent(steps), steps: steps.map((s) => ({ course_id: s.course_id, title: s.title, percent: s.percent ?? null, state: s.state })) };
        });
    });
    router.post('/api/courses/paths/:pid/members', 'location', (ctx) => {
      const p = mustPath(ctx.locationId, ctx.params.pid);
      if (!itemsOf(p.id).length) throw bad('Der Lernpfad hat noch keine Kurse');
      const contactId = contactFrom(ctx.locationId, ctx.body, 'Lernpfade');
      const r = grantPath(ctx.locationId, p.id, contactId, ctx.viaApiKey ? 'api' : 'manual', ctx.user?.name ?? '');
      return { contact_id: contactId, changed: r.changed };
    });
    router.delete('/api/courses/paths/:pid/members/:contactId', 'location', (ctx) => {
      const p = mustPath(ctx.locationId, ctx.params.pid);
      if (!revokePath(ctx.locationId, p.id, ctx.params.contactId, ctx.user?.name ? `von ${ctx.user.name}` : '')) throw notFound('Kein Zugang zum Lernpfad');
      return { ok: true };
    });

    // --- paths: automatic access -----------------------------------------------------------------------------------------------------------
    const pathsWith = (loc: string, kind: 'tags' | 'product_ids', value: string) =>
      db.all<{ id: string }>(`SELECT id FROM course_paths WHERE location_id = ? AND status = 'published' AND EXISTS (SELECT 1 FROM json_each(course_paths.access, '$.${kind}') WHERE value = ?)`, loc, value);
    app.events.on('contact.tag_added', (e) => {
      const { contactId, tag } = e.data;
      if (!contactId || !tag) return;
      for (const p of pathsWith(e.locationId, 'tags', String(tag))) grantPath(e.locationId, p.id, contactId, 'tag', String(tag));
    });
    app.events.on('contact.tag_removed', (e) => {
      const { contactId, tag } = e.data;
      if (!contactId || !tag) return;
      const contact = getContact(app, e.locationId, contactId);
      if (!contact) return;
      for (const row of pathsWith(e.locationId, 'tags', String(tag))) {
        const p = pathOf(e.locationId, row.id)!;
        const m = db.get<any>('SELECT * FROM course_path_members WHERE path_id = ? AND contact_id = ?', p.id, contactId);
        if (!m || m.source !== 'tag' || p.access?.revoke_on_tag_removal === false) continue;
        if ((p.access?.tags ?? []).some((t: string) => contact.tags.includes(t))) continue;
        revokePath(e.locationId, p.id, contactId, `Tag „${tag}“ entfernt`);
      }
    });
    app.events.on('product.purchased', (e) => {
      const { contactId, productId } = e.data;
      if (!contactId || !productId) return;
      for (const p of pathsWith(e.locationId, 'product_ids', String(productId))) grantPath(e.locationId, p.id, contactId, 'purchase', String(productId));
    });
    // A path is finished when every course on it is.
    app.events.on('course.completed', (e) => {
      const { contactId, courseId } = e.data;
      if (!contactId || !courseId) return;
      for (const m of db.all<any>(`SELECT m.*, p.title FROM course_path_members m JOIN course_paths p ON p.id = m.path_id JOIN course_path_items i ON i.path_id = m.path_id WHERE m.contact_id = ? AND i.course_id = ? AND m.completed_at IS NULL AND m.location_id = ?`, contactId, courseId, e.locationId)) {
        const items = itemsOf(m.path_id);
        const all = items.every((it) => {
          const en = getEnrollment(app, it.course_id, contactId);
          return !en || en.status !== 'active' || en.completed_at;
        });
        if (all && items.length && db.run('UPDATE course_path_members SET completed_at = ? WHERE path_id = ? AND contact_id = ? AND completed_at IS NULL', now(), m.path_id, contactId).changes) {
          logActivity(app, e.locationId, contactId, 'course.path_completed', `Lernpfad „${m.title}“ abgeschlossen`);
          app.events.emit(e.locationId, 'course.path_completed', { contactId, pathId: m.path_id, path: { id: m.path_id, title: m.title } });
        }
      }
    });

    // --- paths: the sequence locks lessons of later courses ----------------------------------------------------------------------------------
    const gateMemo = new WeakMap<object, string>();
    app.services.lessonGates = [
      ...((app.services.lessonGates as unknown[] | undefined) ?? []),
      (s: any): string | undefined => {
        const e = s?.enrollment;
        if (!e || e.source !== 'path' || !e.source_ref) return undefined;
        if (gateMemo.has(s)) return gateMemo.get(s) || undefined;
        let why = '';
        const p = pathOf(e.location_id, e.source_ref);
        if (p?.sequential) {
          const steps = pathSteps(
            itemsOf(p.id).map((it) => {
              const en = getEnrollment(app, it.course_id, e.contact_id);
              return { course_id: it.course_id, title: it.title, percent: en?.status === 'active' ? enrollmentProgress(app, en).percent : undefined };
            }),
            { sequential: true, unlockPercent: p.unlock_percent },
          );
          why = steps.find((x) => x.course_id === s.course.id)?.reason ?? '';
        }
        gateMemo.set(s, why);
        return why || undefined;
      },
    ];

    // --- paths: the member's start page --------------------------------------------------------------------------------------------------------
    app.services.portalDashboard = [
      ...((app.services.portalDashboard as unknown[] | undefined) ?? []),
      (p: any, m: any): string => {
        const rows = db.all<any>(`SELECT p.* FROM course_paths p JOIN course_path_members x ON x.path_id = p.id WHERE x.contact_id = ? AND p.location_id = ? AND p.status = 'published' ORDER BY p.position, p.created_at`, m.contact.id, p.locationId);
        if (!rows.length) return '';
        const cards = rows
          .map((raw) => {
            const path = parseJson(raw, ['access']);
            const items = db.all<{ course_id: string; title: string; slug: string }>(`SELECT i.course_id, c.title, c.slug FROM course_path_items i JOIN courses c ON c.id = i.course_id WHERE i.path_id = ? AND c.status = 'published' ORDER BY i.position`, path.id);
            const steps = pathSteps(
              items.map((it) => {
                const en = getEnrollment(app, it.course_id, m.contact.id);
                return { course_id: it.course_id, title: it.title, percent: en?.status === 'active' ? enrollmentProgress(app, en).percent : undefined };
              }),
              { sequential: !!path.sequential, unlockPercent: path.unlock_percent },
            );
            const next = steps.find((x) => x.state === 'open');
            const list = steps
              .map((x, i) => {
                const slug = items[i].slug;
                const icon = x.state === 'done' ? '✓' : x.state === 'locked' ? '🔒' : '▶';
                const note = x.state === 'locked' ? 'gesperrt' : x.percent !== undefined ? `${x.percent} %` : '';
                const inner = `<span class="st" aria-hidden="true">${icon}</span><span class="t">${escapeHtml(x.title)}</span><span class="d">${escapeHtml(note)}</span>`;
                return x.state === 'locked' ? `<li><span class="s locked" title="${escapeHtml(x.reason)}">${inner}</span></li>` : `<li><a class="${x.state === 'done' ? 'done' : ''}${x === next ? ' current' : ''}" href="${p.base}/c/${encodeURIComponent(slug)}">${inner}</a></li>`;
              })
              .join('');
            const pct = pathPercent(steps);
            return `<div class="panel path"><h3>${escapeHtml(path.title)}</h3>${path.description ? `<p class="muted small" style="margin:0">${escapeHtml(path.description)}</p>` : ''}<div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" style="margin-top:10px"><i style="width:${pct}%"></i></div><p class="muted small" style="margin:6px 0 0">${steps.filter((x) => x.state === 'done').length} von ${steps.length} Kursen abgeschlossen${path.sequential ? ' · der Reihe nach' : ''}</p><ol class="steps">${list}</ol></div>`;
          })
          .join('');
        return `${CSS}<section class="lp"><h2>Deine Lernpfade</h2>${cards}</section>`;
      },
    ];

    // --- cohorts -----------------------------------------------------------------------------------------------------------------------------------
    const mustCourse = (loc: string, cid: string) => {
      const c = getCourse(app, loc, cid);
      if (!c) throw notFound('Kurs nicht gefunden');
      return c;
    };
    const cohortOf = (cid: string, id_: string) => db.get<any>('SELECT * FROM course_cohorts WHERE id = ? AND course_id = ?', id_, cid);
    const mustCohort = (cid: string, id_: string) => {
      const c = cohortOf(cid, id_);
      if (!c) throw notFound('Cohort nicht gefunden');
      return c;
    };
    const todayIn = (loc: string) => ymdInTz(new Date(), app.location(loc)?.timezone || 'Europe/Berlin');
    const countOf = (cohortId: string) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM course_enrollments WHERE cohort_id = ? AND status = 'active'`, cohortId)!.n;
    /** Group and channel of the community, as a link for the member (checked when saved). */
    const communityLink = (loc: string, groupId: unknown, channelId: unknown): { group_id: string | null; channel_id: string | null } => {
      const gid = str(groupId, 'Community-Gruppe', { max: 60 });
      if (!gid) return { group_id: null, channel_id: null };
      const g = db.get<any>('SELECT id FROM community_groups WHERE id = ? AND location_id = ?', gid, loc);
      if (!g) throw bad('Community-Gruppe nicht gefunden');
      const cid = str(channelId, 'Kanal', { max: 60 });
      if (cid && !db.get('SELECT id FROM community_channels WHERE id = ? AND group_id = ?', cid, g.id)) throw bad('Kanal nicht gefunden');
      return { group_id: g.id, channel_id: cid || null };
    };
    const dateOf = (v: unknown, what: string, required = true) => {
      try {
        return cleanYmd(v, what, required);
      } catch (e) {
        throw bad((e as Error).message);
      }
    };
    const cohortOut = (loc: string, c: any) => {
      const members = countOf(c.id);
      return { ...c, state: cohortState(c, todayIn(loc)), members, full: !!c.capacity && members >= c.capacity };
    };

    router.get('/api/courses/:id/cohorts', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      return db.all('SELECT * FROM course_cohorts WHERE course_id = ? ORDER BY starts_at DESC', c.id).map((x) => cohortOut(ctx.locationId, x));
    });
    router.post('/api/courses/:id/cohorts', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      const starts = dateOf(ctx.body?.starts_at, 'Startdatum');
      const ends = dateOf(ctx.body?.ends_at, 'Enddatum', false);
      if (ends && ends < starts) throw bad('Das Ende liegt vor dem Start');
      const link = communityLink(ctx.locationId, ctx.body?.group_id, ctx.body?.channel_id);
      const row = { id: id(), location_id: ctx.locationId, course_id: c.id, name: str(ctx.body?.name, 'Name', { required: true, max: 120 }), starts_at: starts, ends_at: ends || null, capacity: Math.min(Math.max(Math.round(num(ctx.body?.capacity)), 0), 100000), ...link, created_at: now(), updated_at: now() };
      db.insert('course_cohorts', row);
      return cohortOut(ctx.locationId, row);
    });
    router.patch('/api/courses/:id/cohorts/:cid', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      const k = mustCohort(c.id, ctx.params.cid);
      const b = ctx.body ?? {};
      const patch: Record<string, any> = { updated_at: now() };
      if (b.name !== undefined) patch.name = str(b.name, 'Name', { required: true, max: 120 });
      if (b.starts_at !== undefined) patch.starts_at = dateOf(b.starts_at, 'Startdatum');
      if (b.ends_at !== undefined) patch.ends_at = dateOf(b.ends_at, 'Enddatum', false) || null;
      if ((patch.ends_at ?? k.ends_at) && (patch.ends_at ?? k.ends_at) < (patch.starts_at ?? k.starts_at)) throw bad('Das Ende liegt vor dem Start');
      if (b.capacity !== undefined) patch.capacity = Math.min(Math.max(Math.round(num(b.capacity)), 0), 100000);
      if (b.group_id !== undefined || b.channel_id !== undefined) Object.assign(patch, communityLink(ctx.locationId, b.group_id ?? k.group_id, b.group_id === undefined ? b.channel_id ?? k.channel_id : b.channel_id));
      db.update('course_cohorts', k.id, patch);
      return cohortOut(ctx.locationId, mustCohort(c.id, k.id));
    });
    router.delete('/api/courses/:id/cohorts/:cid', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      const k = mustCohort(c.id, ctx.params.cid);
      db.tx(() => {
        db.run('UPDATE course_enrollments SET cohort_id = NULL WHERE cohort_id = ?', k.id);
        db.run('DELETE FROM course_cohorts WHERE id = ?', k.id);
      });
      return { ok: true };
    });
    router.get('/api/courses/:id/cohorts/:cid/members', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      const k = mustCohort(c.id, ctx.params.cid);
      return db
        .all<any>(`SELECT e.*, k.first_name, k.last_name, k.email FROM course_enrollments e JOIN contacts k ON k.id = e.contact_id WHERE e.cohort_id = ? ORDER BY e.enrolled_at`, k.id)
        .map((e) => ({ ...e, progress: enrollmentProgress(app, e) }));
    });
    router.post('/api/courses/:id/cohorts/:cid/members', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      const k = mustCohort(c.id, ctx.params.cid);
      const contactId = contactFrom(ctx.locationId, ctx.body, 'Kurse');
      const cur = getEnrollment(app, c.id, contactId);
      if (!(cur?.cohort_id === k.id) && k.capacity && countOf(k.id) >= k.capacity) throw new HttpError(409, 'Dieser Cohort ist voll');
      grantAccess(app, ctx.locationId, c.id, contactId, ctx.viaApiKey ? 'api' : 'manual', ctx.user?.name ?? '');
      db.run('UPDATE course_enrollments SET cohort_id = ? WHERE course_id = ? AND contact_id = ?', k.id, c.id, contactId);
      app.events.emit(ctx.locationId, 'course.cohort_joined', { contactId, courseId: c.id, cohortId: k.id, cohort: { id: k.id, name: k.name, starts_at: k.starts_at } });
      return { contact_id: contactId, cohort_id: k.id };
    });
    router.delete('/api/courses/:id/cohorts/:cid/members/:contactId', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      const k = mustCohort(c.id, ctx.params.cid);
      if (!db.run('UPDATE course_enrollments SET cohort_id = NULL WHERE cohort_id = ? AND contact_id = ? AND course_id = ?', k.id, ctx.params.contactId, c.id).changes) throw notFound('Nicht in diesem Cohort');
      return { ok: true };
    });

    // The course setting "automatisch zuweisen": a new member lands in the next open cohort.
    app.events.on('course.enrolled', (e) => {
      const { contactId, courseId } = e.data;
      if (!contactId || !courseId) return;
      const c = getCourse(app, e.locationId, courseId);
      const en = c && getEnrollment(app, c.id, contactId);
      if (!c || !en || en.cohort_id || courseSettings(c).cohort_mode !== 'auto') return;
      const list = db.all<any>('SELECT * FROM course_cohorts WHERE course_id = ?', c.id).map((x) => ({ ...x, members: countOf(x.id) }));
      const pick = pickCohort(list, todayIn(e.locationId));
      if (!pick) return;
      db.run('UPDATE course_enrollments SET cohort_id = ? WHERE id = ? AND cohort_id IS NULL', pick, en.id);
      const k = list.find((x) => x.id === pick)!;
      app.events.emit(e.locationId, 'course.cohort_joined', { contactId, courseId, cohortId: pick, cohort: { id: pick, name: k.name, starts_at: k.starts_at } });
    });

    // Cohort banner on the course page: name, start (or "läuft seit"), a link into the community channel.
    app.services.courseExtras = [
      ...((app.services.courseExtras as unknown[] | undefined) ?? []),
      (p: any, _m: any, s: any): { top: string } | undefined => {
        const k = s.enrollment.cohort_id && db.get<any>('SELECT * FROM course_cohorts WHERE id = ?', s.enrollment.cohort_id);
        if (!k) return undefined;
        const tz = p.loc.timezone;
        const state = cohortState(k, ymdInTz(new Date(), tz));
        const when = state === 'upcoming' ? `startet am ${deDate(dripOrigin(app, s.enrollment), tz)}` : state === 'running' ? `läuft seit ${deDate(dripOrigin(app, s.enrollment), tz)}` : 'ist beendet';
        const g = k.group_id && db.get<any>('SELECT slug FROM community_groups WHERE id = ? AND location_id = ?', k.group_id, p.locationId);
        const ch = g && k.channel_id && db.get<any>('SELECT slug FROM community_channels WHERE id = ? AND group_id = ?', k.channel_id, k.group_id);
        const link = g ? `<a class="btn ghost" href="${p.base}/community/g/${encodeURIComponent(g.slug)}${ch ? `?ch=${encodeURIComponent(ch.slug)}` : ''}">Zum Cohort-Chat</a>` : '';
        return { top: `${CSS}<div class="panel ch"><span><strong>Dein Cohort: ${escapeHtml(k.name)}</strong> <span class="muted">– ${escapeHtml(when)}</span></span>${link}</div>` };
      },
    ];
    app.services.coursePaths = { grantPath, revokePath };
  },
};
