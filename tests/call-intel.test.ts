import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { client } from './security-fixtures.js';
import { retry } from '../server/services/anthropic.js';
import { twilioSignature } from '../server/services/twilio.js';
import { wavFromPcm } from '../server/services/voice-audio.js';
import {
  ANALYSIS_SCHEMA,
  SCORECARD_TEMPLATES,
  analysisPrompt,
  cleanCriteria,
  countFillers,
  keywords,
  normalise,
  parseAnalysis,
  parseScores,
  promptTranscript,
  questionCount,
  scoreTotal,
  sentimentOf,
  splitChannels,
  talkStats,
  wavChunks,
  wordCount,
  FILLERS,
  type Criterion,
} from '../server/services/call-intel.js';
import type { AppEvent } from '../server/core/events.js';
import { requiredPermission } from '../server/core/permissions.js';

const SID = `AC${'0'.repeat(31)}1`;
const TOKEN = 'f'.repeat(32);
const TWILIO_NUMBER = '+4930123456';
const MOBILE = '+4915112345678';
const KEY = 'sk-ant-api03-testkey-abcdefghijklmnopqrstuvwxyz0123';
const callSid = (n: number) => `CA${String(n).padStart(32, '0')}`;
const recSid = (n: number) => `RE${String(n).padStart(32, '0')}`;
const RATE = 8000;

/** Two channels at 8 kHz: a tone where somebody speaks, hiss otherwise. Channel 0 = caller, channel 1 = us. */
function stereo(spans: [number, number][][]): Buffer {
  const seconds = Math.max(...spans.flat().map(([, b]) => b)) + 0.5;
  const n = Math.round(RATE * seconds);
  const pcm = new Int16Array(n * 2);
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      const speaking = spans[c].some(([a, b]) => t >= a && t < b);
      pcm[i * 2 + c] = speaking ? Math.round(Math.sin(2 * Math.PI * (200 + 150 * c) * t) * 9000) : Math.round(((i * 7919) % 5) - 2);
    }
  }
  return wavFromPcm(pcm, RATE, 2);
}
const CALLER = [[0.2, 2.2], [3.6, 4.1]] as [number, number][]; // 2.5 s
const AGENT = [[2.3, 3.5], [4.2, 6.2]] as [number, number][]; // 3.2 s
const CALL_WAV = stereo([CALLER, AGENT]);

// --- the fakes -----------------------------------------------------------------------------------------------------------------
const stt: string[] = [];
let sttCalls = 0;
let sttFail = false;
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
const fakeStt = (async (url: string) => {
  if (!String(url).endsWith('/audio/transcriptions')) return json({ error: 'no route' }, 404);
  sttCalls++;
  if (sttFail) return json({ error: { message: 'quota' } }, 429);
  return json({ text: stt.shift() ?? 'Das ist ein kurzer Text ohne besondere Wörter.' });
}) as unknown as (url: string, init?: any) => Promise<Response>;

const claude: { prompt: string }[] = [];
let claudeMode: 'ok' | 'down' | 'garbage' = 'ok';
const ANALYSIS = {
  title: 'Angebot für 20 Lizenzen',
  summary: 'Die Kundin möchte ein Angebot für 20 Lizenzen, findet den Preis aber zu hoch. Wir schicken bis Freitag ein Angebot.',
  next_step: 'Angebot bis Freitag senden',
  action_items: [
    { title: 'Angebot für 20 Lizenzen senden', owner: 'agent', due: '2026-10-09' },
    { title: 'Budget intern klären', owner: 'customer', due: '' },
    { title: 'Angebot für 20 Lizenzen senden', owner: 'agent', due: '' },
  ],
  topics: ['Angebot', 'Preis', 'Lizenzen'],
  objections: ['Preis zu hoch'],
  sentiment: { overall: 'gemischt', score: 0.1, customer: 'negativ', agent: 'positiv' },
};
const fakeClaude = (async (_u: string, init: any = {}) => {
  const body = JSON.parse(init.body);
  const prompt: string = body.messages[0].content;
  claude.push({ prompt });
  const reply = (text: string, status = 200) => new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 200 } }), { status, headers: { 'content-type': 'application/json' } });
  if (claudeMode === 'down') return new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 529, headers: { 'content-type': 'application/json' } });
  if (claudeMode === 'garbage') return reply('keine json');
  if (prompt.includes('nach der Checkliste')) {
    const ids = [...prompt.matchAll(/- id "(\w+)"/g)].map((m) => m[1]);
    return reply(JSON.stringify({ scores: ids.map((id, i) => ({ id, applicable: id !== 'redeanteil', score: i % 2 ? 1 : 4, reason: `Grund ${id}`, quote: 'Gerne, wir schicken das Angebot' })) }));
  }
  return reply(JSON.stringify(ANALYSIS));
}) as unknown as typeof fetch;

const twilioRequests: string[] = [];
let recordingWav: Buffer = CALL_WAV;
const fakeTwilio = (async (input: any) => {
  const url = String(input);
  twilioRequests.push(url);
  if (/\/Recordings\/RE\d{32}\.wav\?RequestedChannels=2$/.test(url)) return new Response(new Uint8Array(recordingWav), { status: 200, headers: { 'content-type': 'audio/wav' } });
  if (/\/Recordings\/RE\d{32}\.mp3$/.test(url)) return new Response(new Uint8Array(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(300, 1)])), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  return json({ message: 'not found' }, 404);
}) as unknown as typeof fetch;

describe('counting a conversation (pure)', () => {
  it('counts words, questions and filler words (whole words only)', () => {
    expect(wordCount('Guten Tag, ich möchte 20 Lizenzen. Äh, ja?')).toBe(8);
    expect(questionCount('Wie viel? Und wann? Gut.')).toBe(2);
    const f = countFillers('Äh, also das ist sozusagen quasi eigentlich halt irgendwie ähm gut. Haltung ist wichtig. Ich sag mal so.', FILLERS.de);
    expect(f.by).toMatchObject({ äh: 1, ähm: 1, sozusagen: 1, quasi: 1, eigentlich: 1, halt: 1, irgendwie: 1, 'ich sag mal': 1 });
    expect(f.by['halt']).toBe(1); // "Haltung" is not "halt"
    expect(f.total).toBe(8);
    expect(countFillers('um, you know, it is like basically fine', FILLERS.en).total).toBe(4);
    expect(countFillers('Das war Spitze', ['spitze']).total).toBe(1);
  });

  it('finds the words that carry the conversation', () => {
    const k = keywords('Wir brauchen ein Angebot. Das Angebot muss günstig sein, die Lizenzen auch. Lizenzen und Angebot, dann der Preis. Der Preis zählt.', 5);
    expect(k.slice(0, 3)).toEqual(['angebot', 'lizenzen', 'preis']);
    expect(k).not.toContain('wir');
    expect(keywords('eins zwei drei vier', 5)).toEqual([]); // nothing twice
  });

  it('reads the mood from a word list, with negation', () => {
    expect(sentimentOf('Das ist super, vielen Dank, ich bin begeistert und zufrieden.')).toMatchObject({ label: 'positiv' });
    expect(sentimentOf('Das ist ein Problem, leider ärgerlich, ich bin enttäuscht und unzufrieden.')).toMatchObject({ label: 'negativ' });
    expect(sentimentOf('Das ist nicht gut und nicht schlecht').label).toBe('neutral');
    expect(sentimentOf('Das war nicht schlecht, wirklich nicht schlecht').score).toBeGreaterThan(0);
    expect(sentimentOf('Ich rufe wegen einem Termin an.').label).toBe('neutral');
    expect(sentimentOf('Super Service, toll, aber leider ein Problem und ärgerlich und schlimm und gut und perfekt.').label).toBe('gemischt');
  });
});

describe('who spoke when (pure)', () => {
  it('reads the channels of a stereo WAV and measures talk time, overlap and the longest stretch', () => {
    const ch = splitChannels(CALL_WAV)!;
    expect(ch.rate).toBe(RATE);
    expect(ch.pcm).toHaveLength(2);
    expect(splitChannels(Buffer.from('ID3....'))).toBeNull();
    const t = talkStats(ch.pcm, ch.rate);
    expect(Math.abs(t.talk_ms[0] - 2500)).toBeLessThanOrEqual(120);
    expect(Math.abs(t.talk_ms[1] - 3200)).toBeLessThanOrEqual(120);
    expect(t.overlap_ms).toBeLessThanOrEqual(100);
    expect(Math.abs(t.longest_ms[1] - 2000)).toBeLessThanOrEqual(120); // the pause before it was filled by the caller
    expect(Math.abs(t.longest_ms[0] - 2000)).toBeLessThanOrEqual(120);
    expect(t.turns).toBeGreaterThanOrEqual(2);
    // Interruptions: both speak for a second.
    const talkOver = talkStats(splitChannels(stereo([[[0.2, 2.2]], [[1.2, 3.2]]]))!.pcm, RATE);
    expect(Math.abs(talkOver.overlap_ms - 1000)).toBeLessThanOrEqual(120);
  });

  it('cuts a long channel into files the speech provider takes', () => {
    const pcm = new Int16Array(RATE * 25);
    const chunks = wavChunks(pcm, RATE, 10);
    expect(chunks).toHaveLength(3);
    expect(splitChannels(chunks[0])!.pcm[0].length).toBe(RATE * 10);
    expect(wavChunks(new Int16Array(0), RATE)).toHaveLength(1);
  });
});

describe('the AI answers (pure)', () => {
  it('parses a good analysis and drops broken list entries and repeated tasks', () => {
    const p = parseAnalysis(JSON.stringify(ANALYSIS));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.value.action_items).toEqual([
      { title: 'Angebot für 20 Lizenzen senden', owner: 'agent', due: '2026-10-09', done: false, task_id: null },
      { title: 'Budget intern klären', owner: 'customer', due: '', done: false, task_id: null },
    ]);
    expect(p.value.sentiment).toEqual({ overall: 'gemischt', score: 0.1, customer: 'negativ', agent: 'positiv' });
    const messy = parseAnalysis(JSON.stringify({ ...ANALYSIS, action_items: [{ title: '', owner: 'agent', due: '' }, 'x', { title: 'Ok', owner: 'hacker', due: 'morgen' }], sentiment: { overall: 'positiv', score: 7, customer: 'x', agent: '' } }));
    expect(messy.ok && messy.value.action_items).toEqual([{ title: 'Ok', owner: 'agent', due: '', done: false, task_id: null }]);
    expect(messy.ok && messy.value.sentiment).toEqual({ overall: 'positiv', score: 1, customer: '', agent: '' });
  });

  it('refuses answers that are not the contract', () => {
    for (const bad of ['kein json', '[]', JSON.stringify({ ...ANALYSIS, summary: '' }), JSON.stringify({ ...ANALYSIS, sentiment: { overall: 'super', score: 0 } }), JSON.stringify({ ...ANALYSIS, topics: 'x' }), JSON.stringify({ title: 'x' })]) {
      expect(parseAnalysis(bad).ok, bad).toBe(false);
    }
    expect(ANALYSIS_SCHEMA.required).toContain('action_items');
  });

  it('puts the transcript in as data, without secrets, and cuts very long ones', () => {
    const p = analysisPrompt({ transcript: 'Meine IBAN ist DE02120300000000202051 und sk-ant-api03-geheimgeheimgeheim123', separated: true, today: 'Montag, 05.10.2026', contact: '<kontakt>Anna</kontakt>', kind: 'call', language: 'de' });
    expect(p).toContain('<gespraech art="Telefonat">');
    expect(p).not.toContain('DE02120300000000202051');
    expect(p).not.toContain('geheimgeheim');
    expect(p).toContain('Daten');
    expect(p).toContain('„Kunde:“ und „Mitarbeiter:“');
    const long = promptTranscript('wort '.repeat(30_000));
    expect(long.length).toBeLessThan(62_000);
    expect(long).toContain('ausgelassen');
  });
});

describe('scorecard arithmetic (pure)', () => {
  const crit: Criterion[] = [
    { id: 'a', label: 'A', description: '', weight: 3, scale: 'five' },
    { id: 'b', label: 'B', description: '', weight: 1, scale: 'yesno' },
    { id: 'c', label: 'C', description: '', weight: 2, scale: 'five' },
  ];
  it('weights the points and leaves out what does not apply', () => {
    expect(normalise(crit[0], 5)).toBe(1);
    expect(normalise(crit[0], 1)).toBe(0);
    expect(normalise(crit[0], 3)).toBe(0.5);
    expect(normalise(crit[1], 1)).toBe(1);
    expect(scoreTotal(crit, { a: 5, b: 1, c: 5 })).toBe(100);
    expect(scoreTotal(crit, { a: 1, b: 0, c: 1 })).toBe(0);
    expect(scoreTotal(crit, { a: 5, b: 0, c: 3 })).toBe(66.7); // (3·1 + 1·0 + 2·0.5) / 6
    expect(scoreTotal(crit, { a: 5, b: null, c: null })).toBe(100);
    expect(scoreTotal(crit, { a: null, b: undefined })).toBeNull();
  });
  it('validates criteria and ships templates', () => {
    expect(cleanCriteria([{ label: 'Freundlich', weight: 20, scale: 'yesno' }, { label: 'Fragen', description: 'x'.repeat(500) }])).toEqual([
      { id: 'k1', label: 'Freundlich', description: '', weight: 10, scale: 'yesno' },
      { id: 'k2', label: 'Fragen', description: 'x'.repeat(400), weight: 1, scale: 'five' },
    ]);
    expect(() => cleanCriteria([])).toThrow(/mindestens ein Kriterium/);
    expect(() => cleanCriteria([{ label: '' }])).toThrow(/Bezeichnung/);
    expect(() => cleanCriteria([{ id: 'Ab c', label: 'x' }])).toThrow(/Schlüssel/);
    expect(() => cleanCriteria([{ id: 'a1', label: 'x' }, { id: 'a1', label: 'y' }])).toThrow(/doppelt/);
    for (const tpl of SCORECARD_TEMPLATES) expect(() => cleanCriteria(tpl.criteria)).not.toThrow();
  });
  it('accepts only known criteria and scores inside their scale', () => {
    const ok = parseScores(JSON.stringify({ scores: [{ id: 'a', applicable: true, score: 9, reason: 'r', quote: 'q' }, { id: 'b', applicable: true, score: 0.4, reason: '', quote: '' }, { id: 'c', applicable: false, score: 3, reason: '', quote: '' }, { id: 'zzz', applicable: true, score: 1, reason: '', quote: '' }] }), crit);
    expect(ok.ok && ok.value).toEqual({ a: { score: 5, reason: 'r', quote: 'q' }, b: { score: 0, reason: '', quote: '' }, c: { score: null, reason: '', quote: '' } });
    expect(parseScores('{"scores":[{"id":"zzz"}]}', crit).ok).toBe(false);
    expect(parseScores('nope', crit).ok).toBe(false);
  });
});

describe('analysing conversations', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  let loc = '';
  const events: AppEvent[] = [];
  let contactId = '';
  let adminId = '';
  const settings = (patch: Record<string, unknown>) => t.api.put('/api/call-intel/settings', patch);
  const idle = () => t.app.services.callIntel.idle();
  const hook = async (name: string, params: Record<string, string>, query = '') => {
    const path = `/hooks/twilio/${name}/${loc}${query}`;
    const r = await t.api.raw(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(TOKEN, `http://localhost${path}`, params) }, body: new URLSearchParams(params).toString() });
    return r.text();
  };
  /** A recorded conversation: inbound call, answered on the mobile, recording of 61 s finished. */
  async function recordedCall(n: number, from = '+4917090001') {
    await hook('voice', { CallSid: callSid(n), From: from, To: TWILIO_NUMBER });
    await hook('voice-dial', { CallSid: callSid(n), DialCallStatus: 'completed', DialCallDuration: '65' });
    await hook('voice-recording', { CallSid: callSid(n), RecordingSid: recSid(n), RecordingStatus: 'completed', RecordingDuration: '61', RecordingChannels: '2' }, '?kind=dial');
    await t.app.events.flush();
    await idle();
    return t.app.db.get('SELECT * FROM calls WHERE sid = ?', callSid(n))!;
  }
  const intelOf = (callId: string) => t.app.db.get('SELECT * FROM call_intel WHERE call_id = ?', callId);
  const upload = (buf: Buffer, query: string, type = 'audio/mpeg') => t.api.raw(`/api/call-intel/upload?${query}&locationId=${loc}`, { method: 'POST', headers: { 'content-type': type, 'x-pghl': '1', cookie: t.api.cookie, 'x-location-id': loc }, body: buf });

  beforeAll(async () => {
    retry.ms = 1;
    t = await startTestApp();
    const me = await t.setup();
    adminId = me.user.id;
    loc = t.api.location;
    t.app.services.aiFetch = fakeClaude;
    t.app.services.twilioFetch = fakeTwilio;
    t.app.services.genmediaFetch = fakeStt;
    t.app.events.on('*', (e) => void events.push(e));
    await t.api.put('/api/telephony/settings', { account_sid: SID, auth_token: TOKEN, numbers: TWILIO_NUMBER, forward_to: MOBILE, hours_mode: 'always', record_inbound: true });
    await t.api.put('/api/ai/settings', { api_key: KEY, enabled: true });
    expect((await t.api.post('/api/ai-connections', { provider: 'openai', api_key: 'sk-test-stt-key-1234567890', capabilities: ['stt'], models: { stt: 'gpt-4o-transcribe' } })).status).toBeLessThan(300);
    contactId = (await t.api.post('/api/contacts', { first_name: 'Karla', last_name: 'Kunde', phone: '0170 9000001' })).data.id;
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  it('does nothing with recordings until the sub-account switches it on', async () => {
    expect((await t.api.get('/api/call-intel/settings')).data.settings).toMatchObject({ auto_calls: false, ai: true, language: 'de' });
    const call = await recordedCall(51);
    expect(intelOf(call.id)).toBeUndefined();
    expect(sttCalls).toBe(0);
    expect(call.recording_channels).toBe(2);
  });

  it('transcribes both sides of a two-channel recording, measures them and analyses the conversation', async () => {
    stt.push('Guten Tag, ich möchte ein Angebot für zwanzig Lizenzen. Das ist leider zu teuer, ein echtes Problem.', 'Gerne, wir schicken das Angebot bis Freitag. Äh, sozusagen sofort. Haben Sie noch Fragen? Ähm, ja?');
    expect((await settings({ auto_calls: true, glossary: 'HyperLevel, Lizenzen', fillers: ['sofort'] })).status).toBe(200);
    // The call (inbound) comes from the contact's number so the summary lands on their timeline.
    const call = await recordedCall(52, '+491709000001');
    expect(call.contact_id).toBe(contactId);
    const r = intelOf(call.id)!;
    expect(r).toMatchObject({ status: 'done', source: 'call', separated: 1, contact_id: contactId, title: 'Angebot für 20 Lizenzen' });
    // Stereo: the recording came as WAV with two channels.
    expect(twilioRequests.some((u) => u.endsWith(`/Recordings/${recSid(52)}.wav?RequestedChannels=2`))).toBe(true);
    expect(sttCalls).toBe(2);
    const detail = (await t.api.get(`/api/call-intel/${r.id}`)).data;
    // Inbound: the first channel is the caller.
    expect(detail.utterances.map((u: any) => u.speaker)).toEqual(['customer', 'agent']);
    expect(detail.transcript).toBe(`Kunde: Guten Tag, ich möchte ein Angebot für zwanzig Lizenzen. Das ist leider zu teuer, ein echtes Problem.\nMitarbeiter: Gerne, wir schicken das Angebot bis Freitag. Äh, sozusagen sofort. Haben Sie noch Fragen? Ähm, ja?`);
    expect(detail.metrics.talk.agent_pct).toBeGreaterThanOrEqual(54);
    expect(detail.metrics.talk.agent_pct).toBeLessThanOrEqual(58);
    expect(detail.metrics.talk.agent_pct + detail.metrics.talk.customer_pct).toBe(100);
    expect(detail.metrics.talk.longest_agent_s).toBe(2);
    expect(detail.metrics.words).toMatchObject({ agent: 16, customer: 17, total: 33 });
    expect(detail.metrics.fillers.agent.total).toBe(4); // äh, sozusagen, ähm and the own word "sofort"
    expect(detail.metrics.fillers.customer.total).toBe(0);
    expect(detail.metrics.questions).toMatchObject({ agent: 2, customer: 0 });
    expect(detail.metrics.wpm.agent).toBeGreaterThan(0);
    expect(detail).toMatchObject({ summary: ANALYSIS.summary, next_step: 'Angebot bis Freitag senden', topics: ['Angebot', 'Preis', 'Lizenzen'], objections: ['Preis zu hoch'], sentiment: { overall: 'gemischt' } });
    expect(detail.action_items.map((a: any) => a.title)).toEqual(['Angebot für 20 Lizenzen senden', 'Budget intern klären']);
    // The model saw the transcript as data, with the separated sides.
    expect(claude.at(-1)!.prompt).toContain('Kunde: Guten Tag');
    expect(claude.at(-1)!.prompt).toContain('Mitarbeiter: Gerne');
    expect(claude.at(-1)!.prompt).toContain('Vorname: Karla');
  });

  it('puts the summary on the contact timeline and in the call log, tells the workflow and offers it as callSummaries', async () => {
    const call = t.app.db.get('SELECT * FROM calls WHERE sid = ?', callSid(52))!;
    const act = t.app.db.get('SELECT * FROM activities WHERE contact_id = ? AND type = ?', contactId, 'call.summary')!;
    expect(act.summary).toContain('Gesprächsauswertung: Angebot für 20 Lizenzen');
    expect(JSON.parse(act.data)).toMatchObject({ callId: call.id, sentiment: 'gemischt' });
    expect(call.transcription).toContain('Zusammenfassung: Die Kundin möchte');
    expect(t.app.db.get('SELECT body FROM messages WHERE id = ?', call.message_id)!.body).toContain('Zusammenfassung');
    await t.app.events.flush();
    const ev = events.find((e) => e.type === 'call.analyzed')!;
    expect(ev.data).toMatchObject({ contactId, callId: call.id, sentiment: 'gemischt', next_step: 'Angebot bis Freitag senden' });
    // The hook for other modules (deal timeline).
    const seen: any[] = [];
    t.app.services.callSummaries.subscribe((s: any) => seen.push(s));
    const list = t.app.services.callSummaries.list(loc, { contactId });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ call_id: call.id, contact_id: contactId, summary: ANALYSIS.summary, sentiment: 'gemischt' });
    expect(t.app.services.callSummaries.list(loc, { contactId: 'fremd' })).toEqual([]);
    expect(t.app.services.callSummaries.get(loc, list[0].id).title).toBe('Angebot für 20 Lizenzen');
    // The contact's activity feed shows it.
    expect((await t.api.get(`/api/contacts/${contactId}`)).data.activities.map((a: any) => a.type)).toContain('call.summary');
    void seen;
  });

  it('turns an action item into a task – once – and lets it be ticked off', async () => {
    const r = intelOf(t.app.db.get('SELECT id FROM calls WHERE sid = ?', callSid(52))!.id)!;
    const a = await t.api.post(`/api/call-intel/${r.id}/action-items/0/task`);
    expect(a.data.task_id).toBeTruthy();
    const task = t.app.db.get('SELECT * FROM tasks WHERE id = ?', a.data.task_id)!;
    expect(task).toMatchObject({ title: 'Angebot für 20 Lizenzen senden', contact_id: contactId, done: 0 });
    expect(task.due_at.slice(0, 10)).toBe('2026-10-09');
    expect((await t.api.post(`/api/call-intel/${r.id}/action-items/0/task`)).data.task_id).toBe(a.data.task_id);
    expect(t.app.db.get('SELECT COUNT(*) n FROM tasks WHERE contact_id = ?', contactId)!.n).toBe(1);
    expect((await t.api.post(`/api/call-intel/${r.id}/action-items/7/task`)).status).toBe(404);
    expect((await t.api.patch(`/api/call-intel/${r.id}/action-items/1`, { done: true })).data.items[1].done).toBe(true);
  });

  it('creates the tasks right away when asked to, and ignores short recordings', async () => {
    await settings({ auto_tasks: true, min_seconds: 120 });
    const short = await recordedCall(53, '+4917090002');
    expect(intelOf(short.id)).toBeUndefined(); // 61 s < 120 s
    await settings({ min_seconds: 30 });
    stt.push('Kunde sagt etwas.', 'Mitarbeiter sagt etwas.');
    const call = await recordedCall(54, '+4917090003');
    const r = intelOf(call.id)!;
    const items = JSON.parse(r.action_items);
    expect(items[0].task_id).toBeTruthy();
    expect(items[1].task_id).toBeNull(); // the customer's own task is not ours
    expect(t.app.db.get('SELECT COUNT(*) n FROM tasks WHERE contact_id = ?', r.contact_id)!.n).toBe(1);
    await settings({ auto_tasks: false });
  });

  it('keeps the metrics and the word-list sentiment when the AI is down, and can be repeated', async () => {
    claudeMode = 'down';
    stt.push('Das war super, vielen Dank, ich bin zufrieden und begeistert. Angebot Angebot Preis Preis.', 'Gerne.');
    const call = await recordedCall(55, '+4917090004');
    const r = intelOf(call.id)!;
    expect(r.status).toBe('done');
    expect(r.summary).toBe('');
    expect(r.ai_error).toContain('überlastet');
    expect(JSON.parse(r.sentiment)).toMatchObject({ overall: 'positiv', customer: 'positiv' });
    expect(JSON.parse(r.topics)).toEqual(['angebot', 'preis']); // the most frequent words instead
    expect(JSON.parse(r.metrics).words.total).toBeGreaterThan(5);
    claudeMode = 'garbage';
    expect((await t.api.post(`/api/call-intel/${r.id}/retry`)).status).toBe(200);
    await idle();
    expect(intelOf(call.id)!.ai_error).toContain('Ungültige KI-Antwort');
    claudeMode = 'ok';
    stt.push('Das war super.', 'Gerne.');
    await t.api.post(`/api/call-intel/${r.id}/retry`);
    await idle();
    expect(intelOf(call.id)).toMatchObject({ status: 'done', ai_error: '', summary: ANALYSIS.summary });
  });

  it('says what went wrong when the speech provider fails, without losing the recording', async () => {
    sttFail = true;
    const call = await recordedCall(56, '+4917090005');
    const r = intelOf(call.id)!;
    expect(r.status).toBe('failed');
    expect(r.error.length).toBeGreaterThan(5);
    expect((await t.api.get('/api/call-intel/stats?days=7')).data.failed).toBe(1);
    sttFail = false;
    stt.push('Kunde.', 'Mitarbeiter.');
    expect((await t.api.post(`/api/call-intel/${r.id}/retry`)).status).toBe(200);
    await idle();
    expect(intelOf(call.id)!.status).toBe('done');
  });

  it('analyses a recorded call on demand, even with the automatic analysis off', async () => {
    await settings({ auto_calls: false });
    const call = await recordedCall(57, '+4917090006');
    expect(intelOf(call.id)).toBeUndefined();
    stt.push('Kunde.', 'Mitarbeiter.');
    const r = await t.api.post(`/api/call-intel/calls/${call.id}/analyze`);
    expect(r.status).toBe(200);
    await idle();
    expect(intelOf(call.id)!.status).toBe('done');
    expect((await t.api.get(`/api/call-intel/by-call/${call.id}`)).data).toMatchObject({ id: intelOf(call.id)!.id, status: 'done' });
    expect((await t.api.get('/api/call-intel/by-call/gibtsnicht')).data.id).toBeNull();
    // A call without recording cannot be analysed.
    await hook('voice', { CallSid: callSid(58), From: '+4917090007', To: TWILIO_NUMBER });
    const bare = t.app.db.get('SELECT id FROM calls WHERE sid = ?', callSid(58))!;
    expect((await t.api.post(`/api/call-intel/calls/${bare.id}/analyze`)).data.error).toContain('keine Aufnahme');
  });

  it('analyses an uploaded meeting recording after the participants agreed, and does not keep the audio', async () => {
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(400, 3)]);
    expect((await upload(mp3, 'title=Jour%20fixe')).status).toBe(400); // no consent given
    expect((await upload(Buffer.from('kein audio'), 'consent=1')).status).toBe(400);
    stt.push('Wir besprechen die Roadmap und das Budget für das nächste Quartal. Das Budget ist knapp, aber machbar.');
    const r = await upload(mp3, `title=${encodeURIComponent('Jour fixe')}&contact_id=${contactId}&consent=1`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body).toMatchObject({ source: 'upload', title: 'Jour fixe', contact_id: contactId });
    await idle();
    const done = (await t.api.get(`/api/call-intel/${body.id}`)).data;
    expect(done).toMatchObject({ status: 'done', separated: false, summary: ANALYSIS.summary, has_audio: false, title: 'Jour fixe' });
    expect(done.consent_note).toContain('Zustimmung aller Beteiligten');
    expect(done.metrics.talk).toBeUndefined(); // one channel: no talk-time ratio
    expect(done.metrics.words.total).toBeGreaterThan(10);
    expect(t.app.db.get('SELECT audio_file FROM call_intel WHERE id = ?', body.id)!.audio_file).toBe('');
    expect(claude.at(-1)!.prompt).toContain('Wer spricht, ist nicht gekennzeichnet');
    expect(claude.at(-1)!.prompt).toContain('art="Besprechung"');
  });

  it('analyses a pasted transcript without audio', async () => {
    expect((await t.api.post('/api/call-intel/text', { transcript: 'zu kurz' })).status).toBe(400);
    const text = Array.from({ length: 30 }, (_, i) => `Satz ${i} über das Projekt und die Planung.`).join(' ');
    const r = (await t.api.post('/api/call-intel/text', { title: 'Teams-Protokoll', transcript: text })).data;
    await idle();
    expect((await t.api.get(`/api/call-intel/${r.id}`)).data).toMatchObject({ source: 'text', status: 'done', summary: ANALYSIS.summary });
    expect((await t.api.post('/api/call-intel/text', { transcript: text, contact_id: 'fremd' })).status).toBe(400);
  });

  it('lists, searches and summarises the analyses by team and period', async () => {
    const all = (await t.api.get('/api/call-intel?limit=100')).data;
    expect(all.items.length).toBeGreaterThanOrEqual(6);
    expect((await t.api.get(`/api/call-intel?contact_id=${contactId}&status=done`)).data.items.every((x: any) => x.contact_id === contactId)).toBe(true);
    expect((await t.api.get('/api/call-intel?q=Teams-Protokoll')).data.items.map((x: any) => x.title)).toEqual(['Teams-Protokoll']);
    expect((await t.api.get('/api/call-intel?sentiment=positiv')).data.items.every((x: any) => x.sentiment.overall === 'positiv')).toBe(true);
    expect(JSON.stringify(all)).not.toContain('"transcript"'); // the list carries no transcripts
    const s = (await t.api.get('/api/call-intel/stats?days=30')).data;
    expect(s.analysed).toBeGreaterThanOrEqual(6);
    expect(s.avg_agent_talk_pct).toBeGreaterThanOrEqual(54);
    expect(s.avg_agent_talk_pct).toBeLessThanOrEqual(58);
    expect(s.topics[0].n).toBeGreaterThanOrEqual(2);
    expect(s.sentiment.gemischt).toBeGreaterThanOrEqual(1);
    expect(s.agents.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps retention: analyses older than the period are deleted', async () => {
    const r = (await t.api.post('/api/call-intel/text', { title: 'Alt', transcript: Array.from({ length: 30 }, (_, i) => `Wort${i} alt`).join(' ') })).data;
    await idle();
    t.app.db.run('UPDATE call_intel SET created_at = ? WHERE id = ?', new Date(Date.now() - 100 * 864e5).toISOString(), r.id);
    await settings({ retention_days: 90 });
    await t.app.tick();
    expect(t.app.db.get('SELECT id FROM call_intel WHERE id = ?', r.id)).toBeUndefined();
    expect(t.app.db.get('SELECT COUNT(*) n FROM call_intel')!.n).toBeGreaterThanOrEqual(6);
    await settings({ retention_days: 0 });
  });

  it('puts settings behind the settings area and keeps the sub-accounts apart', async () => {
    expect(requiredPermission('PUT', '/api/call-intel/settings')).toBe('settings');
    expect(requiredPermission('POST', '/api/call-scorecards')).toBe('settings');
    expect(requiredPermission('GET', '/api/call-intel')).toBe('conversations');
    expect(requiredPermission('POST', '/api/call-intel/upload')).toBe('conversations');
    const other = (await t.api.post('/api/locations', { name: 'Andere Firma' })).data.id;
    const mine = intelOf(t.app.db.get('SELECT id FROM calls WHERE sid = ?', callSid(52))!.id)!;
    const c = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': other });
    expect((await c('GET', `/api/call-intel/${mine.id}`)).status).toBe(404);
    expect((await c('GET', '/api/call-intel')).data.items).toEqual([]);
    expect((await c('POST', `/api/call-intel/${mine.id}/retry`, {})).status).toBe(404);
    expect((await c('POST', `/api/call-intel/calls/${mine.call_id}/analyze`, {})).status).toBe(404);
  });

  describe('scorecards', () => {
    let cardId = '';
    let intelId = '';
    let scoreId = '';
    beforeAll(() => {
      intelId = intelOf(t.app.db.get('SELECT id FROM calls WHERE sid = ?', callSid(52))!.id)!.id;
    });

    it('creates a scorecard from a template and the AI pre-scores a conversation with a reason and a quote per criterion', async () => {
      const tpl = (await t.api.get('/api/call-scorecards/templates')).data;
      expect(tpl.map((x: any) => x.key)).toEqual(['sales', 'service']);
      const c = await t.api.post('/api/call-scorecards', { name: tpl[0].name, description: tpl[0].description, criteria: tpl[0].criteria });
      expect(c.status).toBe(200);
      cardId = c.data.id;
      expect((await t.api.post('/api/call-scorecards', { name: 'leer', criteria: [] })).status).toBe(400);
      expect((await t.api.get('/api/call-intel/scorecards')).data.map((x: any) => x.id)).toEqual([cardId]);
      const s = await t.api.post(`/api/call-intel/${intelId}/scores`, { scorecard_id: cardId });
      expect(s.status, JSON.stringify(s.data)).toBe(200);
      scoreId = s.data.id;
      expect(s.data).toMatchObject({ status: 'ai', scorecard_name: 'Vertriebsgespräch' });
      // Criteria 0,2,4 → 4 (five) / 1 (yes-no); "redeanteil" does not apply.
      const by = Object.fromEntries(s.data.criteria.map((k: any) => [k.id, k]));
      expect(by.begruessung.ai).toMatchObject({ score: 4, reason: 'Grund begruessung', quote: 'Gerne, wir schicken das Angebot' });
      expect(by.redeanteil.ai.score).toBeNull();
      expect(by.naechster_schritt.ai.score).toBe(1);
      expect(s.data.ai_total).toBeGreaterThan(40);
      expect(s.data.final_total).toBe(s.data.ai_total);
      expect(claude.at(-1)!.prompt).toContain('id "naechster_schritt"');
      expect((await t.api.post(`/api/call-intel/${intelId}/scores`, { scorecard_id: 'fremd' })).status).toBe(404);
    });

    it('the manager corrects single scores and comments; the total follows, the AI part stays visible', async () => {
      const before = (await t.api.get(`/api/call-intel/${intelId}/scores`)).data[0];
      const r = await t.api.put(`/api/call-intel/${intelId}/scores/${scoreId}/review`, { scores: { beduerfnis: { score: 1, comment: 'Hat nicht nachgefragt' }, naechster_schritt: { score: 0 } }, comment: 'Bedarf zu spät erfragt' });
      expect(r.status, JSON.stringify(r.data)).toBe(200);
      expect(r.data).toMatchObject({ status: 'reviewed', comment: 'Bedarf zu spät erfragt', reviewer_name: expect.any(String) });
      expect(r.data.final_total).toBeLessThan(before.final_total);
      expect(r.data.ai_total).toBe(before.ai_total);
      const by = Object.fromEntries(r.data.criteria.map((k: any) => [k.id, k]));
      expect(by.beduerfnis).toMatchObject({ final: 1, review: { score: 1, comment: 'Hat nicht nachgefragt' } });
      expect(by.begruessung.final).toBe(4); // untouched: the AI's score counts
      expect((await t.api.put(`/api/call-intel/${intelId}/scores/${scoreId}/review`, { scores: { beduerfnis: { score: 9 } } })).data.error).toContain('1 bis 5');
      expect((await t.api.put(`/api/call-intel/${intelId}/scores/${scoreId}/review`, { scores: { gibtsnicht: { score: 1 } } })).status).toBe(400);
      expect((await t.api.put(`/api/call-intel/${intelId}/scores/fremd/review`, { comment: 'x' })).status).toBe(404);
      await t.app.events.flush();
      expect(events.some((e) => e.type === 'call.scored')).toBe(true);
    });

    it('only managers review; a scoring again keeps the review and updates the AI part', async () => {
      await t.api.post('/api/users', { email: 'agent@example.com', name: 'Agent', password: 'passwort-a1', role: 'member', locations: [loc], permissions: ['conversations'] });
      const agent = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
      expect((await agent('POST', '/api/auth/login', { email: 'agent@example.com', password: 'passwort-a1' })).status).toBe(200);
      expect((await agent('PUT', `/api/call-intel/${intelId}/scores/${scoreId}/review`, { comment: 'Ich bewerte mich selbst gut' })).status).toBe(403);
      expect((await agent('GET', `/api/call-intel/${intelId}/scores`)).data[0].status).toBe('reviewed'); // may read
      expect((await agent('POST', '/api/call-scorecards', { name: 'x', criteria: [{ label: 'x' }] })).status).toBe(403); // cards are the managers'
      const again = await t.api.post(`/api/call-intel/${intelId}/scores`, { scorecard_id: cardId });
      expect(again.data).toMatchObject({ status: 'reviewed', comment: 'Bedarf zu spät erfragt' });
      expect(t.app.db.get('SELECT COUNT(*) n FROM call_scores WHERE intel_id = ?', intelId)!.n).toBe(1);
    });

    it('scores automatically with the default scorecard, and reports averages per criterion and per person', async () => {
      await settings({ default_scorecard_id: cardId, auto_calls: true });
      stt.push('Kunde.', 'Mitarbeiter.');
      const call = await recordedCall(59, '+4917090008');
      const r = intelOf(call.id)!;
      // The pre-score runs after the analysis, in the background.
      for (let i = 0; i < 40 && !t.app.db.get('SELECT 1 FROM call_scores WHERE intel_id = ?', r.id); i++) await new Promise((x) => setTimeout(x, 50));
      const s = t.app.db.get('SELECT * FROM call_scores WHERE intel_id = ?', r.id);
      expect(s?.status).toBe('ai');
      const rep = (await t.api.get(`/api/call-scorecards/${cardId}/report?days=30`)).data;
      expect(rep).toMatchObject({ scored: 2, reviewed: 1, scorecard: { name: 'Vertriebsgespräch' } });
      expect(rep.avg_total).toBeGreaterThan(0);
      expect(rep.criteria.find((k: any) => k.id === 'begruessung')).toMatchObject({ n: 2, avg_pct: 75 });
      expect(rep.criteria.find((k: any) => k.id === 'redeanteil').n).toBe(0);
      expect(rep.people.length).toBeGreaterThanOrEqual(1);
      expect((await t.api.put('/api/call-intel/settings', { default_scorecard_id: 'fremd' })).status).toBe(400);
      // Deleting the card removes its scores and the default.
      expect((await t.api.del(`/api/call-scorecards/${cardId}`)).data.ok).toBe(true);
      expect(t.app.db.get('SELECT COUNT(*) n FROM call_scores')!.n).toBe(0);
      expect((await t.api.get('/api/call-intel/settings')).data.settings.default_scorecard_id).toBe('');
      void adminId;
    });
  });
});
