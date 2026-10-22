import { api } from '../api';
import { act, navigate, toast } from '../ui';
import { applyEvent, type Confirm, type Item } from '../agent/Panel';
import { streamPost, type AgentEvent } from '../agent/stream';
import type { UiContext } from '../agent/context';
import { taskBus, type TaskStatus } from './task-bus';

/**
 * The companion's agent runs as tasks that outlive the focus page (1.0.54): a run belongs to a RunController kept at module level,
 * so leaving focus mode, navigating or asking something else never cuts it off – the server's run goes on anyway, and here its stream
 * keeps arriving. Focus mode shows the current controller; asking the agent something new while it still works moves the running
 * one to the background (its own conversation) and starts a fresh one. Every change is reported to the task bus (task-bus.ts) for the
 * task list and the announcement when a background run ends. Voice never confirms: a waiting confirmation card needs a click.
 */

export interface RunResult {
  /** the agent's words of this run (for reading aloud) */
  text: string;
  confirm: Confirm | null;
  error: string;
}

const lastText = (items: Item[]) => {
  const last = [...items].reverse().find((x) => x.role === 'assistant');
  return last && last.role === 'assistant' ? last.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join(' ').trim() : '';
};
let seq = 0;

export class RunController {
  readonly id = `run${++seq}-${Date.now().toString(36)}`;
  label = '';
  items: Item[] = [];
  confirm: Confirm | null = null;
  busy = false;
  error = '';
  status = '';
  convId: string | null = null;
  state: TaskStatus | 'idle' = 'idle';
  startedAt = 0;
  private abort: AbortController | null = null;
  private subs = new Set<() => void>();
  private delta: ((d: string) => void) | null = null;

  constructor(readonly agentId: string | null) {}

  subscribe(fn: () => void) {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  }
  private emit() {
    this.subs.forEach((f) => f());
  }
  private report(settled = false) {
    if (this.state === 'idle') return;
    const text = lastText(this.items);
    taskBus.report({ id: this.id, label: this.label, status: this.state, startedAt: this.startedAt, endedAt: this.busy ? undefined : Date.now(), text: this.error || (text.length > 400 ? `${text.slice(0, 399)}…` : text), confirmTitle: this.confirm?.title }, settled);
  }

  private onEvent = (e: AgentEvent) => {
    if (e.type === 'start' && e.conversation_id) this.convId = e.conversation_id;
    else if (e.type === 'confirm') this.confirm = e as unknown as Confirm;
    else if (e.type === 'navigate' && typeof e.to === 'string') {
      navigate(e.to);
      toast(`${e.label || e.to}`);
    } else if (e.type === 'error') this.error = String(e.message || '–');
    else if (e.type === 'bridge') this.status = String(e.text ?? '');
    else if (e.type === 'step' || e.type === 'done') this.status = '';
    if (e.type === 'text' && typeof e.delta === 'string') this.delta?.(e.delta);
    this.items = applyEvent(this.items, e);
    this.emit();
  };

  private async runStream(path: string, body: unknown, onDelta?: (d: string) => void): Promise<RunResult> {
    const before = this.items.length;
    this.confirm = null;
    this.error = '';
    this.busy = true;
    this.state = 'running';
    this.delta = onDelta ?? null;
    if (!this.startedAt) this.startedAt = Date.now();
    this.emit();
    this.report();
    const ac = new AbortController();
    this.abort = ac;
    try {
      await streamPost(path, body, this.onEvent, ac.signal);
    } catch (e) {
      if (!ac.signal.aborted) this.error = (e as Error).message;
    } finally {
      this.busy = false;
      this.abort = null;
      this.delta = null;
    }
    this.state = ac.signal.aborted ? 'stopped' : this.error ? 'failed' : this.confirm ? 'confirm' : 'done';
    this.emit();
    this.report(true);
    const fresh = this.items.slice(Math.max(0, before - 1));
    return { text: lastText(fresh), confirm: this.confirm, error: this.error };
  }

  /** `entity`: the record the request is about; `shown`: the label people see; `onDelta`: the agent's words as they stream. */
  send(text: string, ui: UiContext, entity?: UiContext['entity'], shown?: string, onDelta?: (d: string) => void): Promise<RunResult> {
    if (!this.label) this.label = (shown || text).slice(0, 120);
    this.items = [...this.items, { role: 'user', text: shown || text, files: [] }, { role: 'assistant', blocks: [] }];
    return this.runStream('/api/agent/chat', { conversation_id: this.convId, agent_id: this.agentId, message: text, ui: { ...ui, ...(entity ? { entity } : {}) }, source: 'focus' }, onDelta);
  }

  async decide(approve: boolean, onDelta?: (d: string) => void): Promise<RunResult | null> {
    const c = this.confirm;
    if (!c) return null;
    this.confirm = null;
    this.emit();
    if (c.bridge) {
      await act(() => api.post('/api/agent/confirm', { pending_id: c.pending_id, token: c.token, approve, args_hash: c.args_hash }));
      this.state = 'done';
      this.report(true);
      return null;
    }
    return this.runStream('/api/agent/confirm', { pending_id: c.pending_id, token: c.token, approve, args_hash: c.args_hash }, onDelta);
  }

  async stop() {
    this.abort?.abort();
    if (this.convId) await api.post(`/api/agent/conversations/${this.convId}/stop`, {}).catch(() => undefined);
    this.busy = false;
    this.status = '';
    this.emit();
  }

  /** the agent's last turn ended with a question to the person (the next input answers it) */
  asked() {
    return !this.confirm && /\?\s*$/.test(lastText(this.items));
  }
}

// --- the store: one current run (shown in focus mode), the others in the background --------------------------------------------

let current: RunController | null = null;
const background: RunController[] = [];
const storeSubs = new Set<() => void>();
const emitStore = () => storeSubs.forEach((f) => f());

export const onRunStore = (fn: () => void) => (storeSubs.add(fn), () => void storeSubs.delete(fn));

/** The current run for this companion (a new one when another agent answers now). */
export function currentRun(agentId: string | null): RunController {
  if (!current || current.agentId !== agentId) {
    if (current && (current.busy || current.confirm)) background.unshift(current);
    // no store event: this runs while rendering (the caller re-renders with it anyway)
    current = new RunController(agentId);
  }
  return current;
}

/** The current run keeps working in the background; a fresh one becomes current. */
export function toBackground(): RunController {
  const c = current;
  if (c && (c.busy || c.confirm)) background.unshift(c);
  current = new RunController(c?.agentId ?? null);
  background.splice(6);
  emitStore();
  return current;
}

/** Starts over (another companion picked): the old run is dropped from view, a running one stays in the background. */
export function resetRun(agentId: string | null): RunController {
  const c = current;
  if (c && (c.busy || c.confirm)) background.unshift(c);
  else if (c) taskBus.remove(c.id);
  current = new RunController(agentId);
  emitStore();
  return current;
}

/** A task from the list becomes the one focus mode shows (the shown one goes to the background if it still works). */
export function bringToFront(id: string): RunController | null {
  const i = background.findIndex((r) => r.id === id);
  if (i < 0) return current?.id === id ? current : null;
  const [r] = background.splice(i, 1);
  if (current && (current.busy || current.confirm || current.items.length)) background.unshift(current);
  current = r;
  emitStore();
  return r;
}

export const runById = (id: string) => (current?.id === id ? current : background.find((r) => r.id === id) ?? null);
