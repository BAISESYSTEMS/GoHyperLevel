import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Module } from '../core/app.js';
import { bad, clampLimit, html, notFound, str, type Ctx, type RawResult } from '../core/http.js';
import { publicPage } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { id, now } from '../core/util.js';
import { certificatePdf, cleanCertConfig, DEFAULT_CERT, type CertConfig } from '../services/certificate-pdf.js';
import { contactName, getContact, logActivity, upsertContact } from '../services/contacts.js';
import { auditLog, clip, deDate, json, limiter } from '../services/creator-kit.js';
import { getCourse } from '../services/courses.js';
import { sendToContact } from '../services/messaging.js';
import { registerActions, registerTriggers, requireText, text as fill } from '../services/wfx-kit.js';
import type { Tool } from './mcp.js';

/**
 * Certificates for courses: a template per course (logo, colours, wording, signature image), the PDF built on the server
 * when a person completes the course or passes a quiz, a public verification page `/zertifikat/<id>` with the PDF, a list in
 * the member area, the workflow action „Zertifikat ausstellen“ and the trigger `certificate.issued`. Revoking marks the
 * verification page invalid. No library: the PDF comes from the canvas PDF writer. Docs: docs/quizzes-certificates.md.
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Record<string, any>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const VERIFY_LIMIT = limiter(120, 10 * 60_000);

const TOOLS: Tool[] = [
  {
    name: 'ghl_certificate_issue',
    title: 'Zertifikat ausstellen',
    description:
      'Stellt für eine Person ein Zertifikat zu einem Kurs aus (contact_id oder email; unbekannte E-Mails werden als Kontakt angelegt). Das PDF entsteht auf dem Server, die Person bekommt auf Wunsch eine E-Mail. Gibt es schon ein gültiges Zertifikat für Kurs und Person, wird es zurückgegeben (created=false). Gibt die Prüfadresse (verify_url) und die PDF-Adresse zurück.',
    inputSchema: obj({ ...LOC, course_id: { type: 'string' }, contact_id: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' }, template_id: { type: 'string' } }, ['location_id', 'course_id']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: (call, a) => call.api('POST', '/api/certificates/issue', { body: { course_id: a.course_id, contact_id: a.contact_id, email: a.email, name: a.name, template_id: a.template_id }, location: a.location_id }),
  },
  {
    name: 'ghl_certificate_list',
    title: 'Ausgestellte Zertifikate',
    description: 'Ausgestellte Zertifikate eines Sub-Accounts (optional nach Kurs oder Kontakt gefiltert) mit Nummer, Name, Datum und Prüfadresse.',
    inputSchema: obj({ ...LOC, course_id: { type: 'string' }, contact_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['location_id']),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => {
      const q = new URLSearchParams();
      for (const k of ['course_id', 'contact_id', 'limit']) if (a[k]) q.set(k, String(a[k]));
      return call.api('GET', `/api/certificates?${q}`, { location: a.location_id });
    },
  },
];

interface Template {
  id: string;
  location_id: string;
  course_id: string | null;
  name: string;
  enabled: number;
  issue_on: 'completion' | 'quiz' | 'manual';
  quiz_id: string | null;
  config: CertConfig;
}

interface Certificate {
  id: string;
  location_id: string;
  template_id: string | null;
  course_id: string;
  contact_id: string;
  enrollment_id: string | null;
  number: string;
  recipient_name: string;
  course_title: string;
  score_percent: number | null;
  issued_at: string;
  config: CertConfig;
  source: string;
  revoked_at: string | null;
  revoked_reason: string;
}

export const quizCertificatesModule: Module = {
  name: 'quiz-certificates',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE certificate_templates (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        course_id TEXT REFERENCES courses(id) ON DELETE CASCADE, name TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
        issue_on TEXT NOT NULL DEFAULT 'completion', quiz_id TEXT REFERENCES quizzes(id) ON DELETE SET NULL, config TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX certificate_templates_course ON certificate_templates(location_id, course_id);
      CREATE TABLE certificates (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, template_id TEXT,
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, enrollment_id TEXT,
        number TEXT NOT NULL, recipient_name TEXT NOT NULL DEFAULT '', course_title TEXT NOT NULL DEFAULT '', score_percent INTEGER, issued_at TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}', source TEXT NOT NULL DEFAULT 'auto', revoked_at TEXT, revoked_reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
        UNIQUE(location_id, number)
      );
      CREATE UNIQUE INDEX certificates_course_contact ON certificates(course_id, contact_id) WHERE revoked_at IS NULL;
      CREATE INDEX certificates_contact ON certificates(contact_id);
      CREATE INDEX certificates_loc ON certificates(location_id, issued_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    const dir = join(app.config.dataDir, 'certificates');
    const uploads = join(app.config.dataDir, 'uploads');
    // The certificates go with the contact – the PDFs cached on disk (with the person's name) are deleted with it.
    app.services.contactFiles = [
      ...(app.services.contactFiles ?? []),
      (_a: unknown, loc: string, cid: string) => db.all<{ id: string }>('SELECT id FROM certificates WHERE location_id = ? AND contact_id = ?', loc, cid).map((r) => join(dir, `${r.id.replace(/[^\w-]/g, '')}.pdf`)),
    ];

    registerTriggers(app, [
      {
        type: 'certificate.issued',
        label: 'Zertifikat ausgestellt',
        category: 'content',
        summary: 'Für eine Person wurde ein Kurs-Zertifikat ausgestellt.',
        doc: '{{event.certificate.url}} ist die öffentliche Prüfseite, {{event.certificate.pdf_url}} das PDF, {{event.certificate.number}} die Nummer. Passend für eine Glückwunsch-Mail, einen LinkedIn-Hinweis oder ein Tag „absolvent“.',
        fields: [{ key: 'course_id', label: 'Nur für Kurs', type: 'text' }],
        sample: { certificateId: 'z1', courseId: 'k1', course: { id: 'k1', title: 'Online-Kurs' }, certificate: { id: 'z1', number: 'ZERT-2026-0001', url: 'https://example.com/zertifikat/z1', pdf_url: 'https://example.com/zertifikat/z1/pdf' }, percent: 90, source: 'completion' },
        keywords: 'zertifikat urkunde abschluss kurs absolvent',
      },
    ]);
    app.services.workflowTriggerFilters = { ...(app.services.workflowTriggerFilters ?? {}), 'certificate.issued': (c: any, d: any) => !c.course_id || c.course_id === d.courseId };

    // --- templates ------------------------------------------------------------------------------------------------
    const templateOf = (loc: string, tid: string): Template | undefined => {
      const r = db.get<any>('SELECT * FROM certificate_templates WHERE id = ? AND location_id = ?', tid, loc);
      return r ? { ...r, config: cleanCertConfig(json(r.config, {})) } : undefined;
    };
    const mustTemplate = (ctx: Ctx) => {
      const t = templateOf(ctx.locationId, ctx.params.id);
      if (!t) throw notFound('Vorlage nicht gefunden');
      return t;
    };
    const templateOut = (t: Template) => ({
      ...t,
      enabled: !!t.enabled,
      course_title: t.course_id ? (db.get<any>('SELECT title FROM courses WHERE id = ?', t.course_id)?.title ?? '') : '',
      issued: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM certificates WHERE template_id = ? AND revoked_at IS NULL', t.id)!.n,
    });
    const brand = (loc: string) => {
      const l = app.location(loc);
      return { name: l?.settings?.branding?.name || l?.name || '', color: l?.settings?.branding?.color || '' };
    };
    const fieldsOf = (ctx: Ctx, cur?: Template) => {
      const b = ctx.body ?? {};
      let courseId = cur?.course_id ?? null;
      if (b.course_id !== undefined) {
        courseId = b.course_id ? String(b.course_id) : null;
        if (courseId && !getCourse(app, ctx.locationId, courseId)) throw notFound('Kurs nicht gefunden');
      }
      const issueOn = b.issue_on ?? cur?.issue_on ?? 'completion';
      if (!['completion', 'quiz', 'manual'].includes(issueOn)) throw bad('Ausstellen bei: completion, quiz oder manual');
      let quizId = cur?.quiz_id ?? null;
      if (b.quiz_id !== undefined) {
        quizId = b.quiz_id ? String(b.quiz_id) : null;
        if (quizId && !db.get('SELECT 1 FROM quizzes WHERE id = ? AND location_id = ?', quizId, ctx.locationId)) throw notFound('Quiz nicht gefunden');
      }
      if (issueOn === 'quiz' && !quizId) throw bad('Bitte das Quiz wählen, das zum Zertifikat führt');
      const config = cleanCertConfig(b.config, cur?.config ?? { ...DEFAULT_CERT, issuer: brand(ctx.locationId).name, color: /^#[0-9a-f]{6}$/i.test(brand(ctx.locationId).color) ? brand(ctx.locationId).color : DEFAULT_CERT.color });
      for (const k of ['logo_upload_id', 'signature_upload_id'] as const) if (config[k] && !db.get('SELECT 1 FROM uploads WHERE id = ? AND location_id = ?', config[k], ctx.locationId)) throw bad(k === 'logo_upload_id' ? 'Logo nicht gefunden' : 'Unterschrift nicht gefunden');
      return { course_id: courseId, issue_on: issueOn, quiz_id: issueOn === 'quiz' ? quizId : null, config };
    };

    router.get('/api/certificates/templates', 'location', (ctx) => db.all<any>('SELECT * FROM certificate_templates WHERE location_id = ? ORDER BY created_at', ctx.locationId).map((r) => templateOut({ ...r, config: cleanCertConfig(json(r.config, {})) })));
    router.post('/api/certificates/templates', 'location', (ctx) => {
      const f = fieldsOf(ctx);
      const row = { id: id(), location_id: ctx.locationId, name: str(ctx.body?.name, 'Name', { max: 120 }) || 'Zertifikat', enabled: ctx.body?.enabled === false ? 0 : 1, ...f, created_at: now(), updated_at: now() };
      db.insert('certificate_templates', row);
      return templateOut(templateOf(ctx.locationId, row.id)!);
    });
    /** A PDF with sample data from a template that is being edited (nothing is saved or issued). */
    router.post('/api/certificates/templates/preview', 'location', (ctx) => {
      const config = cleanCertConfig(ctx.body?.config, { ...DEFAULT_CERT, issuer: brand(ctx.locationId).name });
      for (const k of ['logo_upload_id', 'signature_upload_id'] as const) if (config[k] && !db.get('SELECT 1 FROM uploads WHERE id = ? AND location_id = ?', config[k], ctx.locationId)) config[k] = '';
      const pdf = renderPdf(ctx.locationId, config, { name: 'Erika Musterfrau', course: clip(ctx.body?.course, 120) || 'Beispiel-Kurs', date: deDate(new Date(), app.location(ctx.locationId)?.timezone), number: `${config.number_prefix}-2026-0001`, score: 92, id: 'vorschau' });
      return { pdf_base64: pdf.toString('base64') };
    });
    router.patch('/api/certificates/templates/:id', 'location', (ctx) => {
      const t = mustTemplate(ctx);
      const patch: Record<string, any> = { ...fieldsOf(ctx, t), updated_at: now() };
      if (ctx.body?.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true, max: 120 });
      if (ctx.body?.enabled !== undefined) patch.enabled = ctx.body.enabled ? 1 : 0;
      db.update('certificate_templates', t.id, patch, ctx.locationId);
      return templateOut(templateOf(ctx.locationId, t.id)!);
    });
    router.delete('/api/certificates/templates/:id', 'location', (ctx) => {
      const t = mustTemplate(ctx);
      db.run('DELETE FROM certificate_templates WHERE id = ?', t.id);
      return { ok: true };
    });

    // --- the PDF ----------------------------------------------------------------------------------------------------
    const imageOf = (loc: string, uploadId: string): Buffer | null => {
      if (!uploadId) return null;
      const u = db.get<any>('SELECT file FROM uploads WHERE id = ? AND location_id = ?', uploadId, loc);
      const path = u && join(uploads, u.file);
      return path && existsSync(path) ? readFileSync(path) : null;
    };
    function renderPdf(loc: string, config: CertConfig, o: { name: string; course: string; date: string; number: string; score?: number | null; id: string }): Buffer {
      return certificatePdf({ cfg: config, name: o.name, course: o.course, date: o.date, number: o.number, verifyUrl: `${app.baseUrl()}/zertifikat/${o.id}`, score: o.score, logo: imageOf(loc, config.logo_upload_id), signature: imageOf(loc, config.signature_upload_id) });
    }
    const pdfOf = (c: Certificate): Buffer => {
      const file = join(dir, `${c.id}.pdf`);
      if (existsSync(file)) return readFileSync(file);
      const tz = app.location(c.location_id)?.timezone;
      const pdf = renderPdf(c.location_id, c.config, { name: c.recipient_name, course: c.course_title, date: deDate(c.issued_at, tz), number: c.number, score: c.score_percent, id: c.id });
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, pdf);
      return pdf;
    };
    const pdfResult = (c: Certificate, inline = true): RawResult => ({ __raw: true, status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="zertifikat-${c.number}.pdf"`, 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff' }, body: pdfOf(c) });

    // --- issuing --------------------------------------------------------------------------------------------------------
    const certOf = (loc: string, cid: string): Certificate | undefined => {
      const r = db.get<any>('SELECT * FROM certificates WHERE id = ? AND location_id = ?', cid, loc);
      return r ? { ...r, config: cleanCertConfig(json(r.config, {})) } : undefined;
    };
    const urls = (c: Pick<Certificate, 'id'>) => ({ url: `${app.baseUrl()}/zertifikat/${c.id}`, pdf_url: `${app.baseUrl()}/zertifikat/${c.id}/pdf` });
    const certOut = (c: Certificate) => ({ ...c, config: undefined, revoked: !!c.revoked_at, ...urls(c) });
    const nextNumber = (loc: string, prefix: string) => {
      const year = new Date().getUTCFullYear();
      let n = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM certificates WHERE location_id = ?', loc)!.n + 1;
      let number = `${prefix}-${year}-${String(n).padStart(4, '0')}`;
      while (db.get('SELECT 1 FROM certificates WHERE location_id = ? AND number = ?', loc, number)) number = `${prefix}-${year}-${String(++n).padStart(4, '0')}`;
      return number;
    };

    /**
     * Issues the certificate of a course for a contact (once: a valid one is returned instead). Returns null when automatic
     * issuing finds no template (`auto`), so a course without a template simply has no certificate.
     */
    async function issue(loc: string, o: { courseId: string; contactId: string; templateId?: string; score?: number | null; source: string; by?: string; ctx?: Ctx; fallback?: boolean }) {
      const course = getCourse(app, loc, o.courseId);
      const contact = getContact(app, loc, o.contactId);
      if (!course) throw notFound('Kurs nicht gefunden');
      if (!contact) throw notFound('Kontakt nicht gefunden');
      const existing = db.get<any>('SELECT * FROM certificates WHERE course_id = ? AND contact_id = ? AND revoked_at IS NULL', course.id, contact.id);
      if (existing) return { certificate: certOf(loc, existing.id)!, created: false };
      let template: Template | undefined;
      if (o.templateId) {
        template = templateOf(loc, o.templateId);
        if (!template) throw notFound('Vorlage nicht gefunden');
      } else {
        const t = db.get<any>(`SELECT * FROM certificate_templates WHERE location_id = ? AND enabled = 1 AND course_id = ? ORDER BY created_at LIMIT 1`, loc, course.id) ?? db.get<any>(`SELECT * FROM certificate_templates WHERE location_id = ? AND enabled = 1 AND course_id IS NULL ORDER BY created_at LIMIT 1`, loc);
        template = t ? { ...t, config: cleanCertConfig(json(t.config, {})) } : undefined;
      }
      if (!template && !o.fallback) return null;
      const config = template?.config ?? cleanCertConfig({ issuer: brand(loc).name }, DEFAULT_CERT);
      const cid = id(22);
      const number = nextNumber(loc, config.number_prefix);
      const enrollment = db.get<any>('SELECT id FROM course_enrollments WHERE course_id = ? AND contact_id = ?', course.id, contact.id);
      const row = { id: cid, location_id: loc, template_id: template?.id ?? null, course_id: course.id, contact_id: contact.id, enrollment_id: enrollment?.id ?? null, number, recipient_name: contactName(contact).trim() || (contact.email ? contact.email.split('@')[0] : 'Teilnehmer:in'), course_title: course.title, score_percent: o.score ?? null, issued_at: now(), config, source: o.source, revoked_at: null, revoked_reason: '', created_at: now() };
      db.insert('certificates', row);
      const cert = certOf(loc, cid)!;
      pdfOf(cert);
      logActivity(app, loc, contact.id, 'certificate.issued', `Zertifikat ${number} für „${course.title}“ ausgestellt`);
      auditLog(app, o.ctx, loc, 'certificate.issue', `Zertifikat ${number} für ${row.recipient_name} (${course.title}, ${o.source})`, cid, o.ctx ? undefined : (o.by ?? 'System'));
      app.events.emit(loc, 'certificate.issued', { contactId: contact.id, certificateId: cid, courseId: course.id, course: { id: course.id, title: course.title }, certificate: { id: cid, number, ...urls({ id: cid }) }, percent: o.score ?? null, source: o.source });
      if (config.send_email && contact.email) {
        void sendToContact(app, loc, { contactId: contact.id, channel: 'email', subject: `Dein Zertifikat für „${course.title}“`, body: `Hallo ${contact.first_name || ''},\n\nglückwunsch! Dein Zertifikat für „${course.title}“ ist fertig.\n\nPDF: ${urls({ id: cid }).pdf_url}\nPrüfseite (zum Teilen): ${urls({ id: cid }).url}\n\n${app.location(loc)?.name ?? ''}`, source: 'Kurse', ignoreDnd: true }).catch(() => undefined);
      }
      return { certificate: cert, created: true };
    }

    // Automatic issuing: when the course is completed (templates with „bei Abschluss“) or a quiz is passed (templates bound to it).
    app.events.on('course.completed', async (e) => {
      const { contactId, courseId } = e.data;
      if (!contactId || !courseId) return;
      const t = db.get<any>(`SELECT * FROM certificate_templates WHERE location_id = ? AND enabled = 1 AND issue_on = 'completion' AND (course_id = ? OR course_id IS NULL) ORDER BY course_id IS NULL LIMIT 1`, e.locationId, courseId);
      if (!t) return;
      try {
        await issue(e.locationId, { courseId, contactId, templateId: t.id, source: 'completion' });
      } catch (err) {
        console.error('[certificates]', (err as Error).message);
      }
    });
    app.events.on('quiz.passed', async (e) => {
      const { contactId, courseId, quizId, percent } = e.data;
      const t = db.get<any>(`SELECT * FROM certificate_templates WHERE location_id = ? AND enabled = 1 AND issue_on = 'quiz' AND quiz_id = ? LIMIT 1`, e.locationId, quizId);
      if (!t || !contactId) return;
      try {
        await issue(e.locationId, { courseId: t.course_id ?? courseId, contactId, templateId: t.id, score: percent, source: 'quiz' });
      } catch (err) {
        console.error('[certificates]', (err as Error).message);
      }
    });

    // --- admin API for issued certificates -------------------------------------------------------------------------------
    router.get('/api/certificates', 'location', (ctx) => {
      const where = ['c.location_id = ?'];
      const args: any[] = [ctx.locationId];
      for (const [k, col] of [['course_id', 'c.course_id'], ['contact_id', 'c.contact_id']] as const) {
        const v = ctx.query.get(k);
        if (v) (where.push(`${col} = ?`), args.push(v));
      }
      return db
        .all<any>(`SELECT c.*, k.email FROM certificates c LEFT JOIN contacts k ON k.id = c.contact_id WHERE ${where.join(' AND ')} ORDER BY c.issued_at DESC LIMIT ?`, ...args, clampLimit(ctx.query.get('limit'), 100, 500))
        .map((r) => ({ ...certOut({ ...r, config: cleanCertConfig(json(r.config, {})) }), email: r.email ?? '' }));
    });
    router.post('/api/certificates/issue', 'location', async (ctx) => {
      const b = ctx.body ?? {};
      let contactId = clip(b.contact_id, 40);
      if (contactId && !getContact(app, ctx.locationId, contactId)) throw notFound('Kontakt nicht gefunden');
      if (!contactId) {
        const email = String(b.email ?? '').trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Kontakt oder gültige E-Mail angeben');
        contactId = upsertContact(app, ctx.locationId, { email, name: clip(b.name, 120) }, { source: 'Zertifikate' }).contact.id;
      }
      const r = await issue(ctx.locationId, { courseId: clip(b.course_id, 40), contactId, templateId: clip(b.template_id, 40) || undefined, source: 'manual', ctx, fallback: true });
      return { ...certOut(r!.certificate), created: r!.created };
    });
    router.get('/api/certificates/:id/pdf', 'location', (ctx): RawResult => {
      const c = certOf(ctx.locationId, ctx.params.id);
      if (!c) throw notFound('Zertifikat nicht gefunden');
      return pdfResult(c);
    });
    router.post('/api/certificates/:id/revoke', 'location', (ctx) => {
      const c = certOf(ctx.locationId, ctx.params.id);
      if (!c) throw notFound('Zertifikat nicht gefunden');
      if (c.revoked_at) throw bad('Dieses Zertifikat ist schon widerrufen');
      db.run('UPDATE certificates SET revoked_at = ?, revoked_reason = ? WHERE id = ?', now(), clip(ctx.body?.reason, 300), c.id);
      logActivity(app, c.location_id, c.contact_id, 'certificate.revoked', `Zertifikat ${c.number} widerrufen`);
      return certOut(certOf(ctx.locationId, c.id)!);
    });
    router.post('/api/certificates/:id/resend', 'location', async (ctx) => {
      const c = certOf(ctx.locationId, ctx.params.id);
      if (!c || c.revoked_at) throw notFound('Zertifikat nicht gefunden');
      const m = await sendToContact(app, c.location_id, { contactId: c.contact_id, channel: 'email', subject: `Dein Zertifikat für „${c.course_title}“`, body: `Hallo,\n\nhier noch einmal dein Zertifikat für „${c.course_title}“:\nPDF: ${urls(c).pdf_url}\nPrüfseite: ${urls(c).url}\n\n${app.location(c.location_id)?.name ?? ''}`, source: 'Kurse', ignoreDnd: true, userId: ctx.user?.id });
      if (m.status === 'failed') throw bad(String(m.error));
      return { ok: true };
    });

    // --- public verification ------------------------------------------------------------------------------------------------
    const page = (title: string, body: string, status = 200, color?: string) => {
      const r = html(publicPage({ title, color, head: '<meta name="robots" content="noindex, nofollow">', body: `<div class="wrap" style="max-width:640px"><div class="card">${body}</div></div>` }), status);
      r.headers['cache-control'] = 'private, no-cache';
      r.headers['x-robots-tag'] = 'noindex';
      return r;
    };
    const publicCert = (cid: string): Certificate | undefined => {
      if (!/^[A-Za-z0-9]{22}$/.test(cid)) return undefined;
      const r = db.get<any>('SELECT * FROM certificates WHERE id = ?', cid);
      return r ? { ...r, config: cleanCertConfig(json(r.config, {})) } : undefined;
    };
    router.get('/zertifikat/:id', 'public', (ctx) => {
      if (VERIFY_LIMIT(ctx.ip)) return page('Zu viele Anfragen', '<h1>Zu viele Anfragen</h1><p class="muted">Bitte in ein paar Minuten noch einmal.</p>', 429);
      const c = publicCert(ctx.params.id);
      if (!c) return page('Zertifikat nicht gefunden', '<h1>Kein Zertifikat gefunden</h1><p class="muted">Zu dieser Adresse gibt es kein Zertifikat. Bitte prüfe den Link oder die Nummer.</p>', 404);
      const loc = app.location(c.location_id);
      const issuer = c.config.issuer || loc?.settings?.branding?.name || loc?.name || '';
      const date = deDate(c.issued_at, loc?.timezone);
      const color = /^#[0-9a-f]{6}$/i.test(c.config.color) ? c.config.color : undefined;
      if (c.revoked_at) {
        return page(`Zertifikat ${c.number} (widerrufen)`, `<h1 style="color:#b91c1c">Dieses Zertifikat wurde widerrufen</h1><p>Das Zertifikat <b>${escapeHtml(c.number)}</b> von ${escapeHtml(issuer)} ist nicht mehr gültig.</p><p class="muted">Widerrufen am ${escapeHtml(deDate(c.revoked_at, loc?.timezone))}</p>`, 200, color);
      }
      return page(
        `Zertifikat ${c.number}`,
        `<p class="ok" style="display:inline-block;font-weight:700;margin:0 0 14px">✓ Echtes Zertifikat</p>
<h1 style="margin:0 0 6px">${escapeHtml(c.config.title || 'Zertifikat')}</h1>
<p style="font-size:22px;margin:8px 0 2px"><b>${escapeHtml(c.recipient_name)}</b></p>
<p class="muted" style="margin:0 0 16px">${escapeHtml(c.course_title)}</p>
<table><tbody><tr><td class="muted">Kurs</td><td>${escapeHtml(c.course_title)}</td></tr>
<tr><td class="muted">Ausgestellt am</td><td>${escapeHtml(date)}</td></tr>
<tr><td class="muted">Ausgestellt von</td><td>${escapeHtml(issuer)}</td></tr>
<tr><td class="muted">Zertifikat-Nr.</td><td>${escapeHtml(c.number)}</td></tr>
${c.config.show_score && c.score_percent !== null ? `<tr><td class="muted">Ergebnis</td><td>${c.score_percent} %</td></tr>` : ''}</tbody></table>
<p style="margin-top:20px"><a class="btn" href="/zertifikat/${escapeHtml(c.id)}/pdf">Zertifikat als PDF</a></p>`,
        200,
        color,
      );
    });
    router.get('/zertifikat/:id/pdf', 'public', (ctx): RawResult => {
      if (VERIFY_LIMIT(ctx.ip)) throw notFound();
      const c = publicCert(ctx.params.id);
      if (!c || c.revoked_at) throw notFound('Zertifikat nicht gefunden');
      return pdfResult(c);
    });

    // --- member area: the person's certificates ---------------------------------------------------------------------------------
    app.services.portalDashboard = [
      ...(app.services.portalDashboard ?? []),
      (p: any, m: any) => {
        const list = db.all<Certificate>('SELECT * FROM certificates WHERE location_id = ? AND contact_id = ? AND revoked_at IS NULL ORDER BY issued_at DESC LIMIT 50', p.locationId, m.contact.id);
        if (!list.length) return '';
        return `<h2 style="margin:34px 0 12px" id="zertifikate">Meine Zertifikate</h2><div class="grid">${list
          .map((c) => `<div class="panel"><b>${escapeHtml(c.course_title)}</b><div class="muted small">${escapeHtml(c.number)} · ${escapeHtml(deDate(c.issued_at, p.loc.timezone))}</div><p style="margin:12px 0 0"><a class="btn" href="/zertifikat/${escapeHtml(c.id)}/pdf">PDF öffnen</a> <a class="btn ghost" href="/zertifikat/${escapeHtml(c.id)}">Prüfseite</a></p></div>`)
          .join('')}</div>`;
      },
    ];

    // --- workflow action ------------------------------------------------------------------------------------------------------------
    registerActions(app, [
      {
        meta: {
          type: 'certificate_issue',
          label: 'Zertifikat ausstellen',
          category: 'content',
          icon: 'courses',
          summary: 'Stellt dem Kontakt das Zertifikat eines Kurses aus und erzeugt das PDF.',
          doc: 'Gibt es schon ein gültiges Zertifikat für Kurs und Person, passiert nichts Neues. Ohne gewählte Vorlage gilt die Vorlage des Kurses (oder die Standardvorlage). Danach stehen {{var.certificate_url}} (Prüfseite), {{var.certificate_pdf_url}} und {{var.certificate_number}} bereit; der Auslöser „Zertifikat ausgestellt“ startet außerdem.',
          fields: [
            { key: 'course_id', label: 'Kurs (ID, leer = aus dem Ereignis)', type: 'text', placeholder: '{{event.courseId}}' },
            { key: 'template_id', label: 'Vorlage (ID, optional)', type: 'text' },
          ],
          provides: ['var.certificate_url', 'var.certificate_pdf_url', 'var.certificate_number'],
          sample: { course_id: '{{event.courseId}}' },
        },
        run: async (run, step, vars) => {
          const courseId = fill(step.course_id || '{{event.courseId}}', vars).trim();
          requireText(courseId, 'Kurs');
          const r = await issue(run.location_id, { courseId, contactId: run.contact_id, templateId: clip(fill(step.template_id ?? '', vars), 40) || undefined, source: 'workflow', by: 'Workflow', fallback: true });
          const c = r!.certificate;
          return { result: r!.created ? `Zertifikat ${c.number} ausgestellt` : `Zertifikat ${c.number} gab es schon`, vars: { certificate_url: urls(c).url, certificate_pdf_url: urls(c).pdf_url, certificate_number: c.number } };
        },
      },
    ]);

    app.services.certificates = { issue };
  },
};
