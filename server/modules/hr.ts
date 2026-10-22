import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, num, str, type Ctx } from '../core/http.js';
import { contentMatches, extFor } from '../core/files.js';
import { openSecret, sealSecret } from '../core/secrets.js';
import { id, now } from '../core/util.js';
import { addDays, isYmd, q3, today, usersWithArea } from '../services/bo-common.js';
import { DEFAULT_WORK_DAYS, STATES, absenceDays, balance as leaveBalance, entitlement, holidayMap, holidays, isState, isoWeekday, sumDays, type Balance } from '../services/hr-leave.js';
import type { Tool } from './mcp.js';
import { hiddenUser } from '../core/permissions.js';

/**
 * Personal (HR basics): employee records – HyperLevel users and people without a login – with contract data, documents and a
 * sealed block of sensitive fields (salary, bank account, tax ID, social-security number, birth date).
 *
 * Access, strictly:
 * - the area "Personal" opens /api/hr/* – and must be granted explicitly (a login with "all areas" is NOT enough; agency admins always);
 * - the sensitive fields are a second gate: only agency admins and the people HR lists in the settings, only in a browser session
 *   (never through API keys, MCP, mobile tokens), and every read is written to the audit log;
 * - everybody else sees only their own record, under /api/me/hr (contract data, own absences, own documents – no salary).
 */

export interface HrSettings {
  default_state: string;
  default_vacation_days: number;
  /** MM-DD: carry-over days not used by then are gone (Verfall, default 31 March). */
  carryover_expiry: string;
  carryover_max_days: number | null;
  /** Sick notices need no approval. */
  sick_auto_approve: boolean;
  /** Users (besides the agency admins) who may see and edit sensitive fields. */
  sensitive_user_ids: string[];
  /** The standard onboarding/offboarding checklists were created once (deleting them does not bring them back). */
  templates_seeded: boolean;
}

export const defaultHrSettings = (): HrSettings => ({ default_state: 'BE', default_vacation_days: 30, carryover_expiry: '03-31', carryover_max_days: null, sick_auto_approve: true, sensitive_user_ids: [], templates_seeded: false });

export function getHrSettings(app: App, locationId: string): HrSettings {
  const row = app.db.get<{ data: string }>('SELECT data FROM hr_settings WHERE location_id = ?', locationId);
  let saved: any = {};
  try {
    saved = row ? JSON.parse(row.data) : {};
  } catch {
    saved = {};
  }
  const d = defaultHrSettings();
  return {
    default_state: isState(saved.default_state) ? saved.default_state : d.default_state,
    default_vacation_days: Number.isFinite(saved.default_vacation_days) ? saved.default_vacation_days : d.default_vacation_days,
    carryover_expiry: /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(saved.carryover_expiry ?? '') ? saved.carryover_expiry : saved.carryover_expiry === '' ? '' : d.carryover_expiry,
    carryover_max_days: Number.isFinite(saved.carryover_max_days) ? saved.carryover_max_days : null,
    sick_auto_approve: saved.sick_auto_approve !== false,
    sensitive_user_ids: Array.isArray(saved.sensitive_user_ids) ? saved.sensitive_user_ids.filter((x: unknown) => typeof x === 'string') : [],
    templates_seeded: saved.templates_seeded === true,
  };
}

// --- who may do what --------------------------------------------------------------------------------------------

/** HR rights: agency admins, logins that have "Personal" listed explicitly, and sub-account API keys (no person behind them). */
export function isHr(ctx: Ctx): boolean {
  const u = ctx.user;
  if (!u) return ctx.viaApiKey;
  if (u.role === 'admin') return true;
  return Array.isArray(u.permissions) && u.permissions.includes('personal');
}

/** The second gate: admins and the people HR lists, only in a browser session. */
export function canSeeSensitive(app: App, ctx: Ctx): boolean {
  const u = ctx.user;
  if (!u || ctx.via !== 'session') return false;
  if (u.role === 'admin') return true;
  return isHr(ctx) && !!ctx.locationId && getHrSettings(app, ctx.locationId).sensitive_user_ids.includes(u.id);
}

export const SENSITIVE_KEYS = ['salary_cents', 'salary_period', 'iban', 'tax_id', 'social_security_no', 'tax_class', 'health_insurance', 'birth_date'] as const;
export type SensitiveKey = (typeof SENSITIVE_KEYS)[number];
export type Sensitive = Partial<Record<SensitiveKey, string | number>>;

const IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;

/** ISO 13616 check: move the first four characters to the end, letters become 10–35, the number mod 97 must be 1. */
export function ibanChecksumOk(iban: string): boolean {
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of moved) for (const digit of String(/\d/.test(ch) ? ch : ch.charCodeAt(0) - 55)) rest = (rest * 10 + Number(digit)) % 97;
  return rest === 1;
}

export function cleanSensitive(b: any): Sensitive {
  const out: Sensitive = {};
  if (b.salary_cents !== undefined && b.salary_cents !== null && b.salary_cents !== '') {
    const n = Math.round(num(b.salary_cents, NaN));
    if (!Number.isFinite(n) || n < 0 || n > 99_999_999_99) throw bad('Gehalt ungültig (in Cent)');
    out.salary_cents = n;
  }
  if (b.salary_period !== undefined && b.salary_period !== '') {
    if (!['month', 'year', 'hour'].includes(b.salary_period)) throw bad('Gehalt je: month, year oder hour');
    out.salary_period = b.salary_period;
  }
  if (b.iban !== undefined && b.iban !== '') {
    const iban = String(b.iban).replace(/\s+/g, '').toUpperCase();
    if (!IBAN_RE.test(iban) || !ibanChecksumOk(iban)) throw bad('IBAN ungültig');
    out.iban = iban;
  }
  if (b.tax_id !== undefined && b.tax_id !== '') {
    const v = String(b.tax_id).replace(/\s+/g, '');
    if (!/^\d{11}$/.test(v)) throw bad('Steuer-ID: 11 Ziffern');
    out.tax_id = v;
  }
  if (b.social_security_no !== undefined && b.social_security_no !== '') {
    const v = String(b.social_security_no).replace(/\s+/g, '').toUpperCase();
    if (!/^\d{8}[A-Z]\d{3}$/.test(v)) throw bad('Sozialversicherungsnummer: 12 Zeichen (z. B. 12 010190 M 123)');
    out.social_security_no = v;
  }
  for (const [k, max] of [['tax_class', 3], ['health_insurance', 120]] as const) if (b[k] !== undefined && b[k] !== '') out[k] = str(b[k], k, { max });
  if (b.birth_date !== undefined && b.birth_date !== '') {
    if (!isYmd(b.birth_date)) throw bad('Geburtsdatum als JJJJ-MM-TT');
    out.birth_date = b.birth_date;
  }
  return out;
}

export const MIGRATION = `
CREATE TABLE hr_settings (location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);
CREATE TABLE hr_employees (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, user_id TEXT, contact_id TEXT, number TEXT NOT NULL DEFAULT '',
  first_name TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', position TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '', manager_user_id TEXT, employment_type TEXT NOT NULL DEFAULT 'full', start_date TEXT, end_date TEXT, probation_end TEXT,
  notice_period TEXT NOT NULL DEFAULT '', weekly_hours REAL NOT NULL DEFAULT 40, work_days TEXT NOT NULL DEFAULT '[1,2,3,4,5]', vacation_days REAL NOT NULL DEFAULT 30,
  state TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', notes TEXT NOT NULL DEFAULT '', sensitive TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX hr_employees_user ON hr_employees(location_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX hr_employees_loc ON hr_employees(location_id, status);
CREATE INDEX hr_employees_contact ON hr_employees(contact_id);
CREATE INDEX hr_employees_manager ON hr_employees(location_id, manager_user_id);
CREATE TABLE hr_documents (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, employee_id TEXT NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'sonstiges', visibility TEXT NOT NULL DEFAULT 'hr',
  uploaded_by TEXT, created_at TEXT NOT NULL
);
CREATE INDEX hr_documents_emp ON hr_documents(employee_id);
CREATE TABLE hr_leave_years (
  employee_id TEXT NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE, location_id TEXT NOT NULL, year INTEGER NOT NULL,
  carryover_days REAL NOT NULL DEFAULT 0, adjustment_days REAL NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', PRIMARY KEY (employee_id, year)
);
CREATE TABLE hr_absences (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, employee_id TEXT NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  type TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', start_date TEXT NOT NULL, end_date TEXT NOT NULL, half_start INTEGER NOT NULL DEFAULT 0, half_end INTEGER NOT NULL DEFAULT 0,
  days REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'requested', reason TEXT NOT NULL DEFAULT '', certificate INTEGER NOT NULL DEFAULT 0,
  requested_by TEXT, decided_by TEXT, decided_at TEXT, decision_note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX hr_absences_emp ON hr_absences(employee_id, start_date);
CREATE INDEX hr_absences_loc ON hr_absences(location_id, status, start_date);
CREATE TABLE hr_checklist_templates (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, kind TEXT NOT NULL, name TEXT NOT NULL, items TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX hr_checklist_templates_loc ON hr_checklist_templates(location_id, kind);
CREATE TABLE hr_checklists (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, employee_id TEXT NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  template_id TEXT, kind TEXT NOT NULL, name TEXT NOT NULL, items TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX hr_checklists_emp ON hr_checklists(employee_id, status);
CREATE INDEX hr_checklists_loc ON hr_checklists(location_id, status);
`;

export interface EmployeeRow {
  id: string;
  location_id: string;
  user_id: string | null;
  contact_id: string | null;
  number: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  position: string;
  department: string;
  manager_user_id: string | null;
  employment_type: string;
  start_date: string | null;
  end_date: string | null;
  probation_end: string | null;
  notice_period: string;
  weekly_hours: number;
  work_days: string;
  vacation_days: number;
  state: string;
  status: string;
  notes: string;
  sensitive: string | null;
  created_at: string;
  updated_at: string;
}

export const EMPLOYMENT_TYPES: Record<string, string> = { full: 'Vollzeit', part: 'Teilzeit', mini: 'Minijob', intern: 'Praktikum/Ausbildung', freelance: 'Freie Mitarbeit' };

export const workDaysOf = (e: Pick<EmployeeRow, 'work_days'>): number[] => {
  try {
    const v = JSON.parse(e.work_days);
    return Array.isArray(v) && v.length ? v.filter((x) => Number.isInteger(x) && x >= 1 && x <= 7) : DEFAULT_WORK_DAYS;
  } catch {
    return DEFAULT_WORK_DAYS;
  }
};

export const fullName = (e: Pick<EmployeeRow, 'first_name' | 'last_name'>) => [e.first_name, e.last_name].filter(Boolean).join(' ');

/** What leaves the server about an employee: everything except the sensitive block. */
export function employeeOut(e: EmployeeRow, settings?: HrSettings) {
  const { sensitive, ...rest } = e;
  return { ...rest, name: fullName(e), work_days: workDaysOf(e), state: e.state || settings?.default_state || '', has_sensitive: !!sensitive };
}

export const getEmployee = (app: App, locationId: string, employeeId: string): EmployeeRow => {
  const e = app.db.get<EmployeeRow>('SELECT * FROM hr_employees WHERE id = ? AND location_id = ?', employeeId, locationId);
  if (!e) throw notFound('Mitarbeiter nicht gefunden');
  return e;
};

export const selfEmployee = (app: App, ctx: Ctx): EmployeeRow | undefined => (ctx.user ? app.db.get<EmployeeRow>(`SELECT * FROM hr_employees WHERE location_id = ? AND user_id = ? AND status != 'inactive'`, ctx.locationId, ctx.user.id) : undefined);

/** The CRM contact a workflow should address for this employee: the linked one, else one with the same e-mail. */
export function contactOfEmployee(app: App, e: EmployeeRow): string | undefined {
  if (e.contact_id && app.db.get('SELECT 1 FROM contacts WHERE id = ? AND location_id = ?', e.contact_id, e.location_id)) return e.contact_id;
  if (!e.email) return undefined;
  return app.db.get<{ id: string }>('SELECT id FROM contacts WHERE location_id = ? AND lower(email) = lower(?) LIMIT 1', e.location_id, e.email)?.id;
}

const DOC_MIMES = /^(application\/pdf|image\/(png|jpeg|webp)|text\/plain|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet)|application\/vnd\.oasis\.opendocument\.(text|spreadsheet))$/;
const docDir = (app: App) => join(app.config.dataDir, 'hr-docs');
export const hrDocPath = (app: App, d: { id: string; mime: string }) => join(docDir(app), d.id + extFor(d.mime));
const CATEGORIES = ['vertrag', 'zeugnis', 'bescheinigung', 'abrechnung', 'sonstiges'];

export const ABSENCE_TYPES: Record<string, string> = { vacation: 'Urlaub', sick: 'Krankmeldung', other: 'Sonstige Abwesenheit' };
export const HR_TRIGGERS = ['absence.requested', 'absence.approved', 'absence.rejected'];

export interface AbsenceRow {
  id: string;
  location_id: string;
  employee_id: string;
  type: string;
  label: string;
  start_date: string;
  end_date: string;
  half_start: number;
  half_end: number;
  days: number;
  status: string;
  reason: string;
  certificate: number;
  requested_by: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string;
  created_at: string;
  updated_at: string;
}

interface TemplateItem {
  title: string;
  assignee: string;
  /** Days relative to the start date (onboarding) or the end date (offboarding); negative = before. */
  due_days: number;
}

const TOOLS: Tool[] = [
  {
    name: 'ghl_create_absence_request',
    title: 'Abwesenheit beantragen',
    description:
      'Legt einen Abwesenheitsantrag an (vacation = Urlaub, sick = Krankmeldung, other = sonstige). Ohne employee_id/email wird der Antrag für den eigenen Mitarbeiterdatensatz der angemeldeten Person gestellt. Urlaub bleibt "requested" bis das Personalbüro oder die Führungskraft genehmigt; Resturlaub und Überschneidungen werden geprüft. Bei Krankmeldungen wird nie ein Grund gespeichert.',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string' },
        employee_id: { type: 'string' },
        email: { type: 'string', description: 'E-Mail-Adresse des Mitarbeiters (statt employee_id)' },
        type: { type: 'string', enum: ['vacation', 'sick', 'other'] },
        start_date: { type: 'string', description: 'JJJJ-MM-TT' },
        end_date: { type: 'string', description: 'JJJJ-MM-TT (Standard: wie start_date)' },
        half_start: { type: 'boolean', description: 'erster Tag nur halber Tag' },
        half_end: { type: 'boolean', description: 'letzter Tag nur halber Tag' },
        label: { type: 'string', description: 'Bezeichnung bei type=other (z. B. Sonderurlaub)' },
        reason: { type: 'string', description: 'Anmerkung (bei Krankmeldungen ignoriert)' },
      },
      required: ['type', 'start_date'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (call, a) => {
      let employeeId: string | undefined = a.employee_id;
      if (!employeeId && a.email) {
        const list: any[] = await call.api('GET', `/api/hr/employees?q=${encodeURIComponent(a.email)}`, { location: a.location_id });
        employeeId = list.find((x) => String(x.email).toLowerCase() === String(a.email).toLowerCase())?.id;
        if (!employeeId) throw new Error('Kein Mitarbeiter mit dieser E-Mail-Adresse gefunden');
      }
      const body = { type: a.type, start_date: a.start_date, end_date: a.end_date, half_start: a.half_start, half_end: a.half_end, label: a.label, reason: a.reason };
      if (employeeId) return call.api('POST', '/api/hr/absences', { location: a.location_id, body: { ...body, employee_id: employeeId } });
      return call.api('POST', '/api/me/hr/absences', { location: a.location_id, body });
    },
  },
];

export const hrModule: Module = {
  name: 'hr',
  migrations: [['001-init', MIGRATION]],
  register(app) {
    const { db, router } = app;

    // The area has to be granted explicitly: "all areas" (permissions null) is the default of client logins and must not open HR.
    app.guards.push((ctx) => {
      if (ctx.path !== '/api/hr' && !ctx.path.startsWith('/api/hr/')) return;
      if (ctx.user && ctx.user.role !== 'admin' && ctx.user.permissions === null) throw new HttpError(403, 'Kein Zugriff auf „Personal (Mitarbeiter, Abwesenheiten)“ – der Bereich muss für diesen Login ausdrücklich freigegeben sein');
    });

    app.services.privacyErase = [
      ...(app.services.privacyErase ?? []),
      (_a: App, loc: string, contact: { id: string }) => {
        db.run('UPDATE hr_employees SET contact_id = NULL WHERE location_id = ? AND contact_id = ?', loc, contact.id);
      },
    ];

    const userId = (ctx: Ctx) => (ctx.user && ctx.via !== 'agency_key' && ctx.via !== 'mcp' ? ctx.user.id : null);
    const audit = (ctx: Ctx, action: string, entityId: string, summary: string) => app.services.audit?.({ ctx, action, route: `${ctx.method} ${ctx.path.replace(/\/[A-Za-z0-9]{16,}/g, '/:id')}`, entityId, summary });

    // --- access info -----------------------------------------------------------------------------------------------
    router.get('/api/hr/access', 'location', (ctx) => ({ hr: isHr(ctx), sensitive: canSeeSensitive(app, ctx), states: STATES }));

    // --- settings ---------------------------------------------------------------------------------------------------
    const settingsOut = (ctx: Ctx) => {
      const s = getHrSettings(app, ctx.locationId);
      return { ...s, sensitive_user_ids: canSeeSensitive(app, ctx) ? s.sensitive_user_ids : [], can_edit_sensitive_users: canSeeSensitive(app, ctx), states: STATES };
    };
    router.get('/api/hr/settings', 'location', (ctx) => settingsOut(ctx));
    router.put('/api/hr/settings', 'location', (ctx) => {
      const cur = getHrSettings(app, ctx.locationId);
      const b = ctx.body ?? {};
      const next = { ...cur };
      if (b.default_state !== undefined) {
        if (!isState(b.default_state)) throw bad('Bundesland ungültig');
        next.default_state = b.default_state;
      }
      if (b.default_vacation_days !== undefined) {
        const n = num(b.default_vacation_days, NaN);
        if (!Number.isFinite(n) || n < 0 || n > 60) throw bad('Urlaubstage: 0 bis 60');
        next.default_vacation_days = q3(n);
      }
      if (b.carryover_expiry !== undefined) {
        if (b.carryover_expiry !== '' && !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(b.carryover_expiry)) throw bad('Verfall des Resturlaubs als MM-TT (z. B. 03-31) oder leer');
        next.carryover_expiry = b.carryover_expiry;
      }
      if (b.carryover_max_days !== undefined) {
        const n = b.carryover_max_days === null || b.carryover_max_days === '' ? null : num(b.carryover_max_days, NaN);
        if (n !== null && (!Number.isFinite(n) || n < 0 || n > 60)) throw bad('Höchstens übertragbare Tage: 0 bis 60');
        next.carryover_max_days = n;
      }
      if (b.sick_auto_approve !== undefined) next.sick_auto_approve = !!b.sick_auto_approve;
      if (b.sensitive_user_ids !== undefined) {
        // Who sees salaries is decided by those who see them already.
        if (!canSeeSensitive(app, ctx)) throw new HttpError(403, 'Die Liste der Personen mit Zugriff auf sensible Daten dürfen nur Administratoren und bereits Berechtigte ändern');
        if (!Array.isArray(b.sensitive_user_ids)) throw bad('Personen als Liste');
        const ids = [...new Set<string>(b.sensitive_user_ids.map(String))];
        for (const uid of ids) if (!usersOf(ctx.locationId).some((u) => u.id === uid)) throw bad('Eine der Personen hat keinen Zugriff auf diesen Sub-Account');
        next.sensitive_user_ids = ids;
      }
      db.run(`INSERT INTO hr_settings (location_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`, ctx.locationId, JSON.stringify(next), now());
      if (b.sensitive_user_ids !== undefined) audit(ctx, 'hr.sensitive.access.update', ctx.locationId, `Zugriff auf sensible Daten: ${next.sensitive_user_ids.length} Person(en)`);
      return settingsOut(ctx);
    });

    /** Logins that belong to this sub-account (for linking employees and choosing approvers). */
    const usersOf = (loc: string) =>
      db
        .all<{ id: string; name: string; email: string; role: string; locations: string }>('SELECT id, name, email, role, locations FROM users ORDER BY name')
        .filter((u) => u.role === 'admin' || (JSON.parse(u.locations || '[]') as string[]).includes(loc))
        .filter((u) => !hiddenUser(app, u, loc))
        .map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role }));
    router.get('/api/hr/users', 'location', (ctx) => usersOf(ctx.locationId));

    // --- employees -------------------------------------------------------------------------------------------------------
    /** The calendar year in the sub-account's zone (on 1 January at 00:30 in Berlin the UTC year is still the old one). */
    const thisYear = (loc: string) => Number(today(app, loc).slice(0, 4));
    const nextNumber = (loc: string) => {
      const max = db.all<{ number: string }>('SELECT number FROM hr_employees WHERE location_id = ?', loc).reduce((m, r) => Math.max(m, Number(/(\d+)$/.exec(r.number)?.[1] ?? 0)), 0);
      return `P-${String(max + 1).padStart(3, '0')}`;
    };
    const checkUser = (loc: string, uid: unknown, selfId?: string): string | null => {
      if (!uid) return null;
      if (!usersOf(loc).some((u) => u.id === String(uid))) throw bad('Dieser Login hat keinen Zugriff auf den Sub-Account');
      if (db.get('SELECT 1 FROM hr_employees WHERE location_id = ? AND user_id = ? AND id != ?', loc, String(uid), selfId ?? '')) throw bad('Dieser Login gehört schon zu einem anderen Mitarbeiter');
      return String(uid);
    };
    const checkContact = (loc: string, cid: unknown): string | null => {
      if (!cid) return null;
      if (!db.get('SELECT 1 FROM contacts WHERE id = ? AND location_id = ?', String(cid), loc)) throw bad('Kontakt nicht gefunden');
      return String(cid);
    };

    const cleanEmployee = (loc: string, b: any, cur?: EmployeeRow) => {
      const out: Record<string, any> = {};
      if (b.first_name !== undefined) out.first_name = str(b.first_name, 'Vorname', { max: 80 });
      if (b.last_name !== undefined || !cur) out.last_name = str(b.last_name, 'Nachname', { required: true, max: 80 });
      for (const [k, max] of [['email', 200], ['phone', 50], ['position', 120], ['department', 120], ['notice_period', 80], ['notes', 3000]] as const) if (b[k] !== undefined) out[k] = str(b[k], k, { max });
      if (out.email && !/^[^\s@]+@[^\s@]+$/.test(out.email)) throw bad('E-Mail-Adresse ungültig');
      if (b.employment_type !== undefined) {
        if (!(b.employment_type in EMPLOYMENT_TYPES)) throw bad(`Beschäftigungsart: ${Object.keys(EMPLOYMENT_TYPES).join(', ')}`);
        out.employment_type = b.employment_type;
      }
      for (const k of ['start_date', 'end_date', 'probation_end'] as const)
        if (b[k] !== undefined) {
          if (b[k] && !isYmd(b[k])) throw bad(`${k === 'start_date' ? 'Eintrittsdatum' : k === 'end_date' ? 'Austrittsdatum' : 'Ende der Probezeit'}: bitte als JJJJ-MM-TT angeben`);
          out[k] = b[k] || null;
        }
      const start = out.start_date !== undefined ? out.start_date : cur?.start_date;
      const end = out.end_date !== undefined ? out.end_date : cur?.end_date;
      if (start && end && end < start) throw bad('Das Austrittsdatum liegt vor dem Eintrittsdatum');
      if (b.weekly_hours !== undefined) {
        const n = num(b.weekly_hours, NaN);
        if (!Number.isFinite(n) || n < 0 || n > 80) throw bad('Wochenstunden: 0 bis 80');
        out.weekly_hours = q3(n);
      }
      if (b.vacation_days !== undefined) {
        const n = num(b.vacation_days, NaN);
        if (!Number.isFinite(n) || n < 0 || n > 60) throw bad('Urlaubstage: 0 bis 60');
        out.vacation_days = q3(n);
      }
      if (b.work_days !== undefined) {
        if (!Array.isArray(b.work_days) || !b.work_days.length || b.work_days.some((d: unknown) => !Number.isInteger(d) || (d as number) < 1 || (d as number) > 7)) throw bad('Arbeitstage als Liste von 1 (Montag) bis 7 (Sonntag)');
        out.work_days = JSON.stringify([...new Set(b.work_days as number[])].sort());
      }
      if (b.state !== undefined) {
        if (b.state && !isState(b.state)) throw bad('Bundesland ungültig (z. B. BE, BY, NW)');
        out.state = b.state || '';
      }
      if (b.status !== undefined) {
        if (!['active', 'inactive'].includes(b.status)) throw bad('Status: active oder inactive');
        out.status = b.status;
      }
      if (b.user_id !== undefined) out.user_id = checkUser(loc, b.user_id, cur?.id);
      if (b.contact_id !== undefined) out.contact_id = checkContact(loc, b.contact_id);
      if (b.manager_user_id !== undefined) {
        if (b.manager_user_id && !usersOf(loc).some((u) => u.id === String(b.manager_user_id))) throw bad('Vorgesetzte/r hat keinen Zugriff auf den Sub-Account');
        out.manager_user_id = b.manager_user_id ? String(b.manager_user_id) : null;
      }
      return out;
    };

    const SENSITIVE_DENIED = 'Sensible Daten (Gehalt, Bankverbindung, Steuer-ID, Sozialversicherungsnummer, Geburtsdatum) dürfen nur Administratoren und die in den Personal-Einstellungen freigegebenen Personen sehen und ändern – nur in der Oberfläche';
    const saveSensitive = (e: EmployeeRow, patch: Sensitive, replace = false) => {
      const cur = readSensitive(e);
      const next: Sensitive = replace ? patch : { ...cur, ...patch };
      for (const k of Object.keys(next) as SensitiveKey[]) if (next[k] === '' || next[k] === undefined) delete next[k];
      db.run('UPDATE hr_employees SET sensitive = ?, updated_at = ? WHERE id = ?', Object.keys(next).length ? sealSecret(app, JSON.stringify(next)) : null, now(), e.id);
      return next;
    };
    const readSensitive = (e: EmployeeRow): Sensitive => {
      if (!e.sensitive) return {};
      try {
        return JSON.parse(openSecret(app, e.sensitive));
      } catch {
        return {};
      }
    };

    router.get('/api/hr/employees', 'location', (ctx) => {
      const settings = getHrSettings(app, ctx.locationId);
      const where = ['location_id = ?'];
      const params: any[] = [ctx.locationId];
      const status = ctx.query.get('status');
      if (status === 'all') {
        /* every status */
      } else (where.push('status = ?'), params.push(status === 'inactive' ? 'inactive' : 'active'));
      const q = (ctx.query.get('q') ?? '').trim();
      if (q) (where.push('(first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR position LIKE ? OR department LIKE ? OR number LIKE ?)'), params.push(...Array(6).fill(`%${q}%`)));
      const rows = db.all<EmployeeRow>(`SELECT * FROM hr_employees WHERE ${where.join(' AND ')} ORDER BY last_name, first_name LIMIT 1000`, ...params);
      const year = Number(ctx.query.get('year')) || thisYear(ctx.locationId);
      const vac = balancesFor(ctx.locationId, rows, year);
      return rows.map((e) => ({ ...employeeOut(e, settings), vacation: vac.get(e.id) }));
    });
    router.post('/api/hr/employees', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const settings = getHrSettings(app, ctx.locationId);
      // A first-time record can be created without the second gate; sensitive values in the same request need it.
      const sens = b.sensitive && typeof b.sensitive === 'object' ? cleanSensitive(b.sensitive) : undefined;
      if (sens && Object.keys(sens).length && !canSeeSensitive(app, ctx)) throw new HttpError(403, SENSITIVE_DENIED);
      const f = cleanEmployee(ctx.locationId, b);
      const row: EmployeeRow = {
        id: id(),
        location_id: ctx.locationId,
        user_id: null,
        contact_id: null,
        number: str(b.number, 'Personalnummer', { max: 20 }) || nextNumber(ctx.locationId),
        first_name: '',
        last_name: '',
        email: '',
        phone: '',
        position: '',
        department: '',
        manager_user_id: null,
        employment_type: 'full',
        start_date: null,
        end_date: null,
        probation_end: null,
        notice_period: '',
        weekly_hours: 40,
        work_days: JSON.stringify(DEFAULT_WORK_DAYS),
        vacation_days: settings.default_vacation_days,
        state: '',
        status: 'active',
        notes: '',
        sensitive: null,
        created_at: now(),
        updated_at: now(),
        ...f,
      } as EmployeeRow;
      db.tx(() => {
        db.insert('hr_employees', row);
        if (sens && Object.keys(sens).length) saveSensitive(row, sens, true);
      });
      if (sens && Object.keys(sens).length) audit(ctx, 'hr.sensitive.update', row.id, `${fullName(row)}: ${Object.keys(sens).join(', ')}`);
      return employeeOut(getEmployee(app, ctx.locationId, row.id), settings);
    });
    router.get('/api/hr/employees/:id', 'location', (ctx) => {
      const e = getEmployee(app, ctx.locationId, ctx.params.id);
      return { ...employeeOut(e, getHrSettings(app, ctx.locationId)), user_name: e.user_id ? usersOf(ctx.locationId).find((u) => u.id === e.user_id)?.name ?? '' : '' };
    });
    router.patch('/api/hr/employees/:id', 'location', (ctx) => {
      const e = getEmployee(app, ctx.locationId, ctx.params.id);
      const b = ctx.body ?? {};
      if (b.sensitive !== undefined) throw bad('Sensible Felder bitte über PUT /api/hr/employees/:id/sensitive ändern');
      const f = cleanEmployee(ctx.locationId, b, e);
      db.update('hr_employees', e.id, { ...f, updated_at: now() }, ctx.locationId);
      return employeeOut(getEmployee(app, ctx.locationId, e.id), getHrSettings(app, ctx.locationId));
    });

    // --- the sensitive block -------------------------------------------------------------------------------------------------
    router.get('/api/hr/employees/:id/sensitive', 'location', (ctx) => {
      const e = getEmployee(app, ctx.locationId, ctx.params.id);
      if (!canSeeSensitive(app, ctx)) throw new HttpError(403, SENSITIVE_DENIED);
      // Every look at personal data of this kind is logged: who, which person – never the values.
      audit(ctx, 'hr.sensitive.read', e.id, `Sensible Daten von ${fullName(e)} angesehen`);
      return { employee_id: e.id, ...readSensitive(e) };
    });
    router.put('/api/hr/employees/:id/sensitive', 'location', (ctx) => {
      const e = getEmployee(app, ctx.locationId, ctx.params.id);
      if (!canSeeSensitive(app, ctx)) throw new HttpError(403, SENSITIVE_DENIED);
      const patch = cleanSensitive(ctx.body ?? {});
      const cleared = Object.entries(ctx.body ?? {}).filter(([k, v]) => (SENSITIVE_KEYS as readonly string[]).includes(k) && (v === '' || v === null)).map(([k]) => k);
      const next = saveSensitive(e, patch);
      for (const k of cleared) delete (next as any)[k];
      if (cleared.length) saveSensitive(e, next, true);
      audit(ctx, 'hr.sensitive.update', e.id, `${fullName(e)}: ${[...Object.keys(patch), ...cleared].join(', ')}`);
      return { ok: true, fields: Object.keys(next) };
    });

    // --- documents ------------------------------------------------------------------------------------------------------------------
    const docOut = (d: any) => ({ id: d.id, employee_id: d.employee_id, name: d.name, mime: d.mime, size: d.size, sha256: d.sha256, category: d.category, visibility: d.visibility, created_at: d.created_at });
    router.get('/api/hr/employees/:id/documents', 'location', (ctx) => {
      const e = getEmployee(app, ctx.locationId, ctx.params.id);
      const gate = canSeeSensitive(app, ctx);
      return db.all<any>('SELECT * FROM hr_documents WHERE employee_id = ? AND location_id = ? ORDER BY created_at DESC', e.id, ctx.locationId).filter((d) => gate || d.visibility !== 'sensitive').map(docOut);
    });
    router.post('/api/hr/employees/:id/documents', 'location', (ctx) => {
      const e = getEmployee(app, ctx.locationId, ctx.params.id);
      const b = ctx.body ?? {};
      const m = String(b.data ?? '').match(/^data:([\w/+.-]+);base64,(.+)$/s);
      if (!m) throw bad('Erwarte eine data:-URL (Base64)');
      const mime = m[1].toLowerCase();
      if (!DOC_MIMES.test(mime)) throw bad('Nur PDF, Bilder (PNG, JPG, WebP), Textdateien und Office-Dokumente');
      const buf = Buffer.from(m[2], 'base64');
      if (!buf.length) throw bad('Die Datei ist leer');
      if (buf.length > 8 * 1024 * 1024) throw bad('Datei größer als 8 MB');
      if (!contentMatches(mime, buf)) throw bad('Dateiinhalt passt nicht zum Dateityp');
      const visibility = ['hr', 'sensitive', 'employee'].includes(b.visibility) ? b.visibility : 'hr';
      if (visibility === 'sensitive' && !canSeeSensitive(app, ctx)) throw new HttpError(403, SENSITIVE_DENIED);
      const row = { id: id(20), location_id: ctx.locationId, employee_id: e.id, name: str(b.name, 'Dateiname', { required: true, max: 150 }).replace(/[\\/\r\n"<>:|?*]/g, '_'), mime, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), category: CATEGORIES.includes(b.category) ? b.category : 'sonstiges', visibility, uploaded_by: userId(ctx), created_at: now() };
      mkdirSync(docDir(app), { recursive: true });
      writeFileSync(hrDocPath(app, row), buf);
      db.insert('hr_documents', row);
      return docOut(row);
    });
    const fileOf = (d: any) => {
      const path = hrDocPath(app, d);
      if (!existsSync(path)) throw notFound('Datei fehlt auf dem Server');
      const inline = d.mime === 'application/pdf' || /^image\//.test(d.mime);
      return {
        __raw: true as const,
        status: 200,
        headers: {
          'content-type': d.mime,
          'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${d.name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(d.name)}`,
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
          'cache-control': 'private, no-store',
        },
        body: readFileSync(path),
      };
    };
    router.get('/api/hr/documents/:id', 'location', (ctx) => {
      const d = db.get<any>('SELECT * FROM hr_documents WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!d) throw notFound('Dokument nicht gefunden');
      if (d.visibility === 'sensitive' && !canSeeSensitive(app, ctx)) throw new HttpError(403, SENSITIVE_DENIED);
      audit(ctx, 'hr.document.read', d.employee_id, `${d.name} (${d.category}) geöffnet`);
      return fileOf(d);
    });
    router.delete('/api/hr/documents/:id', 'location', (ctx) => {
      const d = db.get<any>('SELECT * FROM hr_documents WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!d) throw notFound('Dokument nicht gefunden');
      if (d.visibility === 'sensitive' && !canSeeSensitive(app, ctx)) throw new HttpError(403, SENSITIVE_DENIED);
      db.run('DELETE FROM hr_documents WHERE id = ?', d.id);
      return { ok: true, name: d.name };
    });

    // --- self-service: only the own record -------------------------------------------------------------------------------------------
    app.services.hr = { isHr, canSeeSensitive: (ctx: Ctx) => canSeeSensitive(app, ctx), selfEmployee: (ctx: Ctx) => selfEmployee(app, ctx), usersOf };
    router.get('/api/me/hr/documents', 'location', (ctx) => {
      const e = selfEmployee(app, ctx);
      if (!e) return [];
      return db.all<any>(`SELECT * FROM hr_documents WHERE employee_id = ? AND location_id = ? AND visibility = 'employee' ORDER BY created_at DESC`, e.id, ctx.locationId).map(docOut);
    });
    router.get('/api/me/hr/documents/:id', 'location', (ctx) => {
      const e = selfEmployee(app, ctx);
      const d = e && db.get<any>(`SELECT * FROM hr_documents WHERE id = ? AND employee_id = ? AND location_id = ? AND visibility = 'employee'`, ctx.params.id, e.id, ctx.locationId);
      if (!d) throw notFound('Dokument nicht gefunden');
      audit(ctx, 'hr.document.read', d.employee_id, `${d.name} geöffnet (eigene Unterlagen)`);
      return fileOf(d);
    });
    router.get('/api/me/hr/holidays', 'location', (ctx) => {
      const e = selfEmployee(app, ctx);
      const state = e?.state || getHrSettings(app, ctx.locationId).default_state;
      return { state, holidays: app.services.hrHolidays?.(Number(ctx.query.get('year')) || thisYear(ctx.locationId), state) ?? [] };
    });
    // --- vacation balance ------------------------------------------------------------------------------------------------------------
    const profileOf = (e: EmployeeRow, s: HrSettings) => ({ work_days: workDaysOf(e), state: e.state || s.default_state });

    /** Balance of the given employees in one year (one query for absences and leave years, however many people). */
    function balancesFor(loc: string, employees: EmployeeRow[], year: number, opts: { asOf?: string; excludeId?: string } = {}): Map<string, Balance> {
      const out = new Map<string, Balance>();
      if (!employees.length) return out;
      const settings = getHrSettings(app, loc);
      const abs = db.all<AbsenceRow>(`SELECT * FROM hr_absences WHERE location_id = ? AND status IN ('requested', 'approved') AND end_date >= ? AND start_date <= ?`, loc, `${year}-01-01`, `${year}-12-31`).filter((a) => a.id !== opts.excludeId);
      const byEmp = new Map<string, AbsenceRow[]>();
      for (const a of abs) byEmp.set(a.employee_id, [...(byEmp.get(a.employee_id) ?? []), a]);
      const years = new Map(db.all<{ employee_id: string; carryover_days: number; adjustment_days: number }>('SELECT employee_id, carryover_days, adjustment_days FROM hr_leave_years WHERE location_id = ? AND year = ?', loc, year).map((r) => [r.employee_id, r]));
      for (const e of employees) {
        const ly = years.get(e.id);
        out.set(
          e.id,
          leaveBalance({
            annualDays: e.vacation_days,
            startDate: e.start_date,
            endDate: e.end_date,
            carryover: ly?.carryover_days ?? 0,
            adjustment: ly?.adjustment_days ?? 0,
            carryoverExpiry: settings.carryover_expiry || null,
            profile: profileOf(e, settings),
            absences: (byEmp.get(e.id) ?? []).map((a) => ({ type: a.type, status: a.status, start_date: a.start_date, end_date: a.end_date, half_start: a.half_start, half_end: a.half_end })),
            year,
            asOf: opts.asOf ?? today(app, loc),
          }),
        );
      }
      return out;
    }
    const balanceOf = (e: EmployeeRow, year: number, opts: { asOf?: string; excludeId?: string } = {}) => balancesFor(e.location_id, [e], year, opts).get(e.id)!;
    app.services.hrBalance = (loc: string, employeeId: string, year: number) => balanceOf(getEmployee(app, loc, employeeId), year);

    /** What the previous year leaves over (capped by the setting); null when the person started this year or later. */
    const suggestedCarryover = (e: EmployeeRow, year: number): number | null => {
      if (e.start_date && Number(e.start_date.slice(0, 4)) >= year) return null;
      const prev = balanceOf(e, year - 1, { asOf: `${year - 1}-12-31` });
      const max = getHrSettings(app, e.location_id).carryover_max_days;
      const left = Math.max(0, prev.remaining);
      return q3(max === null ? left : Math.min(left, max));
    };

    app.services.hrHolidays = (year: number, state: string) => holidays(year, state);

    // --- absences ---------------------------------------------------------------------------------------------------------------------------
    const absenceOut = (a: AbsenceRow, e?: EmployeeRow) => ({ ...a, half_start: !!a.half_start, half_end: !!a.half_end, certificate: !!a.certificate, ...(e ? { employee_name: fullName(e) } : {}) });
    const getAbsence = (loc: string, absenceId: string): AbsenceRow => {
      const a = db.get<AbsenceRow>('SELECT * FROM hr_absences WHERE id = ? AND location_id = ?', absenceId, loc);
      if (!a) throw notFound('Antrag nicht gefunden');
      return a;
    };
    const fmtDay = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.`;
    const range = (a: { start_date: string; end_date: string }) => (a.start_date === a.end_date ? fmtDay(a.start_date) : `${fmtDay(a.start_date)}–${fmtDay(a.end_date)}`);

    /** May this caller approve or reject requests of `e`? HR and the employee's manager – never their own (agency admins excepted, they have nobody above them). */
    const canDecide = (ctx: Ctx, e: EmployeeRow): boolean => {
      const u = ctx.user;
      if (!u) return ctx.viaApiKey && isHr(ctx);
      const own = e.user_id === u.id;
      if (own && u.role !== 'admin') return false;
      return isHr(ctx) || e.manager_user_id === u.id;
    };

    interface Plan {
      type: string;
      label: string;
      start_date: string;
      end_date: string;
      half_start: number;
      half_end: number;
      days: number;
      reason: string;
      certificate: number;
    }

    /** Checks an absence against the employment, the calendar, other absences and (vacation) the balance, and counts its days. */
    function planAbsence(e: EmployeeRow, b: any, o: { hr: boolean; force?: boolean; excludeId?: string }): Plan {
      const settings = getHrSettings(app, e.location_id);
      const type = String(b.type ?? '');
      if (!(type in ABSENCE_TYPES)) throw bad(`Art der Abwesenheit: ${Object.keys(ABSENCE_TYPES).join(', ')}`);
      const start = b.start_date;
      const end = b.end_date || b.start_date;
      if (!isYmd(start) || !isYmd(end)) throw bad('Zeitraum bitte als JJJJ-MM-TT angeben');
      if (end < start) throw bad('Das Ende liegt vor dem Beginn');
      if (addDays(start, 366) < end) throw bad('Ein Antrag kann höchstens ein Jahr umfassen');
      if (e.status !== 'active') throw bad('Der Mitarbeiter ist nicht aktiv');
      if (e.start_date && start < e.start_date) throw bad(`Der Zeitraum beginnt vor dem Eintritt (${e.start_date})`);
      if (e.end_date && end > e.end_date) throw bad(`Der Zeitraum endet nach dem Austritt (${e.end_date})`);
      if (!o.hr && type === 'vacation' && start < today(app, e.location_id)) throw bad('Urlaub in der Vergangenheit kann nur das Personalbüro eintragen');
      const half_start = b.half_start ? 1 : 0;
      const half_end = b.half_end ? 1 : 0;
      const profile = profileOf(e, settings);
      const list = absenceDays({ start_date: start, end_date: end, half_start, half_end }, profile);
      const days = sumDays(list);
      if (!days) throw bad('Im Zeitraum liegt kein Arbeitstag (Wochenende, Feiertag oder arbeitsfreier Tag)');

      // Every day can be used once: a morning of vacation and an afternoon of other leave fit, two full days do not.
      const used = new Map<string, number>();
      for (const other of db.all<AbsenceRow>(`SELECT * FROM hr_absences WHERE employee_id = ? AND status IN ('requested', 'approved') AND id != ? AND end_date >= ? AND start_date <= ?`, e.id, o.excludeId ?? '', start, end))
        for (const d of absenceDays(other, profile)) used.set(d.date, (used.get(d.date) ?? 0) + d.value);
      for (const d of list) if ((used.get(d.date) ?? 0) + d.value > 1) throw bad(`Am ${d.date.split('-').reverse().join('.')} gibt es schon eine Abwesenheit`);

      if (type === 'vacation' && !(o.hr && o.force)) {
        const perYear = new Map<number, number>();
        for (const d of list) perYear.set(Number(d.date.slice(0, 4)), (perYear.get(Number(d.date.slice(0, 4))) ?? 0) + d.value);
        for (const [year, n] of perYear) {
          const bal = balanceOf(e, year, { excludeId: o.excludeId });
          if (n > bal.available + 1e-9) throw bad(`Nicht genug Urlaub ${year}: ${q3(bal.available)} Tage frei, ${q3(n)} beantragt`);
        }
      }
      const certificate = type === 'sick' && b.certificate ? 1 : 0;
      return {
        type,
        label: type === 'other' ? str(b.label, 'Bezeichnung', { max: 80 }) : '',
        start_date: start,
        end_date: end,
        half_start,
        half_end,
        days,
        // A sick note records that someone is away, never why (health data, Art. 9 GDPR): no reason is stored.
        reason: type === 'sick' ? '' : str(b.reason, 'Anmerkung', { max: 500 }),
        certificate,
      };
    }

    const absenceEvent = (name: 'absence.requested' | 'absence.approved' | 'absence.rejected', e: EmployeeRow, a: AbsenceRow) =>
      app.events.emit(e.location_id, name, { contactId: contactOfEmployee(app, e), absenceId: a.id, employeeId: e.id, name: fullName(e), type: a.type, label: a.label, start_date: a.start_date, end_date: a.end_date, days: a.days, status: a.status });

    const push = (userIds: string[], title: string, body: string, tag: string) => {
      if (!userIds.length) return;
      try {
        void Promise.resolve(app.services.pushNotify?.({ userIds, kind: 'absence', title, body, url: '/app/personal', tag })).catch(() => undefined);
      } catch (err) {
        console.error('[hr] notify', (err as Error).message);
      }
    };
    const notifyApprovers = (e: EmployeeRow, a: AbsenceRow, actorId: string | null) => {
      const ids = new Set(usersWithArea(app, e.location_id, 'personal', { explicit: true }));
      if (e.manager_user_id) ids.add(e.manager_user_id);
      for (const skip of [actorId, e.user_id]) if (skip) ids.delete(skip);
      push([...ids], `${ABSENCE_TYPES[a.type]} beantragt: ${fullName(e)}`, `${range(a)} (${a.days} ${a.days === 1 ? 'Tag' : 'Tage'})`, `absence-${a.id}`);
    };

    /** Files an absence for `e`; sick notes are approved at once when the setting says so, HR may enter one already approved. */
    function createAbsence(ctx: Ctx, e: EmployeeRow, b: any, o: { hr: boolean }) {
      const plan = planAbsence(e, b, { hr: o.hr, force: o.hr && b.force === true });
      const settings = getHrSettings(app, e.location_id);
      const actor = userId(ctx);
      const approvedNow = (plan.type === 'sick' && settings.sick_auto_approve) || (o.hr && b.approved === true && canDecide(ctx, e));
      const row: AbsenceRow = { id: id(), location_id: e.location_id, employee_id: e.id, ...plan, status: approvedNow ? 'approved' : 'requested', requested_by: actor, decided_by: approvedNow && !(plan.type === 'sick' && settings.sick_auto_approve) ? actor : null, decided_at: approvedNow ? now() : null, decision_note: approvedNow && plan.type === 'sick' && settings.sick_auto_approve ? 'automatisch bestätigt' : '', created_at: now(), updated_at: now() };
      db.insert('hr_absences', row);
      absenceEvent('absence.requested', e, row);
      if (row.status === 'approved') absenceEvent('absence.approved', e, row);
      // A request by the employee is announced to the approvers; HR entering something for someone else is not news to HR.
      if (row.status === 'requested') notifyApprovers(e, row, actor);
      else if (e.user_id && e.user_id !== actor) push([e.user_id], `${ABSENCE_TYPES[row.type]} eingetragen`, range(row), `absence-${row.id}`);
      return row;
    }

    function decide(ctx: Ctx, a: AbsenceRow, decision: 'approved' | 'rejected', note: unknown, force = false) {
      const e = getEmployee(app, ctx.locationId, a.employee_id);
      if (a.status !== 'requested') throw bad('Dieser Antrag ist schon entschieden');
      if (!canDecide(ctx, e)) throw new HttpError(403, e.user_id && e.user_id === ctx.user?.id ? 'Eigene Anträge kann man nicht selbst genehmigen' : 'Nur das Personalbüro und die Vorgesetzten dürfen Anträge entscheiden');
      if (decision === 'approved') planAbsence(e, a, { hr: true, force, excludeId: a.id });
      const patch = { status: decision, decided_by: userId(ctx), decided_at: now(), decision_note: str(note, 'Notiz', { max: 500 }), updated_at: now() };
      db.update('hr_absences', a.id, patch, ctx.locationId);
      const fresh = getAbsence(ctx.locationId, a.id);
      absenceEvent(decision === 'approved' ? 'absence.approved' : 'absence.rejected', e, fresh);
      if (e.user_id && e.user_id !== ctx.user?.id) push([e.user_id], `${ABSENCE_TYPES[a.type]} ${decision === 'approved' ? 'genehmigt' : 'abgelehnt'}`, `${range(a)}${patch.decision_note ? ` – ${patch.decision_note}` : ''}`, `absence-${a.id}`);
      return fresh;
    }

    function cancel(ctx: Ctx, a: AbsenceRow, hr: boolean) {
      const e = getEmployee(app, ctx.locationId, a.employee_id);
      if (!['requested', 'approved'].includes(a.status)) throw bad('Dieser Antrag ist nicht mehr aktiv');
      const own = !!ctx.user && e.user_id === ctx.user.id;
      if (!hr && !own) throw new HttpError(403, 'Nur eigene Anträge können zurückgezogen werden');
      if (!hr && a.status === 'approved' && a.start_date <= today(app, ctx.locationId)) throw bad('Bereits begonnene oder vergangene Abwesenheiten kann nur das Personalbüro ändern');
      db.update('hr_absences', a.id, { status: 'cancelled', updated_at: now(), decided_by: a.decided_by, decision_note: a.decision_note }, ctx.locationId);
      return getAbsence(ctx.locationId, a.id);
    }

    router.get('/api/hr/absences', 'location', (ctx) => {
      const where = ['a.location_id = ?'];
      const params: any[] = [ctx.locationId];
      const status = ctx.query.get('status');
      if (status && ['requested', 'approved', 'rejected', 'cancelled'].includes(status)) (where.push('a.status = ?'), params.push(status));
      const type = ctx.query.get('type');
      if (type && type in ABSENCE_TYPES) (where.push('a.type = ?'), params.push(type));
      const emp = ctx.query.get('employee_id');
      if (emp) (where.push('a.employee_id = ?'), params.push(emp));
      const from = ctx.query.get('from');
      const to = ctx.query.get('to');
      if (from && isYmd(from)) (where.push('a.end_date >= ?'), params.push(from));
      if (to && isYmd(to)) (where.push('a.start_date <= ?'), params.push(to));
      const emps = new Map(db.all<EmployeeRow>('SELECT * FROM hr_employees WHERE location_id = ?', ctx.locationId).map((e) => [e.id, e]));
      return db
        .all<AbsenceRow>(`SELECT a.* FROM hr_absences a WHERE ${where.join(' AND ')} ORDER BY a.start_date DESC, a.created_at DESC LIMIT 1000`, ...params)
        .map((a) => ({ ...absenceOut(a, emps.get(a.employee_id)), can_decide: a.status === 'requested' && !!emps.get(a.employee_id) && canDecide(ctx, emps.get(a.employee_id)!) }));
    });
    router.post('/api/hr/absences', 'location', (ctx) => {
      const e = getEmployee(app, ctx.locationId, String(ctx.body?.employee_id ?? ''));
      const row = createAbsence(ctx, e, ctx.body ?? {}, { hr: true });
      return absenceOut(row, e);
    });
    router.patch('/api/hr/absences/:id', 'location', (ctx) => {
      const a = getAbsence(ctx.locationId, ctx.params.id);
      if (!['requested', 'approved'].includes(a.status)) throw bad('Nur offene oder genehmigte Anträge lassen sich ändern');
      const e = getEmployee(app, ctx.locationId, a.employee_id);
      if (a.status === 'approved' && !canDecide(ctx, e)) throw new HttpError(403, 'Eigene genehmigte Abwesenheiten kann man nicht selbst ändern');
      const b = ctx.body ?? {};
      const plan = planAbsence(e, { ...a, ...b }, { hr: true, force: b.force === true, excludeId: a.id });
      db.update('hr_absences', a.id, { ...plan, updated_at: now() }, ctx.locationId);
      return absenceOut(getAbsence(ctx.locationId, a.id), e);
    });
    router.post('/api/hr/absences/:id/approve', 'location', (ctx) => absenceOut(decide(ctx, getAbsence(ctx.locationId, ctx.params.id), 'approved', ctx.body?.note, ctx.body?.force === true)));
    router.post('/api/hr/absences/:id/reject', 'location', (ctx) => absenceOut(decide(ctx, getAbsence(ctx.locationId, ctx.params.id), 'rejected', ctx.body?.note)));
    router.post('/api/hr/absences/:id/cancel', 'location', (ctx) => absenceOut(cancel(ctx, getAbsence(ctx.locationId, ctx.params.id), true)));

    // --- balances ---------------------------------------------------------------------------------------------------------------------------------------
    const yearOf = (ctx: Ctx) => {
      const y = Number(ctx.query.get('year')) || thisYear(ctx.locationId);
      if (!Number.isInteger(y) || y < 2000 || y > 2100) throw bad('Jahr ungültig');
      return y;
    };
    router.get('/api/hr/employees/:id/balance', 'location', (ctx) => {
      const e = getEmployee(app, ctx.locationId, ctx.params.id);
      const year = yearOf(ctx);
      const ly = db.get<{ carryover_days: number; adjustment_days: number; note: string }>('SELECT carryover_days, adjustment_days, note FROM hr_leave_years WHERE employee_id = ? AND year = ?', e.id, year);
      return { employee_id: e.id, year, balance: balanceOf(e, year), leave_year: ly ?? { carryover_days: 0, adjustment_days: 0, note: '' }, suggested_carryover: suggestedCarryover(e, year), entitlement_full_year: entitlement(e.vacation_days, year) };
    });
    router.put('/api/hr/employees/:id/leave-years/:year', 'location', (ctx) => {
      const e = getEmployee(app, ctx.locationId, ctx.params.id);
      const year = Number(ctx.params.year);
      if (!Number.isInteger(year) || year < 2000 || year > 2100) throw bad('Jahr ungültig');
      const b = ctx.body ?? {};
      const cur = db.get<{ carryover_days: number; adjustment_days: number; note: string }>('SELECT * FROM hr_leave_years WHERE employee_id = ? AND year = ?', e.id, year) ?? { carryover_days: 0, adjustment_days: 0, note: '' };
      const carry = b.carryover_days === undefined ? cur.carryover_days : num(b.carryover_days, NaN);
      const adj = b.adjustment_days === undefined ? cur.adjustment_days : num(b.adjustment_days, NaN);
      if (!Number.isFinite(carry) || carry < 0 || carry > 120) throw bad('Resturlaub: 0 bis 120 Tage');
      if (!Number.isFinite(adj) || adj < -120 || adj > 120) throw bad('Korrektur: -120 bis 120 Tage');
      db.run(
        `INSERT INTO hr_leave_years (employee_id, location_id, year, carryover_days, adjustment_days, note) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(employee_id, year) DO UPDATE SET carryover_days = excluded.carryover_days, adjustment_days = excluded.adjustment_days, note = excluded.note`,
        e.id,
        ctx.locationId,
        year,
        q3(carry),
        q3(adj),
        b.note === undefined ? cur.note : str(b.note, 'Notiz', { max: 300 }),
      );
      return { year, balance: balanceOf(e, year) };
    });

    // --- calendar, holidays, overview --------------------------------------------------------------------------------------------------------------------
    router.get('/api/hr/holidays', 'location', (ctx) => {
      const state = ctx.query.get('state') || getHrSettings(app, ctx.locationId).default_state;
      if (!isState(state)) throw bad('Bundesland ungültig');
      return { state, year: yearOf(ctx), holidays: holidays(yearOf(ctx), state) };
    });

    const rangeOf = (ctx: Ctx) => {
      const from = ctx.query.get('from') || today(app, ctx.locationId).slice(0, 8) + '01';
      const to = ctx.query.get('to') || addDays(from, 41);
      if (!isYmd(from) || !isYmd(to) || to < from) throw bad('Zeitraum ungültig (from/to als JJJJ-MM-TT)');
      if (addDays(from, 366) < to) throw bad('Höchstens ein Jahr auf einmal');
      return { from, to };
    };

    /** Team calendar. HR sees every type and status; everybody else sees approved absences as "Urlaub" or just "abwesend" – never sick leave as such. */
    const calendarFor = (loc: string, from: string, to: string, hr: boolean, selfId?: string) => {
      const settings = getHrSettings(app, loc);
      const emps = new Map(db.all<EmployeeRow>(`SELECT * FROM hr_employees WHERE location_id = ? AND status = 'active'`, loc).map((e) => [e.id, e]));
      const items = db
        .all<AbsenceRow>(`SELECT * FROM hr_absences WHERE location_id = ? AND status IN ('requested', 'approved') AND end_date >= ? AND start_date <= ? ORDER BY start_date`, loc, from, to)
        .filter((a) => emps.has(a.employee_id) && (hr || a.status === 'approved' || a.employee_id === selfId))
        .map((a) => {
          const e = emps.get(a.employee_id)!;
          const seeType = hr || a.employee_id === selfId;
          return { id: a.id, employee_id: a.employee_id, name: fullName(e), type: seeType ? a.type : a.type === 'vacation' ? 'vacation' : 'away', label: seeType ? a.label : '', status: a.status, start_date: a.start_date, end_date: a.end_date, half_start: !!a.half_start, half_end: !!a.half_end, days: seeType ? a.days : undefined };
        });
      const states = [...new Set([settings.default_state, ...[...emps.values()].map((e) => e.state).filter(Boolean)])];
      return { from, to, state: settings.default_state, holidays: [...holidayMap(from, to, settings.default_state)].map(([date, name]) => ({ date, name })), other_states: states.filter((s) => s !== settings.default_state), items };
    };
    router.get('/api/hr/calendar', 'location', (ctx) => {
      const { from, to } = rangeOf(ctx);
      return calendarFor(ctx.locationId, from, to, true);
    });

    router.get('/api/hr/status', 'location', (ctx) => {
      const loc = ctx.locationId;
      const one = (sql: string, ...p: any[]) => db.get<{ n: number }>(sql, ...p)?.n ?? 0;
      const day = today(app, loc);
      const away = db.all<{ type: string; n: number }>(`SELECT type, COUNT(DISTINCT employee_id) AS n FROM hr_absences WHERE location_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ? GROUP BY type`, loc, day, day);
      return {
        employees: one(`SELECT COUNT(*) AS n FROM hr_employees WHERE location_id = ? AND status = 'active'`, loc),
        pending_requests: one(`SELECT COUNT(*) AS n FROM hr_absences WHERE location_id = ? AND status = 'requested'`, loc),
        away_today: Object.fromEntries(away.map((r) => [r.type, r.n])),
        open_checklists: one(`SELECT COUNT(*) AS n FROM hr_checklists WHERE location_id = ? AND status = 'open'`, loc),
        settings: getHrSettings(app, loc),
        sensitive_access: canSeeSensitive(app, ctx),
      };
    });

    // --- working-time overview (hook for the time tracking of feat/pm) -------------------------------------------------------------------------------------
    /** Approved absences of one employee in a period as one entry per day (holidays included as their own type). */
    const daysOff = (e: EmployeeRow, from: string, to: string) => {
      const settings = getHrSettings(app, e.location_id);
      const profile = profileOf(e, settings);
      const out: { date: string; type: string; value: number; name?: string }[] = [];
      for (const a of db.all<AbsenceRow>(`SELECT * FROM hr_absences WHERE employee_id = ? AND status = 'approved' AND end_date >= ? AND start_date <= ?`, e.id, from, to))
        for (const d of absenceDays(a, profile)) if (d.date >= from && d.date <= to) out.push({ date: d.date, type: a.type, value: d.value });
      // A public holiday only matters on a day the person would work.
      const works = new Set(profile.work_days);
      for (const [date, name] of holidayMap(from, to, profile.state)) if (works.has(isoWeekday(date))) out.push({ date, type: 'holiday', value: 1, name });
      return out.sort((x, y) => x.date.localeCompare(y.date));
    };
    /** Contract hours for a period: weekly hours spread over the work days, without public holidays, approved absences and days outside the employment. */
    const targetHours = (e: EmployeeRow, from: string, to: string): number => {
      const settings = getHrSettings(app, e.location_id);
      const profile = profileOf(e, settings);
      const lo = e.start_date && e.start_date > from ? e.start_date : from;
      const hi = e.end_date && e.end_date < to ? e.end_date : to;
      if (hi < lo) return 0;
      const hol = holidayMap(lo, hi, profile.state);
      const wd = new Set(profile.work_days);
      let n = 0;
      for (let d = lo, i = 0; d <= hi && i < 400; d = addDays(d, 1), i++) if (wd.has(isoWeekday(d)) && !hol.has(d)) n++;
      const off = sumDays(daysOff(e, lo, hi).filter((x) => x.type !== 'holiday'));
      return q3(Math.max(0, n - off) * (e.weekly_hours / Math.max(1, profile.work_days.length)));
    };

    /**
     * Contract for other modules (time tracking): `app.services.absences` answers "who is away" and "what are the target hours"
     * by login; `app.services.workingTimeProvider.hoursByUser(locationId, from, to)` is the one thing HR asks of a time-tracking module.
     */
    app.services.absences = {
      forUser: (loc: string, uid: string, from: string, to: string) => {
        const e = db.get<EmployeeRow>('SELECT * FROM hr_employees WHERE location_id = ? AND user_id = ?', loc, uid);
        return e && isYmd(from) && isYmd(to) ? daysOff(e, from, to) : [];
      },
      targetHours: (loc: string, uid: string, from: string, to: string) => {
        const e = db.get<EmployeeRow>('SELECT * FROM hr_employees WHERE location_id = ? AND user_id = ?', loc, uid);
        return e && isYmd(from) && isYmd(to) ? targetHours(e, from, to) : null;
      },
    };
    router.get('/api/hr/working-time', 'location', async (ctx) => {
      const { from, to } = rangeOf(ctx);
      const emps = db.all<EmployeeRow>(`SELECT * FROM hr_employees WHERE location_id = ? AND status = 'active' ORDER BY last_name, first_name`, ctx.locationId);
      let tracked: Record<string, number> | null = null;
      try {
        tracked = (await app.services.workingTimeProvider?.hoursByUser?.(ctx.locationId, from, to)) ?? null;
      } catch (err) {
        console.error('[hr] workingTimeProvider', (err as Error).message);
      }
      return {
        from,
        to,
        tracking_connected: !!app.services.workingTimeProvider?.hoursByUser,
        employees: emps.map((e) => {
          const off = daysOff(e, from, to);
          const target = targetHours(e, from, to);
          const hours = tracked && e.user_id && e.user_id in tracked ? q3(tracked[e.user_id]) : null;
          return {
            employee_id: e.id,
            name: fullName(e),
            user_id: e.user_id,
            weekly_hours: e.weekly_hours,
            target_hours: target,
            tracked_hours: hours,
            balance_hours: hours === null ? null : q3(hours - target),
            vacation_days: sumDays(off.filter((x) => x.type === 'vacation')),
            sick_days: sumDays(off.filter((x) => x.type === 'sick')),
            other_days: sumDays(off.filter((x) => x.type === 'other')),
            holidays: off.filter((x) => x.type === 'holiday').length,
          };
        }),
      };
    });

    // --- onboarding / offboarding checklists ---------------------------------------------------------------------------------------------------------------
    const ASSIGNEES: Record<string, string> = { hr: 'Personalbüro', employee: 'Mitarbeiter/in', manager: 'Vorgesetzte/r', it: 'IT / Technik' };
    const SEED: { kind: string; name: string; items: TemplateItem[] }[] = [
      {
        kind: 'onboarding',
        name: 'Onboarding Standard',
        items: [
          { title: 'Arbeitsvertrag unterschrieben und abgelegt', assignee: 'hr', due_days: -7 },
          { title: 'Personalfragebogen, Steuer-ID und Sozialversicherungsnummer erhalten', assignee: 'employee', due_days: -7 },
          { title: 'Anmeldung zur Sozialversicherung', assignee: 'hr', due_days: 0 },
          { title: 'Zugänge einrichten (E-Mail, HyperLevel-Login, Tools)', assignee: 'it', due_days: -1 },
          { title: 'Arbeitsgeräte und Schlüssel übergeben', assignee: 'it', due_days: 0 },
          { title: 'Datenschutz- und Verschwiegenheitsverpflichtung unterschrieben', assignee: 'employee', due_days: 0 },
          { title: 'Einarbeitungsplan und Ansprechperson festgelegt', assignee: 'manager', due_days: 0 },
          { title: 'Feedbackgespräch zum Ende der Probezeit', assignee: 'manager', due_days: 150 },
        ],
      },
      {
        kind: 'offboarding',
        name: 'Offboarding Standard',
        items: [
          { title: 'Kündigung oder Aufhebungsvertrag schriftlich bestätigt', assignee: 'hr', due_days: -30 },
          { title: 'Resturlaub und Überstunden geklärt', assignee: 'hr', due_days: -14 },
          { title: 'Aufgaben und Zugangsdaten übergeben', assignee: 'employee', due_days: -7 },
          { title: 'Arbeitsgeräte, Schlüssel und Unterlagen zurückgegeben', assignee: 'employee', due_days: 0 },
          { title: 'Zugänge gesperrt, E-Mail-Weiterleitung eingerichtet', assignee: 'it', due_days: 0 },
          { title: 'Abmeldung bei der Sozialversicherung', assignee: 'hr', due_days: 0 },
          { title: 'Arbeitszeugnis erstellt und übergeben', assignee: 'hr', due_days: 14 },
        ],
      },
    ];
    const seedTemplates = (loc: string) => {
      const s = getHrSettings(app, loc);
      if (s.templates_seeded) return;
      db.tx(() => {
        for (const t of SEED) db.insert('hr_checklist_templates', { id: id(), location_id: loc, kind: t.kind, name: t.name, items: JSON.stringify(t.items), created_at: now(), updated_at: now() });
        db.run(`INSERT INTO hr_settings (location_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`, loc, JSON.stringify({ ...s, templates_seeded: true }), now());
      });
    };
    const cleanItems = (v: unknown): TemplateItem[] => {
      if (!Array.isArray(v) || !v.length) throw bad('Mindestens ein Punkt nötig');
      if (v.length > 60) throw bad('Höchstens 60 Punkte');
      return v.map((x: any) => {
        const assignee = x?.assignee in ASSIGNEES ? x.assignee : 'hr';
        const due = x?.due_days === undefined || x.due_days === '' ? 0 : Math.round(num(x.due_days, NaN));
        if (!Number.isFinite(due) || Math.abs(due) > 730) throw bad('Fälligkeit: -730 bis 730 Tage');
        return { title: str(x?.title, 'Punkt', { required: true, max: 200 }), assignee, due_days: due };
      });
    };
    const templateOut = (t: any) => ({ id: t.id, kind: t.kind, name: t.name, items: JSON.parse(t.items), updated_at: t.updated_at });
    const KINDS = ['onboarding', 'offboarding'];

    router.get('/api/hr/checklist-templates', 'location', (ctx) => {
      seedTemplates(ctx.locationId);
      return { assignees: ASSIGNEES, templates: db.all<any>('SELECT * FROM hr_checklist_templates WHERE location_id = ? ORDER BY kind, name', ctx.locationId).map(templateOut) };
    });
    router.post('/api/hr/checklist-templates', 'location', (ctx) => {
      const b = ctx.body ?? {};
      if (!KINDS.includes(b.kind)) throw bad('Art: onboarding oder offboarding');
      const row = { id: id(), location_id: ctx.locationId, kind: b.kind, name: str(b.name, 'Name', { required: true, max: 120 }), items: JSON.stringify(cleanItems(b.items)), created_at: now(), updated_at: now() };
      db.insert('hr_checklist_templates', row);
      return templateOut(row);
    });
    router.patch('/api/hr/checklist-templates/:id', 'location', (ctx) => {
      const t = db.get<any>('SELECT * FROM hr_checklist_templates WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!t) throw notFound('Vorlage nicht gefunden');
      const b = ctx.body ?? {};
      db.update('hr_checklist_templates', t.id, { name: b.name === undefined ? undefined : str(b.name, 'Name', { required: true, max: 120 }), items: b.items === undefined ? undefined : JSON.stringify(cleanItems(b.items)), updated_at: now() }, ctx.locationId);
      return templateOut(db.get('SELECT * FROM hr_checklist_templates WHERE id = ?', t.id));
    });
    router.delete('/api/hr/checklist-templates/:id', 'location', (ctx) => {
      const n = db.run('DELETE FROM hr_checklist_templates WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId).changes;
      if (!n) throw notFound('Vorlage nicht gefunden');
      return { ok: true };
    });

    interface ChecklistItem {
      id: string;
      title: string;
      assignee: string;
      due: string | null;
      done: boolean;
      done_at: string | null;
      done_by: string;
    }
    const checklistOut = (c: any, e?: EmployeeRow) => ({ id: c.id, employee_id: c.employee_id, ...(e ? { employee_name: fullName(e) } : {}), template_id: c.template_id, kind: c.kind, name: c.name, status: c.status, items: JSON.parse(c.items) as ChecklistItem[], created_at: c.created_at, completed_at: c.completed_at });
    router.get('/api/hr/checklists', 'location', (ctx) => {
      const where = ['location_id = ?'];
      const params: any[] = [ctx.locationId];
      for (const [q, col] of [['employee_id', 'employee_id'], ['status', 'status'], ['kind', 'kind']] as const) {
        const v = ctx.query.get(q);
        if (v) (where.push(`${col} = ?`), params.push(v));
      }
      const emps = new Map(db.all<EmployeeRow>('SELECT * FROM hr_employees WHERE location_id = ?', ctx.locationId).map((e) => [e.id, e]));
      return db.all<any>(`SELECT * FROM hr_checklists WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 500`, ...params).map((c) => checklistOut(c, emps.get(c.employee_id)));
    });
    router.post('/api/hr/checklists', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const e = getEmployee(app, ctx.locationId, String(b.employee_id ?? ''));
      seedTemplates(ctx.locationId);
      const t = db.get<any>('SELECT * FROM hr_checklist_templates WHERE id = ? AND location_id = ?', String(b.template_id ?? ''), ctx.locationId);
      if (!t) throw bad('Bitte eine Vorlage wählen');
      const base = (t.kind === 'offboarding' ? e.end_date : e.start_date) ?? today(app, ctx.locationId);
      const items: ChecklistItem[] = (JSON.parse(t.items) as TemplateItem[]).map((it) => ({ id: id(8), title: it.title, assignee: it.assignee, due: addDays(base, it.due_days), done: false, done_at: null, done_by: '' }));
      const row = { id: id(), location_id: ctx.locationId, employee_id: e.id, template_id: t.id, kind: t.kind, name: `${t.name}: ${fullName(e)}`.slice(0, 160), items: JSON.stringify(items), status: 'open', created_at: now(), completed_at: null };
      db.insert('hr_checklists', row);
      return checklistOut(row, e);
    });
    const tick = (ctx: Ctx, c: any, itemId: string, done: boolean, who: string) => {
      const items = JSON.parse(c.items) as ChecklistItem[];
      const it = items.find((x) => x.id === itemId);
      if (!it) throw notFound('Punkt nicht gefunden');
      it.done = done;
      it.done_at = done ? now() : null;
      it.done_by = done ? who : '';
      const complete = items.every((x) => x.done);
      db.update('hr_checklists', c.id, { items: JSON.stringify(items), status: complete ? 'done' : 'open', completed_at: complete ? c.completed_at ?? now() : null }, ctx.locationId);
      return checklistOut(db.get('SELECT * FROM hr_checklists WHERE id = ?', c.id));
    };
    router.post('/api/hr/checklists/:id/items/:itemId', 'location', (ctx) => {
      const c = db.get<any>('SELECT * FROM hr_checklists WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!c) throw notFound('Checkliste nicht gefunden');
      return tick(ctx, c, ctx.params.itemId, ctx.body?.done !== false, ctx.user?.name ?? 'API');
    });
    router.delete('/api/hr/checklists/:id', 'location', (ctx) => {
      if (!db.run('DELETE FROM hr_checklists WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId).changes) throw notFound('Checkliste nicht gefunden');
      return { ok: true };
    });

    router.delete('/api/hr/employees/:id', 'location', (ctx) => {
      const e = getEmployee(app, ctx.locationId, ctx.params.id);
      if (!canSeeSensitive(app, ctx)) throw new HttpError(403, 'Mitarbeiterdaten löschen dürfen nur Administratoren und die für sensible Daten freigegebenen Personen');
      if (e.status !== 'inactive') throw bad('Bitte den Mitarbeiter zuerst auf „ausgeschieden“ setzen – Aufbewahrungsfristen (Lohnunterlagen: 6 bis 10 Jahre) beachten');
      const docs = db.all<any>('SELECT * FROM hr_documents WHERE employee_id = ?', e.id);
      db.run('DELETE FROM hr_employees WHERE id = ?', e.id);
      for (const d of docs) {
        try {
          rmSync(hrDocPath(app, d), { force: true });
        } catch {
          /* already gone */
        }
      }
      audit(ctx, 'hr.employee.delete', e.id, `${fullName(e)} gelöscht (${docs.length} Dokument(e))`);
      return { ok: true };
    });

    // --- self-service: everybody sees their own record, nothing else ------------------------------------------------------------------------------------------
    /** What an employee may see of their own record: contract data, no internal notes, no sensitive block. */
    const selfOut = (e: EmployeeRow) => {
      const o = employeeOut(e, getHrSettings(app, e.location_id));
      const manager = e.manager_user_id ? usersOf(e.location_id).find((u) => u.id === e.manager_user_id)?.name ?? '' : '';
      const { notes, contact_id, user_id, has_sensitive, manager_user_id, ...rest } = o;
      void notes, contact_id, user_id, has_sensitive, manager_user_id;
      return { ...rest, manager };
    };
    const reportsOf = (loc: string, uid: string) => db.all<EmployeeRow>(`SELECT * FROM hr_employees WHERE location_id = ? AND manager_user_id = ? AND status = 'active'`, loc, uid);

    router.get('/api/me/hr', 'location', (ctx) => {
      const e = selfEmployee(app, ctx);
      const year = thisYear(ctx.locationId);
      const settings = getHrSettings(app, ctx.locationId);
      return {
        is_hr: isHr(ctx),
        can_sensitive: canSeeSensitive(app, ctx),
        is_manager: !!ctx.user && reportsOf(ctx.locationId, ctx.user.id).length > 0,
        employee: e ? selfOut(e) : null,
        balance: e ? balanceOf(e, year) : null,
        default_state: settings.default_state,
        states: STATES,
      };
    });
    router.get('/api/me/hr/balance', 'location', (ctx) => {
      const e = selfEmployee(app, ctx);
      if (!e) throw notFound('Dein Login ist noch keinem Mitarbeiter zugeordnet');
      const year = yearOf(ctx);
      return { year, balance: balanceOf(e, year) };
    });
    router.get('/api/me/hr/absences', 'location', (ctx) => {
      const e = selfEmployee(app, ctx);
      if (!e) return [];
      const year = ctx.query.get('year') ? yearOf(ctx) : null;
      const rows = db.all<AbsenceRow>(`SELECT * FROM hr_absences WHERE employee_id = ? ${year ? 'AND end_date >= ? AND start_date <= ?' : ''} ORDER BY start_date DESC LIMIT 500`, e.id, ...(year ? [`${year}-01-01`, `${year}-12-31`] : []));
      return rows.map((a) => absenceOut(a));
    });
    router.post('/api/me/hr/absences', 'location', (ctx) => {
      const e = selfEmployee(app, ctx);
      if (!e) throw new HttpError(404, 'Dein Login ist noch keinem Mitarbeiter zugeordnet – bitte im Personalbüro melden');
      // Whatever the body says, an employee only files for themselves, never pre-approved and never past the balance.
      const { employee_id, approved, force, ...b } = ctx.body ?? {};
      void employee_id, approved, force;
      return absenceOut(createAbsence(ctx, e, b, { hr: false }));
    });
    router.post('/api/me/hr/absences/:id/cancel', 'location', (ctx) => {
      const a = getAbsence(ctx.locationId, ctx.params.id);
      const own = selfEmployee(app, ctx);
      if (!own || own.id !== a.employee_id) throw notFound('Antrag nicht gefunden');
      return absenceOut(cancel(ctx, a, false));
    });
    router.get('/api/me/hr/approvals', 'location', (ctx) => {
      if (!ctx.user) return [];
      const reports = new Map(reportsOf(ctx.locationId, ctx.user.id).map((e) => [e.id, e]));
      if (!reports.size) return [];
      return db
        .all<AbsenceRow>(`SELECT * FROM hr_absences WHERE location_id = ? AND status = 'requested' ORDER BY start_date`, ctx.locationId)
        .filter((a) => reports.has(a.employee_id))
        .map((a) => ({ ...absenceOut(a, reports.get(a.employee_id)), balance: a.type === 'vacation' ? balanceOf(reports.get(a.employee_id)!, Number(a.start_date.slice(0, 4))) : null }));
    });
    router.post('/api/me/hr/absences/:id/decide', 'location', (ctx) => {
      const a = getAbsence(ctx.locationId, ctx.params.id);
      const e = getEmployee(app, ctx.locationId, a.employee_id);
      // Through this door only the manager of the employee may decide – HR uses /api/hr/absences/:id/approve.
      if (!ctx.user || e.manager_user_id !== ctx.user.id) throw notFound('Antrag nicht gefunden');
      const decision = ctx.body?.decision;
      if (decision !== 'approved' && decision !== 'rejected') throw bad('decision: approved oder rejected');
      return absenceOut(decide(ctx, a, decision, ctx.body?.note));
    });
    router.get('/api/me/hr/calendar', 'location', (ctx) => {
      const e = selfEmployee(app, ctx);
      const manager = !!ctx.user && reportsOf(ctx.locationId, ctx.user.id).length > 0;
      const { from, to } = rangeOf(ctx);
      // The team calendar shows colleagues' names – only for people who are employees (or manage some) themselves.
      if (!e && !manager && !isHr(ctx)) return { from, to, state: '', holidays: [], other_states: [], items: [] };
      return calendarFor(ctx.locationId, from, to, isHr(ctx), e?.id);
    });
    router.get('/api/me/hr/checklists', 'location', (ctx) => {
      const e = selfEmployee(app, ctx);
      return e ? db.all<any>(`SELECT * FROM hr_checklists WHERE employee_id = ? AND location_id = ? ORDER BY created_at DESC`, e.id, ctx.locationId).map((c) => checklistOut(c)) : [];
    });
    router.post('/api/me/hr/checklists/:id/items/:itemId', 'location', (ctx) => {
      const e = selfEmployee(app, ctx);
      const c = e && db.get<any>('SELECT * FROM hr_checklists WHERE id = ? AND employee_id = ? AND location_id = ?', ctx.params.id, e.id, ctx.locationId);
      if (!c) throw notFound('Checkliste nicht gefunden');
      const it = (JSON.parse(c.items) as ChecklistItem[]).find((x) => x.id === ctx.params.itemId);
      if (!it) throw notFound('Punkt nicht gefunden');
      if (it.assignee !== 'employee') throw new HttpError(403, 'Dieser Punkt liegt nicht bei dir');
      return tick(ctx, c, it.id, ctx.body?.done !== false, ctx.user?.name ?? '');
    });

    // --- MCP tool and workflow triggers --------------------------------------------------------------------------------------------------------------------------
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    app.services.workflowTriggers = [...(app.services.workflowTriggers ?? []), ...HR_TRIGGERS];
  },
};
