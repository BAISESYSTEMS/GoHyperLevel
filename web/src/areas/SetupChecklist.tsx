import { useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useLook } from '../theme/store';
import { Link } from '../ui';
import { missingSetup, type SetupFacts, type SetupKey } from './setup-model';
import './settings-easy.css';

/**
 * "Was muss ich einrichten?" – at the top of Einstellungen in the Einfach-Modus: only the steps that are still missing
 * (rules: ./setup-model.ts), each a link to the section that fixes it. Nothing missing → no card. ✕ hides it in this
 * browser for this sub-account.
 */

const hideKey = (loc: string) => `hl.setup.hide.${loc}`;
const ok = <T,>(r: PromiseSettledResult<T>): T | undefined => (r.status === 'fulfilled' ? r.value : undefined);

export function SetupChecklist() {
  const t = useT('simple');
  const session = useSession();
  const goals = useLook().prefs.goals;
  const admin = session.user.role === 'admin';
  const [facts, setFacts] = useState<SetupFacts | null>(null);
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(hideKey(session.locationId)) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (hidden) return;
    let live = true;
    void Promise.allSettled([
      api.get<any>('/api/location'),
      api.get<any>('/api/ai-connections'),
      api.get<any>('/api/invoice-settings'),
      api.get<any>('/api/pay/providers'),
      api.get<any>('/api/me/2fa'),
    ]).then(([loc, ai, inv, pay, tfa]) => {
      if (!live) return;
      const eff = ok(ai)?.routing?.effective;
      const providers = ok(pay)?.providers;
      setFacts({
        goals,
        admin,
        location: ok(loc),
        ai: eff ? !!(eff.agent || eff.text) : undefined,
        invoice: ok(inv)?.settings,
        payments: Array.isArray(providers) ? providers.some((p: any) => p.ready) : undefined,
        twoFactor: ok(tfa) ? !!ok(tfa).enabled : undefined,
      });
    });
    return () => {
      live = false;
    };
  }, [session.locationId, hidden, goals.join(','), admin]); // eslint-disable-line react-hooks/exhaustive-deps
  if (hidden || !facts) return null;
  const steps = missingSetup(facts);
  if (!steps.length) return null;
  const TEXT: Record<SetupKey, [string, string]> = {
    company: [t('Firmendaten ergänzen'), t('Name, E-Mail und Adresse – stehen in E-Mails, Rechnungen und im Impressum.')],
    email: [t('E-Mail-Versand einrichten'), t('Noch geht keine E-Mail raus („Nur speichern“). Postfach verbinden oder SMTP eintragen.')],
    ai: [t('KI verbinden'), t('Einen KI-Schlüssel eintragen, damit Assistent und Agenten arbeiten können.')],
    invoice: [t('Rechnungsangaben ergänzen'), t('Anschrift und Steuernummer – Pflicht auf jeder Rechnung.')],
    payments: [t('Online-Zahlung verbinden'), t('Stripe, PayPal oder Mollie, damit Kunden direkt bezahlen können.')],
    twofactor: [t('Zwei-Faktor-Login einschalten'), t('Schützt dein Admin-Konto mit einem Code aus einer App.')],
  };
  const hide = () => {
    setHidden(true);
    try {
      localStorage.setItem(hideKey(session.locationId), '1');
    } catch {
      /* private mode: shows again next time */
    }
  };
  return (
    <div className="card setup-card" data-tour="settings-setup">
      <div className="setup-card-head">
        <h2>{t('Was muss ich einrichten?')}</h2>
        <button type="button" className="icon-btn" onClick={hide} aria-label={t('Ausblenden')} title={t('Ausblenden')}>
          ✕
        </button>
      </div>
      <ol>
        {steps.map((s) => (
          <li key={s.key}>
            <Link to={s.to}>{TEXT[s.key][0]}</Link>
            <div className="muted small">{TEXT[s.key][1]}</div>
          </li>
        ))}
      </ol>
    </div>
  );
}
