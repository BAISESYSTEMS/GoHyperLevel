import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { umzugHarness, type Harness } from './umzug2-harness.js';

/** Export files of the second-wave sources: the same readers as before, plus the consent ledger (legacy / revoked, source named). */
let h: Harness;
beforeAll(async () => {
  h = await umzugHarness();
  await h.fresh('Dateien Welle 2');
});
afterAll(() => h.t.close());

const upload = async (source: string, name: string, body: string) => {
  const r = await h.t.api.raw(`/api/umzug/files?source=${source}&name=${encodeURIComponent(name)}`, { method: 'POST', headers: { cookie: h.t.api.cookie, 'x-pghl': '1', 'x-location-id': h.loc(), 'content-type': 'application/octet-stream' }, body: Buffer.from(body) });
  const j: any = await r.json();
  expect(r.status, JSON.stringify(j)).toBe(200);
  return j;
};

describe('Export files of the newer sources', () => {
  it('KlickTipp CSV: status decides do-not-disturb, every active row gets a legacy line, withdrawals a revoked line', async () => {
    const csv = 'E-Mail-Adresse;Vorname;Nachname;Status;Anmeldedatum\nanna@example.com;Anna;Alt;Angemeldet;2024-01-05\nben@example.com;Ben;Bau;Abgemeldet;2024-02-05\ncleo@example.com;Cleo;;Unbestätigt;2024-03-05\ndora@example.com;Dora;;;2024-04-05';
    const up = await upload('klicktipp', 'kontakte.csv', csv);
    expect(up.kind).toBe('contacts');
    const job = await h.run({ source: 'klicktipp', file_ids: [up.id] });
    expect(job.status, job.error).toBe('done');
    expect(h.email('anna@example.com').dnd).toBe(0);
    expect(h.email('ben@example.com').dnd).toBe(1);
    expect(h.email('cleo@example.com').dnd).toBe(1);
    expect(h.ledger('anna@example.com')).toMatchObject([{ action: 'legacy', source_label: 'Umzug aus KlickTipp' }]);
    expect(h.ledger('anna@example.com')[0].note).toContain('Export-Datei');
    expect(h.ledger('ben@example.com')).toMatchObject([{ action: 'revoked' }]);
    expect(h.ledger('cleo@example.com')).toEqual([]);
    expect(h.ledger('dora@example.com')).toMatchObject([{ action: 'legacy' }]);
    expect(h.lines(job).consent_events.created).toBe(3);
    const undone = await h.undo(job.id);
    expect(undone.status).toBe('undone');
    expect(h.count('consent_events')).toBe(0);
  });
  it('the first-wave sources keep writing no ledger lines from files', async () => {
    const up = await upload('mailchimp', 'a.csv', 'Email Address,First Name\nmc@example.com,Mia');
    const job = await h.run({ source: 'mailchimp', file_ids: [up.id] });
    expect(job.status, job.error).toBe('done');
    expect(h.ledger('mc@example.com')).toEqual([]);
  });
});
