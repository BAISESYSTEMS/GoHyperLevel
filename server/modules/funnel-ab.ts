import { randomBytes } from 'node:crypto';
import type { Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { bad, html, notFound, num, str, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { logActivity } from '../services/contacts.js';
import { isBot, pickVariant, summarize } from '../services/ab-stats.js';
import { cleanBlocks, pageUrl, renderPage } from './funnels.js';

/**
 * A/B split tests for funnel and website pages. The live page is variant A; B, C, D are copies
 * that can be edited on their own. Visitors get a variant by weight and keep it (first-party
 * cookie with a random id, no personal data); bots are not counted. A conversion (form, booking,
 * purchase or a visit of a goal page) counts once per visitor and is logged on the contact.
 * Forms, booking widgets and buy links on the visitor's pages carry the visitor id (`_ab` / `ab`),
 * because a sandboxed funnel page cannot send cookies with them.
 */

const COOKIE = 'pghl_ab';
const VISITOR = /^[A-Za-z0-9]{20}$/;
const KEYS = ['A', 'B', 'C', 'D'];
const GOALS = ['form', 'booking', 'purchase', 'page'] as const;
type GoalType = (typeof GOALS)[number];
interface Goal {
  type: GoalType;
  form_id?: string;
  calendar_id?: string;
  product_id?: string;
  page_id?: string;
  url?: string;
}
const GOAL_LABEL: Record<GoalType, string> = { form: 'Formular abgeschickt', booking: 'Termin gebucht', purchase: 'Kauf', page: 'Zielseite besucht' };
const ACTIVE = `('draft', 'running', 'paused')`;

const random = () => randomBytes(4).readUInt32BE() / 2 ** 32;
const validVisitor = (v: unknown): v is string => typeof v === 'string' && VISITOR.test(v);

/** Path part of a goal URL ("https://x.de/danke/?a=1" → "/danke"). */
function goalPath(u: string): string {
  const s = String(u ?? '').trim();
  if (!s) return '';
  let path = s;
  try {
    path = new URL(s, 'http://x').pathname;
  } catch {
    /* keep as typed */
  }
  return path.replace(/\/+$/, '') || '/';
}

/** Adds the visitor id to forms, booking widgets and buy links of a rendered page. */
export function tagPage(page: string, visitor: string): string {
  if (!validVisitor(visitor)) return page;
  return page
    .replace(/(<form\b[^>]*\bclass="pghl-form"[^>]*>)/g, `$1<input type="hidden" name="_ab" value="${visitor}">`)
    .replace(/(src="[^"]*\/book\/[^"?]+\?embed=1)(")/g, `$1&amp;ab=${visitor}$2`)
    .replace(/href="([^"]*\/buy\/[^"]+)"/g, (m, u: string) => {
      if (/[?&](amp;)?ab=/.test(u)) return m;
      const [path, hash] = u.split('#');
      return `href="${path}${path.includes('?') ? '&amp;' : '?'}ab=${visitor}${hash !== undefined ? `#${hash}` : ''}"`;
    });
}

export const funnelAbModule: Module = {
  name: 'funnel-ab',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE ab_tests (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
        page_id TEXT NOT NULL REFERENCES funnel_pages(id) ON DELETE CASCADE,
        name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', goal TEXT NOT NULL DEFAULT '{}',
        winner_id TEXT, started_at TEXT, ended_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX ab_tests_page ON ab_tests(page_id, status);
      CREATE INDEX ab_tests_location ON ab_tests(location_id, status);
      CREATE TABLE ab_variants (
        id TEXT PRIMARY KEY, test_id TEXT NOT NULL REFERENCES ab_tests(id) ON DELETE CASCADE, location_id TEXT NOT NULL,
        key TEXT NOT NULL, name TEXT NOT NULL, weight INTEGER NOT NULL DEFAULT 50, is_control INTEGER NOT NULL DEFAULT 0,
        blocks TEXT NOT NULL DEFAULT '[]', seo TEXT NOT NULL DEFAULT '{}', archived INTEGER NOT NULL DEFAULT 0,
        views INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(test_id, key)
      );
      CREATE TABLE ab_assignments (
        test_id TEXT NOT NULL REFERENCES ab_tests(id) ON DELETE CASCADE, visitor TEXT NOT NULL,
        variant_id TEXT NOT NULL REFERENCES ab_variants(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL, converted_at TEXT, contact_id TEXT, PRIMARY KEY (test_id, visitor)
      );
      CREATE INDEX ab_assignments_visitor ON ab_assignments(visitor);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;

    const getTest = (locationId: string, tid: string) => parseJson(db.get('SELECT * FROM ab_tests WHERE id = ? AND location_id = ?', tid, locationId), ['goal']);
    const variantsOf = (tid: string) => parseRows(db.all('SELECT * FROM ab_variants WHERE test_id = ? ORDER BY key', tid), ['blocks', 'seo']);
    const getPage = (locationId: string, pid: string) => parseJson(db.get('SELECT * FROM funnel_pages WHERE id = ? AND location_id = ?', pid, locationId), ['blocks', 'seo']);
    const getFunnel = (fid: string) => parseJson(db.get('SELECT * FROM funnels WHERE id = ?', fid), ['settings']);

    function testOut(t: any, withBlocks = false) {
      const variants = variantsOf(t.id);
      const counts = new Map<string, { visitors: number; conversions: number }>();
      for (const r of db.all('SELECT variant_id, COUNT(*) AS visitors, COUNT(converted_at) AS conversions FROM ab_assignments WHERE test_id = ? GROUP BY variant_id', t.id)) {
        counts.set(r.variant_id, { visitors: Number(r.visitors), conversions: Number(r.conversions) });
      }
      const stats = summarize(variants.map((v) => ({ id: v.id, key: v.key, is_control: !!v.is_control, visitors: counts.get(v.id)?.visitors ?? 0, conversions: counts.get(v.id)?.conversions ?? 0 })));
      const page = db.get('SELECT id, name, slug, funnel_id FROM funnel_pages WHERE id = ?', t.page_id);
      const funnel = page ? getFunnel(page.funnel_id) : undefined;
      const pages = funnel ? db.all('SELECT id FROM funnel_pages WHERE funnel_id = ? ORDER BY position, created_at', funnel.id) : [];
      const g: Goal = t.goal ?? {};
      const named = (table: string, rid?: string) => (rid ? (db.get(`SELECT name FROM ${table} WHERE id = ?`, rid)?.name ?? '') : '');
      return {
        id: t.id,
        name: t.name,
        status: t.status,
        goal: t.goal,
        goal_label: GOAL_LABEL[g.type] ?? '',
        goal_target: named('forms', g.form_id) || named('calendars', g.calendar_id) || named('products', g.product_id) || named('funnel_pages', g.page_id) || g.url || '',
        funnel_id: t.funnel_id,
        page_id: t.page_id,
        page: page && funnel ? { id: page.id, name: page.name, url: pageUrl(app, funnel, page, pages[0]?.id === page.id) } : null,
        winner_id: t.winner_id,
        started_at: t.started_at,
        ended_at: t.ended_at,
        created_at: t.created_at,
        updated_at: t.updated_at,
        small_sample: stats.small_sample,
        leader: stats.leader,
        visitors: stats.variants.reduce((s, v) => s + v.visitors, 0),
        conversions: stats.variants.reduce((s, v) => s + v.conversions, 0),
        variants: variants.map((v) => {
          const st = stats.variants.find((x) => x.id === v.id)!;
          return {
            id: v.id,
            key: v.key,
            name: v.name,
            weight: v.weight,
            is_control: !!v.is_control,
            archived: !!v.archived,
            views: v.views,
            ...(withBlocks ? { blocks: v.blocks, seo: v.seo } : {}),
            visitors: st.visitors,
            conversions: st.conversions,
            rate: st.rate,
            uplift: st.uplift,
            z: st.z,
            p_value: st.p_value,
            significant: st.significant,
            prob_beat: st.prob_beat,
            verdict: st.verdict,
          };
        }),
      };
    }

    function cleanGoal(locationId: string, pageId: string, input: any, strict: boolean): Goal {
      const type = GOALS.includes(input?.type) ? (input.type as GoalType) : undefined;
      if (!type) {
        if (strict) throw bad('Ziel wählen: Formular, Termin, Kauf oder Seite');
        return { type: 'form' };
      }
      const ref = (k: string) => (typeof input?.[k] === 'string' ? input[k].trim() : '');
      const goal: Goal = { type };
      if (type === 'form' && ref('form_id')) {
        if (!db.get('SELECT id FROM forms WHERE id = ? AND location_id = ?', ref('form_id'), locationId)) throw bad('Formular nicht gefunden');
        goal.form_id = ref('form_id');
      }
      if (type === 'booking' && ref('calendar_id')) {
        if (!db.get('SELECT id FROM calendars WHERE id = ? AND location_id = ?', ref('calendar_id'), locationId)) throw bad('Kalender nicht gefunden');
        goal.calendar_id = ref('calendar_id');
      }
      if (type === 'purchase' && ref('product_id')) {
        if (!db.get('SELECT id FROM products WHERE id = ? AND location_id = ?', ref('product_id'), locationId)) throw bad('Produkt nicht gefunden');
        goal.product_id = ref('product_id');
      }
      if (type === 'page') {
        if (ref('page_id')) {
          if (ref('page_id') === pageId) throw bad('Die Zielseite muss eine andere Seite sein als die getestete');
          if (!db.get('SELECT id FROM funnel_pages WHERE id = ? AND location_id = ?', ref('page_id'), locationId)) throw bad('Zielseite nicht gefunden');
          goal.page_id = ref('page_id');
        } else if (ref('url')) {
          goal.url = str(ref('url'), 'Ziel-URL', { max: 500 });
        } else if (strict) throw bad('Zielseite oder Ziel-URL wählen');
      }
      return goal;
    }

    /** Spreads 100 % evenly over the active variants (A gets the remainder). */
    function rebalance(tid: string) {
      const vs = db.all('SELECT id FROM ab_variants WHERE test_id = ? AND archived = 0 ORDER BY key', tid);
      if (!vs.length) return;
      const each = Math.floor(100 / vs.length);
      vs.forEach((v, i) => db.run('UPDATE ab_variants SET weight = ? WHERE id = ?', i === 0 ? 100 - each * (vs.length - 1) : each, v.id));
    }

    function addVariant(t: any, from: { blocks: any; seo: any }, name?: string) {
      const used = new Set(db.all('SELECT key FROM ab_variants WHERE test_id = ?', t.id).map((r) => r.key));
      const key = KEYS.find((k) => !used.has(k));
      if (!key) throw bad('Höchstens 4 Varianten (A–D)');
      const v = {
        id: id(),
        test_id: t.id,
        location_id: t.location_id,
        key,
        name: str(name, 'Name', { max: 80 }) || `Variante ${key}`,
        weight: 0,
        is_control: 0,
        blocks: from.blocks ?? [],
        seo: from.seo ?? {},
        created_at: now(),
        updated_at: now(),
      };
      db.insert('ab_variants', v);
      rebalance(t.id);
      return v;
    }

    // --- conversions ----------------------------------------------------------------------
    /** Counts a conversion for every running test of the location this visitor is in whose goal matches. */
    function convert(locationId: string, visitor: unknown, type: GoalType, matches: (g: Goal) => boolean, contactId: string | null) {
      if (!validVisitor(visitor)) return 0;
      const rows = db.all(
        `SELECT a.test_id, a.variant_id, t.name, t.goal, v.key, v.name AS variant_name FROM ab_assignments a
         JOIN ab_tests t ON t.id = a.test_id JOIN ab_variants v ON v.id = a.variant_id
         WHERE a.visitor = ? AND a.converted_at IS NULL AND t.location_id = ? AND t.status = 'running'`,
        visitor,
        locationId,
      );
      let n = 0;
      for (const r of rows) {
        const goal = (parseJson({ goal: r.goal }, ['goal']).goal ?? {}) as Goal;
        if (goal.type !== type || !matches(goal)) continue;
        const changed = db.run('UPDATE ab_assignments SET converted_at = ?, contact_id = ? WHERE test_id = ? AND visitor = ? AND converted_at IS NULL', now(), contactId, r.test_id, visitor).changes;
        if (!changed) continue;
        n++;
        if (contactId && db.get('SELECT id FROM contacts WHERE id = ? AND location_id = ?', contactId, locationId)) {
          logActivity(app, locationId, contactId, 'ab.converted', `A/B-Test „${r.name}“: Variante ${r.key} (${r.variant_name}) – ${GOAL_LABEL[type]}`, {
            test_id: r.test_id,
            variant_id: r.variant_id,
            variant: r.key,
            goal: type,
          });
        }
      }
      return n;
    }

    app.events.on('form.submitted', (e) => {
      const ab = e.data.submission?.meta?.ab;
      convert(e.locationId, ab, 'form', (g) => !g.form_id || g.form_id === e.data.formId, e.data.contactId ?? null);
    });
    app.events.on('appointment.booked', (e) => {
      convert(e.locationId, e.data.meta?.ab, 'booking', (g) => !g.calendar_id || g.calendar_id === e.data.calendarId, e.data.contactId ?? null);
    });
    app.events.on('product.purchased', (e) => {
      convert(e.locationId, e.data.metadata?.ab, 'purchase', (g) => !g.product_id || g.product_id === e.data.productId, e.data.contactId ?? null);
    });

    // --- serving: assignment, page goal, attribution ----------------------------------------
    function assign(test: any, visitor: string) {
      const known = db.get('SELECT v.* FROM ab_assignments a JOIN ab_variants v ON v.id = a.variant_id WHERE a.test_id = ? AND a.visitor = ?', test.id, visitor);
      if (known && !known.archived) return known;
      const vs = db.all<{ id: string; weight: number; [k: string]: any }>('SELECT * FROM ab_variants WHERE test_id = ? AND archived = 0 ORDER BY key', test.id);
      if (!vs.length) return undefined;
      const v = pickVariant(vs, random());
      db.run(
        `INSERT INTO ab_assignments (test_id, visitor, variant_id, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(test_id, visitor) DO UPDATE SET variant_id = excluded.variant_id, converted_at = NULL, contact_id = NULL`,
        test.id,
        visitor,
        v.id,
        now(),
      );
      return v;
    }

    app.services.pageServe = [
      ...(app.services.pageServe ?? []),
      (ctx: Ctx, funnel: any, page: any) => {
        const purpose = String(ctx.req.headers['sec-purpose'] ?? ctx.req.headers.purpose ?? '');
        if (isBot(String(ctx.req.headers['user-agent'] ?? ''), purpose)) return undefined;
        let visitor = validVisitor(ctx.cookies[COOKIE]) ? ctx.cookies[COOKIE] : '';
        const test = db.get(`SELECT * FROM ab_tests WHERE page_id = ? AND status = 'running'`, page.id);
        let out: { page?: any; transform?: (h: string) => string; headers?: Record<string, string> } | undefined;
        if (test) {
          visitor ||= id(20);
          ctx.setCookie(COOKIE, visitor, { maxAge: 180 * 86400 });
          const v = assign(test, visitor);
          out = { headers: { 'cache-control': 'private, no-store' } };
          if (v) {
            db.run('UPDATE ab_variants SET views = views + 1 WHERE id = ?', v.id);
            if (!v.is_control) {
              const blocks = parseJson({ b: v.blocks }, ['b']).b;
              const seo = parseJson({ s: v.seo }, ['s']).s ?? {};
              out.page = { ...page, blocks: Array.isArray(blocks) ? blocks : page.blocks, seo: { ...(page.seo ?? {}), ...seo } };
            }
          }
        }
        if (!visitor) return out;
        const paths = new Set([goalPath(ctx.url.pathname), goalPath(ctx.path)]);
        convert(funnel.location_id, visitor, 'page', (g) => g.page_id === page.id || (!!g.url && paths.has(goalPath(g.url))), null);
        const inTest = db.get(`SELECT 1 AS x FROM ab_assignments a JOIN ab_tests t ON t.id = a.test_id WHERE a.visitor = ? AND t.location_id = ? AND t.status = 'running' LIMIT 1`, visitor, funnel.location_id);
        if (inTest) (out ??= {}).transform = (h: string) => tagPage(h, visitor);
        return out;
      },
    ];

    // Buy links: keep the visitor id through the buy page into the Checkout metadata.
    app.services.buyPageHtml = [
      ...(app.services.buyPageHtml ?? []),
      (ctx: Ctx) => {
        const ab = ctx.query.get('ab') || ctx.cookies[COOKIE];
        return validVisitor(ab) ? `<input type="hidden" name="ab" value="${ab}">` : '';
      },
    ];
    app.services.buyCheckout = [
      ...(app.services.buyCheckout ?? []),
      (ctx: Ctx, { meta }: { meta: Record<string, any> }) => {
        if (validVisitor(ctx.body?.ab)) meta.ab = ctx.body.ab;
      },
    ];

    // --- API -------------------------------------------------------------------------------
    const testOr404 = (ctx: Ctx) => {
      const t = getTest(ctx.locationId, ctx.params.id);
      if (!t) throw notFound('Test nicht gefunden');
      return t;
    };
    const variantOr404 = (ctx: Ctx) => {
      const v = parseJson(db.get('SELECT * FROM ab_variants WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId), ['blocks', 'seo']);
      if (!v) throw notFound('Variante nicht gefunden');
      return { v, t: getTest(ctx.locationId, v.test_id)! };
    };
    const touch = (tid: string, patch: Record<string, any> = {}) => db.update('ab_tests', tid, { ...patch, updated_at: now() });

    router.get('/api/ab-tests', 'location', (ctx) => {
      const where = ['location_id = ?'];
      const params: string[] = [ctx.locationId];
      for (const k of ['page_id', 'funnel_id', 'status']) {
        const v = ctx.query.get(k);
        if (v) (where.push(`${k} = ?`), params.push(v));
      }
      return parseRows(db.all(`SELECT * FROM ab_tests WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 500`, ...params), ['goal']).map((t) => testOut(t));
    });
    router.get('/api/ab-tests/:id', 'location', (ctx) => testOut(testOr404(ctx), ctx.query.get('blocks') !== '0'));

    router.post('/api/ab-tests', 'location', (ctx) => {
      const page = getPage(ctx.locationId, str(ctx.body.page_id, 'Seite', { required: true }));
      if (!page) throw notFound('Seite nicht gefunden');
      if (db.get(`SELECT id FROM ab_tests WHERE page_id = ? AND status IN ${ACTIVE}`, page.id)) throw bad('Für diese Seite gibt es schon einen offenen Test');
      const t = {
        id: id(),
        location_id: ctx.locationId,
        funnel_id: page.funnel_id,
        page_id: page.id,
        name: str(ctx.body.name, 'Name', { max: 120 }) || `Test: ${page.name}`,
        status: 'draft',
        goal: cleanGoal(ctx.locationId, page.id, ctx.body.goal, false),
        created_at: now(),
        updated_at: now(),
      };
      db.tx(() => {
        db.insert('ab_tests', t);
        db.insert('ab_variants', { id: id(), test_id: t.id, location_id: t.location_id, key: 'A', name: 'Original', weight: 50, is_control: 1, created_at: now(), updated_at: now() });
        addVariant(t, { blocks: page.blocks, seo: {} });
      });
      return testOut(getTest(ctx.locationId, t.id), true);
    });

    router.patch('/api/ab-tests/:id', 'location', (ctx) => {
      const t = testOr404(ctx);
      if (t.status === 'ended') throw bad('Der Test ist beendet');
      const patch: Record<string, any> = {};
      if (ctx.body.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true, max: 120 });
      if (ctx.body.goal !== undefined) patch.goal = cleanGoal(ctx.locationId, t.page_id, ctx.body.goal, t.status !== 'draft');
      if (ctx.body.weights && typeof ctx.body.weights === 'object') {
        const active = db.all('SELECT id, weight FROM ab_variants WHERE test_id = ? AND archived = 0', t.id);
        const next = new Map(active.map((v) => [v.id, Number(v.weight)]));
        for (const [vid, w] of Object.entries(ctx.body.weights)) {
          if (!next.has(vid)) throw bad('Unbekannte Variante');
          const n = Math.round(num(w, -1));
          if (n < 0 || n > 100) throw bad('Aufteilung: 0 bis 100 %');
          next.set(vid, n);
        }
        const sum = [...next.values()].reduce((s, n) => s + n, 0);
        if (sum !== 100) throw bad(`Die Aufteilung muss zusammen 100 % ergeben (jetzt ${sum} %)`);
        db.tx(() => {
          for (const [vid, n] of next) db.run('UPDATE ab_variants SET weight = ?, updated_at = ? WHERE id = ?', n, now(), vid);
        });
      }
      touch(t.id, patch);
      return testOut(getTest(ctx.locationId, t.id), true);
    });

    router.delete('/api/ab-tests/:id', 'location', (ctx) => {
      const t = testOr404(ctx);
      if (t.status === 'running') throw bad('Laufenden Test erst pausieren oder beenden');
      db.run('DELETE FROM ab_tests WHERE id = ?', t.id);
      return { ok: true };
    });

    router.post('/api/ab-tests/:id/variants', 'location', (ctx) => {
      const t = testOr404(ctx);
      if (t.status === 'ended') throw bad('Der Test ist beendet');
      const page = getPage(ctx.locationId, t.page_id)!;
      const src = ctx.body.from ? variantsOf(t.id).find((v) => v.id === ctx.body.from && !v.is_control) : undefined;
      addVariant(t, src ? { blocks: src.blocks, seo: src.seo } : { blocks: page.blocks, seo: {} }, ctx.body.name);
      touch(t.id);
      return testOut(getTest(ctx.locationId, t.id), true);
    });

    router.patch('/api/ab-variants/:id', 'location', (ctx) => {
      const { v, t } = variantOr404(ctx);
      if (t.status === 'ended') throw bad('Der Test ist beendet');
      const patch: Record<string, any> = { updated_at: now() };
      if (ctx.body.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true, max: 80 });
      if (ctx.body.blocks !== undefined || ctx.body.seo !== undefined) {
        if (v.is_control) throw bad('Variante A ist die Live-Seite – bitte im Tab „Inhalt“ bearbeiten');
        if (ctx.body.blocks !== undefined) patch.blocks = cleanBlocks(ctx.body.blocks);
        if (ctx.body.seo && typeof ctx.body.seo === 'object') patch.seo = { ...v.seo, ...ctx.body.seo };
      }
      db.update('ab_variants', v.id, patch);
      touch(t.id);
      return parseJson(db.get('SELECT * FROM ab_variants WHERE id = ?', v.id), ['blocks', 'seo']);
    });

    router.delete('/api/ab-variants/:id', 'location', (ctx) => {
      const { v, t } = variantOr404(ctx);
      if (t.status === 'ended') throw bad('Der Test ist beendet');
      if (v.is_control) throw bad('Variante A (Original) kann nicht gelöscht werden');
      const left = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ab_variants WHERE test_id = ? AND archived = 0', t.id)!.n;
      if (t.status === 'running' && left <= 2) throw bad('Ein laufender Test braucht mindestens zwei Varianten');
      db.run('DELETE FROM ab_variants WHERE id = ?', v.id);
      rebalance(t.id);
      touch(t.id);
      return testOut(getTest(ctx.locationId, t.id), true);
    });

    /** Builder preview of a variant without saving. */
    router.post('/api/ab-variants/:id/preview', 'location', (ctx) => {
      const { v, t } = variantOr404(ctx);
      const page = getPage(ctx.locationId, t.page_id)!;
      const funnel = getFunnel(page.funnel_id);
      const blocks = cleanBlocks(ctx.body.blocks ?? (v.is_control ? page.blocks : v.blocks));
      return html(renderPage(app, funnel, { ...page, blocks, seo: { ...page.seo, ...(v.is_control ? {} : v.seo) } }));
    });

    router.post('/api/ab-tests/:id/start', 'location', (ctx) => {
      const t = testOr404(ctx);
      if (t.status === 'running') return testOut(t, true);
      if (t.status === 'ended') throw bad('Der Test ist beendet – lege einen neuen an');
      const goal = cleanGoal(ctx.locationId, t.page_id, t.goal, true);
      const active = db.all('SELECT weight FROM ab_variants WHERE test_id = ? AND archived = 0', t.id);
      if (active.length < 2) throw bad('Mindestens zwei Varianten nötig');
      const sum = active.reduce((s, v) => s + Number(v.weight), 0);
      if (sum !== 100) throw bad(`Die Aufteilung muss zusammen 100 % ergeben (jetzt ${sum} %)`);
      if (active.filter((v) => Number(v.weight) > 0).length < 2) throw bad('Mindestens zwei Varianten brauchen Besucher (Aufteilung > 0 %)');
      touch(t.id, { status: 'running', goal, started_at: t.started_at ?? now() });
      return testOut(getTest(ctx.locationId, t.id), true);
    });
    router.post('/api/ab-tests/:id/pause', 'location', (ctx) => {
      const t = testOr404(ctx);
      if (t.status !== 'running') throw bad('Der Test läuft nicht');
      touch(t.id, { status: 'paused' });
      return testOut(getTest(ctx.locationId, t.id), true);
    });
    router.post('/api/ab-tests/:id/end', 'location', (ctx) => {
      const t = testOr404(ctx);
      if (t.status === 'ended') return testOut(t, true);
      db.tx(() => {
        db.run('UPDATE ab_variants SET archived = 1 WHERE test_id = ? AND is_control = 0', t.id);
        touch(t.id, { status: 'ended', ended_at: now() });
      });
      return testOut(getTest(ctx.locationId, t.id), true);
    });

    /** The winner becomes the live page; the old page content stays on variant A (archived). */
    router.post('/api/ab-tests/:id/winner', 'location', (ctx) => {
      const t = testOr404(ctx);
      if (t.winner_id) throw bad('Für diesen Test steht der Gewinner schon fest');
      const all = variantsOf(t.id);
      const win = all.find((v) => v.id === ctx.body.variant_id);
      if (!win) throw bad('Variante wählen');
      const page = getPage(ctx.locationId, t.page_id);
      if (!page) throw notFound('Seite nicht gefunden');
      db.tx(() => {
        if (!win.is_control) {
          const control = all.find((v) => v.is_control)!;
          db.update('ab_variants', control.id, { blocks: page.blocks, seo: page.seo, updated_at: now() });
          db.update('funnel_pages', page.id, { blocks: win.blocks, seo: { ...page.seo, ...win.seo }, updated_at: now() });
          db.run('UPDATE funnels SET updated_at = ? WHERE id = ?', now(), page.funnel_id);
        }
        db.run('UPDATE ab_variants SET archived = CASE WHEN id = ? THEN 0 ELSE 1 END, updated_at = ? WHERE test_id = ?', win.id, now(), t.id);
        touch(t.id, { status: 'ended', winner_id: win.id, ended_at: t.ended_at ?? now() });
      });
      return testOut(getTest(ctx.locationId, t.id), true);
    });

    // --- MCP ---------------------------------------------------------------------------------
    app.services.mcpTools = [
      ...(app.services.mcpTools ?? []),
      {
        name: 'ghl_ab_test_results',
        title: 'A/B-Test-Ergebnisse',
        description:
          'Ergebnisse der A/B-Tests auf Funnel-/Website-Seiten: je Variante Besucher, Conversions, Conversion-Rate, Uplift gegenüber dem Original, p-Wert (z-Test), Signifikanz und Wahrscheinlichkeit, das Original zu schlagen; small_sample warnt vor zu wenig Daten. Mit test_id ein Test, sonst alle des Projekts (optional nach funnel_id, page_id oder status gefiltert).',
        inputSchema: {
          type: 'object',
          properties: {
            location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' },
            test_id: { type: 'string' },
            funnel_id: { type: 'string' },
            page_id: { type: 'string' },
            status: { type: 'string', enum: ['draft', 'running', 'paused', 'ended'] },
          },
          required: ['location_id'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
        run: (call: any, a: any) => {
          if (a.test_id) return call.api('GET', `/api/ab-tests/${encodeURIComponent(a.test_id)}?blocks=0`, { location: a.location_id });
          const q = new URLSearchParams(Object.entries({ funnel_id: a.funnel_id, page_id: a.page_id, status: a.status }).filter(([, v]) => v) as [string, string][]).toString();
          return call.api('GET', `/api/ab-tests${q ? `?${q}` : ''}`, { location: a.location_id });
        },
      },
    ];
  },
};

export const AB_COOKIE = COOKIE;
