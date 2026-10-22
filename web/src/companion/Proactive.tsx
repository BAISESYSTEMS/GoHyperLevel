import { useState } from 'react';
import { CheckCircle2, CircleAlert, Hand, Loader2, Mic, Sparkles, X } from 'lucide-react';
import { useT } from '../i18n';
import type { LiveSuggestion, Offer } from './live';
import type { TaskInfo } from './task-bus';
import type { ConvPhase } from './vad';

/**
 * The live parts of the companion panel (1.0.54): the conversation indicator ("hört zu / denkt nach / spricht" with the microphone
 * mark and ✕), a proactive offer ("Neuer Lead: Lea – soll ich eine Begrüßung entwerfen?" with the prepared draft), the initiative's
 * open suggestions and the compact list of background tasks.
 */

export function ConvPill({ phase, name, live, onEnd }: { phase: ConvPhase; name: string; live: boolean; onEnd: () => void }) {
  const t = useT('companion');
  const label = phase === 'listening' ? t('hört zu') : phase === 'thinking' ? t('denkt nach') : phase === 'speaking' ? t('spricht') : t('bereit');
  return (
    <span className={`cmp-conv s-${phase}`} role="status" aria-live="polite" data-tour="companion-conversation">
      <span className="cmp-conv-dot" aria-hidden="true" />
      <Mic size={14} aria-hidden="true" />
      <span className="cmp-conv-text">
        <strong>{live ? t('Echtzeit-Gespräch mit {name}', { name }) : t('Gespräch mit {name}', { name })}</strong>
        <span className="cmp-conv-sep"> · </span>
        {label} · {t('Mikro an')}
      </span>
      <button type="button" className="icon-btn cmp-conv-x" onClick={onEnd} aria-label={t('Gespräch beenden (Esc)')} title={t('Gespräch beenden (Esc)')}>
        <X size={14} />
      </button>
    </span>
  );
}

export function OfferCard({ offer, draft, name, emoji, onYes, onNo, onLater }: { offer: Offer; draft?: string; name: string; emoji: string; onYes: () => void; onNo: () => void; onLater: () => void }) {
  const t = useT('companion');
  const [open, setOpen] = useState(false);
  return (
    <div className="cmp-offer" role="region" aria-label={t('Vorschlag von {name}', { name })} data-tour="companion-offer">
      <span className="cmp-run-avatar" aria-hidden="true">
        {emoji}
      </span>
      <div className="cmp-offer-body">
        <span className="cmp-run-name">
          {name} <Sparkles size={13} aria-hidden="true" />
        </span>
        <strong>{offer.title}</strong>
        <p>{offer.say}</p>
        {draft && (
          <>
            <button type="button" className="linkish" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? t('Entwurf ausblenden') : t('Vorbereiteten Entwurf ansehen')}
            </button>
            {open && <pre className="cmp-offer-draft">{draft}</pre>}
          </>
        )}
        <div className="cmp-offer-actions">
          <button type="button" className="btn small" onClick={onYes}>
            {t('Ja, bitte')}
          </button>
          <button type="button" className="btn small secondary" onClick={onNo}>
            {t('Nein danke')}
          </button>
          <span className="cmp-offer-note">{t('Du kannst auch „ja“ oder „nein“ sagen – Senden bestätigst du trotzdem per Klick.')}</span>
        </div>
      </div>
      <button type="button" className="icon-btn cmp-offer-x" onClick={onLater} aria-label={t('Später')} title={t('Später')}>
        <X size={15} />
      </button>
    </div>
  );
}

export function SuggestionList({ list, onPick }: { list: LiveSuggestion[]; onPick: (s: LiveSuggestion) => void }) {
  const t = useT('companion');
  if (!list.length) return null;
  return (
    <div className="cmp-sugg" role="group" aria-label={t('Vorschläge')} data-tour="companion-suggestions">
      <span className="fx-history-label">
        <Sparkles size={13} aria-hidden="true" /> {t('Vorschläge')}
      </span>
      {list.slice(0, 4).map((s) => (
        <button key={s.id} type="button" className="fx-chip cmp-sugg-item" onClick={() => onPick(s)} title={s.say}>
          {s.title}
          {s.draft ? <em>{t('Entwurf bereit')}</em> : null}
        </button>
      ))}
    </div>
  );
}

const icon = (s: TaskInfo['status']) => (s === 'running' ? <Loader2 size={14} className="cmp-spin-ico" aria-hidden="true" /> : s === 'done' ? <CheckCircle2 size={14} aria-hidden="true" /> : s === 'confirm' ? <Hand size={14} aria-hidden="true" /> : <CircleAlert size={14} aria-hidden="true" />);

export function TaskList({ list, currentId, onOpen }: { list: TaskInfo[]; currentId: string | null; onOpen: (id: string) => void }) {
  const t = useT('companion');
  const shown = list.filter((x) => x.id !== currentId || x.status === 'running').slice(0, 5);
  if (!shown.length) return null;
  const label = (s: TaskInfo['status']) => (s === 'running' ? t('läuft') : s === 'done' ? t('erledigt') : s === 'confirm' ? t('wartet auf dich') : s === 'stopped' ? t('angehalten') : t('fehlgeschlagen'));
  return (
    <div className="cmp-tasks" role="group" aria-label={t('Aufgaben')} data-tour="companion-tasks">
      <span className="fx-history-label">{t('Aufgaben')}</span>
      {shown.map((x) => (
        <button key={x.id} type="button" className={`fx-chip cmp-task s-${x.status}`} onClick={() => onOpen(x.id)} title={x.text || x.label}>
          {icon(x.status)} <span className="cmp-task-label">{x.label}</span> <em>{label(x.status)}</em>
        </button>
      ))}
    </div>
  );
}
