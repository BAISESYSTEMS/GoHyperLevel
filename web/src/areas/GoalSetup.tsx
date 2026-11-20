import { useState } from 'react';
import { DEFAULT_GOAL, GOALS, coreForGoals } from '../../../server/services/areas-model';
import { useT } from '../i18n';
import { Icon } from '../icons';
import { Modal } from '../ui';
import { update } from '../theme/store';
import { areaOf, allAreas } from './registry';
import './simple.css';

/**
 * "Was willst du tun?" – the goal-based first-run setup of the Einfach-Modus. The chosen goals decide which areas stay in
 * the menu (server/services/areas-model.ts); everything else is one click away under "Mehr". New logins pick them in
 * the first step of the welcome wizard (web/src/onboarding/FirstRun.tsx – skipping it keeps the whole menu), existing
 * ones get the offer once as a banner. Changeable any time under Einstellungen → Darstellung.
 */

export function GoalPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const t = useT('simple');
  // menu labels are message ids of the shell catalog
  const ts = useT('shell');
  const toggle = (id: string) => {
    if (id === 'all') return onChange(value.includes('all') ? [] : ['all']);
    const rest = value.filter((g) => g !== 'all');
    onChange(rest.includes(id) ? rest.filter((g) => g !== id) : [...rest, id]);
  };
  const order = allAreas().map((a) => a.route);
  const core = value.length && !value.includes('all') ? coreForGoals(value, order) : [];
  return (
    <>
      <div className="gs-goals" role="group" aria-label={t('Ziele')}>
        {GOALS.map((g) => (
          <button key={g.id} type="button" className={`gs-goal${value.includes(g.id) ? ' on' : ''}`} aria-pressed={value.includes(g.id)} onClick={() => toggle(g.id)} data-tour={`goal-${g.id}`}>
            <b>
              {t(g.label)} <span className="gs-check">{value.includes(g.id) ? '✓' : ''}</span>
            </b>
            <span className="muted small">{t(g.text)}</span>
          </button>
        ))}
      </div>
      {core.length > 0 && (
        <div className="gs-preview" data-tour="goal-preview">
          <span className="small muted">{t('So sieht dein Menü aus – alles andere findest du unter „Mehr“:')}</span>
          <ul>
            {core.map((r) => {
              const a = areaOf(r);
              return a ? (
                <li key={r}>
                  <Icon name={a.icon} size={14} /> {ts(a.label)}
                </li>
              ) : null;
            })}
          </ul>
        </div>
      )}
    </>
  );
}

/** Existing logins: the offer once, as a banner above the page. */
export function GoalBanner() {
  const t = useT('simple');
  const [step, setStep] = useState<'ask' | 'pick' | 'gone'>('ask');
  const [goals, setGoals] = useState<string[]>([DEFAULT_GOAL]);
  if (step === 'gone') return null;
  const done = (g?: string[]) => {
    setStep('gone');
    void update(g ? { goals: g, goal_asked: true } : { goal_asked: true });
  };
  return (
    <>
      <div className="gs-banner" role="region" aria-label={t('Neu: Einfach-Modus')} data-tour="goal-banner">
        <p>
          <b>{t('Neu: Einfach-Modus')}</b> – {t('Menü auf deine Ziele zuschneiden? Alles andere bleibt unter „Mehr“ erreichbar.')}
        </p>
        <div className="actions">
          <button className="btn small" onClick={() => setStep('pick')}>
            {t('Ziele wählen')}
          </button>
          <button className="btn small secondary" onClick={() => done(['all'])}>
            {t('Alles behalten')}
          </button>
          <button className="icon-btn" onClick={() => done()} aria-label={t('Schließen')}>
            ✕
          </button>
        </div>
      </div>
      {step === 'pick' && (
        <Modal
          title={t('Was willst du tun?')}
          wide
          onClose={() => setStep('ask')}
          footer={
            <>
              <button className="btn secondary" onClick={() => setStep('ask')}>
                {t('Abbrechen')}
              </button>
              <button className="btn" disabled={!goals.length} onClick={() => done(goals)} data-tour="goal-apply">
                {t('Übernehmen')}
              </button>
            </>
          }
        >
          <GoalPicker value={goals} onChange={setGoals} />
        </Modal>
      )}
    </>
  );
}

/** Einstellungen → Darstellung: the goals again, first on the page. */
export function GoalCard({ goals, locked }: { goals: string[]; locked: boolean }) {
  const t = useT('simple');
  return (
    <div className="card ap-section" data-tour="appearance-goals">
      <h2>{t('Einfach-Modus: Was willst du tun?')}</h2>
      <p className="muted small" style={{ marginTop: -4 }}>
        {t('Deine Ziele bestimmen, welche Bereiche im Menü stehen. Alles andere liegt unter „Mehr“ – dort kannst du Bereiche auch anheften. „Alles“ zeigt das ganze Menü wie bisher.')}
      </p>
      {locked ? <p className="ap-lock">{t('Von deiner Agentur festgelegt')}</p> : <GoalPicker value={goals} onChange={(g) => void update({ goals: g, goal_asked: true })} />}
    </div>
  );
}
