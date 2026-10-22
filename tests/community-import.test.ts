import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { detectColumns, parseCsv, parseDate, parseMarkdownPost } from '../server/services/community-import.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let g: any;
let ch: any;
let pro: any, free: any;
const mails: { to: string; subject: string }[] = [];
const events: string[] = [];

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  const capture = async (_l: any, mail: any) => {
    mails.push(mail);
    return { status: 'sent' };
  };
  t.app.services.memberMailer = capture;
  t.app.services.communityMailer = capture;
  for (const type of ['community.member_joined', 'contact.created']) t.app.events.on(type, () => void events.push(type));
});
afterAll(async () => {
  await t.close();
});

const CSV = `FirstName,LastName,Email,Joined,Plan,Points
Anna,Muster,anna@example.de,2023-03-14,Free,12
Ben,"Beispiel, Jr.",ben@example.de,"Mar 5, 2022",Gold,150
Cara,,cara@example.de,14.07.2021,Unbekannt,
Dora,Doppelt,anna@example.de,2024-01-01,Free,
Emil,Ohne,keine-adresse,2024-01-01,Free,
Frieda,Frisch,frieda@example.de,,,
`;

describe('parsing', () => {
  it('reads CSV with quotes, line breaks, BOM and the usual delimiters', () => {
    expect(parseCsv('﻿a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a;b\r\n"x;y";"z ""q"" w"\r\n')).toEqual([['a', 'b'], ['x;y', 'z "q" w']]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a,b\n"line\nbreak",2\n\n\n3,4')).toEqual([['a', 'b'], ['line\nbreak', '2'], ['3', '4']]);
    expect(() => parseCsv('a,b\n"offen,2')).toThrow(/unvollständig/);
    expect(() => parseCsv('x'.repeat(7 * 1024 * 1024))).toThrow(/zu groß/);
  });

  it('finds columns by their usual names, in English and German, or by an explicit mapping', () => {
    expect(detectColumns(['Vorname', 'Nachname', 'E-Mail', 'Mitglied seit', 'Abo', 'Punkte'])).toEqual({ first_name: 0, last_name: 1, email: 2, joined: 3, tier: 4, points: 5 });
    expect(detectColumns(['Name', 'Email address', 'Date Joined'])).toEqual({ name: 0, email: 1, joined: 2 });
    expect(detectColumns(['a', 'b'], { email: 'b' })).toEqual({ email: 1 });
    expect(() => detectColumns(['a'], { email: 'x' })).toThrow(/gibt es in der Datei nicht/);
  });

  it('understands the dates people export', () => {
    expect(parseDate('2023-03-14')).toBe('2023-03-14T12:00:00.000Z');
    expect(parseDate('2023-03-14T08:30:00Z')).toBe('2023-03-14T12:00:00.000Z');
    expect(parseDate('14.07.2021')).toBe('2021-07-14T12:00:00.000Z');
    expect(parseDate('Mar 5, 2022')).toBe('2022-03-05T12:00:00.000Z');
    expect(parseDate('5 März 2022')).toBe('2022-03-05T12:00:00.000Z');
    expect(parseDate('13/02/2022')).toBe('2022-02-13T12:00:00.000Z');
    expect(parseDate('03/04/2022')).toBe('2022-03-04T12:00:00.000Z');
    expect(parseDate('03/04/2022', 'dmy')).toBe('2022-04-03T12:00:00.000Z');
    expect(parseDate('31.02.2022')).toBeNull();
    expect(parseDate('2999-01-01')).toBeNull();
    expect(parseDate('irgendwann')).toBeNull();
    expect(parseDate('')).toBeNull();
  });

  it('reads Markdown posts with front matter', () => {
    const r = parseMarkdownPost('a.md', '---\ntitle: "Hallo Welt"\ndate: 2023-05-01\nauthor: anna@example.de\npinned: true\n---\nText hier');
    expect(r.meta).toMatchObject({ title: 'Hallo Welt', date: '2023-05-01', author: 'anna@example.de', pinned: 'true' });
    expect(r.body).toBe('Text hier');
    expect(parseMarkdownPost('b.md', '# Nur Text').meta).toEqual({});
  });
});

describe('importing members', () => {
  it('sets up a group with tiers', async () => {
    g = (await t.api.post('/api/community/groups', { name: 'Umzugsclub' })).data;
    ch = g.channels[0];
    const saved = await t.api.put(`/api/community/groups/${g.id}/join/page`, { slug: 'umzugsclub', enabled: true });
    free = saved.data.tiers[0];
    const gold = await t.api.post('/api/products', { name: 'Gold', price_cents: 2900, tax_rate: 0, recurring: 'month' });
    pro = (await t.api.post(`/api/community/groups/${g.id}/tiers`, { name: 'Gold', product_id: gold.data.id })).data;
    expect(pro.name).toBe('Gold');
  });

  it('refuses a group that does not let people in by joining, and reports what the file holds', async () => {
    const pre = await t.api.post(`/api/community/groups/${g.id}/import/members/preview`, { csv: CSV });
    expect(pre.status).toBe(200);
    expect(pre.data.access_mode).toBe('all');
    expect(pre.data.warnings.join(' ')).toContain('Beitritt über die Community-Seite');
    expect((await t.api.post(`/api/community/groups/${g.id}/import/members`, { csv: CSV, confirm_rights: true })).status).toBe(400);
    expect((await t.api.put(`/api/community/groups/${g.id}/join/page`, { set_access_join: true })).status).toBe(200);
    const ok = await t.api.post(`/api/community/groups/${g.id}/import/members/preview`, { csv: CSV });
    expect(ok.data.counts).toEqual({ total: 6, new: 4, contact_exists: 0, member_exists: 0, invalid: 1, duplicate: 1 });
    expect(ok.data.columns).toMatchObject({ email: 'Email', first_name: 'FirstName', joined: 'Joined', tier: 'Plan' });
    expect(ok.data.unmatched_tiers).toEqual(['Free', 'Unbekannt']); // the free tier is called "Mitglied" here
    const by: Record<string, any> = {};
    for (const i of ok.data.items) by[i.email] ??= i; // the first row of an address counts
    expect(by['anna@example.de']).toMatchObject({ state: 'new', joined_at: '2023-03-14T12:00:00.000Z', tier_id: free.id, tier_match: 'default' });
    expect(by['ben@example.de']).toMatchObject({ last_name: 'Beispiel, Jr.', tier_id: pro.id, joined_at: '2022-03-05T12:00:00.000Z' });
    expect(by['cara@example.de']).toMatchObject({ tier_match: 'default', joined_at: '2021-07-14T12:00:00.000Z' });
    expect(ok.data.items.find((i: any) => i.line === 5)).toMatchObject({ state: 'duplicate' });
    expect(by['keine-adresse']).toMatchObject({ state: 'invalid' });
    expect(by['frieda@example.de'].joined_at).toBeNull();
    expect((await t.api.post(`/api/community/groups/${g.id}/import/members/preview`, { csv: 'Name\nAnna' })).status).toBe(400);
    expect((await t.api.post(`/api/community/groups/${g.id}/import/members/preview`, { csv: CSV, tier_id: 'fremd' })).status).toBe(400);
    expect((await t.api.post(`/api/community/groups/${g.id}/import/members/preview`, { csv: CSV, tier_map: { Unbekannt: 'fremd' } })).status).toBe(400);
  });

  it('needs the confirmation, then imports quietly with the original dates, tiers and tags', async () => {
    expect((await t.api.post(`/api/community/groups/${g.id}/import/members`, { csv: CSV })).status).toBe(400);
    events.length = 0;
    const r = await t.api.post(`/api/community/groups/${g.id}/import/members`, { csv: CSV, confirm_rights: true, tier_map: { Unbekannt: pro.id }, import_points: true });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ created: 4, updated: 0, skipped: 2, mails: 0, points: 162 });
    await t.app.events.flush();
    expect(events).toEqual([]); // no "member joined", no new-contact workflows
    expect(mails).toHaveLength(0);
    const anna = t.app.db.get<any>(`SELECT * FROM contacts WHERE email = 'anna@example.de'`);
    expect(anna).toMatchObject({ first_name: 'Anna', last_name: 'Muster', source: 'Import (Community)' });
    expect(JSON.parse(anna.tags)).toEqual(expect.arrayContaining(['community', 'community:umzugsclub', 'import']));
    const m = t.app.db.get<any>('SELECT * FROM community_memberships WHERE contact_id = ?', anna.id);
    expect(m).toMatchObject({ status: 'active', source: 'import', billing: 'free', tier_id: free.id, joined_at: '2023-03-14T12:00:00.000Z' });
    expect(t.app.db.get<any>('SELECT * FROM community_members WHERE contact_id = ?', anna.id)).toMatchObject({ joined_at: '2023-03-14T12:00:00.000Z', level: 2 });
    const cara = t.app.db.get<any>(`SELECT id FROM contacts WHERE email = 'cara@example.de'`);
    expect(t.app.db.get<any>('SELECT tier_id FROM community_memberships WHERE contact_id = ?', cara.id)!.tier_id).toBe(pro.id);
    const ben = t.app.db.get<any>(`SELECT id FROM contacts WHERE email = 'ben@example.de'`);
    expect(t.app.db.get<{ n: number }>(`SELECT COALESCE(SUM(points), 0) AS n FROM community_points WHERE contact_id = ?`, ben.id)!.n).toBe(150);
    expect(t.app.db.get<{ level: number }>('SELECT level FROM community_members WHERE contact_id = ?', ben.id)!.level).toBeGreaterThanOrEqual(4);
    // They can use the community right away, with their original "member since".
    expect(t.app.db.get('SELECT 1 FROM community_profiles WHERE contact_id = ?', anna.id)).toBeTruthy();
    expect((await t.api.get(`/api/community/groups/${g.id}/memberships`)).data.length).toBe(4);
  });

  it('can be repeated: nobody twice, nothing new the second time', async () => {
    const pre = await t.api.post(`/api/community/groups/${g.id}/import/members/preview`, { csv: CSV });
    expect(pre.data.counts).toMatchObject({ new: 0, member_exists: 4, invalid: 1, duplicate: 1 });
    expect((await t.api.post(`/api/community/groups/${g.id}/import/members`, { csv: CSV, confirm_rights: true })).status).toBe(400);
    expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM community_members WHERE group_id = ?', g.id)!.n).toBe(4);
  });

  it('takes people who are known contacts, keeps banned ones out, mails and triggers workflows only on request', async () => {
    const known = (await t.api.post('/api/contacts', { email: 'gerd@example.de', first_name: 'Gerd', tags: ['kunde'] })).data;
    const banned = (await t.api.post('/api/contacts', { email: 'bert@example.de', first_name: 'Bert' })).data;
    t.app.db.run('INSERT INTO community_members (group_id, contact_id, location_id, joined_at, banned_at, level) VALUES (?, ?, ?, ?, ?, 1)', g.id, banned.id, loc, new Date().toISOString(), new Date().toISOString());
    const csv = 'Name,Email,Joined\nGerd Alt,gerd@example.de,2020-02-02\nBert Böse,bert@example.de,2020-02-02\nHanna Neu,hanna@example.de,2020-03-03\n';
    const pre = (await t.api.post(`/api/community/groups/${g.id}/import/members/preview`, { csv })).data;
    expect(pre.counts).toMatchObject({ contact_exists: 1, member_exists: 1, new: 1 });
    expect(pre.items.find((i: any) => i.email === 'bert@example.de').reason).toContain('gesperrt');
    events.length = 0;
    const r = await t.api.post(`/api/community/groups/${g.id}/import/members`, { csv, confirm_rights: true, send_mail: true, trigger_workflows: true });
    expect(r.data).toMatchObject({ created: 1, updated: 1, skipped: 1, mails: 2 });
    await t.app.events.flush();
    expect(events).toContain('contact.created');
    expect(mails.map((m) => m.to).sort()).toEqual(['gerd@example.de', 'hanna@example.de']);
    expect(mails[0].subject).toContain('Umzugsclub');
    expect(JSON.parse(t.app.db.get<any>('SELECT tags FROM contacts WHERE id = ?', known.id)!.tags)).toEqual(expect.arrayContaining(['kunde', 'community']));
    expect(t.app.db.get<any>('SELECT joined_at FROM community_members WHERE contact_id = ?', known.id)!.joined_at).toBe('2020-02-02T12:00:00.000Z');
    expect(t.app.db.get<any>('SELECT banned_at FROM community_members WHERE contact_id = ?', banned.id)!.banned_at).toBeTruthy();
  });

  it('moves people who asked not to be disturbed over without mailing them', async () => {
    await t.api.post('/api/contacts', { email: 'ruhe@example.de', first_name: 'Ruhe', dnd: true });
    mails.length = 0;
    const csv = 'Name,Email\nRuhe Still,ruhe@example.de\nLaut Neu,laut@example.de\n';
    const r = await t.api.post(`/api/community/groups/${g.id}/import/members`, { csv, confirm_rights: true, send_mail: true });
    expect(r.data).toMatchObject({ created: 1, updated: 1, mails: 1 });
    expect(mails.map((m) => m.to)).toEqual(['laut@example.de']);
    expect(t.app.db.get('SELECT 1 FROM community_members m JOIN contacts k ON k.id = m.contact_id WHERE k.email = ? AND m.group_id = ?', 'ruhe@example.de', g.id)).toBeTruthy();
  });

  it('adds the access tag when the group opens by tags', async () => {
    const tg = (await t.api.post('/api/community/groups', { name: 'Tag-Club', access: { mode: 'tags', tags: ['club'] } })).data;
    const pre = (await t.api.post(`/api/community/groups/${tg.id}/import/members/preview`, { csv: 'Email,Name\nina@example.de,Ina Tag' })).data;
    expect(pre.warnings.join(' ')).toContain('Tags');
    const r = await t.api.post(`/api/community/groups/${tg.id}/import/members`, { csv: 'Email,Name\nina@example.de,Ina Tag', confirm_rights: true });
    expect(r.data.created).toBe(1);
    expect(JSON.parse(t.app.db.get<any>(`SELECT tags FROM contacts WHERE email = 'ina@example.de'`)!.tags)).toContain('club');
  });
});

describe('importing posts', () => {
  const files = [
    { name: 'willkommen.md', content: '---\ntitle: Willkommen im Club\ndate: 2023-05-01\nauthor: anna@example.de\npinned: true\n---\nSchön, dass ihr da seid.\n\n![Bild](bilder/x.png)' },
    { name: 'regeln.md', content: '# Unsere Regeln\n\nSeid nett zueinander.' },
    { name: 'leer.md', content: '---\ntitle: Nur Titel\n---\n' },
    { name: 'fremd.md', content: '---\ntitle: Fremder Kanal\nchannel: Gibt es nicht\nauthor: Peter vom Team\n---\nText' },
    { name: 'gross.md', content: 'x'.repeat(130_000) },
  ];

  it('previews every file with its problems', async () => {
    const pre = (await t.api.post(`/api/community/groups/${g.id}/import/posts/preview`, { files })).data;
    expect(pre).toMatchObject({ total: 5, ok: 3 });
    const by = Object.fromEntries(pre.items.map((i: any) => [i.file, i]));
    expect(by['willkommen.md']).toMatchObject({ title: 'Willkommen im Club', created_at: '2023-05-01T12:00:00.000Z', pinned: true, channel_name: ch.name });
    expect(by['willkommen.md'].author_name).toBeTruthy();
    expect(by['willkommen.md'].warnings.join(' ')).toContain('lokalem Pfad');
    expect(by['regeln.md']).toMatchObject({ title: 'Unsere Regeln' });
    expect(by['regeln.md'].body).toBe('Seid nett zueinander.');
    expect(by['leer.md'].problem).toContain('keinen Text');
    expect(by['gross.md'].problem).toContain('120 KB');
    expect(by['fremd.md']).toMatchObject({ author_name: 'Peter vom Team' });
    expect(by['fremd.md'].warnings.join(' ')).toContain('Gibt es nicht');
    expect((await t.api.post(`/api/community/groups/${g.id}/import/posts/preview`, { files: [] })).status).toBe(400);
    expect((await t.api.post(`/api/community/groups/${g.id}/import/posts/preview`, { files, channel_id: 'fremd' })).status).toBe(400);
  });

  it('creates posts with the original dates, the right author, no notifications and no points – once', async () => {
    const before = t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM community_notifications')!.n;
    const r = await t.api.post(`/api/community/groups/${g.id}/import/posts`, { files });
    expect(r.data).toEqual({ created: 3, skipped: 2 });
    const p = t.app.db.get<any>(`SELECT * FROM community_posts WHERE title = 'Willkommen im Club'`);
    expect(p).toMatchObject({ created_at: '2023-05-01T12:00:00.000Z', pinned: 1, status: 'visible' });
    expect(p.contact_id).toBe(t.app.db.get<any>(`SELECT id FROM contacts WHERE email = 'anna@example.de'`)!.id);
    expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM community_notifications')!.n).toBe(before);
    expect(t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_points WHERE reason = 'post'`)!.n).toBe(0);
    expect((await t.api.post(`/api/community/groups/${g.id}/import/posts`, { files })).data).toEqual({ created: 0, skipped: 5 });
  });
});

describe('exporting', () => {
  it('exports members as CSV that opens safely in a spreadsheet, and posts as JSON', async () => {
    await t.api.patch(`/api/contacts/${t.app.db.get<any>(`SELECT id FROM contacts WHERE email = 'anna@example.de'`)!.id}`, { first_name: '=HYPERLINK("http://evil.example")' });
    const r = await t.api.raw(`/api/community/groups/${g.id}/export/members.csv`, { headers: { cookie: t.api.cookie, 'x-location-id': loc, 'x-pghl': '1' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toContain('umzugsclub-mitglieder.csv');
    const text = await r.text();
    expect(text.split('\r\n')[0].replace(/^\uFEFF/, '')).toBe('FirstName,LastName,Email,Joined,Tier,Level,Points,Status'); // fetch may drop the BOM Excel needs
    expect(text).toContain("'=HYPERLINK");
    expect(text).not.toMatch(/(^|,)=HYPERLINK/m);
    expect(text).toContain('ben@example.de,2022-03-05,Gold');
    const posts = await t.api.raw(`/api/community/groups/${g.id}/export/posts.json`, { headers: { cookie: t.api.cookie, 'x-location-id': loc, 'x-pghl': '1' } });
    const list = await posts.json();
    expect(list.map((p: any) => p.title)).toEqual(expect.arrayContaining(['Willkommen im Club', 'Unsere Regeln']));
    expect(list[0]).toMatchObject({ comments: [] });
  });
});
