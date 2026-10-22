import { expect } from 'vitest';
import type { App } from '../server/core/app.js';
import { client, type Call } from './security-fixtures.js';
import { startTestApp } from './helpers.js';

/**
 * A sub-account with two sales people and records of both – the setup of the record-access tests. Everything that belongs to Bob
 * (the "foreign" side from Alice's point of view) carries MARK in its texts, so a response that contains it is a leak.
 */
export const MARK = 'LEAKMARKB';

export interface Rig {
  t: Awaited<ReturnType<typeof startTestApp>>;
  loc: string;
  admin: Call;
  alice: Call;
  bob: Call;
  carol: Call;
  ids: { alice: string; bob: string; carol: string; admin: string };
  /** Records by owner: a = Alice's, b = Bob's (marked), c = Carol's, u = nobody's. */
  rec: Record<string, string>;
  pipeline: string;
}

const PERMS = ['contacts', 'opportunities', 'conversations', 'calendars', 'dashboard', 'payments'];

export async function rig(): Promise<Rig> {
  const t = await startTestApp();
  const me = await t.setup();
  const loc = t.api.location;
  const admin = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': loc });
  const mk = async (name: string, email: string) => {
    const r = await admin('POST', '/api/users', { email, password: 'passwort-123', name, locations: [loc], permissions: PERMS });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const c = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
    expect((await c('POST', '/api/auth/login', { email, password: 'passwort-123' })).status).toBe(200);
    return { id: r.data.id as string, call: c };
  };
  const alice = await mk('Alice Vertrieb', 'alice@example.com');
  const bob = await mk('Bob Vertrieb', 'bob@example.com');
  const carol = await mk('Carol Vertrieb', 'carol@example.com');
  const pipeline = (await admin('POST', '/api/pipelines', { name: 'Vertrieb', stages: ['Neu', 'Angebot', 'Gewonnen'] })).data.id as string;
  const rec: Record<string, string> = {};
  const put = async (key: string, method: string, path: string, body: unknown, pick = (d: any) => d?.id) => {
    const r = await admin(method, path, body);
    expect(r.status, `${key}: ${path} ${JSON.stringify(r.data)}`).toBeLessThan(300);
    rec[key] = pick(r.data);
    return r.data;
  };
  const people = { a: alice.id, b: bob.id, c: carol.id };
  for (const [k, owner] of Object.entries(people)) {
    const bobs = k === 'b';
    const tag = bobs ? MARK : k === 'a' ? 'Alpha' : 'Charlie';
    await put(`contact_${k}`, 'POST', '/api/contacts', { first_name: `${tag}Kontakt`, last_name: 'Muster', email: `${tag.toLowerCase()}@example.com`, phone: bobs ? '+4915100000001' : k === 'a' ? '+4915100000002' : '+4915100000003', city: `${tag}stadt`, custom: {}, tags: ['vertrieb'] });
    await admin('PATCH', `/api/contacts/${rec[`contact_${k}`]}`, { assigned_to: owner });
    await put(`note_${k}`, 'POST', `/api/contacts/${rec[`contact_${k}`]}/notes`, { body: `${tag} Notiz` });
    await put(`task_${k}`, 'POST', '/api/tasks', { title: `${tag} Aufgabe`, description: `${tag} Beschreibung`, contact_id: rec[`contact_${k}`], assigned_to: owner });
    await put(`deal_${k}`, 'POST', '/api/opportunities', { pipeline_id: pipeline, contact_id: rec[`contact_${k}`], name: `${tag} Deal`, value: bobs ? 7777 : 1000, assigned_to: owner });
    await put(`company_${k}`, 'POST', '/api/companies', { name: `${tag} Firma`, domain: `${tag.toLowerCase()}-firma.example`, owner_id: owner, city: `${tag}stadt` });
    await admin('POST', '/api/associations', { from_type: 'contact', from_id: rec[`contact_${k}`], to_type: 'company', to_id: rec[`company_${k}`] });
    await admin('POST', '/api/associations', { from_type: 'opportunity', from_id: rec[`deal_${k}`], to_type: 'company', to_id: rec[`company_${k}`] });
    const msg = await admin('POST', '/api/messages', { contact_id: rec[`contact_${k}`], channel: 'email', subject: `${tag} Betreff`, body: `${tag} Nachricht` });
    expect(msg.status).toBe(200);
    rec[`message_${k}`] = msg.data.id;
    rec[`conversation_${k}`] = msg.data.conversation_id;
  }
  // Nobody's records: a contact, a task and a deal without an owner.
  await put('contact_u', 'POST', '/api/contacts', { first_name: 'Niemand', last_name: 'Pool', email: 'pool@example.com' });
  await put('task_u', 'POST', '/api/tasks', { title: 'Pool Aufgabe', contact_id: rec.contact_u, assigned_to: '' });
  await admin('PATCH', `/api/tasks/${rec.task_u}`, { assigned_to: null });
  await put('deal_u', 'POST', '/api/opportunities', { pipeline_id: pipeline, contact_id: rec.contact_u, name: 'Pool Deal', value: 50 });
  // The project planner takes over the plain task list on first use (tasks move into its "Allgemein" project): do it now.
  const planner = await admin('GET', '/api/pm/projects');
  expect(planner.status).toBe(200);
  rec.project = planner.data.find((p: any) => p.is_default)?.id ?? planner.data[0]?.id;
  return { t, loc, admin, alice: alice.call, bob: bob.call, carol: carol.call, ids: { alice: alice.id, bob: bob.id, carol: carol.id, admin: me.user.id }, rec, pipeline };
}

/** Narrows every record type to the person's own (and puts the settings on). */
export const OWN = Object.fromEntries(['contacts', 'companies', 'deals', 'tasks', 'conversations'].map((e) => [e, 'own']));
export const setAccess = (r: Rig, body: Record<string, unknown>) => r.admin('PUT', '/api/sales/access', body);
export const rows = (r: Rig, sql: string, ...p: any[]) => (r.t.app as App).db.all(sql, ...p);
