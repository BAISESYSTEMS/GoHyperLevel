import { describe, expect, it } from 'vitest';
import { requiredPermission } from '../server/core/permissions.js';
import { apiError, buildBody, costMicros, headersFor } from '../server/services/anthropic.js';
import {
  BOT_SCHEMA,
  botActive,
  budgetProblem,
  buildSystem,
  cleanSettings,
  contactBlock,
  defaultSettings,
  handoffAfter,
  handoffBefore,
  isOpenAt,
  knowledgeBlock,
  missingLead,
  parseBotOutput,
  parseSummary,
  redactSecrets,
  transcript,
  type BotOutput,
} from '../server/services/ai-context.js';

const valid: BotOutput = {
  reply: 'Eine Website kostet bei uns ab 990 €.',
  confidence: 0.9,
  handoff: false,
  handoff_reason: '',
  lead: { first_name: 'Mia', last_name: 'Muster', email: 'mia@example.com', phone: '+49 170 1234567' },
  buying_intent: true,
  intent_summary: 'Website-Angebot',
};
const j = (o: unknown) => JSON.stringify(o);

describe('request body (Claude Messages API)', () => {
  const req = { apiKey: 'k', model: 'claude-sonnet-5-5', system: buildSystem('Wissen'), messages: [{ role: 'user' as const, content: 'Hallo' }], maxTokens: 4000 };

  it('caches the static system part and runs Sonnet/Opus 5.5 at the highest effort they take (default xhigh) with fallbacks', () => {
    const b: any = buildBody({ ...req, schema: BOT_SCHEMA });
    expect(b.model).toBe('claude-sonnet-5-5');
    expect(b.system).toHaveLength(2);
    expect(b.system[0].cache_control).toBeUndefined();
    expect(b.system[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(b.output_config).toEqual({ effort: 'high', format: { type: 'json_schema', schema: BOT_SCHEMA } });
    expect(b.fallbacks).toBe('default');
    // Removed/unsupported knobs on these models must not be sent.
    expect(b).not.toHaveProperty('thinking');
    expect(b).not.toHaveProperty('temperature');
    expect(headersFor('k', true)).toMatchObject({ 'x-api-key': 'k', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'server-side-fallback-2026-07-01' });
    expect(headersFor('k', false)).not.toHaveProperty('anthropic-beta');
  });

  it('sends no effort and no fallbacks to Haiku 4.5', () => {
    const b: any = buildBody({ ...req, model: 'claude-haiku-4-5' });
    expect(b).not.toHaveProperty('output_config');
    expect(b).not.toHaveProperty('fallbacks');
    expect((buildBody({ ...req, model: 'claude-opus-5-5' }) as any).output_config.effort).toBe('xhigh');
    expect((buildBody({ ...req, model: 'claude-opus-5-5', effort: 'low' }) as any).output_config.effort).toBe('low');
  });

  it('prices tokens per model in micro-dollars', () => {
    expect(costMicros('claude-sonnet-5-5', { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0 })).toBe(7000);
    expect(costMicros('claude-opus-5-5', { input_tokens: 0, output_tokens: 0, cache_read_tokens: 10_000, cache_write_tokens: 1000 })).toBe(7000);
    expect(costMicros('unknown-model', { input_tokens: 1000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, 'claude-haiku-4-5')).toBe(1000);
  });

  it('turns API errors into German messages', () => {
    expect(apiError(401, '').message).toContain('API-Schlüssel ist ungültig');
    expect(apiError(429, '').status).toBe(429);
    expect(apiError(529, '').message).toContain('überlastet');
    expect(apiError(500, '').status).toBe(503);
  });
});

describe('secrets never reach the model', () => {
  it('strips keys, passwords, cards and IBANs but keeps normal text and phone numbers', () => {
    const s = redactSecrets(
      'Mein Key sk-ant-api03-abcdefghijklmnopqrstuvwxyz und Passwort: hunter2!\nIBAN DE89 3704 0044 0532 0130 00, Karte 4111 1111 1111 1111. Ruf an: +49 170 1234567. Token pghl_abcdefghijklmnop1234',
    );
    expect(s).not.toContain('sk-ant-api03');
    expect(s).not.toContain('hunter2');
    expect(s).not.toContain('DE89 3704');
    expect(s).not.toContain('4111 1111');
    expect(s).not.toContain('pghl_abcdefghijklmnop1234');
    expect(s).toContain('+49 170 1234567');
    expect(s).toContain('Passwort: [entfernt]');
    expect(redactSecrets('Rechnung 2026-0042 über 1.234,56 €')).toBe('Rechnung 2026-0042 über 1.234,56 €');
  });
});

describe('context building', () => {
  it('puts persona, facts, Q&A, profile and website FAQ into the knowledge block', () => {
    const s = { ...defaultSettings(), persona: 'Locker, per du.', facts: 'Gegründet 2019 in Leipzig.', knowledge: [{ q: 'Was kostet eine Website?', a: 'Ab 990 €.' }], knowledge_text: 'Wir arbeiten remote.' };
    const k = knowledgeBlock({ locationName: 'Malerei Muster', website: 'https://maler.example', settings: s, profile: { tagline: 'Farbe für Leipzig', description: 'Malerbetrieb' }, faqs: [{ q: 'Wie lange dauert es?', a: 'Zwei Wochen.' }] });
    for (const part of ['Malerei Muster', 'Locker, per du.', 'Gegründet 2019', 'F: Was kostet eine Website?', 'A: Ab 990 €.', 'Wir arbeiten remote.', 'Farbe für Leipzig', 'Wie lange dauert es?']) expect(k).toContain(part);
    const off = knowledgeBlock({ locationName: 'X', settings: { ...s, use_project_profile: false, use_faq_blocks: false }, profile: { tagline: 'Farbe für Leipzig' }, faqs: [{ q: 'Wie lange dauert es?', a: 'x' }] });
    expect(off).not.toContain('Farbe für Leipzig');
    expect(off).not.toContain('Wie lange dauert es?');
  });

  it('describes the contact without credential-like fields', () => {
    const block = contactBlock({ first_name: 'Anna', last_name: 'Beispiel', email: 'anna@example.com', tags: ['lead', 'vip'], custom: { budget: '5000', passwort: 'geheim123', api_key: 'x' }, created_at: '2026-01-02T10:00:00Z' }, { opportunities: ['Website (Vertrieb, 990 €)'] });
    expect(block).toContain('Vorname: Anna');
    expect(block).toContain('Tags: lead, vip');
    expect(block).toContain('Feld budget: 5000');
    expect(block).toContain('Website (Vertrieb, 990 €)');
    expect(block).not.toContain('geheim123');
    expect(block).not.toContain('api_key');
    expect(contactBlock({ first_name: 'Website-Besucher' })).not.toContain('Website-Besucher');
    expect(missingLead({ first_name: 'Website-Besucher', email: '' })).toEqual(['Name', 'E-Mail']);
    expect(missingLead({ first_name: 'Anna', email: 'a@b.de' })).toEqual([]);
  });

  it('keeps the last 20 real messages, labels who wrote and drops drafts', () => {
    const msgs = Array.from({ length: 25 }, (_, i) => ({ direction: i % 2 ? 'out' : 'in', channel: 'chat', body: `Nachricht ${i + 1}.`, source: i === 23 ? 'KI-Assistent' : '', created_at: new Date(Date.UTC(2026, 9, 1, 10, i)).toISOString() }));
    msgs.push({ direction: 'out', channel: 'email', body: 'Entwurf!', source: '', created_at: new Date(Date.UTC(2026, 9, 1, 11)).toISOString(), status: 'draft' } as any);
    const t = transcript(msgs, 'Europe/Berlin');
    expect(t).not.toContain('Nachricht 5.');
    expect(t).toContain('Nachricht 6.');
    expect(t).toContain('Nachricht 25.');
    expect(t).not.toContain('Entwurf!');
    expect(t).toContain('· Chat · Kunde]');
    expect(t).toContain('· Chat · Team]');
    expect(t).toContain('· Chat · Assistent (KI)]');
    expect(transcript([{ direction: 'in', channel: 'email', subject: 'Hi', body: '<p>Hallo<br>Welt</p>', created_at: '2026-10-01T10:00:00Z' }], 'Europe/Berlin')).toContain('Betreff: Hi\nHallo\nWelt');
  });
});

describe('bot gating, business hours and handoff', () => {
  // Monday 2026-10-05, 10:00 and 20:00 in Berlin (UTC+2).
  const monMorning = new Date('2026-10-05T08:00:00Z');
  const monEvening = new Date('2026-10-05T18:00:00Z');
  const sunday = new Date('2026-10-04T08:00:00Z');

  it('knows the business hours', () => {
    const h = defaultSettings().business_hours;
    expect(isOpenAt(h, 'Europe/Berlin', monMorning)).toBe(true);
    expect(isOpenAt(h, 'Europe/Berlin', monEvening)).toBe(false);
    expect(isOpenAt(h, 'Europe/Berlin', sunday)).toBe(false);
    expect(isOpenAt({ ...h, sun: { open: true, from: '00:00', to: '00:00' } }, 'Europe/Berlin', sunday)).toBe(true);
    expect(isOpenAt({ ...h, mon: { open: true, from: '19:00', to: '07:00' } }, 'Europe/Berlin', monEvening)).toBe(true);
  });

  it('answers only in the configured mode', () => {
    const s = { ...defaultSettings(), enabled: true };
    expect(botActive({ ...s, bot_mode: 'off' }, 'Europe/Berlin', monEvening)).toBe(false);
    expect(botActive({ ...s, bot_mode: 'always' }, 'Europe/Berlin', monMorning)).toBe(true);
    expect(botActive({ ...s, bot_mode: 'after_hours' }, 'Europe/Berlin', monMorning)).toBe(false);
    expect(botActive({ ...s, bot_mode: 'after_hours' }, 'Europe/Berlin', monEvening)).toBe(true);
    expect(botActive({ ...s, bot_mode: 'after_hours' }, 'Europe/Berlin', sunday)).toBe(true);
    expect(botActive({ ...s, enabled: false, bot_mode: 'always' }, 'Europe/Berlin', monEvening)).toBe(false);
  });

  it('hands over when a person is wanted, on keywords and after too many replies', () => {
    const o = { keywords: ['beschwerde', 'anwalt'], botReplies: 0, maxReplies: 8 };
    expect(handoffBefore('Kann ich bitte mit einem Mitarbeiter sprechen?', o)).toContain('Menschen');
    expect(handoffBefore('Ich will einen echten Menschen!', o)).toContain('Menschen');
    expect(handoffBefore('Ruft mich bitte zurück', o)).not.toBeNull();
    expect(handoffBefore('Can I talk to a human?', o)).not.toBeNull();
    expect(handoffBefore('Ich habe eine Beschwerde.', o)).toBe('Stichwort „beschwerde“');
    expect(handoffBefore('Wie viele Mitarbeiter habt ihr?', o)).toBeNull();
    expect(handoffBefore('Was kostet eine Website?', o)).toBeNull();
    expect(handoffBefore('Beschwerdemanagement als Leistung?', o)).toBeNull();
    expect(handoffBefore('Was kostet das?', { ...o, botReplies: 8 })).toContain('8 Antworten');
  });

  it('hands over when the model is unsure or asks for it', () => {
    expect(handoffAfter(valid, 0.6)).toBeNull();
    expect(handoffAfter({ ...valid, confidence: 0.4 }, 0.6)).toContain('40 %');
    expect(handoffAfter({ ...valid, handoff: true, handoff_reason: 'Individuelles Angebot' }, 0.6)).toBe('KI: Individuelles Angebot');
  });
});

describe('strict parsing of the bot JSON (lead capture)', () => {
  it('accepts exactly the contract', () => {
    const r = parseBotOutput(j(valid));
    expect(r.ok && r.value.lead.email).toBe('mia@example.com');
    expect(parseBotOutput(j({ ...valid, reply: '', handoff: true, handoff_reason: 'Beschwerde' })).ok).toBe(true);
  });

  it('rejects anything else', () => {
    const bad: [unknown, string][] = [
      ['not json', 'Kein gültiges JSON'],
      ['```json\n' + j(valid) + '\n```', 'Kein gültiges JSON'],
      [j([valid]), 'JSON-Objekt erwartet'],
      [j({ ...valid, extra: 1 }), 'unbekanntes Feld extra'],
      [j({ ...valid, lead: undefined }), 'Feld lead fehlt'],
      [j({ ...valid, confidence: 1.5 }), 'confidence'],
      [j({ ...valid, confidence: '0.9' }), 'confidence'],
      [j({ ...valid, handoff: 'nein' }), 'handoff'],
      [j({ ...valid, buying_intent: 1 }), 'buying_intent'],
      [j({ ...valid, reply: '' }), 'reply leer'],
      [j({ ...valid, reply: 'x'.repeat(1501) }), 'reply'],
      [j({ ...valid, lead: { ...valid.lead, email: 'keine-mail' } }), 'lead.email'],
      [j({ ...valid, lead: { ...valid.lead, phone: 'ruf mich an' } }), 'lead.phone'],
      [j({ ...valid, lead: { ...valid.lead, first_name: '<script>' } }), 'lead.first_name'],
      [j({ ...valid, lead: { ...valid.lead, company: 'X' } }), 'unbekanntes Feld company'],
      [j({ ...valid, lead: { first_name: 'Mia', last_name: '', email: '' } }), 'Feld phone fehlt'],
    ];
    for (const [raw, err] of bad) {
      const r = parseBotOutput(raw as string);
      expect(r.ok, String(raw).slice(0, 60)).toBe(false);
      if (!r.ok) expect(r.error).toContain(err);
    }
  });

  it('parses summaries strictly too', () => {
    expect(parseSummary(j({ summary: 'Anna will ein Angebot.', next_step: 'Angebot schicken' }))).toEqual({ ok: true, value: { summary: 'Anna will ein Angebot.', next_step: 'Angebot schicken' } });
    expect(parseSummary(j({ summary: '', next_step: '' })).ok).toBe(false);
    expect(parseSummary(j({ summary: 'x', next_step: 'y', more: 1 })).ok).toBe(false);
  });
});

describe('settings and budget', () => {
  it('validates settings', () => {
    const s = defaultSettings();
    expect(() => cleanSettings({ model: 'gpt-4' }, s)).toThrow('Unbekanntes Modell');
    expect(() => cleanSettings({ monthly_limit_usd: 0 }, s)).toThrow('Monatslimit');
    expect(() => cleanSettings({ business_hours: { mon: { open: true, from: '9', to: '17:00' } } }, s)).toThrow('HH:MM');
    expect(() => cleanSettings({ bot_mode: 'sometimes' }, s)).toThrow('Bot-Modus');
    const next = cleanSettings({ model: 'claude-haiku-4-5', handoff_keywords: [' Anwalt ', 'anwalt', ''], knowledge: [{ q: 'A?', a: 'B' }, { q: '', a: 'leer' }] }, s);
    expect(next.model).toBe('claude-haiku-4-5');
    expect(next.handoff_keywords).toEqual(['anwalt']);
    expect(next.knowledge).toEqual([{ q: 'A?', a: 'B' }]);
  });

  it('stops at the monthly cost or token limit', () => {
    const s = { ...defaultSettings(), monthly_limit_usd: 5, monthly_token_limit: 0 };
    expect(budgetProblem(s, { cost_micros: 4_990_000, tokens: 1e9 })).toBeNull();
    expect(budgetProblem(s, { cost_micros: 5_000_000, tokens: 0 })).toContain('Monatslimit');
    expect(budgetProblem({ ...s, monthly_token_limit: 1000 }, { cost_micros: 0, tokens: 1000 })).toContain('Token-Limit');
  });

  it('maps the routes to permission areas', () => {
    expect(requiredPermission('POST', '/api/ai/suggest')).toBe('conversations');
    expect(requiredPermission('GET', '/api/ai/conversations/abc')).toBe('conversations');
    expect(requiredPermission('PUT', '/api/ai/settings')).toBe('settings');
    expect(requiredPermission('GET', '/api/ai/usage')).toBe('settings');
    expect(requiredPermission('GET', '/api/ai/status')).toBeUndefined();
  });
});
