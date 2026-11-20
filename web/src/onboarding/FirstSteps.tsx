import { useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { Icon } from '../icons';
import { useSession } from '../session';
import { FIRST_TOUR, learn } from '../tour/learn';
import { useAcademy } from '../tour/progress';
import { AcademyWelcome } from '../tour/welcome';
import { navigate } from '../ui';
import { firstSteps, progressOf, type FirstRunFacts, type FirstStep } from './first-run-model';
import { hidePlan, planHidden, usePlan } from './plan';
import './onboarding.css';

/**
 * "Erste Schritte" – the card at the top of the dashboard after the welcome wizard (./FirstRun.tsx): three steps with a
 * progress bar, ticked off from real data (a contact, a calendar, a form …), and exactly one primary action – the next
 * open step. ✕ hides it for this person in this browser. Without wizard answers (older logins, other browsers) the
 * academy hint shows as before.
 */

const ENDPOINT: Record<string, string> = { booking: '/api/calendars', form: '/api/forms', site: '/api/funnels', course: '/api/courses' };

export function FirstSteps({ contacts }: { contacts?: number }) {
  const t = useT('onboarding');
  const session = useSession();
  const academy = useAcademy();
  const plan = usePlan(session.user.id);
  const [hidden, setHidden] = useState(() => planHidden(session.user.id));
  const [items, setItems] = useState<any[] | undefined>();
  useEffect(() => {
    if (!plan || hidden) return;
    let live = true;
    void api
      .get<any[]>(ENDPOINT[plan.success] ?? '/api/forms')
      .then((r) => live && setItems(Array.isArray(r) ? r : []))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [session.locationId, plan?.success, hidden]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!plan || hidden) return <AcademyWelcome />;
  const n = items?.length;
  const facts: FirstRunFacts = {
    contacts,
    calendars: plan.success === 'booking' ? n : undefined,
    forms: plan.success === 'form' ? n : undefined,
    funnels: plan.success === 'site' ? n : undefined,
    courses: plan.success === 'course' ? n : undefined,
    tour: !!academy?.tours[FIRST_TOUR]?.done,
    practice: !!academy?.sandbox,
  };
  const steps = firstSteps(plan, facts);
  const { done, total, next } = progressOf(steps);
  // the booking page is the success you can show around: its public link, right on the card
  const link: string | undefined = plan.success === 'booking' ? items?.[0]?.url : undefined;
  const go = (s: FirstStep) => (s.key === 'tour' ? learn(FIRST_TOUR) : navigate(s.to));
  const hide = () => {
    setHidden(true);
    hidePlan(session.user.id);
  };
  return (
    <section className="card fr-card" aria-labelledby="fr-card-title" data-tour="first-steps">
      <div className="fr-card-head">
        <h2 id="fr-card-title">{done === total ? t('Geschafft – du bist startklar!') : t('Erste Schritte')}</h2>
        <span className="muted small">{t('{done} von {total} erledigt', { done, total })}</span>
        <button type="button" className="icon-btn" onClick={hide} aria-label={t('Ausblenden')} title={t('Ausblenden')}>
          ✕
        </button>
      </div>
      <div className="fr-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={t('Erste Schritte')}>
        <span style={{ width: `${(done / total) * 100}%` }} />
      </div>
      <ol className="fr-steps">
        {steps.map((s) => (
          <li key={s.key} className={s.done ? 'done' : s === next ? 'next' : ''}>
            <span className="fr-mark" aria-hidden="true">
              {s.done ? <Icon name="check" size={14} /> : null}
            </span>
            <div className="grow">
              {s.done ? (
                <b>{t(s.label)}</b>
              ) : (
                <a
                  href={`/app/${s.to}`}
                  onClick={(e) => {
                    e.preventDefault();
                    go(s);
                  }}
                >
                  <b>{t(s.label)}</b>
                </a>
              )}
              <div className="muted small">
                {s.done && s.key === 'success' && link ? (
                  <>
                    {t('Live:')}{' '}
                    <a href={link} target="_blank" rel="noreferrer">
                      {link.replace(/^https?:\/\//, '')}
                    </a>
                  </>
                ) : (
                  t(s.text)
                )}
              </div>
            </div>
            {s === next && (
              <button type="button" className="btn small" onClick={() => go(s)} data-tour={`first-steps-${s.key}`}>
                {s.key === 'tour' ? t('Tour starten') : t('Jetzt erledigen')}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
