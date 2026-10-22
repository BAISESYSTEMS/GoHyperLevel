import { useEffect, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../../icons';
import { api } from '../../api';
import { useLoad } from '../../ui';
import { fmtMoney, useT } from '../../i18n';
import './site-ai.css';

/** Shared pieces of the Funnel & Website AI screens: status, chat bubbles, chips, radio cards, cost line, diff and preview. */

export interface AiStatus {
  ready: boolean;
  reason: string | null;
  provider: { label: string; model: string; byok: boolean };
  budget: { used_usd: number; limit_usd: number; remaining_usd: number; problem: string | null };
  examples: string[];
  options: { page_types: string[]; goals: string[]; tones: string[]; languages: string[] };
  commands: { id: string; label: string }[];
}
export interface Estimate {
  usd: number;
  fits: boolean;
  problem: string | null;
  model: { label: string; model: string; byok: boolean };
  budget: { used_usd: number; limit_usd: number; remaining_usd: number };
}
export interface SectionDiff {
  id: string;
  name: string;
  change: 'new' | 'changed' | 'removed' | 'same';
  blocks: number;
  preview: string;
}

export const useAiStatus = () => useLoad(() => api.get<AiStatus>('/api/site-ai/status'), []);
export const usd = (v: number) => fmtMoney(Math.round(v * 1000) / 10, 'USD', { minimumFractionDigits: 2, maximumFractionDigits: v > 0 && v < 0.1 ? 3 : 2 });

export function Bubble({ me, children }: { me?: boolean; children: ReactNode }) {
  return (
    <div className={`ai-msg${me ? ' me' : ''}`}>
      {!me && (
        <span className="ai-avatar" aria-hidden="true">
          <Icon name="ai" size={16} />
        </span>
      )}
      <div className="ai-bubble">{children}</div>
    </div>
  );
}

export function Chips({ items, onPick, label }: { items: [string, string][]; onPick(id: string): void; label: string }) {
  return (
    <div className="ai-chips" role="group" aria-label={label}>
      {items.map(([id, text]) => (
        <button key={id} type="button" className="ai-chip" onClick={() => onPick(id)}>
          {text}
        </button>
      ))}
    </div>
  );
}

export function RadioCards({ name, value, onChange, options, small, label }: { name: string; value: string; onChange(v: string): void; options: { value: string; title: string; text?: string; icon?: IconName }[]; small?: boolean; label: string }) {
  return (
    <div className={`ai-cards${small ? ' small' : ''}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={o.value} className={`ai-card${value === o.value ? ' on' : ''}`}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          {o.icon && <Icon name={o.icon} size={18} />}
          <span>
            <b>{o.title}</b>
            {o.text && <small>{o.text}</small>}
          </span>
        </label>
      ))}
    </div>
  );
}

export function CostLine({ estimate, status }: { estimate?: Estimate | null; status?: AiStatus | null }) {
  const t = useT('siteai');
  const model = estimate?.model ?? status?.provider;
  const b = estimate?.budget ?? status?.budget;
  return (
    <div className="ai-cost" aria-live="polite">
      {estimate && (
        <span>
          {t('Geschätzt')} <b>{usd(estimate.usd)}</b>
        </span>
      )}
      {model && (
        <span>
          {model.label}
          {model.model ? ` · ${model.model}` : ''}
          {model.byok ? ` · ${t('eigener Anbieter')}` : ''}
        </span>
      )}
      {b && <span>{t('{used} von {limit} diesen Monat genutzt', { used: usd(b.used_usd), limit: usd(b.limit_usd) })}</span>}
      {estimate?.problem && <span className="warn">{estimate.problem}</span>}
    </div>
  );
}

export function Working({ text }: { text: string }) {
  return (
    <div className="ai-working" role="status">
      <span className="dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {text}
    </div>
  );
}

export function DiffList({ sections }: { sections: SectionDiff[] }) {
  const t = useT('siteai');
  const label = { new: t('neu'), changed: t('geändert'), removed: t('entfernt'), same: t('unverändert') };
  return (
    <ul className="ai-diff">
      {sections.map((s) => (
        <li key={s.id + s.change}>
          <span className={`what ${s.change}`}>{label[s.change]}</span>
          <b>{s.name}</b>
          <span className="pv">{s.preview}</span>
        </li>
      ))}
    </ul>
  );
}

/** A proposal rendered by the server (sandboxed, no scripts of the page leave the frame). */
export function Preview({ url, title }: { url: string; title: string }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    let live = true;
    setHtml('');
    api.text('GET', url).then((h) => live && setHtml(h), () => undefined);
    return () => {
      live = false;
    };
  }, [url]);
  return <iframe className="ai-preview" srcDoc={html} title={title} sandbox="allow-scripts" />;
}
