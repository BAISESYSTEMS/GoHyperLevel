import { useEffect, useState } from 'react';
import { api } from '../api';
import { navigate } from '../ui';
import './umzug-mailbar.css';
import { tr, useT } from '../i18n';

/** Hinweis im Versand-Dialog der Kampagnen: wie steht es um SPF, DKIM und DMARC der Absender-Domain? (Details: Einstellungen → E-Mail-Zustellung.) */

export interface MailStatus {
  status: 'none' | 'log' | 'new' | 'ok' | 'warn' | 'fail' | 'unknown';
  domain: string | null;
  summary: string;
  issues?: { key: string; label: string; status: string; summary: string }[];
}

/** The verdict for the sender's domain (checks it first when it is old). null = could not be read. */
export async function mailStatus(): Promise<MailStatus | null> {
  try {
    return await api.get<MailStatus>('/api/mail-domains/status?refresh=1');
  } catch {
    return null;
  }
}

/** Text for the send confirmation – empty when everything is fine or unknown. */
export async function mailWarning(): Promise<string> {
  const s = await mailStatus();
  if (!s || (s.status !== 'warn' && s.status !== 'fail')) return '';
  const what = (s.issues ?? []).map((i) => i.label).join(', ');
  const t = tr('campaigns');
  return what
    ? t('Achtung: Bei deiner Absender-Domain {domain} gibt es Probleme mit der E-Mail-Zustellung ({what}). Die Mails können im Spam landen. Wie du das behebst, steht unter Einstellungen → E-Mail-Zustellung.', { domain: String(s.domain), what })
    : t('Achtung: Bei deiner Absender-Domain {domain} gibt es Probleme mit der E-Mail-Zustellung. Die Mails können im Spam landen. Wie du das behebst, steht unter Einstellungen → E-Mail-Zustellung.', { domain: String(s.domain) });
}

export function MailBanner() {
  const t = useT('campaigns');
  const [s, setS] = useState<MailStatus | null>(null);
  useEffect(() => {
    let stop = false;
    void mailStatus().then((r) => !stop && setS(r));
    return () => {
      stop = true;
    };
  }, []);
  if (!s || s.status === 'log' || s.status === 'unknown') return null;
  const go = (e: { preventDefault(): void }) => {
    e.preventDefault();
    navigate('settings/deliverability');
  };
  if (s.status === 'ok') {
    return (
      <p className="um-mailbar ok" data-tour="campaign-mailcheck">
        {t('✓ Absender-Domain {domain}: SPF, DKIM und DMARC sind in Ordnung.', { domain: s.domain ?? '' })}
      </p>
    );
  }
  const bad = s.status === 'fail';
  return (
    <div className={`um-mailbar ${bad ? 'fail' : 'warn'}`} role="status" data-tour="campaign-mailcheck">
      <strong>{s.status === 'none' ? t('Noch kein Absender eingestellt') : s.status === 'new' ? t('Zustellung noch nicht geprüft') : bad ? t('Zustellung gefährdet') : t('Zustellung prüfen')}</strong>
      {s.status === 'new' || s.status === 'none' || !s.issues?.length ? (
        <span>{s.summary}</span>
      ) : (
        <ul>
          {s.issues.map((i) => (
            <li key={i.key}>
              <strong>{i.label}:</strong> {i.summary}
            </li>
          ))}
        </ul>
      )}
      <a href="#" onClick={go}>
        {t('E-Mail-Zustellung prüfen')}
      </a>
    </div>
  );
}
