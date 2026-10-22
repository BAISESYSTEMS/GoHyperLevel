import { expect } from 'vitest';

/** In-memory stand-in for the Todoist API v1 (Sync endpoint + the two REST calls we use). */
export class FakeTodoist {
  token = 'todoist-token-1234';
  version = 1;
  seq = 1;
  projects = new Map<string, any>();
  sections = new Map<string, any>();
  items = new Map<string, any>();
  /** Plan limits like the free plan (5 projects incl. Inbox, 20 sections per project). */
  maxProjects = 1000;
  maxSections = 1000;
  changed = new Map<string, number>();
  uuids = new Set<string>();
  requests: { path: string; form: URLSearchParams | null }[] = [];
  fail429 = 0;
  loseNextResponse = false;
  clock = Date.parse('2026-10-04T10:00:00Z');

  id = (p: string) => `${p}${this.seq++}`;
  stamp = () => new Date((this.clock += 1000)).toISOString();
  touch(kind: 'item' | 'project' | 'section', obj: any) {
    if (kind === 'item') obj.updated_at = obj.updated_at_override ?? this.stamp();
    delete obj.updated_at_override;
    this.changed.set(`${kind}:${obj.id}`, ++this.version);
  }
  addProject(name: string, parent_id: string | null = null) {
    const p = { id: this.id('P'), name, parent_id, is_deleted: false, is_archived: false };
    this.projects.set(p.id, p);
    this.touch('project', p);
    return p;
  }
  addSection(project_id: string, name: string) {
    const s = { id: this.id('S'), project_id, name, is_deleted: false, is_archived: false };
    this.sections.set(s.id, s);
    this.touch('section', s);
    return s;
  }
  sectionByName = (n: string) => [...this.sections.values()].find((s) => s.name === n && !s.is_deleted);
  projectByName = (n: string) => [...this.projects.values()].find((p) => p.name === n && !p.is_deleted);
  addItem(project_id: string, content: string, extra: any = {}) {
    const it = { id: this.id('I'), project_id, section_id: null, content, description: '', due: null, checked: false, is_deleted: false, labels: [], completed_at: null, ...extra };
    this.items.set(it.id, it);
    this.touch('item', it);
    return it;
  }
  edit(id: string, patch: any) {
    const it = this.items.get(id);
    Object.assign(it, patch);
    this.touch('item', it);
    return it;
  }
  byContent = (c: string) => [...this.items.values()].find((i) => i.content === c);
  commands = () => this.requests.filter((r) => r.form?.has('commands')).flatMap((r) => JSON.parse(r.form!.get('commands')!));

  fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const u = new URL(url);
    expect(u.origin + u.pathname.slice(0, 7)).toBe('https://api.todoist.com/api/v1');
    const path = u.pathname.slice(7);
    const form = init.body && init.headers['content-type']?.includes('form') ? new URLSearchParams(init.body) : null;
    this.requests.push({ path, form });
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, headers, text: JSON.stringify(body) });
    if (init.headers.authorization !== `Bearer ${this.token}`) return json(401, { error: 'Unauthorized' });
    if (this.fail429 > 0) {
      this.fail429--;
      return json(429, { error: 'Too many requests', error_extra: { retry_after: 3 } }, this.fail429 % 2 ? { 'retry-after': '2' } : {});
    }
    if (path === '/user') return json(200, { id: '4711', email: 'inhaber@example.com', full_name: 'Paul', tz_info: { timezone: 'Europe/Berlin' } });
    if (path.startsWith('/projects')) return json(200, { results: [...this.projects.values()].filter((p) => !p.is_deleted), next_cursor: null });
    if (path.startsWith('/sections')) return json(200, { results: [...this.sections.values()].filter((x) => !x.is_deleted && x.project_id === u.searchParams.get('project_id')), next_cursor: null });
    if (path === '/sync' && form?.has('commands')) {
      const out = this.exec(JSON.parse(form.get('commands')!));
      if (this.loseNextResponse) {
        this.loseNextResponse = false;
        throw new Error('socket hang up'); // executed in Todoist, but the answer never arrives
      }
      return json(200, out);
    }
    if (path === '/sync') {
      const tok = form!.get('sync_token')!;
      expect(JSON.parse(form!.get('resource_types')!)).toEqual(['projects', 'sections', 'items']);
      const full = tok === '*';
      const since = full ? 0 : Number(tok.slice(1));
      const pick = (kind: string, m: Map<string, any>) => [...m.values()].filter((o) => (full ? !o.is_deleted && !o.checked : (this.changed.get(`${kind}:${o.id}`) ?? 0) > since));
      return json(200, { sync_token: `v${this.version}`, full_sync: full, ...(full ? { full_sync_date_utc: new Date().toISOString() } : {}), items: pick('item', this.items), projects: pick('project', this.projects), sections: pick('section', this.sections) });
    }
    return json(404, { error: 'not found' });
  };

  exec(cmds: any[]) {
    expect(cmds.length).toBeLessThanOrEqual(100);
    const sync_status: Record<string, any> = {};
    const temp_id_mapping: Record<string, string> = {};
    const ref = (v: string) => temp_id_mapping[v] ?? v;
    for (const c of cmds) {
      if (this.uuids.has(c.uuid)) {
        sync_status[c.uuid] = 'ok';
        continue;
      }
      this.uuids.add(c.uuid);
      const a = c.args;
      const item = a.id ? this.items.get(a.id) : undefined;
      const missing = () => (sync_status[c.uuid] = { error_tag: 'ITEM_NOT_FOUND', error_code: 22, error: 'Item not found', http_code: 400 });
      switch (c.type) {
        case 'project_add': {
          if ([...this.projects.values()].filter((p) => !p.is_deleted).length >= this.maxProjects) {
            sync_status[c.uuid] = { error_tag: 'MAX_PROJECTS_LIMIT_REACHED', error_code: 49, error: 'Maximum number of projects per user limit reached', http_code: 403 };
            continue;
          }
          if (a.parent_id && !this.projects.has(ref(a.parent_id))) {
            sync_status[c.uuid] = { error_tag: 'INVALID_TEMPID', error_code: 15, error: 'Invalid temporary id', http_code: 400 };
            continue;
          }
          const p = this.addProject(a.name, a.parent_id ? ref(a.parent_id) : null);
          temp_id_mapping[c.temp_id] = p.id;
          break;
        }
        case 'section_add': {
          if (!this.projects.has(ref(a.project_id))) {
            sync_status[c.uuid] = { error_tag: 'PROJECT_NOT_FOUND', error: 'Project not found', http_code: 400 };
            continue;
          }
          if ([...this.sections.values()].filter((x) => !x.is_deleted && x.project_id === ref(a.project_id)).length >= this.maxSections) {
            sync_status[c.uuid] = { error_tag: 'MAX_SECTIONS_LIMIT_REACHED', error: 'Maximum number of sections per project limit reached', http_code: 403 };
            continue;
          }
          const sec = this.addSection(ref(a.project_id), a.name);
          temp_id_mapping[c.temp_id] = sec.id;
          break;
        }
        case 'project_update': {
          const pr = this.projects.get(a.id);
          Object.assign(pr, { name: a.name });
          this.touch('project', pr);
          break;
        }
        case 'section_update': {
          const sec = this.sections.get(a.id);
          Object.assign(sec, { name: a.name });
          this.touch('section', sec);
          break;
        }
        case 'item_add': {
          if (!this.projects.has(ref(a.project_id)) || this.projects.get(ref(a.project_id)).is_deleted) {
            sync_status[c.uuid] = { error_tag: 'PROJECT_NOT_FOUND', error: 'Project not found', http_code: 400 };
            continue;
          }
          const due = a.due ? { ...a.due, timezone: a.due.timezone ?? null, string: '', is_recurring: false } : null;
          const it = this.addItem(ref(a.project_id), a.content, { description: a.description ?? '', due, labels: a.labels ?? [], section_id: a.section_id ?? null });
          temp_id_mapping[c.temp_id] = it.id;
          break;
        }
        case 'item_update':
          if (!item || item.is_deleted) {
            missing();
            continue;
          }
          this.edit(a.id, { content: a.content ?? item.content, description: a.description ?? item.description, due: a.due === undefined ? item.due : a.due && { ...a.due, timezone: a.due.timezone ?? null } });
          break;
        case 'item_close':
        case 'item_complete':
          if (!item || item.is_deleted) {
            missing();
            continue;
          }
          this.edit(a.id, { checked: true, completed_at: this.stamp() });
          break;
        case 'item_uncomplete':
          if (!item || item.is_deleted) {
            missing();
            continue;
          }
          this.edit(a.id, { checked: false, completed_at: null });
          break;
        case 'item_delete':
          if (!item || item.is_deleted) {
            missing();
            continue;
          }
          this.edit(a.id, { is_deleted: true });
          break;
        default:
          sync_status[c.uuid] = { error: `unknown ${c.type}` };
          continue;
      }
      sync_status[c.uuid] = 'ok';
    }
    return { sync_status, temp_id_mapping, sync_token: `v${this.version}` };
  }
}
