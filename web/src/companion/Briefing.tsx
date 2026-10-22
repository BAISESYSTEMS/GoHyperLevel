import { ArrowRight, Flame, Lightbulb, Volume2, VolumeX } from 'lucide-react';
import { useLocale, useT } from '../i18n';
import { GrowthKpis, type GrowthView } from './Growth';
import { Go } from '../boards/views';
import { FocusTiles } from '../focus/FocusTiles';
import type { FocusTile } from '../focus/types';

/** GET /api/companion/briefing and the check-ins (server/modules/companion.ts) – mirrored, the browser never imports server code. */
export interface NextStep {
  key: string;
  label: string;
  prompt?: string;
  url?: string;
  entity?: { type: string; id: string; label: string };
}
export interface HotspotView {
  key: string;
  title: string;
  detail: string;
  count: number;
  url: string;
  step?: NextStep;
}
export interface BriefingView {
  id?: string;
  kind?: 'scheduled' | 'manual' | 'growth' | 'weekly';
  say: string;
  tip: string;
  source: 'ai' | 'rules';
  hotspots: HotspotView[];
  next: NextStep[];
  tiles: FocusTile[];
  created_at?: string;
  at?: string;
  /** check-ins (1.0.54): the initiative's suggestions, the collected events and what the companion adds aloud */
  suggestions?: import('./live').LiveSuggestion[];
  digest?: { id: string; kind: string; title: string }[];
  offer?: string;
  /** a growth check-in (Business Developer): the week's KPIs vs. the week before */
  growth?: GrowthView | null;
}

const TONE: Record<string, string> = { website_down: 'red', overdue_invoices: 'red', tickets: 'red', overdue_tasks: 'yellow', inbox: 'yellow', appointments: 'blue', deals: 'blue', dunning: 'red', workflow_errors: 'yellow', low_stock: 'gray', approvals: 'blue' };

/**
 * The companion's briefing as the current view of focus mode: the mentor sentence (and a tip when the AI phrased it), the Brennpunkte
 * – each with where to check it and its next step –, "Wo geht's weiter" as one-click steps for the agent, and the tiles with live
 * numbers. A step never runs by itself: it becomes the agent's task, and the agent asks before anything goes out.
 */
export function Briefing({ b, name, emoji, onStep, speaking, onSpeak, canSpeak }: { b: BriefingView; name: string; emoji: string; onStep: (s: NextStep) => void; speaking: boolean; onSpeak: () => void; canSpeak: boolean }) {
  const t = useT('companion');
  const locale = useLocale();
  const when = b.created_at ? new Date(b.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <div className="cmp-brief" data-tour="companion-briefing">
      <div className="fx-say cmp-brief-say">
        <span className="fx-say-icon cmp-brief-avatar" aria-hidden="true">
          {emoji}
        </span>
        <div className="fx-say-body">
          <p className="fx-q">{b.kind === 'weekly' ? t('Wochenbilanz von {name}', { name }) : b.kind === 'growth' ? t('Wachstums-Briefing von {name}', { name }) : b.kind === 'scheduled' ? t('Check-in von {name} · {time}', { name, time: when }) : b.kind === 'manual' ? t('Check-in von {name}', { name }) : t('Lagebericht von {name}', { name })}</p>
          <p className="fx-say-text">{b.say}</p>
          {b.tip && (
            <p className="cmp-brief-tip">
              <Lightbulb size={15} /> {b.tip}
            </p>
          )}
        </div>
        {canSpeak && (
          <button type="button" className="bd-iconbtn lg" onClick={onSpeak} aria-label={speaking ? t('Vorlesen anhalten') : t('Vorlesen')} title={speaking ? t('Vorlesen anhalten') : t('Vorlesen')}>
            {speaking ? <VolumeX size={17} /> : <Volume2 size={17} />}
          </button>
        )}
      </div>

      {b.growth && <GrowthKpis g={b.growth} locale={locale} />}

      {b.hotspots.length > 0 && (
        <section className="cmp-hot" aria-label={b.growth ? t('Chancen und Risiken') : t('Brennpunkte')}>
          <h2 className="cmp-h">
            <Flame size={15} /> {b.growth ? t('Chancen und Risiken') : t('Brennpunkte')}
          </h2>
          <ol className="cmp-hot-list">
            {b.hotspots.map((h) => (
              <li key={h.key} className={`cmp-hot-item t-${TONE[h.key] ?? (h.key.startsWith('risk_') ? 'red' : h.key.startsWith('opp_') || h.key.startsWith('growth_') ? 'blue' : 'gray')}`}>
                <span className="cmp-hot-count" aria-hidden="true">
                  {h.count > 99 ? '99+' : h.count}
                </span>
                <div className="cmp-hot-text">
                  <strong>{h.title}</strong>
                  <span>{h.detail}</span>
                </div>
                <Go url={h.url} className="cmp-hot-open">
                  {t('Öffnen')}
                </Go>
              </li>
            ))}
          </ol>
        </section>
      )}

      {b.next.length > 0 && (
        <section className="cmp-next" aria-label={t('Wo geht’s weiter')}>
          <h2 className="cmp-h">
            <ArrowRight size={15} /> {t('Wo geht’s weiter')}
          </h2>
          <div className="cmp-next-list">
            {b.next.map((s) => (
              <button key={s.key} type="button" className="cmp-step" onClick={() => onStep(s)} title={s.prompt ?? s.label}>
                <span>{s.label}</span>
                <small>{s.prompt ? t('an {name} übergeben', { name }) : t('Seite öffnen')}</small>
              </button>
            ))}
          </div>
          <p className="cmp-note">{t('Ein Schritt wird zur Aufgabe für {name} – vor allem, was rausgeht oder etwas ändert, fragt der Agent nach.', { name })}</p>
        </section>
      )}

      {b.tiles.length > 0 && <FocusTiles tiles={b.tiles} />}
    </div>
  );
}
