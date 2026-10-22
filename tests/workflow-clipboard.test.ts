import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newApp, type T } from './wfx-helpers.js';
import { cleanLayout, layoutKeys, LAYOUT_LIMITS } from '../server/services/workflow-layout.js';

/** Copy and paste of steps between workflows (format gohigh-steps) and the canvas's settings.layout (docs/workflow-actions.md). */

let t: T;
let source = '';
let target = '';
beforeAll(async () => {
  t = await newApp();
  const mk = async (name: string) => (await t.api.post('/api/workflows', { name, trigger: { type: 'manual', config: {} }, steps: [] })).data.id as string;
  source = await mk('Quelle');
  target = await mk('Ziel');
});
afterAll(() => t.close());

const steps = () => [
  { id: 's1', type: 'add_tag', tags: ['kopie'] },
  { id: 's2', type: 'http_request', method: 'POST', url: 'https://example.com/api', headers: [{ name: 'Authorization', value: 'Bearer geheim' }, { name: 'X-Plain', value: 'ok' }], auth: 'bearer', auth_secret: 'sehr-geheim' },
  { id: 's3', type: 'if', conditions: [{ field: 'tag', op: 'has', value: 'a' }], match: 'all', then: [{ id: 's4', type: 'goto', target: 's1' }], else: [{ id: 's5', type: 'goto', target: 'draussen' }] },
  { id: 's6', type: 'create_opportunity', pipeline_id: 'gibt-es-nicht' },
];

describe('copy', () => {
  it('answers the gohigh-steps format with secrets blanked like an export', async () => {
    const r = await t.api.post(`/api/workflows/${source}/copy`, { steps: steps() });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ format: 'gohigh-steps', version: 1, source: { workflow_id: source, workflow: 'Quelle' } });
    const http = r.data.steps[1];
    expect(http.auth_secret).toBe('');
    expect(http.headers).toEqual([{ name: 'Authorization', value: '' }, { name: 'X-Plain', value: 'ok' }]);
    expect(r.data.references).toContain('pipeline_id:gibt-es-nicht');
    expect(JSON.stringify(r.data)).not.toContain('geheim');
  });

  it('refuses unknown step types, empty lists and other sub-accounts’ workflows', async () => {
    expect((await t.api.post(`/api/workflows/${source}/copy`, { steps: [{ id: 'x', type: 'boom' }] })).status).toBe(400);
    expect((await t.api.post(`/api/workflows/${source}/copy`, { steps: [] })).status).toBe(400);
    expect((await t.api.post('/api/workflows/fremd/copy', { steps: steps() })).status).toBe(404);
  });
});

describe('paste', () => {
  it('gives every step a new id, rewrites jumps inside the pasted steps and warns about the rest', async () => {
    const data = (await t.api.post(`/api/workflows/${source}/copy`, { steps: steps() })).data;
    const r = await t.api.post(`/api/workflows/${target}/paste`, { data });
    expect(r.status).toBe(200);
    expect(r.data.count).toBe(6);
    const [tag, , iff, opp] = r.data.steps;
    const ids = [tag.id, iff.id, iff.then[0].id, iff.else[0].id, opp.id];
    for (const old of ['s1', 's2', 's3', 's4', 's5', 's6']) expect(ids).not.toContain(old);
    expect(new Set(ids).size).toBe(ids.length);
    expect(iff.then[0].target, 'a jump to a pasted step follows its new id').toBe(tag.id);
    expect(iff.else[0].target, 'a jump out of the pasted steps is cleared').toBe('');
    expect(r.data.warnings.some((w: string) => w.includes('Sprungziel'))).toBe(true);
    expect(r.data.warnings.some((w: string) => w.includes('Pipeline „gibt-es-nicht“'))).toBe(true);
    // nothing was saved – the editor inserts and saves
    expect((await t.api.get(`/api/workflows/${target}`)).data.steps).toEqual([]);
  });

  it('keeps a jump to a step that exists in the workflow being edited (also unsaved, via existing_ids)', async () => {
    const data = { format: 'gohigh-steps', version: 1, steps: [{ id: 'a', type: 'goto', target: 'hier' }] };
    const kept = await t.api.post(`/api/workflows/${target}/paste`, { data, existing_ids: ['hier'] });
    expect(kept.data.steps[0].target).toBe('hier');
    expect(kept.data.warnings).toEqual([]);
    // as a JSON string from the clipboard, too
    const asText = await t.api.post(`/api/workflows/${target}/paste`, { data: JSON.stringify(data) });
    expect(asText.data.steps[0].target).toBe('');
  });

  it('refuses what is not gohigh-steps', async () => {
    expect((await t.api.post(`/api/workflows/${target}/paste`, { data: { format: 'gohigh-workflow', steps: [] } })).status).toBe(400);
    expect((await t.api.post(`/api/workflows/${target}/paste`, { data: '{kaputt' })).status).toBe(400);
    expect((await t.api.post(`/api/workflows/${target}/paste`, { data: { format: 'gohigh-steps', version: 9, steps: [{ type: 'end' }] } })).status).toBe(400);
    expect((await t.api.post(`/api/workflows/${target}/paste`, { data: { format: 'gohigh-steps', version: 1, steps: [{ type: 'nope' }] } })).status).toBe(400);
  });
});

describe('settings.layout of the canvas', () => {
  it('cleanLayout keeps the known shape within limits', () => {
    expect(cleanLayout(null)).toBeUndefined();
    expect(cleanLayout({ offsets: {}, notes: [] })).toBeUndefined();
    const keys = layoutKeys([{ id: 'a', type: 'if', then: [{ id: 'b', type: 'end' }], else: [] }]);
    expect([...keys].sort()).toEqual(['a', 'a/else', 'a/then', 'b', 'trigger']);
    const out = cleanLayout(
      {
        offsets: { a: [10.4, -5], 'a/then': [1, 2], gone: [5, 5], zero: [0, 0], 'bad key!': [1, 1], b: ['x', 3], trigger: [1e9, 0] },
        notes: [{ id: 'n1', x: 1, y: 2, w: 10, h: 5000, text: 'x'.repeat(5000), color: 'rot' }, { id: 'n1', x: 0, y: 0 }, { x: 0 }, 'junk'],
        extra: 'weg',
      },
      keys,
    )!;
    expect(out).toEqual({
      v: 1,
      offsets: { a: [10, -5], 'a/then': [1, 2], b: [0, 3], trigger: [LAYOUT_LIMITS.coord, 0] },
      notes: [{ id: 'n1', x: 1, y: 2, w: LAYOUT_LIMITS.minW, h: LAYOUT_LIMITS.maxH, text: 'x'.repeat(LAYOUT_LIMITS.text), color: 'yellow' }],
    });
  });

  it('is cleaned when a workflow is saved, and null removes it', async () => {
    const saved = await t.api.patch(`/api/workflows/${target}`, {
      steps: [{ id: 'k1', type: 'add_tag', tags: ['a'] }],
      settings: { layout: { offsets: { k1: [40, 0], alt: [9, 9] }, notes: [{ id: 'n', x: 5, y: 6, text: 'Hinweis', color: 'blue' }] } },
    });
    expect(saved.status).toBe(200);
    expect(saved.data.settings.layout).toEqual({ v: 1, offsets: { k1: [40, 0] }, notes: [{ id: 'n', x: 5, y: 6, w: 220, h: 140, text: 'Hinweis', color: 'blue' }] });
    // a settings-only save prunes against the stored steps
    const again = await t.api.patch(`/api/workflows/${target}`, { settings: { layout: { offsets: { k1: [1, 1], weg: [2, 2] } } } });
    expect(again.data.settings.layout).toEqual({ v: 1, offsets: { k1: [1, 1] } });
    const cleared = await t.api.patch(`/api/workflows/${target}`, { settings: { layout: null } });
    expect(cleared.data.settings.layout).toBeUndefined();
    expect(cleared.data.settings).toHaveProperty('allow_reentry');
  });
});
