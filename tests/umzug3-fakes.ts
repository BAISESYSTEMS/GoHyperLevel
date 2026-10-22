import { FakeVendor, json, type Req } from './umzug-fakes.js';

/**
 * In-memory copies of the public APIs of the project / documents / table tools (monday.com, ClickUp, Notion, Airtable) – only what
 * the Umzug importers call, with the payload shapes the real APIs use. Pages are tiny (pageCap) so pagination is exercised.
 */

// ---------------------------------------------------------------------------------------------------------------
// monday.com (GraphQL)
// ---------------------------------------------------------------------------------------------------------------

export const MONDAY_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.fake-monday-token.sig123';

const statusSettings = (labels: Record<string, string>, done: number[], colors: Record<string, string> = {}) => JSON.stringify({ labels, done_colors: done, labels_colors: Object.fromEntries(Object.entries(colors).map(([k, c]) => [k, { color: c }])) });
const cvs = (o: Record<string, [string, string | null, any?]>) => Object.entries(o).map(([id, [type, text, value]]) => ({ id, type, text, value: value === undefined ? null : JSON.stringify(value) }));

export class FakeMonday extends FakeVendor {
  pageCap = 2;
  /** Answer the next N GraphQL calls with a complexity-budget error (HTTP 200). */
  soft = 0;
  daily = false;
  boards: any[] = [
    {
      id: '1001',
      name: 'Website-Relaunch',
      description: 'Neue Firmenseite',
      type: 'board',
      items_count: 3,
      groups: [
        { id: 'g1', title: 'Planung' },
        { id: 'g2', title: 'Umsetzung' },
      ],
      columns: [
        { id: 'name', title: 'Name', type: 'name', settings_str: '{}' },
        { id: 'status', title: 'Status', type: 'status', settings_str: statusSettings({ '0': 'Working on it', '1': 'Done', '2': 'Stuck', '5': 'Bald' }, [1], { '0': '#fdab3d', '1': '#00c875', '2': '#e2445c' }) },
        { id: 'prio', title: 'Priorität', type: 'status', settings_str: statusSettings({ '0': 'Critical', '1': 'High', '2': 'Low' }, []) },
        { id: 'person', title: 'Zuständig', type: 'people', settings_str: '{}' },
        { id: 'due', title: 'Fällig', type: 'date', settings_str: '{}' },
        { id: 'zeit', title: 'Zeitplan', type: 'timeline', settings_str: '{}' },
        { id: 'kunde', title: 'Kunde', type: 'text', settings_str: '{}' },
        { id: 'budget', title: 'Budget', type: 'numbers', settings_str: '{}' },
        { id: 'desc', title: 'Beschreibung', type: 'long_text', settings_str: '{}' },
        { id: 'brief', title: 'Briefing', type: 'link', settings_str: '{}' },
        { id: 'ok', title: 'Freigegeben', type: 'checkbox', settings_str: '{}' },
        { id: 'art', title: 'Art', type: 'status', settings_str: statusSettings({ '0': 'Intern', '1': 'Kunde' }, []) },
        { id: 'datei', title: 'Dateien', type: 'file', settings_str: '{}' },
        { id: 'subs', title: 'Subitems', type: 'subtasks', settings_str: '{}' },
        { id: 'zeitlog', title: 'Zeiterfassung', type: 'time_tracking', settings_str: '{}' },
      ],
    },
    { id: '1002', name: 'Content-Kalender', description: '', type: 'board', items_count: 1, groups: [{ id: 'topics', title: 'Themen' }], columns: [{ id: 'name', title: 'Name', type: 'name', settings_str: '{}' }] },
    { id: '1003', name: 'Subitems of Website-Relaunch', description: '', type: 'sub_items_board', items_count: 4, groups: [], columns: [] },
    { id: '1004', name: 'Wissen', description: '', type: 'document', items_count: 0, groups: [], columns: [] },
  ];
  users = [
    { id: '77', name: 'Anna Alt', email: 'anna@example.com' },
    { id: '78', name: 'Ben Fremd', email: 'ben@elsewhere.example' },
  ];
  items: Record<string, any[]> = {
    '1001': [
      {
        id: '9001',
        name: 'Startseite gestalten',
        created_at: '2024-02-01T09:00:00Z',
        group: { id: 'g1' },
        column_values: cvs({
          status: ['status', 'Working on it', { index: 0 }],
          prio: ['status', 'High'],
          person: ['people', 'Anna Alt, Ben Fremd', { personsAndTeams: [{ id: 77, kind: 'person' }, { id: 78, kind: 'person' }] }],
          due: ['date', '2024-06-30', { date: '2024-06-30' }],
          zeit: ['timeline', '2024-06-01 - 2024-06-15', { from: '2024-06-01', to: '2024-06-15' }],
          kunde: ['text', 'Muster GmbH'],
          budget: ['numbers', '1200'],
          desc: ['long_text', 'Entwurf und Abstimmung mit dem Kunden'],
          brief: ['link', 'https://muster.example.com/briefing https://muster.example.com/briefing', { url: 'https://muster.example.com/briefing', text: 'Briefing' }],
          ok: ['checkbox', 'v', { checked: 'true' }],
          art: ['status', 'Kunde'],
          datei: ['file', 'logo.png'],
        }),
        subitems: [
          { id: '9101', name: 'Moodboard', created_at: '2024-02-02T09:00:00Z', column_values: cvs({ status: ['status', 'Done'], date: ['date', '2024-06-05'], person: ['people', 'Anna Alt', { personsAndTeams: [{ id: 77, kind: 'person' }] }] }) },
          { id: '9102', name: 'Farben', created_at: '2024-02-02T10:00:00Z', column_values: cvs({ status: ['status', 'Working on it'] }) },
        ],
        updates: [
          { id: 'u1', text_body: 'Erster Entwurf ist da', created_at: '2024-02-10T10:00:00Z', creator: { name: 'Anna Alt' }, replies: [{ id: 'r1', text_body: 'Sieht gut aus', created_at: '2024-02-10T11:00:00Z', creator: { name: 'Ben Fremd' } }] },
        ],
      },
      {
        id: '9002',
        name: 'Texte schreiben',
        created_at: '2024-02-03T09:00:00Z',
        group: { id: 'g2' },
        column_values: cvs({ status: ['status', 'Done', { index: 1 }], prio: ['status', 'Critical'], budget: ['numbers', '800,5'], kunde: ['text', ''] }),
        subitems: [],
        updates: [],
      },
      { id: '9003', name: 'Launch planen', created_at: '2024-02-04T09:00:00Z', group: { id: 'g2' }, column_values: cvs({ status: ['status', null], due: ['date', '2024-07-01', { date: '2024-07-01' }], zeit: ['timeline', '2024-07-10 - 2024-07-05', { from: '2024-07-10', to: '2024-07-05' }] }), subitems: [], updates: [] },
    ],
    '1002': [{ id: '9010', name: 'Blogartikel Juni', created_at: '2024-03-01T09:00:00Z', group: { id: 'topics' }, column_values: [], subitems: [], updates: [] }],
  };
  docs = [
    { id: '5001', object_id: '60001', name: 'Handbuch', created_at: '2024-01-10' },
    { id: '5002', object_id: '60002', name: 'Leer', created_at: '2024-01-11' },
  ];
  blocks: Record<string, any[]> = {
    '5001': [
      { id: 'b1', type: 'large title', position: 1, parent_block_id: null, content: JSON.stringify({ deltaFormat: [{ insert: 'Willkommen' }] }) },
      { id: 'b2', type: 'normal text', position: 2, parent_block_id: null, content: JSON.stringify({ deltaFormat: [{ insert: 'Das ist ' }, { insert: 'wichtig', attributes: { bold: true } }, { insert: ' – siehe ' }, { insert: 'Doku', attributes: { link: 'https://muster.example.com/doku' } }] }) },
      { id: 'b3', type: 'bulleted list', position: 3, parent_block_id: null, content: JSON.stringify({ deltaFormat: [{ insert: 'Erstens' }] }) },
      { id: 'b4', type: 'bulleted list', position: 4, parent_block_id: null, content: JSON.stringify({ deltaFormat: [{ insert: 'Zweitens' }] }) },
      { id: 'b5', type: 'check list', position: 5, parent_block_id: null, content: JSON.stringify({ deltaFormat: [{ insert: 'Erledigt' }], checked: true }) },
      { id: 'b6', type: 'divider', position: 6, parent_block_id: null, content: '{}' },
      { id: 'b7', type: 'table', position: 7, parent_block_id: null, content: JSON.stringify({ cells: [[{ blockId: 'c1' }, { blockId: 'c2' }], [{ blockId: 'c3' }, { blockId: 'c4' }]] }) },
      { id: 'c1', type: 'normal text', position: 8, parent_block_id: 'b7', content: JSON.stringify({ deltaFormat: [{ insert: 'Name' }] }) },
      { id: 'c2', type: 'normal text', position: 9, parent_block_id: 'b7', content: JSON.stringify({ deltaFormat: [{ insert: 'Rolle' }] }) },
      { id: 'c3', type: 'normal text', position: 10, parent_block_id: 'b7', content: JSON.stringify({ deltaFormat: [{ insert: 'Anna' }] }) },
      { id: 'c4', type: 'normal text', position: 11, parent_block_id: 'b7', content: JSON.stringify({ deltaFormat: [{ insert: 'Chefin' }] }) },
      { id: 'b8', type: 'image', position: 12, parent_block_id: null, content: JSON.stringify({ url: 'https://files.monday.com/x/logo.png' }) },
    ],
    '5002': [],
  };

  authOk(r: Req) {
    return r.headers.authorization === MONDAY_TOKEN && !!r.headers['api-version'];
  }

  private ok(data: unknown) {
    return json(200, { data, account_id: 1 });
  }

  handle(r: Req): Response | undefined {
    if (r.method !== 'POST' || r.path !== '/v2') return undefined;
    const q: string = r.body?.query ?? '';
    const v = r.body?.variables ?? {};
    if (this.daily) return json(200, { errors: [{ message: 'Daily limit exceeded', extensions: { code: 'DAILY_LIMIT_EXCEEDED', retry_in_seconds: 40_000 } }] });
    if (this.soft > 0) {
      this.soft--;
      return json(200, { errors: [{ message: 'Complexity budget exhausted, query cost 5002 exceeds remaining budget 12. Remaining reset in 3 seconds', extensions: { code: 'COMPLEXITY_BUDGET_EXHAUSTED', retry_in_seconds: 3 } }] });
    }
    if (/\bme\s*\{/.test(q)) return this.ok({ me: { id: '1', name: 'Chef', email: 'chef@muster.example.com', account: { id: '555', name: 'Muster GmbH', slug: 'muster' } } });
    if (/users\(/.test(q)) {
      const page = Number(v.page ?? 1);
      return this.ok({ users: this.users.slice((page - 1) * this.pageCap, page * this.pageCap) });
    }
    if (/next_items_page/.test(q)) {
      const m = /^c(\d+):(\d+)$/.exec(String(v.cursor));
      if (!m) return json(200, { errors: [{ message: 'Invalid cursor', extensions: { code: 'InvalidCursorException' } }] });
      return this.ok({ next_items_page: this.itemsPage(m[1], Number(m[2]), Number(v.limit), q) });
    }
    if (/items_page/.test(q)) {
      const id = String(v.ids?.[0]);
      return this.ok({ boards: [{ items_page: this.itemsPage(id, 0, Number(v.limit), q) }] });
    }
    if (/boards\(/.test(q)) {
      const page = Number(v.page ?? 1);
      return this.ok({ boards: this.boards.slice((page - 1) * this.pageCap, page * this.pageCap) });
    }
    if (/docs\(ids/.test(q)) {
      const page = Number(v.page ?? 1);
      return this.ok({ docs: [{ blocks: (this.blocks[String(v.id)] ?? []).slice((page - 1) * 5, page * 5) }] });
    }
    if (/docs\(/.test(q)) {
      const page = Number(v.page ?? 1);
      return this.ok({ docs: this.docs.slice((page - 1) * this.pageCap, page * this.pageCap) });
    }
    return json(200, { errors: [{ message: 'Unknown query in fake', extensions: { code: 'FAKE' } }] });
  }

  private itemsPage(board: string, from: number, limit: number, q: string) {
    const all = this.items[board] ?? [];
    const size = Math.min(limit, this.pageCap);
    const slice = all.slice(from, from + size).map((i) => (/updates\(/.test(q) ? i : { ...i, updates: undefined }));
    const next = from + size < all.length ? `c${board}:${from + size}` : null;
    return { cursor: next, items: slice };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// ClickUp (REST v2 + Docs v3)
// ---------------------------------------------------------------------------------------------------------------

export const CLICKUP_TOKEN = 'pk_4711_FAKECLICKUPTOKENABCDEFGHIJKLMN';
const cms = (iso: string) => String(Date.parse(iso));

export class FakeClickUp extends FakeVendor {
  pageCap = 2;
  /** Answer the next N calls with 429 and an X-RateLimit-Reset five seconds ahead. */
  reset = 0;
  assigneeEmail = 'anna@example.com';
  statuses = [
    { status: 'to do', type: 'open', orderindex: 0, color: '#87909e' },
    { status: 'in progress', type: 'custom', orderindex: 1, color: '#4194f6' },
    { status: 'review', type: 'custom', orderindex: 2, color: '#a875ff' },
    { status: 'complete', type: 'done', orderindex: 3, color: '#6bc950' },
    { status: 'closed', type: 'closed', orderindex: 4, color: '#008844' },
  ];
  fields = [
    { id: 'cf1', name: 'Kunde', type: 'short_text', type_config: {} },
    { id: 'cf2', name: 'Budget', type: 'number', type_config: {} },
    { id: 'cf3', name: 'Typ', type: 'drop_down', type_config: { options: [{ id: 'o1', name: 'Bug', orderindex: 0 }, { id: 'o2', name: 'Feature', orderindex: 1 }] } },
    { id: 'cf4', name: 'Frist', type: 'date', type_config: {} },
    { id: 'cf5', name: 'Link', type: 'url', type_config: {} },
    { id: 'cf6', name: 'Geprüft', type: 'checkbox', type_config: {} },
    { id: 'cf7', name: 'Verknüpft', type: 'tasks', type_config: {} },
  ];
  tasks: Record<string, any[]> = {};
  comments: Record<string, any[]> = {};
  docs: any[] = [
    { id: 'd1', name: 'Handbuch', date_created: 1700000000000 },
    { id: 'd2', name: 'Einzelseite', date_created: 1700000100000 },
    { id: 'd3', name: 'Archiv', archived: true },
  ];
  pages: Record<string, any[]> = {
    d1: [
      { id: 'p1', name: 'Start', content: '# Start\n\nHallo **Welt**', pages: [{ id: 'p2', name: 'Unterseite', content: 'Mehr dazu', pages: [] }] },
      { id: 'p3', name: 'Ende', content: 'Tschüss', pages: [] },
    ],
    d2: [{ id: 'p4', name: 'Einzelseite', content: 'Nur eine Seite', pages: [] }],
  };

  constructor() {
    super();
    const due = cms('2024-06-29T22:00:00Z'); // 30 June, midnight in Berlin
    const base = { creator: { id: 1 }, watchers: [], archived: false, dependencies: [], linked_tasks: [], team_id: '9001', sharing: {} };
    this.tasks.l1 = [
      { ...base, id: 'tsub', name: 'Entwurf schreiben', parent: 't1', top_level_parent: 't1', status: { status: 'complete', type: 'done' }, date_created: cms('2024-03-02T09:00:00Z'), date_closed: cms('2024-03-05T09:00:00Z'), assignees: [{ id: 1, username: 'Anna Alt', email: this.assigneeEmail }], tags: [], checklists: [], custom_fields: [], priority: null, due_date: null, start_date: null, url: 'https://app.clickup.com/t/tsub' },
      {
        ...base,
        id: 't1',
        name: 'Kampagne planen',
        parent: null,
        text_content: 'Plan',
        markdown_description: '**Ziel**: Reichweite',
        status: { status: 'in progress', type: 'custom' },
        priority: { id: '2', priority: 'high' },
        date_created: cms('2024-03-01T09:00:00Z'),
        due_date: String(due),
        due_date_time: false,
        start_date: String(due - 14 * 86_400_000),
        start_date_time: false,
        time_estimate: 7_200_000,
        tags: [{ name: 'marketing' }, { name: 'q3' }],
        assignees: [{ id: 1, username: 'Anna Alt', email: this.assigneeEmail }, { id: 2, username: 'Ben Fremd', email: 'ben@elsewhere.example' }],
        checklists: [{ id: 'cl1', name: 'Vorbereitung', items: [{ id: 'i1', name: 'Briefing', resolved: true, children: [] }, { id: 'i2', name: 'Budget', resolved: false, children: [{ id: 'i3', name: 'Freigabe', resolved: false }] }] }],
        custom_fields: [
          { id: 'cf1', name: 'Kunde', type: 'short_text', value: 'Muster GmbH' },
          { id: 'cf2', name: 'Budget', type: 'number', value: '1500' },
          { id: 'cf3', name: 'Typ', type: 'drop_down', value: 1, type_config: {} },
          { id: 'cf4', name: 'Frist', type: 'date', value: String(due) },
          { id: 'cf5', name: 'Link', type: 'url', value: 'https://x.example/brief' },
          { id: 'cf6', name: 'Geprüft', type: 'checkbox', value: true },
          { id: 'cf7', name: 'Verknüpft', type: 'tasks', value: [] },
        ],
        url: 'https://app.clickup.com/t/t1',
      },
      { ...base, id: 't3', name: 'Altlast', parent: null, status: { status: 'closed', type: 'closed' }, date_created: cms('2023-01-01T09:00:00Z'), date_closed: cms('2023-02-01T09:00:00Z'), assignees: [], tags: [], checklists: [], custom_fields: [], priority: { id: '4', priority: 'low' }, due_date: null, start_date: null, url: 'https://app.clickup.com/t/t3' },
    ];
    this.tasks.l2 = [{ ...base, id: 't4', name: 'Newsletter Juli', parent: null, status: { status: 'to do', type: 'open' }, date_created: cms('2024-04-01T09:00:00Z'), due_date: cms('2024-07-15T13:30:00Z'), due_date_time: true, assignees: [], tags: [], checklists: [], custom_fields: [], priority: { id: '1', priority: 'urgent' }, url: 'https://app.clickup.com/t/t4' }];
    this.tasks.l3 = [];
    // 27 comments on t1: the API gives 25 per page, newest first
    this.comments.t1 = Array.from({ length: 27 }, (_, i) => ({ id: `cm${i + 1}`, comment_text: `Kommentar ${i + 1}`, user: { id: 1, username: i % 2 ? 'Anna Alt' : 'Ben Fremd' }, date: String(Date.parse('2024-03-10T09:00:00Z') + i * 3_600_000), resolved: false })).reverse();
    this.comments.tsub = [{ id: 'cmx', comment_text: 'Fertig!', user: { id: 1, username: 'Anna Alt' }, date: String(Date.parse('2024-03-05T08:00:00Z')) }];
  }

  authOk(r: Req) {
    return r.headers.authorization === CLICKUP_TOKEN && r.url.hostname === 'api.clickup.com';
  }

  handle(r: Req): Response | undefined {
    const p = r.path;
    if (this.reset > 0) {
      this.reset--;
      return json(429, { err: 'Rate limit reached', ECODE: 'APP_002' }, { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 5), 'x-ratelimit-remaining': '0' });
    }
    if (p === '/api/v2/user') return json(200, { user: { id: 4711, username: 'Chef', email: 'chef@muster.example.com' } });
    if (p === '/api/v2/team') return json(200, { teams: [{ id: '9001', name: 'Muster GmbH' }] });
    if (p === '/api/v2/team/9001/space') return json(200, { spaces: [{ id: 's1', name: 'Marketing' }, { id: 's2', name: 'Technik' }] });
    if (p === '/api/v2/space/s1/list') return json(200, { lists: [{ id: 'l1', name: 'Backlog', task_count: 3 }] });
    if (p === '/api/v2/space/s1/folder') return json(200, { folders: [{ id: 'f1', name: 'Q3', lists: [{ id: 'l2', name: 'Kampagnen', task_count: 1 }] }] });
    if (p === '/api/v2/space/s2/list') return json(200, { lists: [{ id: 'l3', name: 'Releases', task_count: 0 }] });
    if (p === '/api/v2/space/s2/folder') return json(200, { folders: [] });
    let m = /^\/api\/v2\/list\/(l\d)$/.exec(p);
    if (m) return json(200, { id: m[1], name: m[1], content: m[1] === 'l1' ? 'Alles Offene' : '', statuses: this.statuses });
    m = /^\/api\/v2\/list\/(l\d)\/field$/.exec(p);
    if (m) return json(200, { fields: m[1] === 'l1' ? this.fields : [] });
    m = /^\/api\/v2\/list\/(l\d)\/task$/.exec(p);
    if (m) {
      const all = this.tasks[m[1]] ?? [];
      const page = Number(r.url.searchParams.get('page') ?? 0);
      const slice = all.slice(page * this.pageCap, (page + 1) * this.pageCap);
      return json(200, { tasks: slice, last_page: (page + 1) * this.pageCap >= all.length });
    }
    m = /^\/api\/v2\/task\/(\w+)\/comment$/.exec(p);
    if (m) {
      const all = this.comments[m[1]] ?? [];
      const from = r.url.searchParams.get('start_id');
      const at = from ? all.findIndex((c) => c.id === from) + 1 : 0;
      return json(200, { comments: all.slice(at, at + 25) });
    }
    if (p === '/api/v3/workspaces/9001/docs') {
      const cur = Number(r.url.searchParams.get('cursor') ?? 0);
      const slice = this.docs.slice(cur, cur + this.pageCap);
      return json(200, { docs: slice, next_cursor: cur + this.pageCap < this.docs.length ? String(cur + this.pageCap) : '' });
    }
    m = /^\/api\/v3\/workspaces\/9001\/docs\/(\w+)\/pages$/.exec(p);
    if (m) return json(200, this.pages[m[1]] ?? []);
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------------------------------------------------

export const NOTION_TOKEN = 'ntn_FAKE0123456789notion0token0abcdefghijkl';

const rt = (text: string, ann: Record<string, unknown> = {}, href?: string) => [{ type: 'text', plain_text: text, href: href ?? null, annotations: { bold: false, italic: false, strikethrough: false, code: false, ...ann } }];
const nTitle = (t: string) => ({ id: 'title', type: 'title', title: t ? rt(t) : [] });
const nText = (id: string, t: string) => ({ id, type: 'rich_text', rich_text: t ? rt(t) : [] });
const nNum = (id: string, n: number | null) => ({ id, type: 'number', number: n });
const nSel = (id: string, name: string | null) => ({ id, type: 'select', select: name ? { name } : null });
const nMulti = (id: string, names: string[]) => ({ id, type: 'multi_select', multi_select: names.map((name) => ({ name })) });
const nDate = (id: string, start: string | null, end: string | null = null) => ({ id, type: 'date', date: start ? { start, end } : null });
const nPeople = (id: string, people: any[]) => ({ id, type: 'people', people });
const nRel = (id: string, ids: string[]) => ({ id, type: 'relation', relation: ids.map((x) => ({ id: x })), has_more: false });
const dbProps = (o: Record<string, any>) => o;

export class FakeNotion extends FakeVendor {
  pageCap = 2;
  anna = 'anna@example.com';
  multiSource = new Set<string>();
  commentsDenied = false;
  databases: any[] = [];
  rows: Record<string, any[]> = {};
  pages: any[] = [];
  blocks: Record<string, any[]> = {};
  comments: Record<string, any[]> = {};

  constructor() {
    super();
    const statusOpts = [{ id: 'o1', name: 'Nicht begonnen' }, { id: 'o2', name: 'In Arbeit' }, { id: 'o3', name: 'Fertig' }];
    const mk = (id: string, title: string, properties: Record<string, any>, extra: Record<string, unknown> = {}) => ({ object: 'database', id, created_time: '2024-01-01T10:00:00.000Z', title: rt(title), description: [], properties, archived: false, in_trash: false, ...extra });
    const withIds = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).map(([name, p]) => [name, { id: `id_${name}`, name, ...p }]));
    this.databases = [
      mk(
        'db1',
        'Aufgaben',
        withIds({
          Name: { type: 'title', title: {} },
          Status: { type: 'status', status: { options: statusOpts, groups: [{ id: 'g1', name: 'To-do', option_ids: ['o1'] }, { id: 'g2', name: 'In progress', option_ids: ['o2'] }, { id: 'g3', name: 'Complete', option_ids: ['o3'] }] } },
          Fällig: { type: 'date', date: {} },
          Start: { type: 'date', date: {} },
          Zuständig: { type: 'people', people: {} },
          Priorität: { type: 'select', select: { options: [{ name: 'Hoch' }, { name: 'Niedrig' }] } },
          Tags: { type: 'multi_select', multi_select: { options: [{ name: 'a' }, { name: 'b' }] } },
          Aufwand: { type: 'number', number: { format: 'number' } },
          Notiz: { type: 'rich_text', rich_text: {} },
          Art: { type: 'select', select: { options: [{ name: 'Intern' }, { name: 'Extern' }] } },
          Datei: { type: 'files', files: {} },
          Erstellt: { type: 'created_time', created_time: {} },
        }),
      ),
      mk(
        'db2',
        'Kunden',
        withIds({
          Name: { type: 'title', title: {} },
          'E-Mail': { type: 'email', email: {} },
          Telefon: { type: 'phone_number', phone_number: {} },
          Branche: { type: 'select', select: { options: [{ name: 'IT' }, { name: 'Handel' }] } },
          Umsatz: { type: 'number', number: {} },
          Seit: { type: 'date', date: {} },
          Aktiv: { type: 'checkbox', checkbox: {} },
          Website: { type: 'url', url: {} },
          Tags: { type: 'multi_select', multi_select: { options: [{ name: 'vip' }] } },
          Notizen: { type: 'rich_text', rich_text: {} },
          Projekte: { type: 'relation', relation: { database_id: 'db3', type: 'dual_property' } },
          Betreuer: { type: 'people', people: {} },
          Formel: { type: 'formula', formula: { expression: 'x' } },
        }),
      ),
      mk('db3', 'Projekte', withIds({ Name: { type: 'title', title: {} }, Kunde: { type: 'relation', relation: { database_id: 'db2', type: 'dual_property' } }, Budget: { type: 'number', number: {} }, Ziel: { type: 'relation', relation: { database_id: 'db-fremd', type: 'single_property' } } })),
      mk('db4', 'Altes Archiv', withIds({ Name: { type: 'title', title: {} } }), { archived: true }),
    ];
    const anna = { object: 'user', id: 'u1', name: 'Anna Alt', person: { email: this.anna } };
    const ben = { object: 'user', id: 'u2', name: 'Ben Fremd', person: { email: 'ben@elsewhere.example' } };
    const row = (id: string, db: string, properties: Record<string, any>, created = '2024-02-01T09:00:00.000Z') => ({ object: 'page', id, created_time: created, last_edited_time: '2024-05-01T09:00:00.000Z', archived: false, in_trash: false, parent: { type: 'database_id', database_id: db }, properties, url: `https://www.notion.so/${id}` });
    this.rows.db1 = [
      row('r1', 'db1', { Name: nTitle('Website bauen'), Status: { id: 's', type: 'status', status: { name: 'In Arbeit' } }, Fällig: nDate('d', '2024-06-30'), Start: nDate('s2', '2024-06-01'), Zuständig: nPeople('p', [anna, ben]), Priorität: nSel('pr', 'Hoch'), Tags: nMulti('t', ['a', 'b']), Aufwand: nNum('n', 5), Notiz: nText('nz', 'Kurznotiz'), Art: nSel('a', 'Intern'), Datei: { id: 'f', type: 'files', files: [{ name: 'logo.png' }] } }),
      row('r2', 'db1', { Name: nTitle('Texte schreiben'), Status: { id: 's', type: 'status', status: { name: 'Fertig' } }, Fällig: nDate('d', '2024-05-01', '2024-05-10'), Aufwand: nNum('n', 0) }, '2024-02-02T09:00:00.000Z'),
      row('r3', 'db1', { Name: nTitle('Backlog-Idee'), Status: { id: 's', type: 'status', status: null } }, '2024-02-03T09:00:00.000Z'),
    ];
    this.rows.db2 = [
      row('k1', 'db2', { Name: nTitle('Muster GmbH'), 'E-Mail': { id: 'e', type: 'email', email: 'info@muster.example.com' }, Telefon: { id: 'ph', type: 'phone_number', phone_number: '+49 30 1234567' }, Branche: nSel('b', 'IT'), Umsatz: nNum('u', 12000.5), Seit: nDate('sd', '2020-03-01'), Aktiv: { id: 'ak', type: 'checkbox', checkbox: true }, Website: { id: 'w', type: 'url', url: 'https://muster.example.com' }, Tags: nMulti('tg', ['vip', 'neu']), Notizen: nText('no', 'Wichtiger Kunde'), Projekte: nRel('id_Projekte', ['p1', 'p2']), Betreuer: nPeople('bt', [anna]), Formel: { id: 'fo', type: 'formula', formula: { type: 'string', string: 'berechnet' } } }),
      row('k2', 'db2', { Name: nTitle('Beispiel AG'), Branche: nSel('b', 'Handel'), Projekte: nRel('id_Projekte', ['p2']), Aktiv: { id: 'ak', type: 'checkbox', checkbox: false } }, '2024-02-02T09:00:00.000Z'),
      row('k3', 'db2', { Name: nTitle(''), Notizen: nText('no', 'Ohne Namen'), Projekte: nRel('id_Projekte', []) }, '2024-02-03T09:00:00.000Z'),
    ];
    this.rows.db3 = [
      row('p1', 'db3', { Name: nTitle('Relaunch'), Kunde: nRel('id_Kunde', ['k1']), Budget: nNum('bu', 5000), Ziel: nRel('id_Ziel', ['x1']) }),
      row('p2', 'db3', { Name: nTitle('Kampagne'), Kunde: nRel('id_Kunde', ['k1', 'k2']), Budget: nNum('bu', 800), Ziel: nRel('id_Ziel', []) }, '2024-02-02T09:00:00.000Z'),
    ];
    const page = (id: string, title: string, parent: any, created: string) => ({ object: 'page', id, created_time: created, last_edited_time: created, archived: false, in_trash: false, parent, icon: id === 'pgA' ? { type: 'emoji', emoji: '📘' } : null, properties: { title: nTitle(title) }, url: `https://www.notion.so/${id}` });
    this.pages = [
      page('pgB', 'Onboarding', { type: 'page_id', page_id: 'pgA' }, '2024-01-03T09:00:00.000Z'),
      page('pgA', 'Handbuch', { type: 'workspace', workspace: true }, '2024-01-02T09:00:00.000Z'),
      page('pgC', 'Ideen', { type: 'page_id', page_id: 'unbekannt' }, '2024-01-04T09:00:00.000Z'),
      ...Object.values(this.rows).flat(),
    ];
    const b = (id: string, type: string, data: Record<string, unknown>, has_children = false) => ({ object: 'block', id, type, has_children, [type]: data });
    this.blocks.r1 = [
      b('b1', 'heading_2', { rich_text: rt('Ziel') }),
      b('b2', 'paragraph', { rich_text: [...rt('Eine ', {}), ...rt('neue', { bold: true }), ...rt(' Seite, siehe '), ...rt('Doku', {}, 'https://muster.example.com/doku')] }),
      b('b3', 'bulleted_list_item', { rich_text: rt('Erstens') }, true),
      b('b4', 'bulleted_list_item', { rich_text: rt('Zweitens') }),
      b('b5', 'to_do', { rich_text: rt('Abnahme'), checked: true }),
      b('b6', 'code', { rich_text: rt('npm run build'), language: 'bash' }),
      b('b7', 'image', { type: 'file', file: { url: 'https://prod-files-secure.s3.us-west-2.amazonaws.com/x/logo.png?X-Amz=1' }, caption: [] }),
      b('b8', 'table', { table_width: 2, has_column_header: true }, true),
      b('b9', 'child_page', { title: 'Unterseite' }, true),
    ];
    this.blocks.b3 = [b('b3a', 'bulleted_list_item', { rich_text: rt('Unterpunkt') })];
    this.blocks.b8 = [b('t1', 'table_row', { cells: [rt('Name'), rt('Rolle')] }), b('t2', 'table_row', { cells: [rt('Anna'), rt('Chefin')] })];
    this.blocks.pgA = [b('a1', 'paragraph', { rich_text: rt('Willkommen im Team') }), b('a2', 'numbered_list_item', { rich_text: rt('Erst') }), b('a3', 'numbered_list_item', { rich_text: rt('Dann') }), b('a4', 'child_page', { title: 'Onboarding' })];
    this.blocks.pgB = [b('c1', 'callout', { rich_text: rt('Wichtig!'), icon: { type: 'emoji', emoji: '💡' } })];
    this.blocks.pgC = [];
    this.comments.r1 = [{ id: 'cm1', created_time: '2024-03-01T09:00:00.000Z', created_by: { id: 'u1' }, rich_text: rt('Sieht gut aus') }, { id: 'cm2', created_time: '2024-03-02T09:00:00.000Z', created_by: { id: 'u2' }, rich_text: rt('Danke') }];
  }

  authOk(r: Req) {
    return r.headers.authorization === `Bearer ${NOTION_TOKEN}` && r.headers['notion-version'] === '2022-06-28' && r.url.hostname === 'api.notion.com';
  }

  private list(items: any[], cursor: string | null | undefined) {
    const at = Number(cursor ?? 0) || 0;
    const slice = items.slice(at, at + this.pageCap);
    const more = at + this.pageCap < items.length;
    return json(200, { object: 'list', results: slice, has_more: more, next_cursor: more ? String(at + this.pageCap) : null });
  }

  handle(r: Req): Response | undefined {
    const p = r.path;
    if (p === '/v1/users/me') return json(200, { object: 'user', id: 'bot1', type: 'bot', name: 'Umzug', bot: { workspace_name: 'Muster Workspace' } });
    if (p === '/v1/users') return this.list([{ object: 'user', id: 'u1', name: 'Anna Alt' }, { object: 'user', id: 'u2', name: 'Ben Fremd' }], r.url.searchParams.get('start_cursor'));
    if (p === '/v1/search' && r.method === 'POST') {
      const want = r.body?.filter?.value;
      const all = want === 'database' ? this.databases : this.pages;
      return this.list(all, r.body?.start_cursor);
    }
    let m = /^\/v1\/databases\/(\w+)\/query$/.exec(p);
    if (m && r.method === 'POST') {
      if (this.multiSource.has(m[1])) return json(400, { object: 'error', status: 400, code: 'validation_error', message: 'Databases with multiple data sources are not supported in this API version.' });
      const rows = this.rows[m[1]] ?? [];
      const only = r.url.searchParams.getAll('filter_properties');
      const out = only.length ? rows.map((row) => ({ ...row, properties: Object.fromEntries(Object.entries(row.properties).filter(([, v]: any) => only.includes(v.id))) })) : rows;
      return this.list(out, r.body?.start_cursor);
    }
    m = /^\/v1\/blocks\/(\w+)\/children$/.exec(p);
    if (m) return this.list(this.blocks[m[1]] ?? [], r.url.searchParams.get('start_cursor'));
    if (p === '/v1/comments') {
      if (this.commentsDenied) return json(403, { object: 'error', status: 403, code: 'restricted_resource', message: 'Insufficient permissions for this endpoint.' });
      return this.list(this.comments[r.url.searchParams.get('block_id') ?? ''] ?? [], r.url.searchParams.get('start_cursor'));
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Airtable
// ---------------------------------------------------------------------------------------------------------------

export const AIRTABLE_TOKEN = 'patFAKE0123456789.abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567';

export class FakeAirtable extends FakeVendor {
  pageCap = 2;
  basesCap = 1;
  /** Answer the next N calls with a bare 429 (Airtable names no Retry-After). */
  bare429 = 0;
  bases: any[] = [
    { id: 'appBase1', name: 'CRM', permissionLevel: 'create' },
    { id: 'appBase2', name: 'Projekte', permissionLevel: 'read' },
    { id: 'appNone', name: 'Gesperrt', permissionLevel: 'none' },
  ];
  tables: Record<string, any[]> = {
    appBase1: [
      {
        id: 'tblKunden',
        name: 'Kunden',
        primaryFieldId: 'fldName',
        fields: [
          { id: 'fldName', name: 'Name', type: 'singleLineText' },
          { id: 'fldMail', name: 'E-Mail', type: 'email' },
          { id: 'fldPhone', name: 'Telefon', type: 'phoneNumber' },
          { id: 'fldBranche', name: 'Branche', type: 'singleSelect', options: { choices: [{ id: 's1', name: 'IT' }, { id: 's2', name: 'Handel' }] } },
          { id: 'fldTags', name: 'Tags', type: 'multipleSelects', options: { choices: [{ id: 't1', name: 'vip' }, { id: 't2', name: 'neu' }] } },
          { id: 'fldUmsatz', name: 'Umsatz', type: 'currency', options: { precision: 2, symbol: '€' } },
          { id: 'fldQuote', name: 'Quote', type: 'percent', options: { precision: 1 } },
          { id: 'fldRating', name: 'Bewertung', type: 'rating', options: { max: 5 } },
          { id: 'fldDauer', name: 'Dauer', type: 'duration', options: { durationFormat: 'h:mm' } },
          { id: 'fldAktiv', name: 'Aktiv', type: 'checkbox', options: {} },
          { id: 'fldSeit', name: 'Kunde seit', type: 'date', options: { dateFormat: { name: 'iso' } } },
          { id: 'fldAngelegt', name: 'Angelegt', type: 'createdTime', options: { result: { type: 'dateTime' } } },
          { id: 'fldBetreuer', name: 'Betreuer', type: 'singleCollaborator' },
          { id: 'fldDateien', name: 'Dateien', type: 'multipleAttachments' },
          { id: 'fldProjekte', name: 'Projekte', type: 'multipleRecordLinks', options: { linkedTableId: 'tblProjekte', inverseLinkFieldId: 'fldKunde' } },
          { id: 'fldFormel', name: 'Anrede', type: 'formula', options: { result: { type: 'singleLineText' } } },
          { id: 'fldSumme', name: 'Projektsumme', type: 'rollup', options: { result: { type: 'number' } } },
          { id: 'fldLookup', name: 'Projektnamen', type: 'multipleLookupValues', options: { result: { type: 'singleLineText' } } },
          { id: 'fldBtn', name: 'Aktion', type: 'button' },
          { id: 'fldNr', name: 'Nr', type: 'autoNumber' },
          { id: 'fldNotiz', name: 'Notiz', type: 'multilineText' },
          { id: 'fldWeb', name: 'Webseite', type: 'url' },
        ],
      },
      {
        id: 'tblProjekte',
        name: 'Projekte',
        primaryFieldId: 'fldTitel',
        fields: [
          { id: 'fldTitel', name: 'Titel', type: 'singleLineText' },
          { id: 'fldKunde', name: 'Kunde', type: 'multipleRecordLinks', options: { linkedTableId: 'tblKunden', inverseLinkFieldId: 'fldProjekte' } },
          { id: 'fldBudget', name: 'Budget', type: 'currency', options: { precision: 0 } },
          { id: 'fldStart', name: 'Start', type: 'dateTime', options: { timeZone: 'utc' } },
        ],
      },
    ],
    appBase2: [{ id: 'tblAufgaben', name: 'Aufgaben', primaryFieldId: 'fldA', fields: [{ id: 'fldA', name: 'Aufgabe', type: 'singleLineText' }, { id: 'fldB', name: 'Stand', type: 'singleSelect', options: { choices: [] } }] }],
  };
  records: Record<string, any[]> = {
    tblKunden: [
      {
        id: 'recK1',
        createdTime: '2024-01-10T08:00:00.000Z',
        fields: {
          fldName: 'Muster GmbH',
          fldMail: 'info@muster.example.com',
          fldPhone: '+49 30 1234567',
          fldBranche: 'IT',
          fldTags: ['vip', 'neu', 'unbekannt'],
          fldUmsatz: 12000.5,
          fldQuote: 0.125,
          fldRating: 4,
          fldDauer: 5400,
          fldAktiv: true,
          fldSeit: '2020-03-01',
          fldAngelegt: '2024-01-10T08:00:00.000Z',
          fldBetreuer: { id: 'usr1', email: 'anna@example.com', name: 'Anna Alt' },
          fldDateien: [{ id: 'att1', filename: 'vertrag.pdf', url: 'https://dl.airtable.com/x/vertrag.pdf', size: 1 }],
          fldProjekte: ['recP1', 'recP2'],
          fldFormel: 'Sehr geehrte Frau Muster',
          fldSumme: 5800,
          fldLookup: ['Relaunch', 'Kampagne'],
          fldNr: 1,
          fldNotiz: 'Zeile 1\nZeile 2',
          fldWeb: 'https://muster.example.com',
        },
      },
      { id: 'recK2', createdTime: '2024-01-11T08:00:00.000Z', fields: { fldName: 'Beispiel AG', fldBranche: 'Handel', fldProjekte: ['recP2'], fldMail: 'kaputt', fldNr: 2 } },
      { id: 'recK3', createdTime: '2024-01-12T08:00:00.000Z', fields: { fldNr: 3 } },
    ],
    tblProjekte: [
      { id: 'recP1', createdTime: '2024-02-01T08:00:00.000Z', fields: { fldTitel: 'Relaunch', fldKunde: ['recK1'], fldBudget: 5000, fldStart: '2024-03-01T09:30:00.000Z' } },
      { id: 'recP2', createdTime: '2024-02-02T08:00:00.000Z', fields: { fldTitel: 'Kampagne', fldKunde: ['recK1', 'recK2'], fldBudget: 800 } },
    ],
    tblAufgaben: [{ id: 'recA1', createdTime: '2024-03-01T08:00:00.000Z', fields: { fldA: 'Aufgabe 1', fldB: 'Offen' } }],
  };

  authOk(r: Req) {
    return r.headers.authorization === `Bearer ${AIRTABLE_TOKEN}` && r.url.hostname === 'api.airtable.com';
  }

  handle(r: Req): Response | undefined {
    const p = r.path;
    if (this.bare429 > 0) {
      this.bare429--;
      return json(429, { error: { type: 'RATE_LIMIT_REACHED', message: 'Rate limit reached' } });
    }
    if (p === '/v0/meta/whoami') return json(200, { id: 'usrFAKE1', email: 'chef@muster.example.com', scopes: ['data.records:read', 'schema.bases:read'] });
    if (p === '/v0/meta/bases') {
      const at = Number(r.url.searchParams.get('offset') ?? 0) || 0;
      const slice = this.bases.slice(at, at + this.basesCap);
      return json(200, { bases: slice, ...(at + this.basesCap < this.bases.length ? { offset: String(at + this.basesCap) } : {}) });
    }
    let m = /^\/v0\/meta\/bases\/(\w+)\/tables$/.exec(p);
    if (m) return json(200, { tables: this.tables[m[1]] ?? [] });
    m = /^\/v0\/(app\w+)\/(tbl\w+)$/.exec(p);
    if (m) {
      const all = this.records[m[2]] ?? [];
      const at = Number(r.url.searchParams.get('offset') ?? 0) || 0;
      const only = r.url.searchParams.getAll('fields[]');
      const slice = all.slice(at, at + this.pageCap).map((rec) => (only.length ? { ...rec, fields: Object.fromEntries(Object.entries(rec.fields).filter(([k]) => only.includes(k))) } : rec));
      if (r.url.searchParams.get('returnFieldsByFieldId') !== 'true') return json(422, { error: { type: 'INVALID_REQUEST_UNKNOWN', message: 'fake wants ids' } });
      return json(200, { records: slice, ...(at + this.pageCap < all.length ? { offset: String(at + this.pageCap) } : {}) });
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Typeform
// ---------------------------------------------------------------------------------------------------------------

export const TYPEFORM_TOKEN = 'tfp_FAKE5UpLwFZq1234567890typeformtokenabcdefg';

export class FakeTypeform extends FakeVendor {
  pageCap = 2;
  host = 'api.typeform.com';
  forms: any[] = [
    {
      id: 'F1',
      title: 'Kontaktformular',
      logic: [{ type: 'field', ref: 'x', actions: [] }],
      fields: [
        { id: 'q1', ref: 'name', type: 'short_text', title: 'Wie *heißt* du?', validations: { required: true } },
        { id: 'q2', ref: 'mail', type: 'email', title: 'Deine E-Mail', validations: { required: true } },
        { id: 'q3', ref: 'tel', type: 'phone_number', title: 'Telefon' },
        { id: 'q4', ref: 'msg', type: 'long_text', title: 'Hallo {{field:name}}, was möchtest du wissen?' },
        { id: 'q5', ref: 'art', type: 'multiple_choice', title: 'Art der Anfrage', properties: { choices: [{ id: 'c1', label: 'Angebot' }, { id: 'c2', label: 'Support' }], allow_multiple_selection: false } },
        { id: 'q6', ref: 'int', type: 'multiple_choice', title: 'Interessen', properties: { choices: [{ id: 'c3', label: 'CRM' }, { id: 'c4', label: 'E-Mail' }], allow_multiple_selection: true } },
        { id: 'q7', ref: 'yn', type: 'yes_no', title: 'Rückruf gewünscht?' },
        { id: 'q8', ref: 'ds', type: 'legal', title: 'Datenschutz akzeptiert', validations: { required: true } },
        { id: 'q9', ref: 'dd', type: 'dropdown', title: 'Land', properties: { choices: [{ label: 'Deutschland' }, { label: 'Österreich' }] } },
        { id: 'q10', ref: 'rt', type: 'rating', title: 'Wie zufrieden?' },
        { id: 'q11', ref: 'dt', type: 'date', title: 'Wunschtermin' },
        { id: 'q12', ref: 'fu', type: 'file_upload', title: 'Anhang' },
        { id: 'q13', ref: 'st', type: 'statement', title: 'Nur ein Hinweis' },
        { id: 'g1', ref: 'grp', type: 'group', title: 'Gruppe', properties: { fields: [{ id: 'q14', ref: 'firm', type: 'short_text', title: 'Firma' }] } },
      ],
    },
    { id: 'F2', title: 'Umfrage', fields: [{ id: 'u1', ref: 'a', type: 'nps', title: 'Weiterempfehlen?' }] },
  ];
  responses: Record<string, any[]> = {};

  constructor() {
    super();
    const ans = (list: [string, string, any][]) => list.map(([id, type, v]) => ({ field: { id, type: type === 'email' ? 'email' : 'short_text', ref: id }, type, [type === 'choice' ? 'choice' : type === 'choices' ? 'choices' : type]: v }));
    const r = (token: string, at: string, answers: any[], extra: any = {}) => ({ landing_id: `l-${token}`, token, response_id: token, landed_at: at, submitted_at: at, metadata: { user_agent: 'Mozilla', platform: 'desktop', referer: 'https://muster.example.com/kontakt', browser: 'default' }, hidden: {}, answers, ...extra });
    this.responses.F1 = [
      r('t1', '2024-03-01T10:00:00Z', ans([['q1', 'text', 'Anna Alt'], ['q2', 'email', 'Anna@Example.com'], ['q3', 'phone_number', '+49 30 1234567'], ['q4', 'text', 'Preise?'], ['q5', 'choice', { label: 'Angebot' }], ['q6', 'choices', { labels: ['CRM', 'E-Mail'] }], ['q7', 'boolean', true], ['q10', 'number', 4], ['q11', 'date', '2024-04-02'], ['q12', 'file_url', 'https://api.typeform.com/responses/files/abc/x.pdf']])),
      r('t2', '2024-03-02T10:00:00Z', ans([['q1', 'text', 'Ben Bau'], ['q2', 'email', 'ben@example.com'], ['q6', 'choices', { labels: ['CRM'], other: 'Sonstiges' }], ['q7', 'boolean', false]])),
      r('t3', '2024-03-03T10:00:00Z', ans([['q1', 'text', 'Anna Alt'], ['q2', 'email', 'anna@example.com'], ['q4', 'text', 'Noch eine Frage']])),
      r('t4', '2024-03-04T10:00:00Z', ans([['q1', 'text', 'Anonym'], ['q4', 'text', 'ohne Mail']])),
      r('t5', '2024-03-05T10:00:00Z', ans([['q1', 'text', 'Cleo Neu'], ['q2', 'email', 'cleo@example.com'], ['q14', 'text', 'Neu GmbH']]), { hidden: { utm_source: 'newsletter', leer: '' } }),
    ];
    this.responses.F2 = [r('u1', '2024-04-01T10:00:00Z', [{ field: { id: 'u1', type: 'opinion_scale', ref: 'a' }, type: 'number', number: 9 }])];
  }

  authOk(r: Req) {
    return r.headers.authorization === `Bearer ${TYPEFORM_TOKEN}` && r.url.hostname === this.host;
  }

  handle(r: Req): Response | undefined {
    const p = r.path;
    if (p === '/me') return json(200, { user_id: 'tfu1', alias: 'Muster GmbH', email: 'chef@muster.example.com', language: 'de' });
    if (p === '/forms') {
      const page = Number(r.url.searchParams.get('page') ?? 1);
      return json(200, { total_items: this.forms.length, page_count: Math.ceil(this.forms.length / this.pageCap), items: this.forms.slice((page - 1) * this.pageCap, page * this.pageCap).map((f) => ({ id: f.id, title: f.title })) });
    }
    let m = /^\/forms\/(\w+)$/.exec(p);
    if (m) {
      const f = this.forms.find((x) => x.id === m![1]);
      return f ? json(200, f) : json(404, { code: 'FORM_NOT_FOUND', description: 'Form not found' });
    }
    m = /^\/forms\/(\w+)\/responses$/.exec(p);
    if (m) {
      const all = this.responses[m[1]] ?? [];
      const after = r.url.searchParams.get('after');
      const at = after ? all.findIndex((x) => x.token === after) + 1 : 0;
      if (r.url.searchParams.get('response_type') !== 'completed') return json(400, { code: 'INVALID', description: 'fake wants completed only' });
      const size = Math.min(Number(r.url.searchParams.get('page_size') ?? 25), this.pageCap === 2 && r.url.searchParams.get('page_size') !== '1' ? 2 : 1000);
      return json(200, { total_items: all.length, page_count: 1, items: all.slice(at, at + size) });
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Calendly
// ---------------------------------------------------------------------------------------------------------------

export const CALENDLY_TOKEN = 'eyJraWQiOiIxY2UxZTEzNjE3ZGNmNzY2YjNjZWJjY2Y4ZGM1YmFmYThhNjVlNjg0MDIzZjdjMzJiZTgzNDliMjM4MDEzNWI0In0.fake.sig';
const CAL = 'https://api.calendly.com';

export class FakeCalendly extends FakeVendor {
  pageCap = 2;
  eventTypes: any[] = [
    { uri: `${CAL}/event_types/ET1`, name: 'Erstgespräch', active: true, slug: 'erst', scheduling_url: 'https://calendly.com/muster/erst', duration: 30, kind: 'solo', pooling_type: null, secret: false, color: '#0069ff', description_plain: 'Wir lernen uns kennen', locations: [{ kind: 'zoom_conference' }], deleted_at: null },
    { uri: `${CAL}/event_types/ET2`, name: 'Beratung vor Ort', active: false, slug: 'beratung', scheduling_url: 'https://calendly.com/muster/beratung', duration: 60, kind: 'group', pooling_type: 'round_robin', secret: true, color: 'kaputt', description_plain: '', locations: [{ kind: 'physical', location: 'Musterstr. 1, 10115 Berlin' }], deleted_at: null },
    { uri: `${CAL}/event_types/ET3`, name: 'Gelöscht', active: false, duration: 15, deleted_at: '2024-01-01T00:00:00Z' },
  ];
  availability: Record<string, any> = {
    ET1: { timezone: 'Europe/Berlin', rules: [{ type: 'wday', wday: 'monday', intervals: [{ from: '09:00', to: '12:00' }, { from: '13:00', to: '17:00' }] }, { type: 'wday', wday: 'friday', intervals: [{ from: '09:00', to: '12:00' }] }, { type: 'wday', wday: 'saturday', intervals: [] }, { type: 'date', date: '2099-12-24', intervals: [] }, { type: 'date', date: '2099-12-27', intervals: [{ from: '10:00', to: '24:00' }] }, { type: 'date', date: '2020-01-01', intervals: [] }] },
  };
  userSchedule = { uri: `${CAL}/user_availability_schedules/S1`, default: true, name: 'Arbeitszeiten', timezone: 'Europe/Vienna', rules: [{ type: 'wday', wday: 'tuesday', intervals: [{ from: '10:00', to: '16:00' }] }, { type: 'wday', wday: 'thursday', intervals: [{ from: '10:00', to: '16:00' }] }] };
  events: any[] = [];
  invitees: Record<string, any[]> = {};

  constructor() {
    super();
    const ev = (id: string, type: string, name: string, start: string, end: string, extra: any = {}) => ({ uri: `${CAL}/scheduled_events/${id}`, name, status: 'active', start_time: start, end_time: end, event_type: `${CAL}/event_types/${type}`, location: { type: 'zoom_conference', status: 'pushed', join_url: 'https://zoom.us/j/123' }, invitees_counter: { total: 1, active: 1, limit: 1 }, created_at: '2024-04-20T10:00:00Z', updated_at: '2024-04-20T10:00:00Z', event_memberships: [{ user: `${CAL}/users/USER1`, user_name: 'Chef', user_email: 'chef@muster.example.com' }], event_guests: [], ...extra });
    this.events = [
      ev('E1', 'ET1', 'Erstgespräch', '2024-05-02T09:00:00Z', '2024-05-02T09:30:00Z', { meeting_notes_plain: 'Preise besprochen' }),
      ev('E2', 'ET1', 'Erstgespräch', '2024-05-03T09:00:00Z', '2024-05-03T09:30:00Z', { status: 'canceled', cancellation: { canceled_by: 'Anna Alt', reason: 'Krank', canceler_type: 'invitee' } }),
      ev('E3', 'ET2', 'Beratung vor Ort', '2099-06-01T08:00:00Z', '2099-06-01T09:00:00Z', { location: { type: 'physical', location: 'Musterstr. 1' }, event_guests: [{ email: 'gast@example.com' }] }),
      ev('E4', 'ET9', 'Altes Format', '2023-01-05T09:00:00Z', '2023-01-05T10:00:00Z'),
    ];
    const inv = (id: string, email: string, name: string, extra: any = {}) => ({ uri: `${CAL}/scheduled_events/X/invitees/${id}`, email, name, first_name: name.split(' ')[0], last_name: name.split(' ').slice(1).join(' ') || null, status: 'active', timezone: 'Europe/Berlin', created_at: '2024-04-20T10:05:00Z', questions_and_answers: [], text_reminder_number: null, rescheduled: false, ...extra });
    this.invitees.E1 = [inv('I1', 'Anna@Example.com', 'Anna Alt', { questions_and_answers: [{ question: 'Worum geht es?', answer: 'Preise', position: 0 }, { question: 'Firma', answer: 'Muster GmbH', position: 1 }], text_reminder_number: '+49 30 1234567' })];
    this.invitees.E2 = [inv('I2', 'anna@example.com', 'Anna Alt', { status: 'canceled', cancellation: { canceled_by: 'Anna Alt', reason: 'Krank' } })];
    this.invitees.E3 = [inv('I3', 'ben@example.com', 'Ben Bau'), inv('I4', 'cleo@example.com', 'Cleo Neu')];
    this.invitees.E4 = [];
  }

  authOk(r: Req) {
    return r.headers.authorization === `Bearer ${CALENDLY_TOKEN}` && r.url.hostname === 'api.calendly.com';
  }

  private page(items: any[], r: Req) {
    const at = Number(r.url.searchParams.get('page_token') ?? 0) || 0;
    const slice = items.slice(at, at + this.pageCap);
    const more = at + this.pageCap < items.length;
    return json(200, { collection: slice, pagination: { count: slice.length, next_page: more ? 'https://api.calendly.com/next' : null, previous_page: null, next_page_token: more ? String(at + this.pageCap) : null, previous_page_token: null } });
  }

  handle(r: Req): Response | undefined {
    const p = r.path;
    if (p === '/users/me') return json(200, { resource: { uri: `${CAL}/users/USER1`, name: 'Chef Muster', email: 'chef@muster.example.com', timezone: 'Europe/Berlin', current_organization: `${CAL}/organizations/ORG1`, scheduling_url: 'https://calendly.com/muster' } });
    if (p === '/event_types') return this.page(this.eventTypes, r);
    if (p === '/event_type_availability_schedules') {
      const id = String(r.url.searchParams.get('event_type')).split('/').pop()!;
      const a = this.availability[id];
      return json(200, { collection: a ? [{ event_type: r.url.searchParams.get('event_type'), availability_setting: 'host', availability_rule: { ...a, uri: 'u', name: 'x', user: `${CAL}/users/USER1` } }] : [], pagination: { count: 0, next_page: null, previous_page: null, next_page_token: null, previous_page_token: null } });
    }
    if (p === '/user_availability_schedules') return json(200, { collection: [this.userSchedule] });
    if (p === '/scheduled_events') return this.page(this.events, r);
    const m = /^\/scheduled_events\/(\w+)\/invitees$/.exec(p);
    if (m) return this.page(this.invitees[m[1]] ?? [], r);
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Lexware Office (lexoffice)
// ---------------------------------------------------------------------------------------------------------------

export const LEXOFFICE_KEY = 'a1b2c3d4-e5f6-4711-8a9b-0c1d2e3f4a5b';
const LXN = (id: string) => `00000000-0000-4000-8000-${id.padStart(12, '0')}`;

export class FakeLexoffice extends FakeVendor {
  pageCap = 2;
  contacts: any[] = [
    {
      id: LXN('1'),
      version: 3,
      archived: false,
      roles: { customer: { number: 10001 } },
      company: { name: 'Muster GmbH', taxNumber: '12/345/67890', vatRegistrationId: 'DE123456789', contactPersons: [{ salutation: 'Frau', firstName: 'Anna', lastName: 'Alt', primary: true, emailAddress: 'anna@muster.example.com', phoneNumber: '+49 30 1234567' }, { firstName: 'Ben', lastName: 'Bau', primary: false, emailAddress: 'ben@muster.example.com', phoneNumber: '' }] },
      addresses: { billing: [{ street: 'Hauptstr. 1', zip: '10115', city: 'Berlin', countryCode: 'DE' }] },
      emailAddresses: { business: ['info@muster.example.com'] },
      phoneNumbers: { business: ['+49 30 7654321'] },
      note: 'Stammkunde',
    },
    { id: LXN('2'), version: 1, archived: false, roles: { customer: { number: 10002 } }, person: { salutation: 'Herr', firstName: 'Cleo', lastName: 'Neu' }, addresses: { billing: [{ street: 'Weg 2', zip: '80331', city: 'München', countryCode: 'DE' }] }, emailAddresses: { private: ['cleo@example.com'] }, phoneNumbers: { mobile: ['0170 1234567'] } },
    { id: LXN('3'), version: 1, archived: false, roles: { customer: { number: 10003 } }, company: { name: 'Ohne Person AG' }, emailAddresses: { office: ['buero@ohne.example.com'] }, phoneNumbers: {} },
    { id: LXN('4'), version: 1, archived: true, roles: { customer: { number: 10004 } }, company: { name: 'Archiviert AG' }, emailAddresses: {} },
    { id: LXN('5'), version: 1, archived: false, roles: { vendor: { number: 70001 } }, company: { name: 'Lieferant GmbH' }, emailAddresses: {} },
  ];
  vouchers: any[] = [];

  constructor() {
    super();
    const v = (n: string, type: string, status: string, contactId: string | undefined, extra: any = {}) => ({ id: LXN(`9${n}`), voucherType: type, voucherStatus: status, voucherNumber: extra.number ?? `RE${n.padStart(4, '0')}`, voucherDate: extra.date ?? '2024-03-01T00:00:00.000+01:00', createdDate: '2024-03-01T10:00:00.000+01:00', updatedDate: '2024-03-02T10:00:00.000+01:00', dueDate: extra.due ?? '2024-03-15T00:00:00.000+01:00', contactId, contactName: 'Muster GmbH', totalAmount: extra.total ?? 1190, openAmount: extra.open ?? 1190, currency: 'EUR', archived: false });
    this.vouchers = [
      v('1', 'invoice', 'open', LXN('1')),
      v('2', 'invoice', 'paidoff', LXN('2'), { total: 59.5, open: 0, date: '2024-04-01T00:00:00.000+02:00' }),
      v('3', 'creditnote', 'open', LXN('1'), { number: 'GS0001', total: 100, open: 0 }),
      v('4', 'quotation', 'accepted', LXN('2'), { number: 'AN0001', total: 500 }),
      v('5', 'invoice', 'voided', 'unbekannt-0000-0000-0000-000000000000'),
      v('6', 'deliverynote', 'open', undefined, { number: 'LS0001' }),
    ];
  }

  authOk(r: Req) {
    return r.headers.authorization === `Bearer ${LEXOFFICE_KEY}` && r.url.hostname === 'api.lexware.io';
  }

  private paged(list: any[], r: Req) {
    const size = Math.min(Number(r.url.searchParams.get('size') ?? 25), 25);
    const cap = size === 1 ? 1 : Math.min(size, this.pageCap);
    const page = Number(r.url.searchParams.get('page') ?? 0);
    const content = list.slice(page * cap, (page + 1) * cap);
    const totalPages = Math.max(1, Math.ceil(list.length / cap));
    return json(200, { content, first: page === 0, last: page + 1 >= totalPages, totalPages, totalElements: list.length, numberOfElements: content.length, size: cap, number: page });
  }

  handle(r: Req): Response | undefined {
    const p = r.path;
    if (p === '/v1/profile') return json(200, { organizationId: 'org-lx-1', companyName: 'Muster GmbH', connectionId: 'conn1' });
    if (p === '/v1/contacts') {
      let list = this.contacts;
      if (r.url.searchParams.get('customer') === 'true') list = list.filter((c) => c.roles?.customer);
      return this.paged(list, r);
    }
    if (p === '/v1/voucherlist') {
      if (!r.url.searchParams.get('voucherType') || !r.url.searchParams.get('voucherStatus')) return json(400, { message: 'voucherType and voucherStatus are required' });
      if (Number(r.url.searchParams.get('size')) > 25) return json(400, { message: 'size too large' });
      const types = r.url.searchParams.get('voucherType')!.split(',');
      const status = r.url.searchParams.get('voucherStatus')!.split(',');
      return this.paged(this.vouchers.filter((x) => types.includes(x.voucherType) && status.includes(x.voucherStatus)), r);
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// sevDesk
// ---------------------------------------------------------------------------------------------------------------

export const SEVDESK_TOKEN = 'b7794de0085f5cd00560f160f290af38';

export class FakeSevdesk extends FakeVendor {
  pageCap = 2;
  contacts: any[] = [];
  ways: any[] = [];
  addresses: any[] = [];
  invoices: any[] = [];
  creditNotes: any[] = [];
  orders: any[] = [];

  constructor() {
    super();
    const client = { id: '4711', objectName: 'SevClient' };
    const c = (id: string, extra: any) => ({ id, objectName: 'Contact', create: '2023-05-01T10:00:00+02:00', sevClient: client, category: { id: '3', objectName: 'Category' }, customerNumber: '', parent: null, ...extra });
    this.contacts = [
      c('100', { name: 'Muster GmbH', customerNumber: 'K-100', vatNumber: 'DE123456789', taxNumber: '12/345/67890', description: 'Stammkunde' }),
      c('101', { name: 'Lieferant AG', category: { id: '2', objectName: 'Category' } }),
      c('200', { surename: 'Anna', familyname: 'Alt', parent: { id: '100', objectName: 'Contact' } }),
      c('201', { surename: 'Ben', familyname: 'Interessent', category: { id: '28', objectName: 'Category' } }),
      c('202', { surename: 'Liefer', familyname: 'Person', category: { id: '2', objectName: 'Category' } }),
      c('203', { surename: 'Cleo', familyname: 'Waise', category: { id: '2', objectName: 'Category' }, parent: { id: '101', objectName: 'Contact' } }),
    ];
    const w = (id: string, contact: string, type: string, value: string, main: string) => ({ id, objectName: 'CommunicationWay', contact: { id: contact, objectName: 'Contact' }, type, value, main, key: { id: '2' } });
    this.ways = [w('1', '100', 'EMAIL', 'info@muster.example.com', '1'), w('2', '100', 'PHONE', '+49 30 1234567', '1'), w('3', '200', 'EMAIL', 'andere@muster.example.com', '0'), w('4', '200', 'EMAIL', 'anna@muster.example.com', '1'), w('5', '200', 'MOBILE', '0170 1234567', '0'), w('6', '201', 'EMAIL', 'ben@example.com', '1'), w('7', '100', 'WEB', 'https://muster.example.com', '1')];
    this.addresses = [{ id: 1, contact: { id: '100', objectName: 'Contact' }, street: 'Hauptstr. 1', zip: '10115', city: 'Berlin', country: { id: 1 } }];
    const inv = (id: string, contact: string, extra: any) => ({ id, objectName: 'Invoice', invoiceNumber: `RE-${id}`, contact: { id: contact, objectName: 'Contact' }, invoiceDate: '2024-03-01T00:00:00+01:00', status: '1000', invoiceType: 'RE', sumNet: '1000.00', sumTax: '190.00', sumGross: '1190.00', currency: 'EUR', timeToPay: '14', paidAmount: 1190, ...extra });
    this.invoices = [inv('1', '100', {}), inv('2', '100', { status: '100', invoiceNumber: null }), inv('3', '200', { status: '200', invoiceNumber: 'RE-3', sumGross: '59.50', paidAmount: 0 }), inv('4', '201', { invoiceType: 'SR', status: '750', paidAmount: 100 }), inv('5', '999', {})];
    this.creditNotes = [{ id: '1', objectName: 'CreditNote', creditNoteNumber: 'GU-1', contact: { id: '100', objectName: 'Contact' }, creditNoteDate: '2024-05-01T00:00:00+02:00', status: '200', sumGross: '100.00', currency: 'EUR' }];
    this.orders = [
      { id: '1', objectName: 'Order', orderNumber: 'AN-1', orderType: 'AN', contact: { id: '100', objectName: 'Contact' }, orderDate: '2024-02-01T00:00:00+01:00', status: '500', sumGross: '500.00', currency: 'EUR' },
      { id: '2', objectName: 'Order', orderNumber: 'LI-1', orderType: 'LI', contact: { id: '100', objectName: 'Contact' }, orderDate: '2024-02-05T00:00:00+01:00', status: '200', sumGross: '0', currency: 'EUR' },
    ];
  }

  authOk(r: Req) {
    return r.headers.authorization === SEVDESK_TOKEN && r.url.hostname === 'my.sevdesk.de';
  }

  private list(items: any[], r: Req) {
    const offset = Number(r.url.searchParams.get('offset') ?? 0) || 0;
    const limit = Math.min(Number(r.url.searchParams.get('limit') ?? 100), this.pageCap);
    return json(200, { objects: items.slice(offset, offset + limit), ...(r.url.searchParams.get('countAll') === 'true' ? { total: items.length } : {}) });
  }

  handle(r: Req): Response | undefined {
    const p = r.path.replace('/api/v1', '');
    if (p === '/Contact') return this.list(r.url.searchParams.get('depth') === '1' ? this.contacts : this.contacts.filter((c) => c.name), r);
    if (p === '/CommunicationWay') return this.list(this.ways, r);
    if (p === '/ContactAddress') return this.list(this.addresses, r);
    if (p === '/Invoice') return this.list(this.invoices, r);
    if (p === '/CreditNote') return this.list(this.creditNotes, r);
    if (p === '/Order') return this.list(this.orders, r);
    return undefined;
  }
}
