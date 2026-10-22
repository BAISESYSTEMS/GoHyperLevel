import type { App, Module } from '../core/app.js';
import { HttpError, bad, html, notFound, str, type Ctx, type Handler } from '../core/http.js';
import { jsonForScript, messagePage, publicPage } from '../core/page.js';
import { escapeHtml, render, textToHtml } from '../core/template.js';
import { formatInTz } from '../core/time.js';
import { id, normalizeEmail, now, sha256, token } from '../core/util.js';
import { contactVars, getContact, logActivity } from '../services/contacts.js';
import { deliverEmail, notifyTeam, sendToContact } from '../services/messaging.js';
import { registerTriggers, type TriggerMeta } from '../services/wfx-kit.js';
import { contractHtml, isSignatureImage } from './contracts.js';
import type { Tool } from './mcp.js';

/**
 * Several signers with roles and a signing order for a contract (HighLevel/PandaDoc parity, docs/sales.md#several-signers).
 * A contract without signers works exactly as before (one contact signs on /s/:token). With signers, each one gets a link of their
 * own (/sign/:token), signs in order (sequential: the next one is invited when the previous one signed) or all at once (parallel),
 * and every signature is kept with its own audit trail (name, IP address, device, time, SHA-256 of the frozen text). When the last
 * one signed, the contract is signed and `contract.signed` fires as always. It plugs into contracts.ts through router wrappers only:
 * "Senden" starts the signing run, /s/:token shows the overview and the single-signer routes refuse.
 */

const MAX_SIGNERS = 10;
const ACTIVE = new Set(['invited', 'viewed']);

type Signer = {
  id: string;
  location_id: string;
  contract_id: string;
  position: number;
  role: string;
  name: string;
  email: string;
  token: string;
  status: 'waiting' | 'invited' | 'viewed' | 'signed' | 'declined';
  invited_at: string | null;
  viewed_at: string | null;
  signed_at: string | null;
  signed_name: string | null;
  signature: string | null;
  ip: string | null;
  ua: string | null;
  content_hash: string | null;
  decline_reason: string | null;
};

const TRIGGER: TriggerMeta = {
  type: 'contract.signer_signed',
  label: 'Vertrag: Unterzeichner hat unterschrieben',
  category: 'payments',
  summary: 'Bei Verträgen mit mehreren Unterzeichnern: eine Person hat ihren Teil unterschrieben.',
  doc: 'Feuert je Unterschrift eines Signaturlaufs mit mehreren Unterzeichnern (Rolle, Name, E-Mail, Position, verbleibende Unterschriften). Ist es die letzte, folgt zusätzlich „Vertrag unterschrieben“. {{event.signer.role}}, {{event.signer.name}}, {{event.remaining}} und {{event.contract.title}} stehen im Ereignis.',
  fields: [],
  sample: { contract: { id: 'c1', title: 'Rahmenvertrag' }, signer: { role: 'Geschäftsführung', name: 'Erika Muster', email: 'erika@example.com', position: 1 }, remaining: 1 },
  keywords: 'vertrag unterschrift unterzeichner signatur reihenfolge rolle esign',
};


const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });

/** MCP: read and set the signers of a contract (thin relays onto the REST routes – key, member areas and audit log apply). */
export const CONTRACT_SIGNER_TOOLS: Tool[] = [
  {
    name: 'ghl_contract_signers',
    title: 'Unterzeichner eines Vertrags',
    description: 'Die Unterzeichner eines Vertrags mit Rolle, Reihenfolge (sequential = nacheinander, parallel = alle gleichzeitig) und Stand je Person (waiting, invited, viewed, signed, declined) samt persönlichem Link. Ohne Unterzeichner (mode null) unterschreibt wie früher nur der Kontakt.',
    inputSchema: obj({ ...LOC, contract_id: { type: 'string', description: 'Vertrags-ID' } }, ['location_id', 'contract_id']),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/contracts/${encodeURIComponent(a.contract_id)}/signers`, { location: a.location_id }),
  },
  {
    name: 'ghl_contract_signers_set',
    title: 'Unterzeichner festlegen und Signaturlauf starten',
    description: `Legt für einen Vertragsentwurf mehrere Unterzeichner mit Rollen fest (höchstens ${MAX_SIGNERS}; Reihenfolge = Reihenfolge der Liste) und startet mit send=true den Signaturlauf: Bei sequential bekommt zuerst Person 1 ihren Link, die nächste erst nach deren Unterschrift; bei parallel alle sofort. Eine leere Liste stellt wieder auf „nur der Kontakt unterschreibt“ um. Verschickt E-Mails – vor send=true nachfragen.`,
    inputSchema: obj(
      {
        ...LOC,
        contract_id: { type: 'string', description: 'Vertrags-ID (Entwurf)' },
        mode: { type: 'string', enum: ['sequential', 'parallel'], description: 'sequential (Standard): nacheinander; parallel: alle gleichzeitig' },
        signers: { type: 'array', items: { type: 'object', properties: { role: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' } }, required: ['name', 'email'], additionalProperties: false } },
        send: { type: 'boolean', description: 'Gleich senden (E-Mail an die erste bzw. alle Personen)' },
      },
      ['location_id', 'contract_id', 'signers'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (call, a) => {
      const set = await call.api('PUT', `/api/contracts/${encodeURIComponent(a.contract_id)}/signers`, { location: a.location_id, body: { mode: a.mode, signers: a.signers } });
      if (!a.send || !set.total) return { ...set, link: `/app/contracts/${a.contract_id}` };
      const sent = await call.api('POST', `/api/contracts/${encodeURIComponent(a.contract_id)}/send`, { location: a.location_id, body: {} });
      return { ...sent.signers, message: sent.message, link: `/app/contracts/${a.contract_id}` };
    },
  },
];

export const contractSignersModule: Module = {
  name: 'contract-signers',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE contract_sign_runs (
        contract_id TEXT PRIMARY KEY REFERENCES contracts(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        mode TEXT NOT NULL DEFAULT 'sequential', updated_at TEXT NOT NULL
      );
      CREATE TABLE contract_signers (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, role TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, email TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'waiting',
        invited_at TEXT, viewed_at TEXT, signed_at TEXT, signed_name TEXT, signature TEXT, ip TEXT, ua TEXT, content_hash TEXT,
        decline_reason TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX contract_signers_contract ON contract_signers(contract_id, position);
      CREATE INDEX contract_signers_email ON contract_signers(location_id, email);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    registerTriggers(app, [TRIGGER]);
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...CONTRACT_SIGNER_TOOLS];

    const contractOf = (locationId: string, cid: string) => db.get<any>('SELECT * FROM contracts WHERE id = ? AND location_id = ?', cid, locationId);
    const runOf = (cid: string) => db.get<{ mode: string }>('SELECT mode FROM contract_sign_runs WHERE contract_id = ?', cid);
    const signersOf = (cid: string) => db.all<Signer>('SELECT * FROM contract_signers WHERE contract_id = ? ORDER BY position', cid);
    const signerUrl = (s: Signer) => `${app.baseUrl()}/sign/${s.token}`;
    const contractUrl = (c: any) => `${app.baseUrl()}/s/${c.public_token}`;
    const signerOut = (s: Signer) => {
      const { signature, token: _t, ua: _u, ...rest } = s;
      return { ...rest, has_signature: !!signature, url: signerUrl(s) };
    };
    const contractOut = (c: any) => {
      const { signature: _s, ...rest } = c;
      return { ...rest, url: contractUrl(c) };
    };
    function overview(c: any) {
      const run = runOf(c.id);
      const list = signersOf(c.id);
      return { contract_id: c.id, status: c.status, mode: run?.mode ?? null, signers: list.map(signerOut), signed: list.filter((s) => s.status === 'signed').length, total: list.length };
    }

    /** Invites one signer by e-mail: through the contact's conversation when the address belongs to a contact, else as a plain mail. */
    async function invite(c: any, s: Signer, input: { subject?: string; body?: string; userId?: string } = {}) {
      const loc = app.location(c.location_id)!;
      const [first, ...rest] = s.name.split(/\s+/);
      const person = { first_name: first ?? '', last_name: rest.join(' '), name: s.name, full_name: s.name, email: s.email };
      const vars = { contact: person, signer: { ...person, role: s.role, position: s.position }, location: loc, contract: { title: c.title, url: signerUrl(s) } };
      const subject = render(input.subject || 'Bitte unterschreiben: {{contract.title}}', vars);
      const body = render(
        input.body ||
          'Hallo {{signer.first_name}},\n\nbitte lies und unterschreibe „{{contract.title}}“ als {{signer.role|Unterzeichner}}:\n{{contract.url}}\n\nViele Grüße\n{{location.name}}',
        vars,
      );
      const contact = db.get<{ id: string }>('SELECT id FROM contacts WHERE location_id = ? AND lower(email) = ? LIMIT 1', c.location_id, s.email);
      let result: { status: string; error?: string };
      try {
        if (contact) {
          const m = await sendToContact(app, c.location_id, { contactId: contact.id, channel: 'email', subject, body, userId: input.userId, source: 'Vertrag', ignoreDnd: true });
          result = { status: m.status, error: m.error ?? undefined };
        } else {
          const r = await deliverEmail(loc, { to: s.email, subject, text: body, html: textToHtml(body) });
          result = { status: r.status };
        }
      } catch (e) {
        result = { status: 'failed', error: (e as Error).message };
      }
      db.run(`UPDATE contract_signers SET status = CASE WHEN status = 'waiting' THEN 'invited' ELSE status END, invited_at = ? WHERE id = ?`, now(), s.id);
      if (contact) logActivity(app, c.location_id, contact.id, 'contract.sent', `Vertrag „${c.title}“ zum Unterschreiben gesendet${s.role ? ` (${s.role})` : ''}`);
      return result;
    }

    /** Who is invited next: in order the first one still waiting (if nobody is signing), in parallel everybody waiting. */
    async function inviteDue(c: any, input: { subject?: string; body?: string; userId?: string } = {}) {
      const run = runOf(c.id);
      const list = signersOf(c.id);
      const due = run?.mode === 'parallel' ? list.filter((s) => s.status === 'waiting') : list.some((s) => ACTIVE.has(s.status)) ? [] : list.filter((s) => s.status === 'waiting').slice(0, 1);
      const results = [];
      for (const s of due) results.push(await invite(c, s, input));
      return results;
    }

    // --- staff: the signers of a contract ------------------------------------------------------------------------------------
    router.get('/api/contracts/:id/signers', 'location', (ctx) => {
      const c = contractOf(ctx.locationId, ctx.params.id);
      if (!c || c.kind !== 'contract') throw notFound();
      return overview(c);
    });
    router.put('/api/contracts/:id/signers', 'location', (ctx) => {
      const c = contractOf(ctx.locationId, ctx.params.id);
      if (!c || c.kind !== 'contract') throw notFound();
      if (c.status !== 'draft') throw bad('Nach dem Versand lassen sich die Unterzeichner nicht mehr ändern');
      const raw = ctx.body.signers;
      if (!Array.isArray(raw)) throw bad('Unterzeichner fehlen');
      if (raw.length > MAX_SIGNERS) throw bad(`Höchstens ${MAX_SIGNERS} Unterzeichner`);
      const mode = ctx.body.mode === 'parallel' ? 'parallel' : 'sequential';
      const seen = new Set<string>();
      const clean = raw.map((x: any, i: number) => {
        if (!x || typeof x !== 'object') throw bad(`Unterzeichner ${i + 1}: ungültig`);
        const name = str(x.name, `Unterzeichner ${i + 1}: Name`, { required: true, max: 200 });
        const email = normalizeEmail(x.email);
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad(`Unterzeichner ${i + 1}: E-Mail-Adresse fehlt oder ist ungültig`);
        if (seen.has(email)) throw bad(`Unterzeichner ${i + 1}: Diese E-Mail-Adresse steht schon in der Liste`);
        seen.add(email);
        return { role: str(x.role, `Unterzeichner ${i + 1}: Rolle`, { max: 80 }), name, email };
      });
      db.tx(() => {
        db.run('DELETE FROM contract_signers WHERE contract_id = ?', c.id);
        db.run('DELETE FROM contract_sign_runs WHERE contract_id = ?', c.id);
        if (!clean.length) return;
        db.insert('contract_sign_runs', { contract_id: c.id, location_id: c.location_id, mode, updated_at: now() });
        clean.forEach((s, i) => db.insert('contract_signers', { id: id(), location_id: c.location_id, contract_id: c.id, position: i + 1, ...s, token: token(24), status: 'waiting', created_at: now() }));
      });
      return overview(c);
    });
    router.post('/api/contracts/:id/signers/:sid/remind', 'location', async (ctx) => {
      const c = contractOf(ctx.locationId, ctx.params.id);
      if (!c || c.kind !== 'contract') throw notFound();
      const s = db.get<Signer>('SELECT * FROM contract_signers WHERE id = ? AND contract_id = ?', ctx.params.sid, c.id);
      if (!s) throw notFound('Unterzeichner nicht gefunden');
      if (!['sent', 'viewed'].includes(c.status) || !ACTIVE.has(s.status)) throw bad('Diese Person ist gerade nicht mit Unterschreiben dran');
      return { ...overview(c), message: await invite(c, s, { userId: ctx.user?.id }) };
    });

    // --- the hooks into contracts.ts --------------------------------------------------------------------------------------------
    /** "Senden" on a contract with signers starts (or, sent again, repeats the invitations of) the signing run. */
    async function startRun(ctx: Ctx, c: any) {
      if (['signed', 'declined', 'void'].includes(c.status)) throw bad('Dieser Vertrag ist abgeschlossen');
      if (ctx.body.channel === 'sms') throw bad('Verträge mit mehreren Unterzeichnern gehen per E-Mail raus');
      const input = { subject: str(ctx.body.subject, 'Betreff', { max: 300 }), body: str(ctx.body.body, 'Nachricht', { max: 20_000 }), userId: ctx.user?.id };
      if (c.status === 'draft') {
        const loc = app.location(c.location_id)!;
        const contact = c.contact_id ? getContact(app, c.location_id, c.contact_id) : undefined;
        const vars = { contact: contactVars(contact), location: loc, contract: { title: c.title, url: contractUrl(c) } };
        db.update('contracts', c.id, { content: render(c.content, vars), title: render(c.title, vars), status: 'sent', sent_at: now(), updated_at: now() });
      }
      const fresh = contractOf(c.location_id, c.id);
      let results = await inviteDue(fresh, input);
      // Sent again: remind whoever is signing right now.
      if (!results.length) for (const s of signersOf(c.id).filter((x) => ACTIVE.has(x.status))) results.push(await invite(fresh, s, input));
      if (c.contact_id) logActivity(app, c.location_id, c.contact_id, 'contract.sent', `Vertrag „${c.title}“ an ${signersOf(c.id).length} Unterzeichner gesendet`);
      const failed = results.find((r) => r.status === 'failed');
      return { ...contractOut(contractOf(c.location_id, c.id)), message: failed ? { status: 'failed', error: failed.error } : { status: results[0]?.status ?? 'sent' }, signers: overview(fresh) };
    }

    const wrap: Record<string, (ctx: Ctx, next: Handler) => unknown> = {
      'POST /api/contracts/:id/send': (ctx, next) => {
        const c = contractOf(ctx.locationId, ctx.params.id);
        return c && c.kind === 'contract' && runOf(c.id) ? startRun(ctx, c) : next(ctx);
      },
      'GET /s/:token': (ctx, next) => {
        const c = db.get<any>('SELECT * FROM contracts WHERE public_token = ?', ctx.params.token);
        return c && c.kind === 'contract' && c.status !== 'draft' && runOf(c.id) ? html(page(c)) : next(ctx);
      },
      'POST /api/public/contracts/:token/sign': (ctx, next) => refuseSingle(ctx, next),
      'POST /api/public/contracts/:token/decline': (ctx, next) => refuseSingle(ctx, next),
    };
    function refuseSingle(ctx: Ctx, next: Handler) {
      const c = db.get<any>('SELECT id FROM contracts WHERE public_token = ?', ctx.params.token);
      if (c && runOf(c.id)) throw new HttpError(409, 'Dieser Vertrag wird über die persönlichen Links der Unterzeichner unterschrieben');
      return next(ctx);
    }
    router.wrappers.push((route, next) => {
      const fn = wrap[`${route.method} ${route.pattern}`];
      return fn ? (ctx) => fn(ctx, next) : next;
    });

    // --- public: one link per signer --------------------------------------------------------------------------------------------
    const byToken = (tok: string) => {
      const s = db.get<Signer>('SELECT * FROM contract_signers WHERE token = ?', tok);
      const c = s ? db.get<any>('SELECT * FROM contracts WHERE id = ?', s.contract_id) : undefined;
      return s && c && c.kind === 'contract' && c.status !== 'draft' ? { s, c } : undefined;
    };

    router.get('/sign/:token', 'public', (ctx) => {
      const found = byToken(ctx.params.token);
      if (!found) return html(messagePage('Nicht gefunden', 'Diesen Link gibt es nicht.'), 404);
      const { s, c } = found;
      if (s.status === 'invited' && ['sent', 'viewed'].includes(c.status)) {
        db.run(`UPDATE contract_signers SET status = 'viewed', viewed_at = ? WHERE id = ? AND status = 'invited'`, now(), s.id);
        if (c.status === 'sent') db.run(`UPDATE contracts SET status = 'viewed', viewed_at = ? WHERE id = ? AND status = 'sent'`, now(), c.id);
        if (c.contact_id) logActivity(app, c.location_id, c.contact_id, 'contract.viewed', `Vertrag „${c.title}“ geöffnet von ${s.name}${s.role ? ` (${s.role})` : ''}`);
      }
      return html(page(db.get<any>('SELECT * FROM contracts WHERE id = ?', c.id), db.get<Signer>('SELECT * FROM contract_signers WHERE id = ?', s.id)));
    });

    const open = (tok: string) => {
      const found = byToken(tok);
      if (!found) throw notFound();
      if (!['sent', 'viewed'].includes(found.c.status)) throw new HttpError(409, 'Dieser Vertrag ist schon abgeschlossen');
      if (found.s.status === 'waiting') throw new HttpError(409, 'Du bist noch nicht an der Reihe – wir schicken dir eine E-Mail, sobald du unterschreiben kannst');
      if (!ACTIVE.has(found.s.status)) throw new HttpError(409, 'Du hast schon geantwortet');
      return found;
    };

    router.post('/api/public/sign/:token', 'public', async (ctx) => {
      const { s, c } = open(ctx.params.token);
      const name = str(ctx.body.name, 'Name', { required: true, max: 200 });
      if (!ctx.body.agree) throw bad('Bitte der Unterschrift zustimmen');
      if (!isSignatureImage(ctx.body.signature)) throw bad('Unterschrift fehlt');
      const at = now();
      const hash = sha256(`${c.title}\n\n${c.content}`);
      const done = db.run(
        `UPDATE contract_signers SET status = 'signed', signed_at = ?, signed_name = ?, signature = ?, ip = ?, ua = ?, content_hash = ? WHERE id = ? AND status IN ('invited','viewed')`,
        at, name, ctx.body.signature, ctx.ip, String(ctx.req.headers['user-agent'] ?? '').slice(0, 300), hash, s.id,
      ).changes;
      if (!done) throw new HttpError(409, 'Du hast schon geantwortet');
      const list = signersOf(c.id);
      const remaining = list.filter((x) => x.status !== 'signed').length;
      if (c.contact_id) logActivity(app, c.location_id, c.contact_id, 'contract.signer_signed', `Vertrag „${c.title}“: ${name}${s.role ? ` (${s.role})` : ''} hat unterschrieben`);
      app.events.emit(c.location_id, 'contract.signer_signed', { contactId: c.contact_id, contract: { id: c.id, title: c.title }, signer: { role: s.role, name, email: s.email, position: s.position }, remaining });
      if (remaining === 0) await complete(c, list);
      else await inviteDue(c);
      return { ok: true, remaining };
    });

    router.post('/api/public/sign/:token/decline', 'public', (ctx) => {
      const { s, c } = open(ctx.params.token);
      const reason = str(ctx.body.reason, 'Grund', { max: 2000 });
      db.run(`UPDATE contract_signers SET status = 'declined', decline_reason = ?, ip = ?, signed_at = ? WHERE id = ?`, reason, ctx.ip, now(), s.id);
      db.run(`UPDATE contracts SET status = 'declined', signed_at = ?, decline_reason = ?, signer_name = ?, signer_email = ?, signer_ip = ?, updated_at = ? WHERE id = ?`, now(), reason, s.name, s.email, ctx.ip, now(), c.id);
      if (c.contact_id) logActivity(app, c.location_id, c.contact_id, 'contract.declined', `Vertrag „${c.title}“ abgelehnt von ${s.name}${s.role ? ` (${s.role})` : ''}`);
      void notifyTeam(app, c.location_id, `Vertrag abgelehnt: ${c.title}`, `${s.name}${s.role ? ` (${s.role})` : ''} hat abgelehnt.\nGrund: ${reason || '–'}\n\n${contractUrl(c)}`);
      app.events.emit(c.location_id, 'contract.declined', { contactId: c.contact_id, contract: { id: c.id, title: c.title }, signer: { role: s.role, name: s.name, email: s.email } });
      return { ok: true };
    });

    /** The last signature: the contract is signed (the first signature and the names stay on the contract row for the old views). */
    async function complete(c: any, list: Signer[]) {
      const at = now();
      const names = list.map((x) => `${x.signed_name || x.name}${x.role ? ` (${x.role})` : ''}`).join(', ');
      const last = list[list.length - 1];
      const ok = db.run(
        `UPDATE contracts SET status = 'signed', signed_at = ?, signer_name = ?, signer_email = ?, signer_ip = ?, signer_ua = ?, signature = ?, content_hash = ?, updated_at = ? WHERE id = ? AND status IN ('sent','viewed')`,
        at, names.slice(0, 1000), list[0].email, last.ip, last.ua, list[0].signature, sha256(`${c.title}\n\n${c.content}`), at, c.id,
      ).changes;
      if (!ok) return;
      if (c.contact_id) logActivity(app, c.location_id, c.contact_id, 'contract.signed', `Vertrag „${c.title}“ von allen unterschrieben`);
      void notifyTeam(app, c.location_id, `Vertrag unterschrieben: ${c.title}`, `Alle ${list.length} Unterzeichner haben „${c.title}“ unterschrieben: ${names}.\n\n${contractUrl(c)}`);
      const loc = app.location(c.location_id)!;
      for (const s of list) {
        const text = `Hallo ${s.signed_name || s.name},\n\n„${c.title}“ ist jetzt von allen unterschrieben. Hier kannst du den Vertrag mit allen Unterschriften ansehen und als PDF speichern:\n${signerUrl(s)}\n\nViele Grüße\n${loc.name}`;
        try {
          await deliverEmail(loc, { to: s.email, subject: `Deine Kopie: ${c.title}`, text, html: textToHtml(text) });
        } catch (e) {
          console.error('[contract-signers] copy', (e as Error).message);
        }
      }
      app.events.emit(c.location_id, 'contract.signed', { contactId: c.contact_id, contract: { id: c.id, title: c.title }, signers: list.map((x) => ({ role: x.role, name: x.signed_name || x.name, email: x.email })) });
    }

    // --- the page: the document, who signs in which order, and (for the signer whose turn it is) the signature pad ---------------
    function page(c: any, me?: Signer) {
      const loc = app.location(c.location_id)!;
      const list = signersOf(c.id);
      const run = runOf(c.id);
      const when = (v: string | null) => (v ? `${formatInTz(v, loc.timezone, { weekday: undefined })} Uhr` : '');
      const state = (s: Signer) =>
        s.status === 'signed' ? `Unterschrieben am ${when(s.signed_at)}` : s.status === 'declined' ? 'Abgelehnt' : ACTIVE.has(s.status) ? 'Ist dran' : run?.mode === 'parallel' ? 'Offen' : 'Wartet';
      const rows = list
        .map(
          (s) =>
            `<tr${me?.id === s.id ? ' style="font-weight:600"' : ''}><td style="padding:6px 8px 6px 0">${s.position}.</td><td style="padding:6px 8px 6px 0">${escapeHtml(s.role || '–')}</td><td style="padding:6px 8px 6px 0">${escapeHtml(s.signed_name || s.name)}${me?.id === s.id ? ' (du)' : ''}</td><td style="padding:6px 0">${escapeHtml(state(s))}</td></tr>`,
        )
        .join('');
      const signatures = list
        .filter((s) => s.status === 'signed' && s.signature)
        .map(
          (s) =>
            `<div style="flex:1 1 240px"><img src="${escapeHtml(s.signature!)}" alt="Unterschrift ${escapeHtml(s.signed_name || s.name)}" style="max-width:260px;max-height:100px;border-bottom:1px solid #111;display:block"><p style="margin:4px 0 0">${escapeHtml(s.signed_name || s.name)}${s.role ? ` · ${escapeHtml(s.role)}` : ''}</p><p class="muted" style="margin:2px 0;font-size:12px">${escapeHtml(when(s.signed_at))} · IP ${escapeHtml(s.ip ?? '')}</p></div>`,
        )
        .join('');
      const canSign = me && ACTIVE.has(me.status) && ['sent', 'viewed'].includes(c.status);
      const notice =
        c.status === 'void'
          ? '<p class="error">Dieser Vertrag ist nicht mehr gültig.</p>'
          : c.status === 'declined'
            ? '<p class="error">Dieser Vertrag wurde abgelehnt.</p>'
            : me?.status === 'waiting'
              ? '<p class="muted">Du bist noch nicht an der Reihe. Sobald die Personen vor dir unterschrieben haben, bekommst du eine E-Mail.</p>'
              : me?.status === 'signed' && c.status !== 'signed'
                ? '<p class="muted">Danke, deine Unterschrift ist gespeichert. Wenn alle unterschrieben haben, bekommst du eine Kopie per E-Mail.</p>'
                : '';
      const form = canSign
        ? `<form id="sign" style="margin-top:20px;border-top:1px solid var(--line);padding-top:16px">
    <label for="n">Vollständiger Name</label><input id="n" name="name" required value="${escapeHtml(me!.name)}" autocomplete="name">
    <label style="margin-top:14px" for="pad">Unterschrift <span class="muted" style="font-weight:400">(mit Maus oder Finger zeichnen)</span></label>
    <canvas id="pad" width="600" height="180" style="width:100%;max-width:600px;height:180px;border:1px dashed #9ca3af;border-radius:9px;background:#fff;touch-action:none;display:block"></canvas>
    <p style="margin:6px 0"><button type="button" class="btn secondary" id="clear" style="padding:6px 12px">Löschen</button></p>
    <label class="check" style="margin-top:12px"><input type="checkbox" name="agree" required> Ich habe den Vertrag gelesen und stimme ihm${me!.role ? ` als ${escapeHtml(me!.role)}` : ''} mit meiner elektronischen Unterschrift zu.</label>
    <div class="row" style="margin-top:16px"><button type="submit">Verbindlich unterschreiben</button><button type="button" class="btn secondary" id="decline">Ablehnen</button></div>
    <div class="error" id="err" role="alert"></div>
  </form>
  <script>
  (function(){
    var T=${jsonForScript(me!.token)},cv=document.getElementById('pad'),x=cv.getContext('2d'),draw=false,ink=false;
    x.lineWidth=2.4;x.lineCap='round';x.lineJoin='round';x.strokeStyle='#111';
    function pos(e){var r=cv.getBoundingClientRect();return [(e.clientX-r.left)*cv.width/r.width,(e.clientY-r.top)*cv.height/r.height]}
    cv.addEventListener('pointerdown',function(e){draw=true;cv.setPointerCapture(e.pointerId);var p=pos(e);x.beginPath();x.moveTo(p[0],p[1])});
    cv.addEventListener('pointermove',function(e){if(!draw)return;var p=pos(e);x.lineTo(p[0],p[1]);x.stroke();ink=true});
    cv.addEventListener('pointerup',function(){draw=false});
    document.getElementById('clear').onclick=function(){x.clearRect(0,0,cv.width,cv.height);ink=false};
    var f=document.getElementById('sign'),err=document.getElementById('err');
    async function post(path,data){var r=await fetch('/api/public/sign/'+T+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});var j=await r.json();if(!r.ok)throw new Error(j.error||'Fehler');location.reload()}
    f.onsubmit=async function(e){e.preventDefault();err.textContent='';if(!ink){err.textContent='Bitte unterschreiben.';return}
      try{await post('',{name:f.name.value,agree:f.agree.checked,signature:cv.toDataURL('image/png')})}catch(x){err.textContent=x.message}};
    document.getElementById('decline').onclick=async function(){var why=prompt('Ablehnen – möchtest du uns einen Grund nennen? (optional)');if(why===null)return;try{await post('/decline',{reason:why})}catch(x){err.textContent=x.message}};
  })();
  </script>`
        : '';
      const body = `<div class="wrap" style="max-width:820px"><div class="card contract">
  <div class="row" style="align-items:center;justify-content:space-between">
    <div>${loc.logo_url ? `<img src="${escapeHtml(loc.logo_url)}" alt="" style="max-height:44px">` : `<strong>${escapeHtml(loc.name)}</strong>`}</div>
    <div class="muted" style="text-align:right;font-size:13px">${escapeHtml(loc.name)}${loc.address ? `<br>${escapeHtml(loc.address)}` : ''}</div>
  </div>
  <h1 style="margin-top:24px">${escapeHtml(c.title)}</h1>
  <div class="doc">${contractHtml(c.content)}</div>
  <div style="margin-top:28px;border-top:1px solid var(--line);padding-top:16px">
    <p><strong>Unterzeichner</strong> <span class="muted" style="font-size:13px">${run?.mode === 'parallel' ? '(in beliebiger Reihenfolge)' : '(in dieser Reihenfolge)'}</span></p>
    <table style="width:100%;font-size:14px;border-collapse:collapse">${rows}</table>
    ${signatures ? `<div class="row" style="margin-top:18px;gap:18px;flex-wrap:wrap">${signatures}</div>` : ''}
    ${c.status === 'signed' ? `<p class="muted" style="font-size:12px;margin-top:14px;overflow-wrap:anywhere">Dokument-Prüfsumme (SHA-256): ${escapeHtml(c.content_hash ?? '')}</p><p class="noprint" style="margin-top:12px"><button onclick="print()">Als PDF speichern / drucken</button></p>` : ''}
    ${notice}
  </div>
  ${form}
</div></div>`;
      const head = `<style>.doc{font-size:15px}.doc h2{font-size:19px;margin-top:22px}.doc h3{font-size:16px}@media print{.noprint{display:none}.card{box-shadow:none;border:0}body{background:#fff}}</style><meta name="robots" content="noindex">`;
      return publicPage({ title: c.title, body, head, color: loc.settings?.branding?.color || undefined });
    }

    // --- DSGVO: a signer is not a contact record; their rows are exported by e-mail address. Signed contracts are business records
    // (kept like the contract itself), the rows of contracts that were never signed go. --------------------------------------------
    app.services.privacyErase = [
      ...(app.services.privacyErase ?? []),
      (_a: App, loc: string, contact: { id: string; email?: string }) => {
        const email = normalizeEmail(contact.email);
        if (!email) return;
        db.run(`DELETE FROM contract_signers WHERE location_id = ? AND email = ? AND contract_id IN (SELECT id FROM contracts WHERE status != 'signed')`, loc, email);
      },
    ];
    app.services.privacyExport = [
      ...(app.services.privacyExport ?? []),
      (_a: App, loc: string, contact: { id: string; email?: string }) => {
        const email = normalizeEmail(contact.email);
        if (!email) return {};
        const rows = db.all(
          `SELECT k.title, s.role, s.name, s.email, s.status, s.invited_at, s.viewed_at, s.signed_at, s.signed_name, s.ip, s.content_hash
           FROM contract_signers s JOIN contracts k ON k.id = s.contract_id WHERE s.location_id = ? AND s.email = ? ORDER BY s.created_at`,
          loc,
          email,
        );
        return rows.length ? { 'contract_signers (E-Mail)': rows } : {};
      },
    ];
  },
};
