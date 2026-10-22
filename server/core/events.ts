export interface AppEvent {
  locationId: string;
  type: string;
  /** Usually carries contactId and the record that changed. */
  data: Record<string, any>;
  at: string;
}

type Listener = (e: AppEvent) => void | Promise<void>;

/**
 * In-process event bus. Listeners run after the current request has answered, each in isolation,
 * so a failing workflow or webhook never breaks the action that caused it.
 */
export class EventBus {
  private listeners = new Map<string, Listener[]>();
  private pending = new Set<Promise<void>>();

  on(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  emit(locationId: string, type: string, data: Record<string, any> = {}): void {
    const e: AppEvent = { locationId, type, data, at: new Date().toISOString() };
    const fns = [...(this.listeners.get(type) ?? []), ...(this.listeners.get('*') ?? [])];
    for (const fn of fns) {
      const p = new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => fn(e))
        .catch((err) => console.error(`[events] ${type} listener failed:`, err))
        .finally(() => this.pending.delete(p));
      this.pending.add(p);
    }
  }

  /** Waits until every listener (and anything they emitted) has run. Used by tests and the CLI. */
  async flush(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
}
