import type { Module } from '../core/app.js';
import { HttpError, type Ctx } from '../core/http.js';
import { callRoute, clampInt, visibleLocations } from '../services/mobile.js';

/**
 * Creator & Commerce on the phone (Android app, /api/mobile/creator/*): read-only lists for the owner on the go – who pays in
 * instalments and who is behind, open payment failures and dunning notices waiting for approval, and quiz answers and hand-ins
 * waiting for a review. Every list relays onto the regular admin route per sub-account (callRoute), so the member's rights
 * (payments / courses) and the sub-account check are exactly those of the web app; a sub-account the user may not read is
 * skipped. Acting on an entry (approve a notice, grade a hand-in) happens in the web app. Documented in docs/api.md.
 */

export const creatorMobileModule: Module = {
  name: 'creator-mobile',
  register(app) {
    const { router } = app;

    /** Runs `fn` for every sub-account the user can open; the ones that refuse (no right, plan) are skipped – unless all refuse. */
    async function each<T>(ctx: Ctx, fn: (loc: { id: string; name: string }) => Promise<T>): Promise<{ loc: { id: string; name: string }; value: T }[]> {
      const want = String(ctx.query.get('location') ?? '').trim() || 'all';
      const visible = visibleLocations(app, ctx);
      const list = want === 'all' ? visible : visible.filter((l) => l.id === want);
      if (want !== 'all' && !list.length) throw new HttpError(403, 'Kein Zugriff auf diesen Sub-Account');
      const out: { loc: { id: string; name: string }; value: T }[] = [];
      let first: HttpError | undefined;
      for (const loc of list) {
        try {
          out.push({ loc, value: await fn(loc) });
        } catch (e) {
          if (!(e instanceof HttpError) || e.status >= 500) throw e;
          first ??= e;
        }
      }
      if (!out.length && first) throw first;
      return out;
    }
    const tag = (loc: { id: string; name: string }) => ({ location_id: loc.id, location_name: loc.name });
    const get = (ctx: Ctx, loc: { id: string }, path: string) => callRoute<any>(app, ctx, 'GET', path, { locationId: loc.id });

    /** Counters for the home screen: an area the user lacks counts as zero; a sub-account they cannot open is still an error. */
    router.get('/api/mobile/creator/overview', 'user', async (ctx) => {
      const want = String(ctx.query.get('location') ?? '').trim();
      if (want && want !== 'all' && !visibleLocations(app, ctx).some((l) => l.id === want)) throw new HttpError(403, 'Kein Zugriff auf diesen Sub-Account');
      const lenient = <T>(p: Promise<T[]>) =>
        p.catch((e) => {
          if (e instanceof HttpError && e.status < 500) return [] as T[];
          throw e;
        });
      const [pay, rev] = await Promise.all([
        lenient(
          each(ctx, async (loc) => {
            const [subs, dun] = await Promise.all([get(ctx, loc, '/api/payment-plans/subscriptions?limit=500'), get(ctx, loc, '/api/dunning/overview')]);
            return { subs, dun };
          }),
        ),
        lenient(each(ctx, (loc) => get(ctx, loc, '/api/quizzes/reviews'))),
      ]);
      const plans = { active: 0, defaulted: 0, completed: 0 };
      const dunning = { open_cases: 0, failed_cases: 0, pending_notices: 0, at_risk_cents: 0 };
      for (const { value } of pay) {
        for (const s of value.subs) if (s.status in plans) plans[s.status as keyof typeof plans]++;
        dunning.open_cases += value.dun.cases.open;
        dunning.failed_cases += value.dun.cases.failed;
        dunning.pending_notices += value.dun.notices.pending;
        dunning.at_risk_cents += value.dun.cases.at_risk_cents;
      }
      const reviews = { quiz_attempts: 0, assignment_submissions: 0 };
      for (const { value } of rev) {
        reviews.quiz_attempts += value.counts.quiz_attempts;
        reviews.assignment_submissions += value.counts.assignment_submissions;
      }
      return { payment_plans: plans, dunning, reviews, locations: { payments: pay.length, courses: rev.length } };
    });

    /** Instalment purchases: `?status=active|defaulted|completed|canceled`, `?location=` one sub-account. */
    router.get('/api/mobile/creator/payment-plans', 'user', async (ctx) => {
      const status = String(ctx.query.get('status') ?? '').replace(/[^a-z_]/g, '');
      const limit = clampInt(ctx.query.get('limit'), 50, 1, 200);
      const rows = await each(ctx, (loc) => get(ctx, loc, `/api/payment-plans/subscriptions?limit=${limit}${status ? `&status=${status}` : ''}`));
      return rows
        .flatMap(({ loc, value }) =>
          value.map((s: any) => ({
            ...tag(loc),
            id: s.id,
            contact: { id: s.contact?.id ?? null, name: s.contact?.name ?? '' },
            product_name: s.product_name ?? '',
            plan_name: s.plan_name ?? '',
            installments: s.installments,
            paid_count: s.paid_count,
            failed_count: s.failed_count,
            amount_cents: s.amount_cents,
            paid_cents: s.paid_cents,
            currency: s.currency,
            status: s.status,
            access: s.access,
            started_at: s.started_at,
            link: '/app/payment-plans',
          })),
        )
        .sort((a: any, b: any) => String(b.started_at).localeCompare(String(a.started_at)))
        .slice(0, limit);
    });

    /** Open payment failures of subscriptions and invoice dunning notices that wait for approval. */
    router.get('/api/mobile/creator/dunning', 'user', async (ctx) => {
      const limit = clampInt(ctx.query.get('limit'), 50, 1, 200);
      const rows = await each(ctx, async (loc) => ({
        open: await get(ctx, loc, `/api/dunning/cases?status=open&limit=${limit}`),
        failed: await get(ctx, loc, `/api/dunning/cases?status=failed&limit=${limit}`),
        notices: await get(ctx, loc, `/api/dunning/notices?status=pending&limit=${limit}`),
      }));
      const cases = rows
        .flatMap(({ loc, value }) => [...value.open, ...value.failed].map((c: any) => ({ ...tag(loc), id: c.id, contact: { id: c.contact?.id ?? null, name: c.contact?.name ?? '' }, product_name: c.product_name ?? '', amount_cents: c.amount_cents, currency: c.currency, status: c.status, attempts: c.attempts, next_attempt_at: c.next_attempt_at ?? null, first_failed_at: c.first_failed_at, access_paused: !!c.access_paused, link: '/app/dunning' })))
        .sort((a: any, b: any) => String(b.first_failed_at).localeCompare(String(a.first_failed_at)))
        .slice(0, limit);
      const notices = rows
        .flatMap(({ loc, value }) => value.notices.map((n: any) => ({ ...tag(loc), id: n.id, invoice_id: n.invoice_id, invoice_number: n.invoice_number ?? '', contact: { id: n.contact?.id ?? null, name: n.contact?.name ?? '' }, level: n.level, label: n.label, total_cents: n.total_cents, currency: n.currency, created_at: n.created_at, link: '/app/dunning' })))
        .sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit);
      return { cases, notices };
    });

    /** Quiz answers and hand-ins that wait for a person. */
    router.get('/api/mobile/creator/reviews', 'user', async (ctx) => {
      const rows = await each(ctx, (loc) => get(ctx, loc, '/api/quizzes/reviews'));
      const quiz = rows.flatMap(({ loc, value }) => value.quiz_attempts.map((a: any) => ({ ...tag(loc), id: a.id, kind: 'quiz', title: a.quiz_title, course_title: a.course_title, contact: a.contact, attempt_no: a.attempt_no, submitted_at: a.submitted_at, open_questions: a.questions.length, link: '/app/quizzes/reviews' })));
      const hand = rows.flatMap(({ loc, value }) => value.assignment_submissions.map((s: any) => ({ ...tag(loc), id: s.id, kind: 'assignment', title: s.assignment_title ?? s.title ?? '', course_title: s.course_title ?? '', contact: s.contact ?? { id: s.contact_id ?? null, name: '' }, attempt_no: s.attempt_no, submitted_at: s.submitted_at, has_file: !!s.has_file, link: '/app/quizzes/reviews' })));
      return [...quiz, ...hand].sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at))).slice(0, clampInt(ctx.query.get('limit'), 50, 1, 200));
    });
  },
};
