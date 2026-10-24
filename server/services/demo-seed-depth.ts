import { id } from '../core/util.js';
import { COURSE_PLANS, SITE_PLANS, type CoursePlan } from './demo-seed-content.js';
import type { Kit } from './demo-seed-extras.js';

/**
 * The depth of the demo seed (services/demo-seed.ts): courses with modules, lessons, a quiz, members with progress and a
 * learning path; landing pages and funnels with visits and conversions; sent campaigns with opens and clicks; workflow runs;
 * a helpdesk with answered tickets and customer ratings; a wiki, team chat and community. Records are created through the
 * routes; only what a route stamps with "now" (dates) or cannot know (progress of a learner, opens of a mail) is written
 * directly with the same table helpers the rest of the seed uses.
 */

const DAY = 864e5;
const int = (k: Kit, a: number, b: number) => a + Math.floor(k.rand() * (b - a + 1));
const pickOf = <T>(k: Kit, list: readonly T[]): T => list[Math.floor(k.rand() * list.length)];
const iso = (ms: number) => new Date(ms).toISOString();
/** Today at 9 o'clock – or now, when that is earlier (the nightly reset runs at 3): nothing is dated into the future. */
const todayMs = (k: Kit) => Math.min(Date.parse(k.inDays(0, 9)), k.nowMs - 60_000);
const nameOf = (c: any) => `${c.first_name} ${c.last_name}`.trim();

// --- courses -------------------------------------------------------------------------------------------------------------

/** Course members and how far they got: from "not started" to "finished". */
const PROGRESS = [1, 0.8, 0.5, 0.25, 0.65, 0, 0.9, 0.4];

async function seedCourse(k: Kit, cp: CoursePlan, index: number) {
  const db = k.app.db;
  const course = await k.call('POST', '/api/courses', { title: cp.title, description: cp.description, empty: true });
  if (!course?.id) return undefined;
  const lessons: { id: string; module: number }[] = [];
  for (const [mi, [mt, ls]] of cp.modules.entries()) {
    const mod = await k.call('POST', `/api/courses/${course.id}/modules`, { title: mt });
    if (!mod?.id) continue;
    for (const [title, text, minutes] of ls) {
      const l = await k.call('POST', `/api/courses/${course.id}/lessons`, { module_id: mod.id, title, body: `## ${title}\n\n${text}\n\n- Erfundener Demo-Inhalt\n- Du kannst ihn im Kurs-Editor frei bearbeiten`, duration_min: minutes, published: true });
      if (l?.id) lessons.push({ id: l.id, module: mi });
    }
  }
  if (cp.quiz && lessons.length > 2)
    await k.call('POST', '/api/quizzes', {
      course_id: course.id,
      lesson_id: lessons[Math.min(2, lessons.length - 1)].id,
      title: cp.quiz.title,
      intro: 'Kurzer Check – du darfst es so oft versuchen, wie du möchtest.',
      pass_percent: 70,
      questions: cp.quiz.questions.map((q) => ({ kind: q.options.filter((o) => o[1]).length > 1 ? 'multiple' : 'single', text: q.text, points: 1, explanation: '', options: q.options.map(([text, correct]) => ({ text, correct })) })),
    });
  await k.call('PATCH', `/api/courses/${course.id}`, { status: 'published' });

  // members: enrolled over the last months, each one somewhere on the way
  const members: any[] = [];
  for (let i = 0; i < cp.enroll; i++) {
    const c = k.contact(index * 7 + i);
    if (members.some((m) => m.id === c.id)) continue;
    const e = await k.call('POST', `/api/courses/${course.id}/enrollments`, { contact_id: c.id });
    if (e?.id) members.push({ id: c.id, name: nameOf(c), enrollment: e.id, i });
  }
  const ordered = db.all<{ id: string }>('SELECT l.id FROM course_lessons l JOIN course_modules m ON m.id = l.module_id WHERE l.course_id = ? ORDER BY m.position, l.position', course.id);
  await k.step('course progress', () =>
    db.tx(() => {
      for (const m of members) {
        const enrolled = todayMs(k) - (6 + ((m.i * 11 + index * 17) % 150)) * DAY;
        const share = PROGRESS[(m.i + index) % PROGRESS.length];
        const done = Math.round(ordered.length * share);
        const touched = done > 0 || m.i % 7 === 5;
        let t = enrolled + DAY;
        for (const [li, l] of ordered.slice(0, done).entries()) {
          t += (0.3 + k.rand() * 2.5) * DAY;
          db.insert('course_progress', { enrollment_id: m.enrollment, lesson_id: l.id, completed_at: iso(Math.min(t, todayMs(k))), last_viewed_at: iso(Math.min(t, todayMs(k))) });
          if (li === done - 1) m.last = { lesson: l.id, at: Math.min(t, todayMs(k)) };
        }
        db.run(
          'UPDATE course_enrollments SET enrolled_at = ?, created_at = ?, started_at = ?, completed_at = ?, last_lesson_id = ?, last_seen_at = ? WHERE id = ?',
          iso(enrolled),
          iso(enrolled),
          touched ? iso(enrolled + DAY) : null,
          done >= ordered.length && ordered.length ? iso(m.last?.at ?? enrolled) : null,
          m.last?.lesson ?? null,
          touched ? iso(m.last?.at ?? enrolled + DAY) : null,
          m.enrollment,
        );
      }
      // reviews of members who finished or came a long way
      for (const [ri, [rating, title, text]] of (cp.reviews ?? []).entries()) {
        const m = members.filter((x) => PROGRESS[(x.i + index) % PROGRESS.length] >= 0.65)[ri];
        if (!m) continue;
        const at = iso(todayMs(k) - (4 + ri * 23) * DAY);
        db.insert('course_reviews', { id: id(), location_id: k.L, course_id: course.id, contact_id: m.id, author_name: m.name, rating, title, body: text, status: 'published', reply: '', replied_at: null, created_at: at, updated_at: at });
      }
    }),
  );
  return { id: course.id as string, members };
}

/** 1–3 courses per business with modules, lessons, a quiz, members with progress and – with several courses – a learning path. */
export async function seedCourses(k: Kit) {
  const plans = COURSE_PLANS[k.plan.key] ?? [];
  const made: { id: string; members: any[] }[] = [];
  for (const [i, cp] of plans.entries()) {
    const c = await seedCourse(k, cp, i);
    if (c) made.push(c);
  }
  if (made.length < 2) return;
  const path = await k.call('POST', '/api/courses/paths', { title: `${k.plan.name}: Komplettprogramm`, description: 'Alle Kurse in einer sinnvollen Reihenfolge – der nächste öffnet sich, wenn der vorige geschafft ist.', items: made.map((m) => m.id) });
  if (!path?.id) return;
  await k.call('PATCH', `/api/courses/paths/${path.id}`, { status: 'published' });
  for (let i = 0; i < 14; i++) await k.call('POST', `/api/courses/paths/${path.id}/members`, { contact_id: k.contact(i * 3).id });
}

// --- landing pages, funnels and their visits --------------------------------------------------------------------------------

const SOURCES = ['google (Suche)', 'direkt', 'instagram', 'newsletter', 'empfehlung', 'facebook', 'linkedin'];
const hex = (k: Kit, n: number) => Array.from({ length: n }, () => Math.floor(k.rand() * 16).toString(16)).join('');

/** Visits per day for the last 60 days (growing, quieter at weekends) and conversions on the last page of the funnel. */
function seedTraffic(k: Kit, funnelId: string, daily: number, flow: number[], conversion: 'form' | 'booking' | 'purchase') {
  const db = k.app.db;
  const pages = db.all<{ id: string }>('SELECT id FROM funnel_pages WHERE funnel_id = ? ORDER BY position, created_at', funnelId);
  if (!pages.length) return;
  const views = new Map<string, number>();
  db.tx(() => {
    for (let back = 59; back >= 0; back--) {
      const day = k.ymd(-back);
      const weekend = [0, 6].includes(new Date(k.inDays(-back, 12)).getDay());
      const visitors = Math.max(1, Math.round(daily * (1 + (0.6 * (59 - back)) / 59) * (weekend ? 0.55 : 1) * (0.8 + k.rand() * 0.4)));
      for (let v = 0; v < visitors; v++) {
        const visitor = hex(k, 16);
        const roll = k.rand();
        const device = roll < 0.56 ? 'phone' : roll < 0.93 ? 'desktop' : 'tablet';
        const source = pickOf(k, SOURCES);
        const first = new Date(k.inDays(-back, int(k, 7, 21), int(k, 0, 59))).toISOString();
        let reached = 0;
        for (let p = 0; p < pages.length; p++) {
          if (p > 0 && k.rand() > (flow[p - 1] ?? 0.5)) break;
          reached = p;
          const n = 1 + (k.rand() < 0.2 ? 1 : 0);
          views.set(pages[p].id, (views.get(pages[p].id) ?? 0) + n);
          db.insert('site_hits', { funnel_id: funnelId, location_id: k.L, page_id: pages[p].id, visitor, day, views: n, seconds: int(k, 12, 220), scroll: int(k, 15, 100), device, source, first_at: first, last_at: first });
        }
        const isLast = reached === pages.length - 1;
        if (isLast && k.rand() < (pages.length === 1 ? 0.14 : conversion === 'purchase' ? 0.25 : 0.55)) {
          const cents = conversion === 'purchase' ? pickOf(k, [1690, 3900, 14900, 3180]) : 0;
          db.insert('site_conversions', { id: id(), location_id: k.L, funnel_id: funnelId, page_id: pages[reached].id, kind: conversion, ref_id: '', amount_cents: cents, currency: 'EUR', day, created_at: first });
        }
      }
    }
    for (const [pageId, n] of views) db.run('UPDATE funnel_pages SET views = ? WHERE id = ?', n, pageId);
  });
}

/** A landing page, a booking page and a webinar funnel besides the website and funnel the seed already made – all with visits. */
export async function seedSites(k: Kit) {
  const formId = k.app.db.get<{ id: string }>('SELECT id FROM forms WHERE location_id = ? ORDER BY created_at LIMIT 1', k.L)?.id ?? '';
  const calendar = k.app.db.get<{ slug: string }>('SELECT slug FROM calendars WHERE location_id = ? ORDER BY created_at LIMIT 1', k.L)?.slug ?? '';
  const traffic = new Map<string, { daily: number; flow: number[]; conversion: 'form' | 'booking' | 'purchase' }>();
  for (const sp of SITE_PLANS[k.plan.key] ?? []) {
    const f = await k.call('POST', '/api/funnels', { name: sp.name, template: sp.template });
    if (!f?.id) continue;
    if (sp.pages) {
      const first = k.app.db.get<{ id: string }>('SELECT id FROM funnel_pages WHERE funnel_id = ? ORDER BY position LIMIT 1', f.id);
      const [head, ...rest] = sp.pages;
      if (first) await k.call('PATCH', `/api/funnel-pages/${first.id}`, { name: head.name, slug: head.slug, blocks: head.blocks });
      for (const p of rest) await k.call('POST', `/api/funnels/${f.id}/pages`, { name: p.name, slug: p.slug, blocks: p.blocks });
    }
    // forms and calendars of the sub-account in the blocks that wait for them
    for (const p of k.app.db.all<{ id: string; blocks: string }>('SELECT id, blocks FROM funnel_pages WHERE funnel_id = ?', f.id)) {
      const blocks = JSON.parse(p.blocks) as any[];
      let changed = false;
      for (const b of blocks) {
        if (b.type === 'form' && !b.form_id && formId) (b.form_id = formId), (changed = true);
        if (b.type === 'calendar' && !b.calendar_slug && calendar) (b.calendar_slug = calendar), (changed = true);
      }
      if (changed) await k.call('PATCH', `/api/funnel-pages/${p.id}`, { blocks });
    }
    traffic.set(f.id, { daily: sp.traffic, flow: sp.flow, conversion: sp.conversion });
  }
  // the website and the funnel from the main seed get visits too
  for (const f of k.app.db.all<{ id: string; kind: string }>('SELECT id, kind FROM funnels WHERE location_id = ?', k.L)) {
    if (traffic.has(f.id)) continue;
    traffic.set(f.id, f.kind === 'website' ? { daily: 26, flow: [0.3, 0.12, 0.1, 0.08], conversion: 'form' } : { daily: 9, flow: [0.35, 0.8], conversion: 'form' });
  }
  for (const [fid, t] of traffic) await k.step('site traffic', () => seedTraffic(k, fid, t.daily, t.flow, t.conversion));
}

// --- campaigns with results ------------------------------------------------------------------------------------------------------

/** Sent campaigns over the year with opens and clicks, one scheduled, one draft. */
export async function seedCampaigns(k: Kit) {
  const db = k.app.db;
  const tags = k.plan.tags.map(([n]) => n);
  const specs: { name: string; subject: string; back: number; filter: Record<string, any>; open: number; click: number }[] = [
    { name: 'Newsletter Herbst', subject: `Neuigkeiten von ${k.plan.name}`, back: 6, filter: { tags: [tags.includes('Newsletter') ? 'Newsletter' : tags[2]] }, open: 0.46, click: 0.12 },
    { name: 'Aktion zum Saisonstart', subject: 'Zum Start: unser Angebot für dich', back: 29, filter: { tags: [tags[0]] }, open: 0.41, click: 0.09 },
    { name: 'Neukunden-Willkommen', subject: 'Schön, dass du da bist', back: 63, filter: { tags: [tags[1]] }, open: 0.58, click: 0.17 },
    { name: 'Sommer-Update', subject: 'Das war los im Sommer', back: 125, filter: { tags: [tags[tags.length - 1]] }, open: 0.39, click: 0.08 },
  ];
  for (const sp of specs) {
    const c = await k.call('POST', '/api/campaigns', {
      name: sp.name,
      channel: 'email',
      subject: sp.subject,
      body: `Hallo {{contact.first_name|du}},\n\nhier sind die Neuigkeiten von ${k.plan.name}: ein kurzer Überblick, was sich getan hat – und ein kleines Dankeschön für dich.\n\nBis bald!`,
      filter: sp.filter,
    });
    if (!c?.id) continue;
    await k.call('POST', `/api/campaigns/${c.id}/send`, {});
    await k.step('campaign results', () =>
      db.tx(() => {
        const sentAt = k.inDays(-sp.back, 10);
        db.run('UPDATE campaigns SET created_at = ?, started_at = ?, sent_at = ?, updated_at = ? WHERE id = ?', new Date(Date.parse(sentAt) - 2 * DAY).toISOString(), sentAt, sentAt, sentAt, c.id);
        for (const [i, r] of db.all<{ contact_id: string; message_id: string | null }>('SELECT contact_id, message_id FROM campaign_recipients WHERE campaign_id = ?', c.id).entries()) {
          const at = new Date(Date.parse(sentAt) + i * 1500).toISOString();
          db.run('UPDATE campaign_recipients SET sent_at = ? WHERE campaign_id = ? AND contact_id = ?', at, c.id, r.contact_id);
          if (!r.message_id) continue;
          const opened = k.rand() < sp.open;
          const clicked = opened && k.rand() < sp.click / sp.open;
          db.run('UPDATE messages SET created_at = ?, opened_at = ?, clicked_at = ? WHERE id = ?', at, opened ? new Date(Date.parse(at) + int(k, 4, 900) * 60e3).toISOString() : null, clicked ? new Date(Date.parse(at) + int(k, 8, 1500) * 60e3).toISOString() : null, r.message_id);
        }
      }),
    );
  }
  const scheduled = await k.call('POST', '/api/campaigns', { name: 'Adventsaktion', channel: 'email', subject: 'Unser Advents-Angebot', body: 'Hallo {{contact.first_name|du}},\n\nnur bis Weihnachten: unser Advents-Angebot …', filter: { tags: [tags[0]] } });
  if (scheduled?.id) await k.call('POST', `/api/campaigns/${scheduled.id}/send`, { scheduled_at: k.inDays(6, 9) });
}

// --- workflows that have run -------------------------------------------------------------------------------------------------------

/** Run history of the active workflows: most completed, some waiting, a few stopped. */
export async function seedWorkflowRuns(k: Kit) {
  const db = k.app.db;
  await k.step('workflow runs', () =>
    db.tx(() => {
      for (const [wi, w] of db.all<{ id: string; steps: string }>(`SELECT id, steps FROM workflows WHERE location_id = ? AND status = 'active'`, k.L).entries()) {
        const steps = JSON.parse(w.steps || '[]') as unknown[];
        const n = 18 + ((wi * 13) % 40);
        for (let i = 0; i < n; i++) {
          const c = k.contact(wi * 5 + i);
          const back = Math.floor((1 - Math.sqrt(k.rand())) * 120);
          const at = iso(todayMs(k) - back * DAY - int(k, 0, 600) * 60e3);
          const roll = k.rand();
          const status = back < 3 && roll < 0.5 ? 'waiting' : roll < 0.93 ? 'completed' : 'stopped';
          db.insert('workflow_runs', {
            id: id(),
            workflow_id: w.id,
            location_id: k.L,
            contact_id: c.id,
            status,
            cursor: JSON.stringify([status === 'completed' ? steps.length : Math.min(1, steps.length)]),
            event: '{}',
            next_run_at: status === 'waiting' ? k.inDays(1, 9) : null,
            log: '[]',
            created_at: at,
            updated_at: iso(Date.parse(at) + int(k, 1, 90) * 60e3),
          });
        }
      }
    }),
  );
}

// --- helpdesk: answered tickets with customer ratings ------------------------------------------------------------------------------

const TICKETS: [subject: string, text: string, category: string][] = [
  ['Frage zur Rechnung', 'Auf meiner letzten Rechnung steht ein Posten, den ich nicht zuordnen kann. Können Sie das erklären?', 'Abrechnung'],
  ['Termin verschieben', 'Ich muss meinen Termin leider verschieben. Welche Zeiten haben Sie in der nächsten Woche frei?', 'Termine'],
  ['Zugang zum Kundenbereich', 'Ich komme nicht mehr in meinen Kundenbereich. Ein neues Passwort kam nicht an.', 'Zugang'],
  ['Angebot anpassen', 'Könnten Sie das Angebot um einen zweiten Standort erweitern? Bitte mit neuem Gesamtpreis.', 'Vertrieb'],
  ['Lieferung noch nicht angekommen', 'Meine Bestellung sollte laut Mail gestern kommen. Gibt es eine Sendungsnummer?', 'Versand'],
  ['Kündigungsfrist', 'Wie lange läuft mein Vertrag noch und bis wann muss ich kündigen?', 'Vertrag'],
  ['Bitte um Rückruf', 'Ich hätte gern einen Rückruf zu meiner Anfrage – am besten vormittags.', 'Allgemein'],
  ['Dokument fehlt', 'In der E-Mail war der Anhang nicht dabei. Können Sie ihn nochmal schicken?', 'Dokumente'],
  ['Wie funktioniert der Export?', 'Ich möchte meine Daten als Tabelle herunterladen. Wo finde ich das?', 'Bedienung'],
  ['Lob und eine Frage', 'Vielen Dank für die tolle Betreuung! Eine Frage hätte ich noch zur Wartung.', 'Allgemein'],
];
const SAAS_TICKETS: [string, string, string][] = [
  ['Schichtplan lässt sich nicht veröffentlichen', 'Beim Veröffentlichen kommt eine Warnung wegen der Ruhezeiten. Wie finde ich die betroffene Schicht?', 'Bedienung'],
  ['Tauschbörse zeigt keine Angebote', 'Mein Team sieht keine offenen Schichten in der Tauschbörse. Haben wir etwas falsch eingestellt?', 'Bedienung'],
  ['Export für die Lohnabrechnung', 'Kann ich die Stunden pro Person im CSV-Format exportieren, mit Zuschlägen?', 'Export'],
  ['Neuer Standort anlegen', 'Wir eröffnen eine zweite Filiale. Wie lege ich den Standort an und weise Mitarbeitende zu?', 'Einrichtung'],
  ['Rechnung zum Tarifwechsel', 'Wir wechseln von Team auf Business. Wann wird die Differenz berechnet?', 'Abrechnung'],
  ['Kalender-Abo aktualisiert nicht', 'Mein Handy-Kalender zeigt neue Schichten erst nach Stunden. Ist das normal?', 'Schnittstellen'],
  ['Mitarbeiter-Import per CSV', 'Der Import bricht bei Umlauten ab. Welche Kodierung erwartet ihr?', 'Einrichtung'],
  ['Datenschutz: Auftragsverarbeitung', 'Wir brauchen den AVV für unseren Datenschutzbeauftragten. Wo bekomme ich ihn?', 'Datenschutz'],
  ['Testphase verlängern', 'Wir sind noch nicht ganz durch mit dem Test. Ist eine Verlängerung um eine Woche möglich?', 'Vertrieb'],
  ['Feature-Wunsch: Schichtgruppen', 'Wir würden gern Schichten für Gruppen planen (z. B. Küche, Service). Ist das geplant?', 'Feature-Wunsch'],
];
const CSAT_COMMENTS: Record<number, string[]> = {
  5: ['Schnell und freundlich geholfen, danke!', 'Super Support – Problem sofort gelöst.', 'Sehr kompetent, gern wieder.', ''],
  4: ['Gut gelöst, die Antwort hätte etwas schneller kommen können.', 'Alles geklärt, danke.'],
  3: ['Es hat etwas gedauert, aber am Ende hat es geklappt.'],
  2: ['Meine Frage wurde erst nach mehreren Nachrichten beantwortet.'],
};

/**
 * Puts a ticket on the timeline: created `back` days ago, the first reply inside the SLA (in 7 % of the cases a little late), solved
 * or closed some time later – or still open –, and a customer rating (CSAT) for most of the solved ones. The SLA dates move with it.
 */
function dateTicket(k: Kit, ticketId: string, back: number, mode: 'open' | 'answered' | 'done', closed: boolean) {
  const db = k.app.db;
  const row = db.get<any>('SELECT * FROM tickets WHERE id = ?', ticketId);
  if (!row) return;
  const created = todayMs(k) - back * DAY - int(k, 0, 480) * 60e3;
  const shift = created - Date.parse(row.created_at);
  const moved = (v: string | null) => (v ? iso(Date.parse(v) + shift) : v);
  const late = k.rand() < 0.07;
  const dueFirst = row.first_response_due_at ? Date.parse(row.first_response_due_at) + shift : created + 4 * 3600e3;
  const dueRes = row.resolution_due_at ? Date.parse(row.resolution_due_at) + shift : created + 3 * DAY;
  const open = mode === 'open';
  const firstAt = open ? null : created + Math.max(3 * 60e3, (late ? 1.15 : 0.1 + k.rand() * 0.6) * (dueFirst - created));
  const resolvedAt = mode !== 'done' ? null : Math.min(Math.max(late ? dueRes + int(k, 1, 6) * 3600e3 : created + (dueRes - created) * (0.2 + k.rand() * 0.65), (firstAt ?? created) + 5 * 60e3), todayMs(k));
  const rated = mode === 'done' && k.rand() < 0.72;
  const score = rated ? pickOf(k, [5, 5, 5, 5, 5, 5, 5, 5, 4, 4, 4, 3]) : null;
  db.run(
    `UPDATE tickets SET created_at = ?, updated_at = ?, first_response_due_at = ?, first_response_warn_at = ?, resolution_due_at = ?, resolution_warn_at = ?, first_response_at = ?, resolved_at = ?, closed_at = ?,
       last_agent_at = ?, last_customer_at = ?, sla_first_state = ?, sla_resolution_state = ?, csat_sent_at = ?, csat_score = ?, csat_comment = ?, csat_at = ? WHERE id = ?`,
    iso(created),
    iso(resolvedAt ?? firstAt ?? created),
    moved(row.first_response_due_at),
    moved(row.first_response_warn_at),
    moved(row.resolution_due_at),
    moved(row.resolution_warn_at),
    firstAt ? iso(firstAt) : null,
    resolvedAt ? iso(resolvedAt) : null,
    closed && resolvedAt ? iso(resolvedAt) : null,
    firstAt ? iso(firstAt) : null,
    iso(created),
    late ? 'breached' : '',
    '',
    resolvedAt ? iso(resolvedAt + 3600e3) : null,
    score,
    score ? pickOf(k, CSAT_COMMENTS[score] ?? ['']) : '',
    score && resolvedAt ? iso(Math.min(resolvedAt + int(k, 2, 40) * 3600e3, todayMs(k))) : null,
    ticketId,
  );
  db.run('UPDATE ticket_events SET created_at = ? WHERE ticket_id = ?', iso(created + 5 * 60e3), ticketId);
  k.dated.add(ticketId);
}

/** Tickets of the last three months: most solved or closed, the first reply in time, a customer rating (CSAT); the freshest still open. */
export async function seedSupportHistory(k: Kit) {
  // the few tickets the main seed made are the newest ones: answered and in progress, or just arrived
  for (const [i, t] of k.app.db.all<{ id: string }>('SELECT id FROM tickets WHERE location_id = ? ORDER BY created_at', k.L).entries()) {
    const answered = i % 2 === 0;
    if (answered) await k.call('POST', `/api/tickets/${t.id}/reply`, { body: 'Danke für deine Nachricht – ich kümmere mich darum und melde mich heute noch mit dem Ergebnis.', status: 'in_bearbeitung' });
    await k.step('ticket dates', () => dateTicket(k, t.id, answered ? 1 + (i % 3) : 0, answered ? 'answered' : 'open', false));
  }
  const pool = k.plan.key === 'saas' ? SAAS_TICKETS : TICKETS;
  const n = k.plan.key === 'saas' ? 26 : 10;
  for (let i = 0; i < n; i++) {
    const [subject, text, category] = pool[i % pool.length];
    const c = k.contact(i * 3 + 5);
    const t = await k.call('POST', '/api/tickets', { subject, description: text, contact_id: c.id, priority: pickOf(k, ['normal', 'normal', 'normal', 'hoch', 'niedrig', 'dringend']), category, source: pickOf(k, ['E-Mail', 'E-Mail', 'E-Mail', 'Telefon']) });
    if (!t?.id) continue;
    const back = Math.floor(Math.pow(k.rand(), 1.4) * 88) + 1;
    const open = back <= 4 && i % 3 === 0;
    if (!open) {
      await k.call('POST', `/api/tickets/${t.id}/reply`, { body: `Hallo ${c.first_name},

danke für deine Nachricht! Ich habe mir das angesehen und kümmere mich darum – du bekommst gleich eine Rückmeldung.

Viele Grüße
${k.plan.name}`, status: 'in_bearbeitung' });
      await k.call('POST', `/api/tickets/${t.id}/reply`, { body: 'So, erledigt: Alles ist umgesetzt. Melde dich gern, falls noch etwas hakt.', status: i % 4 === 0 ? 'geschlossen' : 'geloest' });
    }
    await k.step('ticket dates', () => dateTicket(k, t.id, back, open ? 'open' : 'done', i % 4 === 0));
  }
}

// --- knowledge: wiki, team chat, community ----------------------------------------------------------------------------------------------

const WIKI: [title: string, body: string][] = [
  ['Willkommen im Team-Handbuch', '# Willkommen\n\nHier steht alles, was neue Kolleginnen und Kollegen in der ersten Woche brauchen: Abläufe, Ansprechpartner und Checklisten.\n\n- Erfundener Demo-Inhalt\n- Du kannst alles frei bearbeiten'],
  ['Erster Arbeitstag', '## Checkliste\n\n1. Zugang zu E-Mail und Postfach einrichten\n2. Team vorstellen\n3. Erste Aufgaben mit der Patin oder dem Paten durchgehen\n4. Feedback-Gespräch am Freitag'],
  ['So gehen wir mit Anfragen um', '## Antwortzeiten\n\nJede Anfrage bekommt innerhalb eines Werktags eine Antwort. Dringende Fälle (Ausfall, Störung) rufen wir innerhalb von zwei Stunden zurück.\n\n## Ablauf\n\n1. Anfrage im Posteingang prüfen\n2. Kontakt anlegen oder ergänzen\n3. Angebot oder Termin anbieten'],
  ['Preisliste und Angebote', '## Grundsätze\n\n- Angebote sind 30 Tage gültig.\n- Rabatte über 10 % nur nach Rücksprache.\n- Jede Rechnung nennt Leistungsdatum und Zahlungsziel.'],
  ['Checkliste Monatsabschluss', '- Offene Rechnungen prüfen und nachfassen\n- Zahlungseingänge abgleichen\n- Bewertungen anfragen\n- Monatsbericht verschicken'],
  ['Datenschutz im Alltag', '## Regeln\n\n- Kein Versand personenbezogener Daten per Messenger.\n- Bildschirm sperren beim Verlassen des Platzes.\n- Auskunftsanfragen sofort an die Leitung weitergeben.'],
];
const CHAT: [channel: string, topic: string, messages: string[]][] = [
  ['allgemein', 'Alles fürs ganze Team', ['Guten Morgen zusammen! ☕', 'Heute Nachmittag ist Teamrunde um 15 Uhr.', 'Neue Bewertung eingegangen – 5 Sterne 🎉', 'Bitte denkt an die Zeiterfassung vor dem Wochenende.', 'Danke an alle für den starken Monat!']],
  ['vertrieb', 'Anfragen, Angebote, Abschlüsse', ['Angebot für den neuen Interessenten ist raus – Nachfassen am Donnerstag.', 'Zwei Termine für morgen sind bestätigt.', 'Das große Projekt ist gewonnen! 🚀', 'Wer kann nächste Woche den Vor-Ort-Termin übernehmen?']],
  ['support', 'Fragen von Kundinnen und Kunden', ['Ticket vom Vormittag ist gelöst, Kundin hat sich bedankt.', 'Wir bekommen öfter die Frage zur Rechnung – ich schreibe einen Hilfe-Artikel.', 'Vorlage für die Standard-Antwort liegt im Wiki.']],
];

/** A team wiki with pages, team chat channels with a conversation each. */
export async function seedKnowledge(k: Kit) {
  const space = await k.call('POST', '/api/wiki/spaces', { name: 'Team-Handbuch', icon: '📘', description: 'Abläufe, Checklisten und Wissen des Teams' });
  if (space?.id) {
    const home = await k.call('POST', '/api/wiki/pages', { space_id: space.id, title: WIKI[0][0], body: WIKI[0][1], icon: '👋' });
    for (const [title, body] of WIKI.slice(1)) await k.call('POST', '/api/wiki/pages', { space_id: space.id, parent_id: home?.id, title, body });
  }
  // The chat allows 20 messages per ten seconds per sender; the seed writes a conversation per business within a second.
  const services = k.app.services as Record<string, any>;
  const rate = services.chatRate;
  services.chatRate = { max: 100_000, windowMs: 1 };
  try {
    for (const [name, topic, messages] of CHAT) {
      const ch = await k.call('POST', '/api/team-chat/channels', { name, topic, kind: 'public' });
      if (!ch?.id) continue;
      for (const body of messages) await k.call('POST', `/api/team-chat/channels/${ch.id}/messages`, { body });
    }
  } finally {
    if (rate === undefined) delete services.chatRate;
    else services.chatRate = rate;
  }
  // the conversations took place over the last days, the wiki grew over the last weeks
  await k.step('knowledge dates', () => {
    const db = k.app.db;
    db.tx(() => {
      for (const [ci, ch] of db.all<{ id: string }>('SELECT id FROM teamchat_channels WHERE location_id = ? ORDER BY created_at', k.L).entries()) {
        let at = todayMs(k) - (5 - ci) * DAY - 2 * 3600e3;
        for (const m of db.all<{ id: string }>('SELECT id FROM teamchat_messages WHERE channel_id = ? ORDER BY rowid', ch.id)) {
          db.run('UPDATE teamchat_messages SET created_at = ? WHERE id = ?', iso(Math.min(at, k.nowMs)), m.id);
          at += int(k, 12, 200) * 60e3;
        }
        db.run('UPDATE teamchat_channels SET created_at = ?, last_message_at = (SELECT MAX(created_at) FROM teamchat_messages WHERE channel_id = ?) WHERE id = ?', iso(todayMs(k) - (40 + ci * 9) * DAY), ch.id, ch.id);
      }
      for (const [pi, p] of db.all<{ id: string }>('SELECT id FROM wiki_pages WHERE location_id = ? ORDER BY rowid', k.L).entries()) {
        const created = iso(todayMs(k) - (70 - pi * 9) * DAY);
        db.run('UPDATE wiki_pages SET created_at = ?, updated_at = ? WHERE id = ?', created, iso(Date.parse(created) + int(k, 1, 20) * DAY), p.id);
      }
    });
  });
}

/** A customer community with a few posts and comments (the coach has one already). */
export async function seedCommunity(k: Kit) {
  if (!['saas', 'agency', 'shop'].includes(k.plan.key)) return;
  const posts: Record<string, [string, string][]> = {
    saas: [['Willkommen in der Taktwerk-Community', 'Hier tauschen sich Kundinnen und Kunden aus: Tipps zur Schichtplanung, Feature-Wünsche und Antworten vom Team.'], ['Tipp: Schichtvorlagen für Feiertage', 'Wir legen für jeden Feiertag eine eigene Vorlage an – spart jedes Jahr eine Stunde.'], ['Roadmap: Das kommt im nächsten Quartal', 'Schichtgruppen, ein Export für weitere Lohnprogramme und eine App für die Tauschbörse.'], ['Frage: Wie plant ihr Urlaub?', 'Wir sammeln Wünsche per Antrag und planen danach die Besetzung. Wie macht ihr das?']],
    agency: [['Willkommen im Kunden-Club', 'Der Treffpunkt für alle Kundinnen und Kunden von Nordlicht Digital: Tipps, Neuigkeiten und Fragen.'], ['Neu: SEO-Check zum Mitmachen', 'Jeden Monat prüfen wir live eine Kunden-Website – meldet euch gern für den nächsten Termin.'], ['Beispiel: Newsletter mit 52 % Öffnungsrate', 'Was hinter einem einfachen Betreff steckt – und wie ihr ihn selbst testet.']],
    shop: [['Willkommen bei den Bohnenfreunden', 'Hier gibt es Brüh-Tipps, Röstkalender und Verkostungen für alle Stammkundinnen und Stammkunden.'], ['Rösttag am Donnerstag', 'Frisch geröstet: der neue Espresso aus Brasilien mit Noten von Schokolade und Haselnuss.'], ['Welche Mühle nutzt ihr?', 'Handmühle oder elektrisch? Wir sammeln eure Erfahrungen für den nächsten Newsletter.']],
  };
  const group = await k.call('POST', '/api/community/groups', { name: k.plan.key === 'saas' ? 'Taktwerk-Community' : k.plan.key === 'agency' ? 'Kunden-Club' : 'Bohnenfreunde', description: 'Austausch, Fragen und Neuigkeiten.' });
  if (!group?.id) return;
  for (const [i, [title, body]] of (posts[k.plan.key] ?? []).entries()) {
    const p = await k.call('POST', `/api/community/groups/${group.id}/posts`, { title, body, pinned: i === 0 });
    if (p?.id && i > 0) await k.call('POST', `/api/community/posts/${p.id}/comments`, { body: pickOf(k, ['Danke fürs Teilen – das hilft uns direkt weiter!', 'Machen wir genauso, funktioniert gut.', 'Spannend, mehr davon bitte 👍']) });
  }
}
