import type { Module } from '../core/app.js';
import { HttpError } from '../core/http.js';
import { SOURCE_KEYS, SOURCE_LABELS, PART_KEYS } from '../services/umzug-core.js';
import type { Tool } from './mcp.js';

/**
 * MCP tools of the Umzug assistant and the deliverability wizard (HyperLevel Agent, Claude, ChatGPT, Codex). Thin relays
 * onto the REST routes (modules/umzug.ts, umzug-mailcheck.ts), so the key's sub-account, member rights and the audit
 * log apply. Credentials are never accepted here – they are entered in the app (Einstellungen → Umzug).
 */

const LOC = { location_id: { type: 'string', description: 'Ziel-Sub-Account/Projekt-ID (aus ghl_list_projects) – dorthin wird importiert' } };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const RO = { readOnlyHint: true, openWorldHint: true };
const W = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
/** Straight from the registry (services/umzug-core.ts): a new source shows up here without an edit. */
const SOURCES: string[] = [...SOURCE_KEYS];
const SOURCE_NAMES = SOURCE_KEYS.map((k) => SOURCE_LABELS[k]).join(', ');
const link = (path: string) => `/app/${path}`;

type Caller = Parameters<Tool['run']>[0];
/** Agency callers name the sub-account; a key bound to one sub-account may only name its own. */
function loc(call: Caller, a: Record<string, any>): string | undefined {
  if (call.agency) {
    if (!a.location_id) throw new HttpError(400, 'location_id fehlt (aus ghl_list_projects)');
    return String(a.location_id);
  }
  if (a.location_id && a.location_id !== call.locationId) throw new HttpError(403, 'Dieser Schlüssel gilt nur für einen Sub-Account');
  return undefined;
}

const SHAPE =
  `source = ${SOURCE_KEYS.slice(0, -1).join(', ')} oder ${SOURCE_KEYS[SOURCE_KEYS.length - 1]}. Quelle ist entweder die API-Verbindung (muss vorher in der Oberfläche unter Einstellungen → Umzug eingerichtet sein – Zugangsdaten nimmt dieses Werkzeug nicht entgegen) oder hochgeladene Export-Dateien (file_ids). parts = was mitkommt (Standard: alles, was die Quelle vorschlägt).`;

const jobBrief = (j: any) => ({
  id: j.id,
  source: j.source_label ?? j.source,
  kind: j.kind === 'dry_run' ? 'Probelauf' : 'Import',
  status: j.status,
  percent: j.percent,
  current_step: j.step_label,
  processed: j.processed,
  total: j.total,
  steps: (j.steps ?? []).map((s: any) => `${s.done ? '✓' : '·'} ${s.label}`),
  report: (j.report ?? []).map((l: any) => `${l.label}: ${l.created} neu, ${l.updated} aktualisiert${l.skipped ? `, ${l.skipped} übersprungen` : ''}${l.failed ? `, ${l.failed} Fehler` : ''}`),
  warnings: (j.warnings ?? []).slice(0, 15),
  warnings_total: (j.warnings ?? []).length,
  notes: (j.notes ?? []).slice(0, 8),
  error: j.error ?? undefined,
  undone: !!j.undone_at,
  created_at: j.created_at,
  finished_at: j.finished_at,
  link: link('settings/umzug'),
});

export const UMZUG_TOOLS: Tool[] = [
  {
    name: 'ghl_umzug_sources',
    title: 'Umzug: Quellen und Stand',
    description: `Umzug zu HyperLevel: die Quellen (${SOURCE_NAMES}) mit den Teilen, die mitkommen können, dem was NICHT mitkommt, ob die API-Verbindung im Ziel-Sub-Account steht, hochgeladenen Export-Dateien und den letzten Umzügen. Starte hier, wenn jemand von einem anderen Tool wechseln will. Die Zugangsdaten gibt die Person in der Oberfläche ein (Einstellungen → Umzug, Link in der Antwort) – frage nie nach API-Schlüsseln im Chat.`,
    inputSchema: obj({ ...LOC }, []),
    annotations: RO,
    run: async (call, a) => {
      const r = await call.api('GET', '/api/umzug', { location: loc(call, a) });
      return {
        sources: (r.sources as any[]).map((s) => ({ key: s.key, label: s.label, connected: !!r.connections?.[s.key]?.connected, account: r.connections?.[s.key]?.label, parts: s.parts.map((p: any) => ({ key: p.key, label: p.label, default: p.on !== false, note: p.note })), does_not_move: s.limits, export_files: s.exports.map((e: any) => ({ kind: e.key, label: e.label, how: e.describe })), how_to_connect: s.howto })),
        uploaded_files: (r.files as any[]).map((f) => ({ id: f.id, name: f.name, kind: f.kind, rows: f.rows, source: f.source })),
        recent: (r.jobs as any[]).map(jobBrief),
        link: link('settings/umzug'),
      };
    },
  },
  {
    name: 'ghl_umzug_preview',
    title: 'Umzug: Vorschau mit Zahlen und Feldzuordnung',
    description: `Vorschau eines Umzugs ohne etwas zu schreiben: wie viele Kontakte, Listen/Tags, Deals, Kurse … in der Quelle liegen, wie viele davon schon übernommen wurden, welche Felder wohin zugeordnet werden (automatisch; unbekannte Felder würden als neue eigene Felder angelegt) und Hinweise. ${SHAPE}`,
    inputSchema: obj(
      {
        ...LOC,
        source: { type: 'string', enum: SOURCES },
        parts: { type: 'array', items: { type: 'string' }, description: PART_KEYS.join(', ') },
        file_ids: { type: 'array', items: { type: 'string' }, description: 'IDs hochgeladener Export-Dateien (ghl_umzug_sources) statt der API-Verbindung' },
        mapping: { type: 'object', description: 'Eigene Zuordnung: Quellfeld → Kontaktfeld (first_name, last_name, email, phone, company, address, city, postal_code, country, website, date_of_birth, source), custom:<schlüssel>, new:<typ>:<Bezeichnung>, tag, note oder leer = überspringen' },
      },
      ['source'],
    ),
    annotations: RO,
    run: async (call, a) => {
      const r = await call.api('POST', '/api/umzug/preview', { location: loc(call, a), body: { source: a.source, parts: a.parts, file_ids: a.file_ids, mapping: a.mapping } });
      const mapped = Object.entries(r.mapping as Record<string, string>);
      return {
        source: r.label,
        from: r.origin === 'file' ? 'Export-Datei' : 'API-Verbindung',
        parts: r.parts,
        counts: (r.counts as any[]).map((c) => `${c.label}: ${c.total ?? 'unbekannt'}${c.error ? ` (${c.error})` : ''}`),
        already_imported: r.existing,
        field_mapping: mapped.slice(0, 60).map(([ref, target]) => `${(r.fields as any[]).find((f) => f.ref === ref)?.label ?? ref} → ${target || 'überspringen'}`),
        new_custom_fields: mapped.filter(([, t]) => t.startsWith('new:')).length,
        warnings: r.warnings,
        next: 'Probelauf mit ghl_umzug_start (dry_run: true), dann echt starten. Die Zuordnung lässt sich in der Oberfläche feinjustieren.',
        link: link('settings/umzug'),
      };
    },
  },
  {
    name: 'ghl_umzug_start',
    title: 'Umzug starten (Probelauf oder Import)',
    description: `Startet einen Umzug als Hintergrund-Auftrag: mit dry_run: true ein Probelauf (liest alles, schreibt nichts, zählt neu/aktualisiert und sammelt Warnungen), sonst der Import. Mehrfach ausführbar – ein zweiter Lauf aktualisiert statt zu verdoppeln; vorhandene Kontakte (gleiche E-Mail/Telefon) werden zusammengeführt (merge: fill = nur leere Felder füllen, overwrite = überschreiben); Abgemeldete/Bounces werden „Nicht stören“; Automationen und Sequenzen kommen nur als Entwürfe „bitte prüfen“. Der Auftrag lässt sich in der Oberfläche pausieren, fortsetzen und rückgängig machen. Fortschritt mit ghl_umzug_status. Erst Probelauf, dann Import – und den Import nur nach Rückfrage bei der Person starten. ${SHAPE}`,
    inputSchema: obj(
      {
        ...LOC,
        source: { type: 'string', enum: SOURCES },
        parts: { type: 'array', items: { type: 'string' } },
        file_ids: { type: 'array', items: { type: 'string' } },
        dry_run: { type: 'boolean', description: 'true = Probelauf ohne Schreiben' },
        mapping: { type: 'object', description: 'wie bei ghl_umzug_preview; ohne Angabe gilt die automatische Zuordnung' },
        options: { type: 'object', properties: { merge: { type: 'string', enum: ['fill', 'overwrite'] }, tag: { type: 'string', description: 'zusätzlicher Tag für alle importierten Kontakte' }, keep_files: { type: 'boolean' } } },
      },
      ['source'],
    ),
    annotations: W,
    klassFor: (a) => (a.dry_run ? 'read' : 'write'),
    run: async (call, a) => {
      const j = await call.api('POST', a.dry_run ? '/api/umzug/dry-run' : '/api/umzug/jobs', { location: loc(call, a), body: { source: a.source, parts: a.parts, file_ids: a.file_ids, mapping: a.mapping, options: a.options } });
      return { started: jobBrief(j), next: 'Fortschritt: ghl_umzug_status mit job_id.' };
    },
  },
  {
    name: 'ghl_umzug_status',
    title: 'Umzug: Fortschritt und Bericht',
    description: 'Stand eines Umzugs: Status (läuft, pausiert, fertig, fehlgeschlagen, rückgängig gemacht), Fortschritt je Schritt, Bericht (neu/aktualisiert/übersprungen/Fehler je Bereich) und Warnungen („bitte prüfen“). Ohne job_id: der letzte Umzug des Sub-Accounts.',
    inputSchema: obj({ ...LOC, job_id: { type: 'string' } }, []),
    annotations: RO,
    run: async (call, a) => {
      const l = loc(call, a);
      let id = a.job_id as string | undefined;
      if (!id) {
        const list = await call.api('GET', '/api/umzug/jobs', { location: l });
        if (!list.length) return { jobs: 0, hint: 'Noch kein Umzug – ghl_umzug_sources zeigt, wie es losgeht.' };
        id = list[0].id;
      }
      const j = await call.api('GET', `/api/umzug/jobs/${encodeURIComponent(String(id))}`, { location: l });
      return { ...jobBrief(j), undo: j.undo ?? undefined };
    },
  },
  {
    name: 'ghl_mail_domain_check',
    title: 'E-Mail-Zustellung prüfen (SPF, DKIM, DMARC, MX)',
    description: 'Prüft die Absender-Domain eines Sub-Accounts (oder eine angegebene Domain) per DNS: SPF (ein Eintrag, Abschluss, höchstens 10 Abfragen, Anbieter enthalten), DKIM (Selektor je Anbieter: Amazon SES, Postmark, Resend, Brevo, Mailgun, SMTP), DMARC und MX. Antwort: Gesamtstatus, je Prüfung Status, Befund, Schritte zur Behebung auf Deutsch und die DNS-Einträge zum Kopieren. Nutze es, wenn Mails im Spam landen, vor dem ersten Kampagnenversand oder nach einem Umzug. Die Prüfung schreibt nur das Ergebnis in die Liste der Domains.',
    inputSchema: obj({ ...LOC, domain: { type: 'string', description: 'Domain wie meinefirma.de – ohne Angabe die Domain der Absender-Adresse' } }, []),
    annotations: RO,
    klassFor: () => 'read',
    run: async (call, a) => {
      const r = await call.api('POST', '/api/mail-domains/check', { location: loc(call, a), body: { domain: a.domain } });
      const res = r.result;
      return {
        domain: r.domain,
        provider: r.provider_label,
        status: res.status,
        summary: res.summary,
        checked_at: res.checked_at,
        checks: (res.checks as any[]).map((c) => ({ check: c.label, status: c.status, finding: c.summary, problems: c.problems, steps: c.status === 'ok' ? undefined : c.steps, records_to_add: c.status === 'ok' ? undefined : c.records.map((x: any) => `${x.type} ${x.host} ${x.priority !== undefined ? `${x.priority} ` : ''}${x.value}${x.note ? ` (${x.note})` : ''}`), optional: c.optional || undefined })),
        notes: res.notes,
        link: link('settings/deliverability'),
      };
    },
  },
];

export const umzugToolsModule: Module = {
  name: 'umzug-tools',
  register(app) {
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...UMZUG_TOOLS];
  },
};
