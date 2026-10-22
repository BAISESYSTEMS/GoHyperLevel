import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newApp, type T } from './wfx-helpers.js';
import { ISSUE_TEXT, issueText, issuesByStep, validateSteps, type RuleMeta } from '../server/services/workflow-validate.js';
import { ISSUE_TEXT as WEB_ISSUE_TEXT } from '../web/src/workflow-canvas/issues.js';

/** Validation on save: required step settings and jump targets, shown on the steps of both editors (docs/workflow-actions.md). */

const METAS: Record<string, RuleMeta> = {
  format_text: {
    type: 'format_text',
    fields: [
      { key: 'op', label: 'Operation', type: 'select', required: true, default: 'upper' },
      { key: 'input', label: 'Eingabe', type: 'text', required: true },
      { key: 'find', label: 'Suchen', type: 'text', required: true, showIf: { field: 'op', in: ['replace'] } },
      { key: 'flag', label: 'Schalter', type: 'bool', required: true },
    ],
  },
  goto: { type: 'goto', fields: [{ key: 'target', label: 'Springe zu', type: 'step', required: true }] },
  wait_until: { type: 'wait_until', fields: [{ key: 'timeout_target', label: 'Dann zu', type: 'step' }, { key: 'conditions', label: 'Bedingung', type: 'conditions', required: true }] },
  custom_thing: { type: 'custom_thing', custom: true, fields: [{ key: 'x', label: 'X', type: 'text', required: true }] },
};
const metaOf = (type: string) => METAS[type];
const codes = (steps: any[]) => validateSteps(steps, metaOf).map((i) => `${i.step}:${i.code}${i.field ? `:${i.field}` : ''}`);

describe('validateSteps (pure, shared with the web editor)', () => {
  it('reports required catalogue fields that are empty, honours defaults, showIf and bool fields', () => {
    expect(codes([{ id: 'a', type: 'format_text' }])).toEqual(['a:required:input']);
    expect(codes([{ id: 'a', type: 'format_text', input: '{{contact.first_name}}' }])).toEqual([]);
    expect(codes([{ id: 'a', type: 'format_text', input: 'x', op: 'replace' }])).toEqual(['a:required:find']);
    expect(codes([{ id: 'a', type: 'format_text', input: '   ' }])).toEqual(['a:required:input']);
    const [issue] = validateSteps([{ id: 'a', type: 'format_text' }], metaOf);
    expect(issueText(issue)).toBe('Pflichtfeld fehlt: Eingabe');
  });

  it('checks jump targets against the steps of the workflow', () => {
    expect(codes([{ id: 'j', type: 'goto' }])).toEqual(['j:required:target']);
    expect(codes([{ id: 'j', type: 'goto', target: 'weg' }])).toEqual(['j:target_missing:target']);
    expect(codes([{ id: 'j', type: 'goto', target: 'x' }, { id: 'x', type: 'end' }])).toEqual([]);
    expect(codes([{ id: 'w', type: 'wait_until', conditions: [{ field: 'tag', op: 'has', value: 'a' }], timeout_target: 'nope' }])).toEqual(['w:target_missing:timeout_target']);
    expect(validateSteps([{ id: 'j', type: 'goto', target: 'elsewhere' }], metaOf, new Set(['elsewhere']))).toEqual([]);
  });

  it('has rules for the steps with editors of their own', () => {
    expect(codes([{ id: 'e', type: 'send_email' }])).toEqual(['e:email_empty:subject']);
    expect(codes([{ id: 'e', type: 'send_email', subject: 'Hallo' }])).toEqual([]);
    expect(codes([{ id: 'e', type: 'send_email', design: { blocks: [] } }])).toEqual([]);
    expect(codes([{ id: 's', type: 'send_sms', body: '' }])).toEqual(['s:text_missing:body']);
    expect(codes([{ id: 't', type: 'add_tag', tags: [''] }])).toEqual(['t:tags_empty:tags']);
    expect(codes([{ id: 'h', type: 'webhook', url: 'ftp://x' }])).toEqual(['h:url_invalid:url']);
    expect(codes([{ id: 'h', type: 'webhook', url: 'https://example.com/hook' }])).toEqual([]);
    expect(codes([{ id: 'w', type: 'wait', amount: 0 }, { id: 'v', type: 'wait', mode: 'date' }, { id: 'u', type: 'wait', mode: 'weekday' }])).toEqual(['w:wait_amount:amount', 'v:wait_date:date']);
    expect(codes([{ id: 'i', type: 'if', conditions: [{ field: 'tag', op: 'has', value: '' }], then: [], else: [] }])).toEqual(['i:condition_incomplete:conditions']);
    expect(codes([{ id: 'i', type: 'if', conditions: [], expression: "'vip' in contact.tags" }])).toEqual([]);
    expect(codes([{ id: 'i', type: 'if', conditions: [{ field: 'email', op: 'not_empty' }] }])).toEqual([]);
    expect(codes([{ id: 'p', type: 'split_test', variants: [{ name: 'A', weight: 100 }], b0: [] }])).toEqual(['p:split_paths:variants']);
    expect(codes([{ id: 'c', type: 'custom_thing' }]), 'own editors without built-in rules are trusted').toEqual([]);
  });

  it('walks into lanes and skips paused steps with everything inside them', () => {
    const steps = [
      { id: 'i', type: 'if', conditions: [{ field: 'tag', op: 'has', value: 'a' }], then: [{ id: 'a', type: 'send_sms' }], else: [{ id: 'b', type: 'add_tag', tags: [] }] },
      { id: 'off', type: 'if', disabled: true, conditions: [], then: [{ id: 'c', type: 'send_sms' }] },
      { id: 'd', type: 'send_sms', disabled: true },
    ];
    expect(codes(steps)).toEqual(['a:text_missing:body', 'b:tags_empty:tags']);
    expect(Object.keys(issuesByStep(validateSteps(steps, metaOf)))).toEqual(['a', 'b']);
  });

  it('the web editor shows the same texts as the server sends', () => {
    expect(WEB_ISSUE_TEXT).toEqual(ISSUE_TEXT);
  });
});

describe('validation on save (API)', () => {
  let t: T;
  beforeAll(async () => {
    t = await newApp();
  });
  afterAll(() => t.close());

  it('saving answers with the issues of the steps, loading too – and never refuses a draft', async () => {
    const created = await t.api.post('/api/workflows', { name: 'Unfertig', trigger: { type: 'manual', config: {} }, steps: [] });
    const id = created.data.id;
    const saved = await t.api.patch(`/api/workflows/${id}`, { steps: [{ id: 'm', type: 'send_email' }, { id: 'j', type: 'goto', target: 'gone' }, { id: 'ok', type: 'add_tag', tags: ['x'] }] });
    expect(saved.status).toBe(200);
    expect(saved.data.issues.map((i: any) => [i.step, i.code])).toEqual([
      ['m', 'email_empty'],
      ['j', 'target_missing'],
    ]);
    expect(saved.data.issues[0].message).toBe('Betreff und Text fehlen');
    const loaded = await t.api.get(`/api/workflows/${id}`);
    expect(loaded.data.issues).toHaveLength(2);
    const fixed = await t.api.patch(`/api/workflows/${id}`, { steps: [{ id: 'm', type: 'send_email', subject: 'Hi', body: 'Text' }] });
    expect(fixed.data.issues).toEqual([]);
    // the catalogue's required fields count (goto → target)
    const v = await t.api.post(`/api/workflows/${id}/validate`, { steps: [{ id: 'g', type: 'goto' }] });
    expect(v.data).toMatchObject({ ok: false, issues: [{ step: 'g', code: 'required', field: 'target' }] });
    expect((await t.api.post(`/api/workflows/${id}/validate`, {})).data).toEqual({ ok: true, issues: [] });
  });

  it('validating someone else’s workflow is not found', async () => {
    expect((await t.api.post('/api/workflows/nope/validate', {})).status).toBe(404);
  });
});
