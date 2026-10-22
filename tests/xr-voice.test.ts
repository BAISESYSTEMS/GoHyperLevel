import { beforeEach, describe, expect, it, vi } from 'vitest';

const rec = { stop: vi.fn(), cancel: vi.fn(), elapsed: () => 0 };
const start = vi.fn();
const transcribe = vi.fn();
vi.mock('../web/src/agent/voice', () => ({ canRecord: () => true, micError: (e: any) => `Mikrofon: ${e?.message ?? e}`, startRecording: (...a: unknown[]) => start(...a), transcribe: (...a: unknown[]) => transcribe(...a) }));
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });

const { PushToTalk } = await import('../web/src/xr/engine/voice');

/** Push-to-talk in the headset: hold and let go, or tap to start and tap to stop – the same as the board's prompt bar. */
describe('push-to-talk in XR', () => {
  let t = 0;
  const states: string[] = [];
  const words: string[] = [];
  const errors: string[] = [];
  const make = () => new PushToTalk((s) => states.push(s), async (w) => void words.push(w), (m) => errors.push(m), () => t);
  beforeEach(() => {
    t = 0;
    states.length = 0;
    words.length = 0;
    errors.length = 0;
    start.mockReset().mockResolvedValue(rec);
    transcribe.mockReset().mockResolvedValue({ text: 'zeig mir die offenen Angebote' });
    rec.stop.mockReset().mockResolvedValue(new Blob(['x'.repeat(2000)]));
    rec.cancel.mockReset();
  });

  it('records while held and sends the words when let go after a real hold', async () => {
    const p = make();
    await p.down();
    expect(p.state).toBe('recording');
    t = 1800;
    await p.up();
    expect(states).toEqual(['recording', 'working', 'idle']);
    expect(words).toEqual(['zeig mir die offenen Angebote']);
    expect(p.state).toBe('idle');
  });

  it('a short tap keeps it recording; the next tap ends it', async () => {
    const p = make();
    await p.down();
    t = 120;
    await p.up();
    expect(p.state).toBe('recording');
    expect(words).toEqual([]);
    t = 5000;
    await p.down();
    t = 5100;
    await p.up();
    expect(p.state).toBe('idle');
    expect(words).toHaveLength(1);
  });

  it('says what went wrong and goes back to idle: no microphone, nothing understood, a failing recognition', async () => {
    start.mockRejectedValueOnce(Object.assign(new Error('weg'), { name: 'NotFoundError' }));
    const a = make();
    await a.down();
    expect(errors).toEqual(['Mikrofon: weg']);
    expect(a.state).toBe('idle');
    transcribe.mockResolvedValueOnce({ text: '   ' });
    const b = make();
    await b.down();
    t = 2000;
    await b.up();
    expect(errors[1]).toMatch(/nichts verstanden/);
    expect(b.state).toBe('idle');
    transcribe.mockRejectedValueOnce(new Error('Keine Spracherkennung eingerichtet'));
    const c = make();
    await c.down();
    t = 4000;
    await c.up();
    expect(errors[2]).toMatch(/Spracherkennung/);
    expect(words).toEqual([]);
    expect(c.state).toBe('idle');
    // a recording that came out empty is dropped quietly
    rec.stop.mockResolvedValueOnce(null);
    const d = make();
    await d.down();
    t = 9000;
    await d.up();
    expect(d.state).toBe('idle');
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it('ignores presses while it works or where there is no microphone, and cancels cleanly', async () => {
    const p = make();
    p.state = 'off';
    await p.down();
    expect(start).not.toHaveBeenCalled();
    const q = make();
    await q.down();
    q.cancel();
    expect(rec.cancel).toHaveBeenCalled();
    expect(q.state).toBe('idle');
    const r = make();
    r.state = 'working';
    await r.down();
    expect(start).toHaveBeenCalledTimes(1);
  });
});
