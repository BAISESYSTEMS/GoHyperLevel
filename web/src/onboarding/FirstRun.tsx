import { useState } from 'react';
import { DEFAULT_GOAL } from '../../../server/services/areas-model';
import { api } from '../api';
import { GoalPicker } from '../areas/GoalSetup';
import { useT } from '../i18n';
import { Icon, type IconName } from '../icons';
import { can, useSession } from '../session';
import { update } from '../theme/store';
import { loadAcademy } from '../tour/progress';
import { Modal, navigate, toastError } from '../ui';
import { dataChoices, skipGoals, successChoices, suggestedSuccess, type Choice, type DataChoice, type SuccessChoice } from './first-run-model';
import { savePlan } from './plan';
import './onboarding.css';

/**
 * Der Willkommens-Assistent – the first thing a new login sees (instead of the bare goal dialog): three short steps with
 * a visible progress, "Überspringen" on every one of them.
 *   1. Was machst du?      → the goals of the Einfach-Modus (which areas stay in the menu – areas/GoalSetup.tsx)
 *   2. Deine Daten         → import a CSV, move from another tool, practise in the Übungs-Firma, or start empty
 *   3. Dein erster Erfolg  → a booking page, a form, a landing page or a course – the page opens with its dialog
 * Finishing saves the goals (like the old dialog did), remembers the answers for the "Erste Schritte" card on the
 * dashboard (./FirstSteps.tsx) and goes straight to the first thing to do. Skipping in step 1 keeps the whole menu
 * ("Alles"), later the goals chosen so far (./first-run-model.ts skipGoals) – and still leaves the card, so nothing is lost.
 */

const STEPS = 3;

function Choices<K extends string>({ items, value, onChange, label }: { items: Choice<K>[]; value: K; onChange: (v: K) => void; label: string }) {
  const t = useT('onboarding');
  return (
    <div className="gs-goals fr-choices" role="radiogroup" aria-label={label}>
      {items.map((c) => (
        <button key={c.id} type="button" role="radio" aria-checked={value === c.id} className={`gs-goal${value === c.id ? ' on' : ''}`} onClick={() => onChange(c.id)} data-tour={`firstrun-${c.id}`}>
          <b>
            <Icon name={c.icon as IconName} size={18} /> {t(c.label)} <span className="gs-check">{value === c.id ? '✓' : ''}</span>
          </b>
          <span className="muted small">{t(c.text)}</span>
        </button>
      ))}
    </div>
  );
}

export function FirstRun() {
  const t = useT('onboarding');
  const session = useSession();
  const admin = session.user.role === 'admin';
  const [open, setOpen] = useState(true);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [goals, setGoals] = useState<string[]>([DEFAULT_GOAL]);
  const [data, setData] = useState<DataChoice>('import');
  const [success, setSuccess] = useState<SuccessChoice | null>(null);
  if (!open) return null;
  const datas = dataChoices({ admin, settings: can(session, 'settings') });
  const successes = successChoices(goals);
  // the suggestion follows the goals until a first success was picked by hand
  const picked: SuccessChoice = success && successes.some((c) => c.id === success) ? success : suggestedSuccess(goals);
  const chosenGoals = goals.length ? goals : [DEFAULT_GOAL];

  const close = (skipped: boolean) => {
    setOpen(false);
    void update({ goals: skipped ? skipGoals(step, goals) : chosenGoals, goal_asked: true, asked: true });
    savePlan(session.user.id, { data: skipped ? 'empty' : data, success: picked, at: new Date().toISOString(), ...(skipped ? { skipped: true } : {}) });
  };

  const finish = async () => {
    if (busy) return;
    if (data === 'practice') {
      // The Übungs-Firma: created and filled once (POST /api/academy/sandbox), then opened – the banner there says it is made up.
      setBusy(true);
      const sb = await api.post<{ id: string }>('/api/academy/sandbox', {}).catch((e: unknown) => (toastError(e), null));
      setBusy(false);
      if (!sb) return;
      close(false);
      void loadAcademy(true);
      session.switchLocation(sb.id, 'dashboard');
      return;
    }
    close(false);
    // data first (an import or a move), otherwise straight to the first success
    navigate(data === 'empty' ? successes.find((c) => c.id === picked)!.to : datas.find((c) => c.id === data)!.to);
  };

  const title = step === 1 ? t('Willkommen! Was machst du?') : step === 2 ? t('Woher kommen deine Daten?') : t('Dein erster Erfolg');
  return (
    <Modal
      title={title}
      wide
      className="fr-modal"
      onClose={() => close(true)}
      footer={
        <>
          <button type="button" className="btn secondary fr-skip" onClick={() => close(true)} data-tour="firstrun-skip">
            {t('Überspringen')}
          </button>
          {step > 1 && (
            <button type="button" className="btn secondary" onClick={() => setStep(step - 1)}>
              {t('Zurück')}
            </button>
          )}
          {step < STEPS ? (
            <button type="button" className="btn" disabled={step === 1 && !goals.length} onClick={() => setStep(step + 1)} data-tour="firstrun-next">
              {t('Weiter')}
            </button>
          ) : (
            <button type="button" className="btn" disabled={busy} onClick={() => void finish()} data-tour="firstrun-go">
              {busy ? t('Übungs-Firma wird angelegt …') : t('Los geht’s')}
            </button>
          )}
        </>
      }
    >
      <div className="fr-progress" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS} aria-valuenow={step} aria-valuetext={t('Schritt {n} von {total}', { n: step, total: STEPS })}>
        <span className="fr-dots" aria-hidden="true">
          {Array.from({ length: STEPS }, (_, i) => (
            <span key={i} className={i + 1 < step ? 'done' : i + 1 === step ? 'on' : ''} />
          ))}
        </span>
        <span className="muted small">{t('Schritt {n} von {total}', { n: step, total: STEPS })}</span>
      </div>
      {step === 1 && (
        <>
          <p className="muted fr-lead">{t('Wir zeigen dir nur die Bereiche, die du dafür brauchst. Alles andere liegt unter „Mehr“ – nichts wird gelöscht oder gesperrt.')}</p>
          <GoalPicker value={goals} onChange={setGoals} />
        </>
      )}
      {step === 2 && (
        <>
          <p className="muted fr-lead">{t('Mit echten Daten macht HyperLevel sofort Sinn. Du kannst das jederzeit später nachholen.')}</p>
          <Choices items={datas} value={data} onChange={setData} label={t('Woher kommen deine Daten?')} />
        </>
      )}
      {step === 3 && (
        <>
          <p className="muted fr-lead">{t('Such dir eine Sache aus, die heute live geht. Die Seite öffnet sich direkt mit dem passenden Dialog.')}</p>
          <Choices items={successes} value={picked} onChange={setSuccess} label={t('Dein erster Erfolg')} />
          <p className="muted small fr-after">{t('Danach zeigt dir die Karte „Erste Schritte“ auf dem Dashboard, was noch fehlt.')}</p>
        </>
      )}
    </Modal>
  );
}
