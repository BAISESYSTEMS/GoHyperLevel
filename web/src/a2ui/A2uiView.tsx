import { useEffect, useRef } from 'react';

/**
 * An A2UI 1.0 interface inside the app (docs/a2ui.md): the same renderer as the website chat (web/public/a2ui-renderer.js), loaded
 * on first use. `onAction` gets every button press as an A2UI action message.
 */

type Msg = Record<string, unknown>;
interface Renderer {
  mount: (el: HTMLElement, messages: Msg[], opts: { send?: (m: Msg) => Promise<Msg[] | void>; callAgent?: (m: Msg) => Promise<Msg> }) => { apply: (m: Msg[]) => void };
}

let loading: Promise<Renderer> | null = null;
function loadRenderer(): Promise<Renderer> {
  const w = window as unknown as { HLA2UI?: Renderer };
  if (w.HLA2UI) return Promise.resolve(w.HLA2UI);
  loading ??= new Promise<Renderer>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/a2ui-renderer.js';
    s.async = true;
    s.onload = () => (w.HLA2UI ? resolve(w.HLA2UI) : reject(new Error('A2UI renderer missing')));
    s.onerror = () => {
      loading = null;
      reject(new Error('A2UI renderer could not be loaded'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** `onAction` may return a short status text: it appears under the buttons (data model path /status). */
export function A2uiView({ messages, onAction }: { messages: Msg[]; onAction: (action: { name: string; context: Record<string, unknown> }) => Promise<string | void> | string | void }) {
  const ref = useRef<HTMLDivElement>(null);
  const act = useRef(onAction);
  act.current = onAction;
  useEffect(() => {
    let off = false;
    void loadRenderer()
      .then((r) => {
        if (off || !ref.current) return;
        r.mount(ref.current, messages, {
          send: async (m) => {
            const a = (m as { action?: { name: string; surfaceId: string; context: Record<string, unknown> } }).action;
            if (!a) return undefined;
            const status = await act.current({ name: a.name, context: a.context ?? {} });
            return typeof status === 'string' ? [{ version: '1.0', updateDataModel: { surfaceId: a.surfaceId, path: '/status', value: status } }] : undefined;
          },
        });
      })
      .catch(() => undefined);
    return () => {
      off = true;
      if (ref.current) ref.current.replaceChildren();
    };
  }, [messages]);
  return <div ref={ref} className="agent-a2ui" />;
}
