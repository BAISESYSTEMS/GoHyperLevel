import type { Module } from '../core/app.js';
import type { Row } from '../core/db.js';
import { HttpError, bad, clampLimit, notFound, str, type Ctx } from '../core/http.js';
import { contactName, getContact } from '../services/contacts.js';
import { REASON_LABEL, findGroups, ignoreKey, pairReasons, type DupRow } from '../services/contact-dedupe.js';
import { MERGE_FIELDS, TABLE_LABEL, compareFields, countsFor, frozenInvoices, linkTables, mergeContacts, mergeParts, skipKidsOf } from '../services/contact-merge.js';
import { denyUnless, hiddenFieldsIn, maskRow, permits, resolve, scopeClause } from '../services/record-access.js';
import { tableEntity } from '../services/undo-table.js';
import type { Tool } from './mcp.js';

/**
 * Dubletten-Assistent für Kontakte (docs/sales.md): findet doppelte Kontakte (gleiche E-Mail, gleiche Telefonnummer in anderer
 * Schreibweise, gleicher Name bei derselben Firma, auch mit Tippfehlern), zeigt beide nebeneinander mit Feldauswahl und führt
 * sie zusammen – Aktivitäten, Deals, Aufgaben, Nachrichten und Konversationen wandern mit. Alles lässt sich über „Rückgängig“
 * zurückholen. Die Regeln stehen in services/contact-dedupe.ts (Erkennung) und contact-merge.ts (Zusammenführen).
 */

const TOOLS: Tool[] = [
  {
    name: 'ghl_contact_duplicates',
    title: 'Doppelte Kontakte finden',
    description: 'Listet Gruppen wahrscheinlich doppelter Kontakte (gleiche E-Mail, Telefonnummer oder Name + Firma) mit Vorschlag, welcher bleiben sollte. Nur lesen – zusammengeführt wird in der App (Vertrieb → Dubletten), dort lässt sich jedes Feld wählen und alles rückgängig machen.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium'], description: 'high = nur sichere (E-Mail/Telefon/Name+Firma)' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/contact-duplicates${a.confidence ? `?min=${a.confidence}` : ''}`, { location: a.location_id }),
  },
];

const SCAN_MAX = 50_000;

export const contactDuplicatesModule: Module = {
  name: 'contact-duplicates',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE contact_dupe_ignores (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, pair TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY (location_id, pair)
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    // --- undo: a merge is one entry that puts everything back ----------------------------------------------------------------
    const undo = app.services.undo as { register(type: string, e: any): void; track(rule: any): void } | undefined;
    if (undo) {
      const fields = Object.fromEntries([...MERGE_FIELDS, { key: 'tags', label: 'Tags' }, { key: 'custom', label: 'Eigene Felder' }, { key: 'dnd', label: 'Nicht stören' }].map((f) => [f.key, { label: f.label, ...(f.key === 'tags' ? { fmt: 'tags' } : f.key === 'custom' ? { fmt: 'json' } : f.key === 'dnd' ? { fmt: 'bool' } : {}) }]));
      undo.register(
        'contact_merge',
        tableEntity(app, {
          noun: 'Kontakt',
          plural: 'Kontakte',
          area: 'contacts',
          table: 'contacts',
          title: (r) => contactName(r as any),
          volatile: ['updated_at', 'last_activity_at'],
          keep: ['updated_at', 'last_activity_at'],
          fields: fields as any,
          skipKids: skipKidsOf(app),
          // The second contact carries every row that moved (to put it back by id); the kept one only what its merge changed besides.
          parts: (a, row, ctx) => mergeParts(a, row, ctx ? ctx.body?.from_id === row.id : true),
          // The note on the kept contact's timeline ("… zusammengeführt") goes when the merge is taken back.
          onRestore: (a, target) => {
            if (target) a.db.run(`DELETE FROM activities WHERE location_id = ? AND type = 'contact.merged' AND json_extract(data, '$.from.id') = ?`, String(target.row.location_id), target.id);
          },
        }),
      );
      undo.track({
        method: 'POST',
        pattern: '/api/contact-duplicates/merge',
        entity: 'contact_merge',
        targets: (ctx: Ctx) => [{ id: String(ctx.body?.keep_id ?? '') }, { id: String(ctx.body?.from_id ?? '') }],
        deep: true,
        action: (_b: unknown, a: unknown) => (a ? 'merge' : 'delete'),
        groupLabel: (_ctx: Ctx, rows: { label: string }[]) => `Kontakte zusammengeführt: ${rows.map((r) => r.label.replace(/^Kontakt „|“( zusammengeführt| gelöscht)?$/g, '')).join(' + ')}`,
      });
    }

    // --- finding ----------------------------------------------------------------------------------------------------------------
    const COLS = 'c.id, c.first_name, c.last_name, c.email, c.phone, c.company, c.address, c.city, c.postal_code, c.created_at, c.last_activity_at, c.assigned_to';
    const ignored = (loc: string) => new Set(db.all<{ pair: string }>('SELECT pair FROM contact_dupe_ignores WHERE location_id = ?', loc).map((r) => r.pair));

    const labelled = () => linkTables(app).move.filter((t) => TABLE_LABEL[t.table]);
    const brief = (loc: string, id: string, access: ReturnType<typeof resolve>) => {
      const c = getContact(app, loc, id);
      if (!c) return undefined;
      const counts: Record<string, number> = {};
      for (const t of labelled()) {
        const n = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${t.table}" WHERE contact_id = ?`, id)?.n ?? 0);
        if (n) counts[TABLE_LABEL[t.table]] = (counts[TABLE_LABEL[t.table]] ?? 0) + n;
      }
      const owner = c.assigned_to ? (db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', c.assigned_to)?.name ?? null) : null;
      return maskRow(access, 'contacts', { id: c.id, first_name: c.first_name, last_name: c.last_name, name: contactName(c), email: c.email, phone: c.phone, company: c.company, city: c.city, tags: c.tags, assigned_to: c.assigned_to, owner_name: owner, created_at: c.created_at, last_activity_at: (c as any).last_activity_at ?? null, counts });
    };

    router.get('/api/contact-duplicates', 'location', (ctx) => {
      const access = resolve(app, ctx);
      const scope = scopeClause(access, 'contacts', 'c');
      const rows = db.all<DupRow>(`SELECT ${COLS} FROM contacts c WHERE c.location_id = ?${scope ? ` AND ${scope.sql}` : ''} LIMIT ${SCAN_MAX + 1}`, ctx.locationId, ...(scope?.params ?? []));
      const capped = rows.length > SCAN_MAX;
      const min = ctx.query.get('min') === 'high' ? 'high' : undefined;
      const groups = findGroups(capped ? rows.slice(0, SCAN_MAX) : rows, { ignored: ignored(ctx.locationId), min });
      const limit = clampLimit(ctx.query.get('limit'), 50, 200);
      return {
        scanned: Math.min(rows.length, SCAN_MAX),
        capped,
        total: groups.length,
        reasons: REASON_LABEL,
        groups: groups.slice(0, limit).map((g) => ({ key: g.key, confidence: g.confidence, reasons: g.reasons, keep: g.keep, contacts: g.ids.map((id) => brief(ctx.locationId, id, access)).filter(Boolean) })),
      };
    });

    /** The duplicates of one contact (the banner on its page): cheap candidates by e-mail, number, company and last name. */
    router.get('/api/contact-duplicates/for', 'location', (ctx) => {
      const cid = str(ctx.query.get('contact_id'), 'Kontakt', { required: true, max: 64 });
      const c = getContact(app, ctx.locationId, cid);
      if (!c) throw notFound('Kontakt nicht gefunden');
      const access = resolve(app, ctx);
      const scope = scopeClause(access, 'contacts', 'c');
      const digits = String(c.phone ?? '').replace(/\D/g, '');
      const tail = digits.length >= 7 ? digits.slice(-7) : '';
      const clauses = [`(c.email != '' AND lower(c.email) = lower(?))`, `(c.company != '' AND lower(c.company) = lower(?))`, `(c.last_name != '' AND lower(c.last_name) = lower(?))`];
      const params: string[] = [c.email, c.company, c.last_name];
      if (tail) {
        clauses.push(`REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(c.phone, ' ', ''), '-', ''), '/', ''), '(', ''), ')', '') LIKE ?`);
        params.push(`%${tail}`);
      }
      const pool = db.all<DupRow>(`SELECT ${COLS} FROM contacts c WHERE c.location_id = ? AND c.id != ? AND (${clauses.join(' OR ')})${scope ? ` AND ${scope.sql}` : ''} LIMIT 200`, ctx.locationId, c.id, ...params, ...(scope?.params ?? []));
      const me = db.get<DupRow>(`SELECT ${COLS} FROM contacts c WHERE c.id = ?`, c.id)!;
      const skip = ignored(ctx.locationId);
      return pool
        .map((o) => ({ o, reasons: skip.has(ignoreKey(o.id, c.id)) ? [] : pairReasons(me, o) }))
        .filter((x) => x.reasons.length)
        .map((x) => ({ ...brief(ctx.locationId, x.o.id, access), reasons: x.reasons, reason_labels: x.reasons.map((r) => REASON_LABEL[r]) }));
    });

    // --- merge preview ---------------------------------------------------------------------------------------------------------
    const both = (ctx: Ctx, keepId: string, fromId: string) => {
      const access = resolve(app, ctx);
      denyUnless(permits(app, access, 'contacts', keepId) && permits(app, access, 'contacts', fromId));
      const keep = getContact(app, ctx.locationId, keepId);
      const from = getContact(app, ctx.locationId, fromId);
      if (!keep || !from) throw notFound('Kontakt nicht gefunden');
      if (keep.id === from.id) throw bad('Zweimal derselbe Kontakt');
      return { keep, from, access };
    };

    router.get('/api/contact-duplicates/preview', 'location', (ctx) => {
      const { keep, from, access } = both(ctx, str(ctx.query.get('keep_id'), 'Behalten', { required: true, max: 64 }), str(ctx.query.get('from_id'), 'Zusammenführen', { required: true, max: 64 }));
      const cmp = compareFields(keep, from);
      const hidden = (key: string) => hiddenFieldsIn(access, 'contacts', { [key]: 1 }).length > 0;
      const mask = (rows: typeof cmp.fields) => rows.map((r) => (hidden(r.key) ? { ...r, keep: '', from: '', differs: false, hidden: true } : r));
      const owner = (id: unknown) => (id ? (db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', id as string)?.name ?? '') : '');
      const frozen = frozenInvoices(app, from.id);
      const k = countsFor(app, keep.id);
      const f = countsFor(app, from.id);
      return {
        keep: brief(ctx.locationId, keep.id, access),
        from: brief(ctx.locationId, from.id, access),
        fields: mask(cmp.fields).map((r) => (r.key === 'assigned_to' ? { ...r, keep_label: owner(r.keep), from_label: owner(r.from) } : r)),
        custom: mask(cmp.custom),
        tags: cmp.tags,
        reasons: pairReasons(
          db.get<DupRow>(`SELECT ${COLS} FROM contacts c WHERE c.id = ?`, keep.id)!,
          db.get<DupRow>(`SELECT ${COLS} FROM contacts c WHERE c.id = ?`, from.id)!,
        ).map((r) => ({ key: r, label: REASON_LABEL[r] })),
        moves: Object.entries(f.labelled).map(([label, n]) => ({ label, from: n, keep: k.labelled[label] ?? 0 })),
        other_links: f.other,
        dropped: f.dropped,
        frozen_invoices: frozen,
        notes: [
          ...(from.dnd && !keep.dnd ? ['„Nicht stören“ des zweiten Kontakts gilt für den zusammengeführten.'] : []),
          ...(f.dropped ? [`${f.dropped} Einträge, die nur zum zweiten Kontakt gehören (z. B. Mitgliedschaften, Kurszugänge, Scores), fallen weg – „Rückgängig“ holt sie zurück.`] : []),
          ...(frozen ? [`${frozen} festgeschriebene ${frozen === 1 ? 'Rechnung verliert' : 'Rechnungen verlieren'} die Verknüpfung (Rollen tauschen behält sie).`] : []),
        ],
      };
    });

    router.post('/api/contact-duplicates/merge', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const { keep, from, access } = both(ctx, str(b.keep_id, 'Behalten', { required: true, max: 64 }), str(b.from_id, 'Zusammenführen', { required: true, max: 64 }));
      const picks = b.picks && typeof b.picks === 'object' ? (b.picks as Record<string, unknown>) : {};
      // A person who may not see a field cannot take it from one contact to the other.
      const blocked = hiddenFieldsIn(access, 'contacts', Object.fromEntries(Object.keys(picks).map((k) => [k, 1])));
      if (blocked.length) throw new HttpError(403, `Das Feld „${blocked[0]}“ ist für dich ausgeblendet – du kannst es nicht ändern`);
      const r = mergeContacts(app, ctx.locationId, { keepId: keep.id, fromId: from.id, picks, userId: ctx.user?.id ?? null, confirmDetach: b.confirm_detach === true });
      return { contact: maskRow(access, 'contacts', r.contact as unknown as Row), moved: r.moved, other_links: r.other, dropped: r.dropped, detached_invoices: r.detached };
    });

    // --- "not the same person" ---------------------------------------------------------------------------------------------------------
    router.post('/api/contact-duplicates/ignore', 'location', (ctx) => {
      const ids: string[] = [...new Set<string>((Array.isArray(ctx.body?.contact_ids) ? ctx.body.contact_ids : []).map(String))].slice(0, 20);
      if (ids.length < 2) throw bad('Mindestens zwei Kontakte angeben');
      const access = resolve(app, ctx);
      for (const id of ids) {
        if (!getContact(app, ctx.locationId, id)) throw notFound('Kontakt nicht gefunden');
        denyUnless(permits(app, access, 'contacts', id));
      }
      let n = 0;
      db.tx(() => {
        for (let i = 0; i < ids.length; i++)
          for (let j = i + 1; j < ids.length; j++) n += db.run('INSERT OR IGNORE INTO contact_dupe_ignores (location_id, pair, created_by, created_at) VALUES (?, ?, ?, ?)', ctx.locationId, ignoreKey(ids[i], ids[j]), ctx.user?.id ?? null, new Date().toISOString()).changes;
      });
      return { ok: true, pairs: n };
    });
    router.post('/api/contact-duplicates/unignore', 'location', (ctx) => {
      const ids: string[] = [...new Set<string>((Array.isArray(ctx.body?.contact_ids) ? ctx.body.contact_ids : []).map(String))].slice(0, 20);
      let n = 0;
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) n += db.run('DELETE FROM contact_dupe_ignores WHERE location_id = ? AND pair = ?', ctx.locationId, ignoreKey(ids[i], ids[j])).changes;
      return { ok: true, pairs: n };
    });
  },
};
