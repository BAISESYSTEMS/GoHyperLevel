import { describe, expect, it } from 'vitest';
import { COMMUNITY_DEFAULTS, changedAgainst, communityMoreValues, MAIN_FIELDS, SEQUENCE_DEFAULTS, STEP_MORE, WEBINAR_DEFAULT_BUTTON, WEBINAR_DEFAULT_TAGS, webinarMoreValues, campaignMoreValues, sequenceMoreValues, changedFieldValues, hasStepMore, isCustomized, isTuningField, splitCatalogFields, stepMoreValues, type CatalogField } from '../web/src/areas/marketing-fields';
import { anyFilled } from '../web/src/areas/fields-model';
import { defaultSettings } from '../server/services/webinar-model';
import { DEFAULT_SCHEDULE } from '../server/services/webinar-schedule';
import { DEFAULT_SETTINGS as EMAIL_SETTINGS, blockDefaults, newBlock } from '../server/services/email-render';
import { DEFAULT_LEVEL_POINTS, DEFAULT_SETTINGS as COMMUNITY_SETTINGS } from '../server/services/community';

const keys = (fs: CatalogField[]) => fs.map((f) => f.key);

describe('splitCatalogFields (Einfach-Modus of catalogue-built workflow steps)', () => {
  // the shape of the "HTTP-Anfrage" step (server/services/wfx-http.ts)
  const http: CatalogField[] = [
    { key: 'method', default: 'POST' },
    { key: 'url', required: true },
    { key: 'query' },
    { key: 'headers' },
    { key: 'auth', default: 'none' },
    { key: 'auth_user', showIf: { field: 'auth', in: ['basic', 'header'] } },
    { key: 'auth_secret', showIf: { field: 'auth', in: ['bearer', 'basic', 'header'] } },
    { key: 'body_type', default: 'json' },
    { key: 'body', showIf: { field: 'body_type', in: ['json', 'form', 'text'] } },
    { key: 'retries', default: 2 },
    { key: 'timeout_s', default: 15 },
    { key: 'fail_on_error', type: 'bool', default: true },
    { key: 'response_var', default: 'response' },
    { key: 'map' },
  ];

  it('keeps the action fields and folds retries, timeouts, headers, auth and response mapping', () => {
    const { main, more } = splitCatalogFields(http);
    expect(keys(main)).toEqual(['method', 'url', 'body_type', 'body']);
    expect(keys(more)).toEqual(['query', 'headers', 'auth', 'auth_user', 'auth_secret', 'retries', 'timeout_s', 'fail_on_error', 'response_var', 'map']);
  });

  it('never loses or duplicates a field and keeps the order', () => {
    const { main, more } = splitCatalogFields(http);
    expect([...main, ...more].sort((a, b) => a.key.localeCompare(b.key))).toEqual([...http].sort((a, b) => a.key.localeCompare(b.key)));
    expect(keys(main)).toEqual(keys(http).filter((k) => keys(main).includes(k)));
  });

  it('shows at most MAIN_FIELDS optional fields, but every required one', () => {
    const many: CatalogField[] = Array.from({ length: 9 }, (_, i) => ({ key: `f${i}` }));
    many.push({ key: 'late', required: true });
    const { main, more } = splitCatalogFields(many);
    expect(keys(main)).toEqual([...Array.from({ length: MAIN_FIELDS }, (_, i) => `f${i}`), 'late']);
    expect(keys(more)).toEqual(['f5', 'f6', 'f7', 'f8']);
  });

  it('a field shown for a value of another field follows it, also over several levels, without counting', () => {
    const fs: CatalogField[] = [
      { key: 'mode' },
      { key: 'a', showIf: { field: 'mode', in: ['x'] } },
      { key: 'b', showIf: { field: 'a', in: ['y'] } },
      { key: 'c' },
      { key: 'd' },
      { key: 'e' },
      { key: 'f' },
      { key: 'g' },
      { key: 'h', showIf: { field: 'g', in: ['1'] } },
    ];
    const { main, more } = splitCatalogFields(fs);
    expect(keys(main)).toEqual(['mode', 'a', 'b', 'c', 'd', 'e', 'f']);
    expect(keys(more)).toEqual(['g', 'h']);
  });

  it('a required tuning-looking field stays visible; small forms stay as they are', () => {
    expect(isTuningField({ key: 'timeout_amount', required: true })).toBe(false);
    expect(isTuningField({ key: 'timeout_amount' })).toBe(true);
    const small: CatalogField[] = [{ key: 'title', required: true }, { key: 'description' }, { key: 'due_in_days' }];
    expect(splitCatalogFields(small).more).toEqual([]);
  });

  it('survives a showIf loop', () => {
    const loop: CatalogField[] = [
      { key: 'a', showIf: { field: 'b', in: ['1'] } },
      { key: 'b', showIf: { field: 'a', in: ['1'] } },
    ];
    const { main, more } = splitCatalogFields(loop);
    expect(main.length + more.length).toBe(2);
  });
});

describe('changedFieldValues / isCustomized (a folded section with a changed value opens by itself)', () => {
  it('defaults filled in by a new step do not count, changes do', () => {
    const fs: CatalogField[] = [{ key: 'retries', default: 2 }, { key: 'fail_on_error', default: true }, { key: 'map' }];
    expect(anyFilled(changedFieldValues(fs, { retries: 2, fail_on_error: true, map: [] }))).toBe(false);
    expect(changedFieldValues(fs, { retries: 4 })).toEqual([true, false, false]);
    expect(changedFieldValues(fs, { fail_on_error: false })).toEqual([false, true, false]);
    expect(changedFieldValues(fs, { map: [{ path: 'id', to: 'var.id' }] })).toEqual([false, false, true]);
  });

  it('empty values are unset', () => {
    for (const v of [undefined, null, '', []]) expect(isCustomized(v)).toBe(false);
    expect(isCustomized(false)).toBe(false);
    expect(isCustomized(0)).toBe(true);
    expect(isCustomized('x')).toBe(true);
  });
});

describe('stepMoreValues (workflow steps with their own editor)', () => {
  it('a fresh step keeps its "Weitere Felder" closed', () => {
    expect(anyFilled(stepMoreValues({ id: 's1', type: 'send_email', subject: 'Hi', body: 'Text' }))).toBe(false);
    expect(anyFilled(stepMoreValues({ id: 's2', type: 'webhook', url: 'https://x', method: 'POST' }))).toBe(false);
    expect(anyFilled(stepMoreValues({ id: 's3', type: 'move_opportunity', create_if_missing: true }))).toBe(false);
    expect(anyFilled(stepMoreValues({ id: 's4', type: 'wait', amount: 1, unit: 'days' }))).toBe(false);
  });

  it('opens when a secondary setting holds something', () => {
    expect(anyFilled(stepMoreValues({ type: 'send_email', isHtml: true }))).toBe(true);
    expect(anyFilled(stepMoreValues({ type: 'send_sms', purpose: 'transactional' }))).toBe(true);
    expect(anyFilled(stepMoreValues({ type: 'webhook', method: 'GET' }))).toBe(true);
    expect(anyFilled(stepMoreValues({ type: 'move_opportunity', create_if_missing: false }))).toBe(true);
    expect(anyFilled(stepMoreValues({ type: 'if', expression: "'vip' in contact.tags" }))).toBe(true);
    expect(anyFilled(stepMoreValues({ type: 'create_opportunity', currency: 'CHF' }))).toBe(true);
    // every step: its name in the flow and "ignore errors"
    expect(anyFilled(stepMoreValues({ type: 'ai_text', name: 'Antwort schreiben' }))).toBe(true);
    expect(anyFilled(stepMoreValues({ type: 'add_tag', continue_on_error: true }))).toBe(true);
  });

  it('a designed e-mail is HTML by itself and does not open the section', () => {
    expect(anyFilled(stepMoreValues({ type: 'send_email', design: { sections: [] }, isHtml: true }))).toBe(false);
  });

  it('knows which steps have secondary settings of their own', () => {
    expect(hasStepMore('send_email')).toBe(true);
    expect(hasStepMore('http_request')).toBe(false);
    for (const type of Object.keys(STEP_MORE)) expect(hasStepMore(type)).toBe(true);
  });
});

describe('campaignMoreValues (campaign editor)', () => {
  it('a new draft folds sender name, segment, A/B test, follow-up, send time and speed', () => {
    const v = campaignMoreValues({ channel: 'email', name: 'Neu', filter: { tags: ['kunde'] } });
    expect(anyFilled(v.content)).toBe(false);
    expect(anyFilled(v.audience)).toBe(false);
    expect(anyFilled(v.extras)).toBe(false);
    expect(anyFilled(v.sending)).toBe(false);
  });

  it('each section opens when it holds something', () => {
    const v = campaignMoreValues({ sender_name: 'Anna', filter: { excludeTags: ['abgemeldet'] }, resend: { enabled: true }, speed_per_hour: 100 });
    expect(anyFilled(v.content)).toBe(true);
    expect(anyFilled(v.audience)).toBe(true);
    expect(anyFilled(v.extras)).toBe(true);
    expect(anyFilled(v.sending)).toBe(true);
    expect(anyFilled(campaignMoreValues({ ab: { enabled: true } }).extras)).toBe(true);
    expect(anyFilled(campaignMoreValues({ send_mode: 'sto' }).sending)).toBe(true);
    expect(anyFilled(campaignMoreValues({ filter: { segment_id: 'seg1' } }).audience)).toBe(true);
  });

  it('raw HTML only counts for plain-text mails (the designer always builds HTML)', () => {
    expect(anyFilled(campaignMoreValues({ is_html: 1 }).content)).toBe(true);
    expect(anyFilled(campaignMoreValues({ is_html: 1, design: { sections: [] } }).content)).toBe(false);
  });
});

describe('sequenceMoreValues (sales sequence editor)', () => {
  const fresh = () => ({ name: 'Messe', description: '', settings: JSON.parse(JSON.stringify(SEQUENCE_DEFAULTS)) });

  it('a new sequence with the default send window and stop rules keeps the section closed', () => {
    expect(anyFilled(sequenceMoreValues(fresh()))).toBe(false);
    expect(anyFilled(sequenceMoreValues({ name: 'alt', settings: {} }))).toBe(false);
  });

  it('opens for a description or any changed setting', () => {
    expect(anyFilled(sequenceMoreValues({ ...fresh(), description: 'Nach der Messe' }))).toBe(true);
    const a = fresh();
    a.settings.window.from = '08:00';
    expect(anyFilled(sequenceMoreValues(a))).toBe(true);
    const b = fresh();
    b.settings.window.enabled = false;
    expect(anyFilled(sequenceMoreValues(b))).toBe(true);
    const c = fresh();
    c.settings.stop_on.stage_change = true;
    expect(anyFilled(sequenceMoreValues(c))).toBe(true);
    expect(anyFilled(sequenceMoreValues({ ...fresh(), settings: { ...fresh().settings, footer: false } }))).toBe(true);
    expect(anyFilled(sequenceMoreValues({ ...fresh(), settings: { ...fresh().settings, shared_mailbox: true } }))).toBe(true);
  });
});

describe('webinarMoreValues (webinar editor tabs)', () => {
  const fresh = () => ({ title: 'Live-Demo', presenter_photo: '', slug: 'live-demo', schedule: JSON.parse(JSON.stringify(DEFAULT_SCHEDULE)), settings: JSON.parse(JSON.stringify(defaultSettings())) });

  it('stays in sync with the defaults of a new webinar', () => {
    expect(defaultSettings().tags).toEqual(WEBINAR_DEFAULT_TAGS);
    expect(defaultSettings().registration.button_text).toBe(WEBINAR_DEFAULT_BUTTON);
  });

  it('a new webinar keeps every folded section closed', () => {
    const v = webinarMoreValues(fresh(), DEFAULT_SCHEDULE);
    for (const part of [v.basics, v.schedule, v.registration, v.tags]) expect(anyFilled(part)).toBe(false);
  });

  it('opens a section that holds something of its own', () => {
    const w = fresh();
    w.presenter_photo = 'https://x/foto.jpg';
    w.schedule.jit.enabled = true;
    w.settings.registration.redirect_url = 'https://x/danke';
    w.settings.tags.attended = ['war-da'];
    const v = webinarMoreValues(w, DEFAULT_SCHEDULE);
    for (const part of [v.basics, v.schedule, v.registration, v.tags]) expect(anyFilled(part)).toBe(true);
    const late = fresh();
    late.schedule.late_join_min = 0;
    expect(anyFilled(webinarMoreValues(late, DEFAULT_SCHEDULE).schedule)).toBe(true);
    const button = fresh();
    button.settings.registration.button_text = 'Platz sichern';
    expect(anyFilled(webinarMoreValues(button, DEFAULT_SCHEDULE).registration)).toBe(true);
  });
});

describe('communityMoreValues (community group settings)', () => {
  it('stays in sync with the defaults of a new group', () => {
    const { levels: _l, ...rest } = COMMUNITY_SETTINGS;
    const { level_points, ...mine } = COMMUNITY_DEFAULTS;
    expect(mine).toEqual(rest);
    expect(level_points).toEqual(DEFAULT_LEVEL_POINTS);
  });

  it('a new group folds moderation and points; changes keep them open', () => {
    const fresh = JSON.parse(JSON.stringify(COMMUNITY_SETTINGS));
    const v = communityMoreValues(fresh);
    expect(anyFilled(v.moderation)).toBe(false);
    expect(anyFilled(v.points)).toBe(false);
    expect(anyFilled(communityMoreValues({ ...fresh, word_filter: ['spam'] }).moderation)).toBe(true);
    expect(anyFilled(communityMoreValues({ ...fresh, posts_per_hour: 0 }).moderation)).toBe(true);
    expect(anyFilled(communityMoreValues({ ...fresh, points: { post: 5, comment: 1, like: 1 } }).points)).toBe(true);
    expect(anyFilled(communityMoreValues({ ...fresh, levels: [{ name: 'Neu', points: 0 }] }).points)).toBe(true);
    expect(anyFilled(communityMoreValues({ ...fresh, level_unlocks: [{ level: 3, course_id: 'c1' }] }).points)).toBe(true);
  });
});

describe('changedAgainst (email designer look panels)', () => {
  it('a new block or design keeps "Darstellung" closed', () => {
    for (const type of ['heading', 'text', 'image', 'button', 'divider', 'social', 'video', 'html', 'footer'] as const) {
      const b = newBlock(type);
      expect(anyFilled(changedAgainst(b.style as any, blockDefaults(type).style as any))).toBe(false);
    }
    expect(anyFilled(changedAgainst({ ...EMAIL_SETTINGS } as any, EMAIL_SETTINGS as any, ['width', 'background', 'fontSize']))).toBe(false);
  });

  it('opens for a changed colour, alignment, padding or button look', () => {
    const b = newBlock('text');
    expect(anyFilled(changedAgainst({ ...b.style, color: '#ff0000' } as any, blockDefaults('text').style as any))).toBe(true);
    expect(anyFilled(changedAgainst({ ...b.style, align: 'center' } as any, blockDefaults('text').style as any))).toBe(true);
    expect(anyFilled(changedAgainst({ ...b.style, paddingY: 0 } as any, blockDefaults('text').style as any))).toBe(true);
    expect(changedAgainst({ ...newBlock('button').props, radius: 20 }, blockDefaults('button').props, ['background', 'textColor', 'radius', 'fullWidth'])).toEqual([false, false, true, false]);
    expect(anyFilled(changedAgainst({ ...EMAIL_SETTINGS, width: 700 } as any, EMAIL_SETTINGS as any, ['width']))).toBe(true);
  });

  it('only looks at the given keys and ignores unset ones', () => {
    expect(changedAgainst({ a: 1, b: 2 }, { a: 1, b: 1 }, ['a'])).toEqual([false]);
    expect(changedAgainst(undefined, { a: 1 })).toEqual([false]);
    expect(changedAgainst({ extra: 'x' }, {})).toEqual([true]);
  });
});
