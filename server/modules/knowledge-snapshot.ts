import type { App, Module } from '../core/app.js';
import { parseRows } from '../core/db.js';
import { id, now, slugify } from '../core/util.js';
import type { SnapshotData, SnapshotPart } from '../services/snapshots.js';
import { MODES } from '../services/agent-safety.js';
import { markdownToText } from '../services/wiki-markdown.js';
import { indexPage, type PageRow } from '../services/wiki-store.js';

/**
 * Wissens-Snapshot: what a sub-account has learned travels with its snapshot, so a new market or brand (e.g. a shop
 * going international under another domain) starts with the know-how instead of from zero (docs/api.md, Snapshots; docs/handbook.md, chapter 12).
 *
 *   knowledge_agents     – the sub-account's AI agents: instructions, tools, knowledge text, starter prompts. What
 *                          belongs to one installation stays behind: AI connection, schedules, channel replies.
 *   knowledge_memory     – what those agents remembered (agent memory) and the sub-account's remembered notes
 *                          (ghl_memory_remember). Personal notes of the default assistant stay behind.
 *   knowledge_wiki       – wiki spaces and pages (tree kept, trash left out).
 *   knowledge_kb         – help-centre categories and articles, copied as drafts.
 *   knowledge_learnings  – one generated page "Learnings": best subject lines (human opens only), lead sources and channels by numbers.
 *
 * The parts are only in a snapshot made with "Wissen mitnehmen" (`include_knowledge`, see KNOWLEDGE_KEYS); a single
 * website or course copy never takes them. On applying, `translateKnowledge` can translate every text into the new
 * market's language first.
 */

export const KNOWLEDGE_KEYS = ['knowledge_agents', 'knowledge_memory', 'knowledge_wiki', 'knowledge_kb', 'knowledge_learnings'] as const;

const MAX = { agents: 50, memory: 2000, spaces: 50, pages: 2000, categories: 200, articles: 1000 };

const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return (v as T) ?? fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
const s = (v: unknown, max: number) => String(v ?? '').slice(0, max);

/** The location's first admin – owner of copied agents (an agent needs an owner; it is shared with the whole sub-account). */
const ownerFor = (app: App, locationId: string): string | null =>
  app.db.get<{ id: string }>("SELECT id FROM users WHERE role = 'admin' ORDER BY rowid LIMIT 1")?.id ??
  app.db.all<{ id: string; locations: string }>('SELECT id, locations FROM users ORDER BY rowid').find((u) => json<string[]>(u.locations, []).includes(locationId))?.id ??
  null;

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const euro = (cents: number) => `${Math.round(cents / 100).toLocaleString('de-DE')} €`;

/** The "Learnings" page: what worked, by numbers – read by people and by agents (wiki is agent knowledge). */
export function learningsMarkdown(app: App, locationId: string): string {
  const db = app.db;
  const loc = app.location(locationId);
  const lines: string[] = [`Stand ${new Date().toISOString().slice(0, 10)} · aus „${loc?.name ?? 'Sub-Account'}“. Erzeugt beim Erstellen des Snapshots – Zahlen, keine Meinungen.`, ''];

  const camps = db.all<{ id: string; name: string; subject: string; sent: number; opened: number; clicked: number }>(
    `SELECT c.id, c.name, c.subject,
       (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'sent') AS sent,
       (SELECT COUNT(*) FROM campaign_recipients r JOIN messages m ON m.id = r.message_id WHERE r.campaign_id = c.id AND m.opened_at IS NOT NULL) AS opened,
       (SELECT COUNT(*) FROM campaign_recipients r JOIN messages m ON m.id = r.message_id WHERE r.campaign_id = c.id AND m.clicked_at IS NOT NULL) AS clicked
     FROM campaigns c WHERE c.location_id = ? AND c.channel = 'email' AND c.status IN ('sent', 'sending')`,
    locationId,
  ).filter((c) => c.sent >= 20);
  lines.push('## E-Mail: Betreffzeilen, die geöffnet wurden', '');
  if (camps.length) {
    const top = [...camps].sort((a, b) => b.opened / b.sent - a.opened / a.sent).slice(0, 5);
    const avg = pct(camps.reduce((n, c) => n + c.opened, 0), camps.reduce((n, c) => n + c.sent, 0));
    lines.push(`Durchschnittliche Öffnungsrate: ${avg} % über ${camps.length} Kampagnen.`, '', '| Betreff | Gesendet | Geöffnet | Geklickt |', '|---|---|---|---|');
    for (const c of top) lines.push(`| ${(c.subject || c.name).replace(/\|/g, '/')} | ${c.sent} | ${pct(c.opened, c.sent)} % | ${pct(c.clicked, c.sent)} % |`);
  } else lines.push('Noch keine E-Mail-Kampagne mit mindestens 20 Empfängern.');
  lines.push('');

  const sources = db.all<{ source: string; n: number; won: number; won_value: number }>(
    `SELECT COALESCE(NULLIF(c.source, ''), 'unbekannt') AS source, COUNT(DISTINCT c.id) AS n,
       COUNT(DISTINCT CASE WHEN o.status = 'won' THEN o.id END) AS won, COALESCE(SUM(CASE WHEN o.status = 'won' THEN o.value END), 0) AS won_value
     FROM contacts c LEFT JOIN opportunities o ON o.contact_id = c.id WHERE c.location_id = ? GROUP BY 1 ORDER BY won_value DESC, n DESC LIMIT 8`,
    locationId,
  );
  lines.push('## Lead-Quellen: woher die Kunden kommen', '');
  if (sources.length) {
    lines.push('| Quelle | Kontakte | Gewonnene Deals | Gewonnener Umsatz |', '|---|---|---|---|');
    for (const r of sources) lines.push(`| ${r.source.replace(/\|/g, '/')} | ${r.n} | ${r.won} | ${euro(r.won_value)} |`);
  } else lines.push('Noch keine Kontakte.');
  lines.push('');

  const channels = db.all<{ channel: string; inbound: number; outbound: number }>(
    `SELECT channel, SUM(direction = 'in') AS inbound, SUM(direction = 'out') AS outbound FROM messages
     WHERE location_id = ? AND created_at >= ? GROUP BY channel ORDER BY inbound DESC LIMIT 8`,
    locationId,
    new Date(Date.now() - 180 * 864e5).toISOString(),
  );
  lines.push('## Kanäle: wo Kunden antworten (letzte 180 Tage)', '');
  if (channels.length) {
    lines.push('| Kanal | Eingehend | Ausgehend | Antwortquote |', '|---|---|---|---|');
    for (const c of channels) lines.push(`| ${c.channel} | ${c.inbound} | ${c.outbound} | ${c.outbound ? `${pct(c.inbound, c.outbound)} %` : '–'} |`);
  } else lines.push('Noch keine Nachrichten.');
  lines.push('', '## Für Agenten', '', 'Nutze diese Zahlen als Startwerte im neuen Markt: übernimm die Muster der besten Betreffzeilen und Kanäle, prüfe sie dort neu und ersetze diese Seite, sobald eigene Zahlen da sind.');
  return lines.join('\n');
}

/** Makes a wiki page (indexed for search) – the snapshot copy has no request, so the wiki store's createPage does not fit. */
function insertPage(app: App, locationId: string, spaceId: string, parentId: string | null, p: { title: string; icon?: string; body: string; position?: number }): string {
  const page: PageRow = {
    id: id(),
    location_id: locationId,
    space_id: spaceId,
    parent_id: parentId,
    position: Number(p.position) || 0,
    title: s(p.title, 200) || 'Seite',
    icon: s(p.icon, 16),
    body: s(p.body, 500_000),
    text: markdownToText(s(p.body, 500_000)),
    version: 1,
    trashed_at: null,
    kb_article_id: null,
    kb_version: null,
    created_by: null,
    created_by_name: 'Snapshot',
    updated_by: null,
    updated_by_name: 'Snapshot',
    created_at: now(),
    updated_at: now(),
  } as PageRow;
  app.db.insert('wiki_pages', page as unknown as Record<string, unknown>);
  indexPage(app, page);
  return page.id;
}

function insertSpace(app: App, locationId: string, sp: { name: string; icon?: string; description?: string; team_access?: string; position?: number }): string {
  const row = { id: id(), location_id: locationId, name: s(sp.name, 120) || 'Wissen', icon: s(sp.icon, 16), description: s(sp.description, 2000), team_access: ['edit', 'view', 'none'].includes(String(sp.team_access)) ? sp.team_access : 'edit', owner_id: null, owner_name: '', position: Number(sp.position) || 0, created_at: now(), updated_at: now() };
  app.db.insert('wiki_spaces', row);
  return row.id;
}

export function knowledgeParts(app: App): SnapshotPart[] {
  const db = app.db;
  const has = (table: string) => !!db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table);

  const agents: SnapshotPart = {
    key: 'knowledge_agents',
    export: (_a, loc, only) =>
      only || !has('agents')
        ? []
        : db
            .all('SELECT * FROM agents WHERE location_id = ? ORDER BY name LIMIT ?', loc, MAX.agents)
            .map((a) => ({ id: a.id, name: a.name, emoji: a.emoji, color: a.color, description: a.description, instructions: a.instructions, model: a.model, tools: json(a.tools, null), mode: a.mode, confirm_sensitive: a.confirm_sensitive, knowledge: json(a.knowledge, {}), starters: json(a.starters, []), web_fetch: a.web_fetch, max_steps: a.max_steps, memory: a.memory, template: a.template })),
    prepare: (_a, items, maps) => {
      maps.agents = new Map(items.map((a) => [String(a.id), id()]));
    },
    apply: (_a, loc, items, c) => {
      const owner = ownerFor(app, loc);
      if (!owner || !has('agents')) return void (c.created.knowledge_agents = 0);
      let n = 0;
      for (const a of items.slice(0, MAX.agents)) {
        const k = a.knowledge && typeof a.knowledge === 'object' ? a.knowledge : {};
        db.insert('agents', {
          id: c.maps.agents?.get(String(a.id)) ?? id(),
          location_id: loc,
          owner_id: owner,
          name: s(a.name, 80) || 'Agent',
          emoji: s(a.emoji, 16) || '🤖',
          color: s(a.color, 20),
          description: s(a.description, 500),
          instructions: s(a.instructions, 30_000),
          connection_id: '',
          model: s(a.model, 80),
          tools: a.tools == null ? null : JSON.stringify(a.tools),
          mode: MODES.includes(a.mode) ? a.mode : 'ask',
          confirm_sensitive: a.confirm_sensitive === 0 ? 0 : 1,
          knowledge: JSON.stringify({ sources: Array.isArray(k.sources) ? k.sources : [], text: s(k.text, 30_000) }),
          starters: JSON.stringify(Array.isArray(a.starters) ? a.starters.slice(0, 8).map((x: unknown) => s(x, 200)) : []),
          visibility: 'location',
          web_fetch: a.web_fetch ? 1 : 0,
          max_steps: Math.min(50, Math.max(1, Number(a.max_steps) || 12)),
          memory: a.memory === 0 ? 0 : 1,
          responder: '{}',
          schedules: '[]',
          schedule_state: '{}',
          template: s(a.template, 80),
          created_at: now(),
          updated_at: now(),
        });
        n++;
      }
      c.created.knowledge_agents = n;
    },
  };

  const memory: SnapshotPart = {
    key: 'knowledge_memory',
    export: (_a, loc, only) => {
      if (only) return [];
      const out: Record<string, any>[] = [];
      if (has('agents') && has('agent_memory'))
        for (const m of db.all("SELECT m.agent_key, m.text FROM agent_memory m JOIN agents a ON a.id = m.agent_key AND a.location_id = m.location_id WHERE m.location_id = ? ORDER BY m.created_at LIMIT ?", loc, MAX.memory))
          out.push({ agent_id: m.agent_key, text: m.text });
      if (has('cognee_memories')) for (const m of db.all('SELECT text FROM cognee_memories WHERE location_id = ? ORDER BY created_at LIMIT ?', loc, MAX.memory)) out.push({ text: m.text });
      return out;
    },
    apply: (_a, loc, items, c) => {
      let n = 0;
      for (const m of items.slice(0, MAX.memory * 2)) {
        const text = s(m.text, 4000).trim();
        if (!text) continue;
        if (m.agent_id) {
          const agent = c.maps.agents?.get(String(m.agent_id));
          if (!agent || !has('agent_memory')) continue;
          db.insert('agent_memory', { id: id(), location_id: loc, agent_key: agent, text, created_by: null, created_at: now() });
        } else {
          if (!has('cognee_memories')) continue;
          db.insert('cognee_memories', { id: id(), location_id: loc, text, created_by: null, created_by_name: 'Snapshot', created_at: now(), updated_at: now() });
        }
        n++;
      }
      c.created.knowledge_memory = n;
    },
  };

  const wiki: SnapshotPart = {
    key: 'knowledge_wiki',
    export: (_a, loc, only) => {
      if (only || !has('wiki_spaces')) return [];
      const spaces = db.all('SELECT * FROM wiki_spaces WHERE location_id = ? ORDER BY position LIMIT ?', loc, MAX.spaces);
      let left = MAX.pages;
      return spaces.map((sp) => {
        const pages = db.all('SELECT id, parent_id, position, title, icon, body FROM wiki_pages WHERE space_id = ? AND trashed_at IS NULL ORDER BY position LIMIT ?', sp.id, Math.max(0, left));
        left -= pages.length;
        return { name: sp.name, icon: sp.icon, description: sp.description, team_access: sp.team_access, position: sp.position, pages };
      });
    },
    apply: (_a, loc, items, c) => {
      let n = 0;
      for (const sp of items.slice(0, MAX.spaces)) {
        const spaceId = insertSpace(app, loc, sp as any);
        const pages: any[] = Array.isArray(sp.pages) ? sp.pages : [];
        const newIds = new Map<string, string>();
        // parents before children: a page whose parent is not copied yet waits for the next round (12 levels at most)
        let rest = pages;
        for (let round = 0; round < 13 && rest.length; round++) {
          const next: any[] = [];
          for (const p of rest) {
            if (p.parent_id && !newIds.has(p.parent_id) && pages.some((x) => x.id === p.parent_id)) next.push(p);
            else {
              newIds.set(p.id, insertPage(app, loc, spaceId, p.parent_id ? (newIds.get(p.parent_id) ?? null) : null, p));
              n++;
            }
          }
          rest = next;
        }
      }
      c.created.knowledge_wiki = n;
    },
  };

  const kb: SnapshotPart = {
    key: 'knowledge_kb',
    export: (_a, loc, only) => {
      if (only || !has('kb_articles')) return [];
      const cats = db.all('SELECT id, name, slug, description, position FROM kb_categories WHERE location_id = ? ORDER BY position LIMIT ?', loc, MAX.categories);
      const arts = parseRows(db.all('SELECT category_id, title, slug, body, excerpt, tags, position FROM kb_articles WHERE location_id = ? ORDER BY position LIMIT ?', loc, MAX.articles), ['tags']);
      return [...cats.map((x) => ({ type: 'category', ...x })), ...arts.map((x) => ({ type: 'article', ...x }))];
    },
    apply: (_a, loc, items, c) => {
      const cats = new Map<string, string>();
      const slug = (table: 'kb_categories' | 'kb_articles', base: string) => {
        const first = slugify(base) || 'artikel';
        for (let i = 1; ; i++) {
          const cand = i === 1 ? first : `${first}-${i}`;
          if (!db.get(`SELECT id FROM ${table} WHERE location_id = ? AND slug = ?`, loc, cand)) return cand;
        }
      };
      let n = 0;
      for (const x of items.filter((i) => i.type === 'category').slice(0, MAX.categories)) {
        const row = { id: id(), location_id: loc, name: s(x.name, 120) || 'Kategorie', slug: slug('kb_categories', x.slug || x.name), description: s(x.description, 2000), position: Number(x.position) || 0, created_at: now(), updated_at: now() };
        db.insert('kb_categories', row);
        cats.set(String(x.id), row.id);
      }
      for (const x of items.filter((i) => i.type === 'article').slice(0, MAX.articles)) {
        // drafts: a copied help centre is checked before it goes public under the new brand
        db.insert('kb_articles', { id: id(), location_id: loc, category_id: cats.get(String(x.category_id)) ?? null, title: s(x.title, 200) || 'Artikel', slug: slug('kb_articles', x.slug || x.title), body: s(x.body, 200_000), excerpt: s(x.excerpt, 500), status: 'draft', tags: JSON.stringify(Array.isArray(x.tags) ? x.tags : []), seo: '{}', position: Number(x.position) || 0, created_at: now(), updated_at: now() });
        n++;
      }
      c.created.knowledge_kb = n;
    },
  };

  const learnings: SnapshotPart = {
    key: 'knowledge_learnings',
    export: (_a, loc, only) => (only ? [] : [{ title: 'Learnings', icon: '📈', body: learningsMarkdown(app, loc) }]),
    apply: (_a, loc, items, c) => {
      if (!items.length || !has('wiki_spaces')) return void (c.created.knowledge_learnings = 0);
      const spaceId = insertSpace(app, loc, { name: 'Learnings', icon: '📈', description: 'Was im Ursprungs-Sub-Account funktioniert hat – Startwerte für diesen Markt.' });
      for (const p of items.slice(0, 20)) insertPage(app, loc, spaceId, null, p as any);
      c.created.knowledge_learnings = Math.min(items.length, 20);
    },
  };

  return [agents, memory, wiki, kb, learnings];
}

/** Counts for the snapshot list ("3 Agenten · 40 Wiki-Seiten …"). */
export function knowledgeSummary(d: SnapshotData) {
  const len = (k: string) => (Array.isArray(d[k]) ? (d[k] as unknown[]).length : 0);
  const wikiPages = Array.isArray(d.knowledge_wiki) ? (d.knowledge_wiki as any[]).reduce((n, sp) => n + (Array.isArray(sp.pages) ? sp.pages.length : 0), 0) : 0;
  const kbArticles = Array.isArray(d.knowledge_kb) ? (d.knowledge_kb as any[]).filter((x) => x.type === 'article').length : 0;
  return { agents: len('knowledge_agents'), memories: len('knowledge_memory'), wiki_pages: wikiPages, kb_articles: kbArticles, learnings: len('knowledge_learnings') };
}

/** Leaves only the building blocks in a snapshot (default: knowledge is opt-in, a snapshot is often handed to clients). */
export function withoutKnowledge(d: SnapshotData): SnapshotData {
  for (const k of KNOWLEDGE_KEYS) delete d[k];
  return d;
}

/** Every text of the knowledge parts, as [get, set] pairs – the translator reads and writes through them. */
function knowledgeTexts(d: SnapshotData): [() => string, (v: string) => void][] {
  const out: [() => string, (v: string) => void][] = [];
  const field = (o: any, k: string) => {
    if (o && typeof o[k] === 'string' && o[k].trim()) out.push([() => o[k], (v) => (o[k] = v)]);
  };
  for (const a of (d.knowledge_agents as any[]) ?? []) {
    ['description', 'instructions'].forEach((k) => field(a, k));
    if (a.knowledge) field(a.knowledge, 'text');
    if (Array.isArray(a.starters)) a.starters.forEach((_: unknown, i: number) => field(a.starters, String(i)));
  }
  for (const m of (d.knowledge_memory as any[]) ?? []) field(m, 'text');
  for (const sp of (d.knowledge_wiki as any[]) ?? []) {
    ['name', 'description'].forEach((k) => field(sp, k));
    for (const p of sp.pages ?? []) ['title', 'body'].forEach((k) => field(p, k));
  }
  for (const x of (d.knowledge_kb as any[]) ?? []) ['name', 'description', 'title', 'excerpt', 'body'].forEach((k) => field(x, k));
  for (const p of (d.knowledge_learnings as any[]) ?? []) ['title', 'body'].forEach((k) => field(p, k));
  return out;
}

const TRANSLATE_SCHEMA = { type: 'object', properties: { texts: { type: 'array', items: { type: 'string' } } }, required: ['texts'], additionalProperties: false };

/**
 * Translates the knowledge of a snapshot into `language` (and adapts it to that market: currency formats, salutations,
 * holidays …) with the sub-account's AI assistant, in batches of about 12,000 characters. Names, links, tags, code and
 * {{placeholders}} stay as they are. Returns how many texts were translated; throws when the assistant is not set up.
 */
export async function translateKnowledge(app: App, d: SnapshotData, locationId: string, language: string, userId: string | null): Promise<number> {
  if (!app.services.aiRun) throw new Error('Der KI-Assistent ist auf diesem Server nicht verfügbar');
  const why: string | null = app.services.aiReady?.(locationId) ?? null;
  if (why) throw new Error(`${why} (Einstellungen → KI-Assistent)`);
  const texts = knowledgeTexts(d);
  const batches: (typeof texts)[] = [];
  let cur: typeof texts = [];
  let size = 0;
  for (const t of texts) {
    const n = t[0]().length;
    if (cur.length && size + n > 12_000) (batches.push(cur), (cur = []), (size = 0));
    cur.push(t);
    size += n;
  }
  if (cur.length) batches.push(cur);
  let done = 0;
  for (const batch of batches) {
    const r = await app.services.aiRun({
      locationId,
      purpose: 'snapshot_translate',
      userId,
      system: [{ text: `Du übersetzt das Wissen eines Unternehmens (Anweisungen für KI-Agenten, Notizen, Wiki- und Hilfe-Artikel) ins ${language} und passt es an diesen Markt an (Anrede, Datums- und Zahlenformate, Feiertage). Namen, Marken, Links, E-Mail-Adressen, Tags, Code und Platzhalter wie {{contact.first_name}} bleiben unverändert, Markdown bleibt erhalten. Gib genau so viele Texte in derselben Reihenfolge zurück.` }],
      user: JSON.stringify({ texts: batch.map(([get]) => get()) }),
      schema: TRANSLATE_SCHEMA,
      maxTokens: 16_000,
      timeoutMs: 180_000,
    });
    let outTexts: unknown;
    try {
      outTexts = JSON.parse(String(r.text ?? '').replace(/^```(json)?|```$/g, '').trim()).texts;
    } catch {
      throw new Error('Die Übersetzung kam nicht im erwarteten Format zurück – nichts wurde angewendet');
    }
    if (!Array.isArray(outTexts) || outTexts.length !== batch.length) throw new Error('Die Übersetzung war unvollständig – nichts wurde angewendet');
    batch.forEach(([, set], i) => set(String(outTexts[i] ?? '')));
    done += batch.length;
  }
  return done;
}

export const knowledgeSnapshotModule: Module = {
  name: 'knowledge-snapshot',
  register(app) {
    app.services.snapshotParts = [...(app.services.snapshotParts ?? []), ...knowledgeParts(app)];
  },
};
