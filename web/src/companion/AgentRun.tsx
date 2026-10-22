import { useEffect, useState } from 'react';
import { ArrowUpRight, Square } from 'lucide-react';
import { navigate } from '../ui';
import { useT } from '../i18n';
import { ConfirmCard, ToolCardView, type Confirm, type Item } from '../agent/Panel';
import { AgentMarkdown } from '../agent/markdown';
import type { UiContext } from '../agent/context';
import { currentRun, onRunStore, resetRun, toBackground, type RunController, type RunResult } from './tasks';

/**
 * The HyperLevel Agent inside focus mode: what the person asked to be done goes to the companion's agent (POST /api/agent/chat with
 * source "focus" – the same agent, tools, rights, confirmation cards, audit log and undo as the side panel), and its streamed answer,
 * tool steps and confirmation card render in the focus result area. The run itself lives in companion/tasks.ts, so it goes on in the
 * background while the person asks something else or leaves focus mode. Voice never confirms: the card waits for a click on "Ausführen".
 */

export type { RunResult };

export interface AgentRun {
  /** the controller shown now (its id for the task list) */
  id: string;
  items: Item[];
  confirm: Confirm | null;
  busy: boolean;
  error: string;
  status: string;
  convId: string | null;
  /** `entity`: the record the request is about (a briefing step) – the agent sees it as the selected record; `onDelta`: streamed words */
  send: (text: string, entity?: UiContext['entity'], shown?: string, onDelta?: (d: string) => void) => Promise<RunResult>;
  decide: (approve: boolean, onDelta?: (d: string) => void) => Promise<RunResult | null>;
  stop: () => Promise<void>;
  reset: () => void;
  /** the running request goes on in the background; the next one starts fresh */
  detach: () => void;
  /** the agent's last turn ended with a question to the person (the next input answers it) */
  asked: () => boolean;
}

export function useAgentRun(agentId: string | null, ui: () => UiContext): AgentRun {
  const [, tick] = useState(0);
  const c: RunController = currentRun(agentId);
  useEffect(() => onRunStore(() => tick((n) => n + 1)), []);
  useEffect(() => c.subscribe(() => tick((n) => n + 1)), [c]);
  return {
    id: c.id,
    items: c.items,
    confirm: c.confirm,
    busy: c.busy,
    error: c.error,
    status: c.status,
    convId: c.convId,
    // always the current controller at call time (detach() may just have replaced it)
    send: (text, entity, shown, onDelta) => currentRun(agentId).send(text, ui(), entity, shown, onDelta),
    decide: (approve, onDelta) => currentRun(agentId).decide(approve, onDelta),
    stop: () => currentRun(agentId).stop(),
    reset: () => void resetRun(agentId),
    detach: () => void toBackground(),
    asked: () => currentRun(agentId).asked(),
  };
}

/** The run in the focus result area: the request, the agent's words and tool cards, the confirmation card, stop and "open in the panel". */
export function AgentInline({ run, name, emoji, busyLabel }: { run: AgentRun; name: string; emoji: string; busyLabel: string }) {
  const t = useT('companion');
  const onNavigate = (to: string) => navigate(to);
  return (
    <section className="cmp-run" aria-live="polite" aria-busy={run.busy} data-tour="companion-run">
      {run.items.map((it, i) =>
        it.role === 'user' ? (
          <p key={i} className="cmp-run-q">
            {t('„{text}“', { text: it.text })}
          </p>
        ) : (
          <div key={i} className="cmp-run-a">
            <span className="cmp-run-avatar" aria-hidden="true">
              {emoji}
            </span>
            <div className="cmp-run-body">
              <span className="cmp-run-name">{name}</span>
              {it.blocks.map((b, j) =>
                b.kind === 'text' ? (
                  <AgentMarkdown key={j} text={b.text} />
                ) : (
                  <div key={j} className="agent-tools">
                    {b.tools.map((tool) => (
                      <ToolCardView key={tool.id} t={tool} onNavigate={onNavigate} />
                    ))}
                  </div>
                ),
              )}
              {run.busy && i === run.items.length - 1 && !it.blocks.length && <span className="cmp-run-busy">{busyLabel}</span>}
            </div>
          </div>
        ),
      )}
      {run.confirm && (
        <div className="cmp-run-confirm">
          <ConfirmCard c={run.confirm} onDecide={(approve) => void run.decide(approve)} busy={run.busy} />
          <p className="cmp-run-note">{t('Per Stimme bestätige ich nichts – bitte selbst auf „Ausführen“ tippen.')}</p>
        </div>
      )}
      {run.status && <div className="agent-status">{run.status}</div>}
      {run.error && <div className="agent-error">{run.error}</div>}
      <div className="cmp-run-foot">
        {run.busy && (
          <button type="button" className="btn small secondary" onClick={() => void run.stop()}>
            <Square size={13} /> {t('Stopp')}
          </button>
        )}
        {run.convId && !run.busy && (
          <button type="button" className="btn small secondary" onClick={() => window.dispatchEvent(new CustomEvent('pghl:agent', { detail: { conversationId: run.convId } }))} data-tour="companion-panel">
            <ArrowUpRight size={14} /> {t('Im Agent-Panel weiterführen')}
          </button>
        )}
      </div>
    </section>
  );
}
