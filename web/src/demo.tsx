import { useEffect, useState } from 'react';
import { api } from './api';
import { Icon } from './icons';
import { serverText, useT } from './i18n';
import { FIRST_TOUR, LearnLink } from './tour/learn';

/** GET /api/version: product name, version and – on a public demo – the demo login. */
export interface AppInfo {
  name: string;
  version: string;
  /** Hosted cloud mode (PGHL_CLOUD_MODE=1): where people sign up and see the prices. */
  cloud?: null | { enabled: boolean; signup_url: string; pricing_url: string };
  demo: null | { enabled: boolean; login: { email: string; password: string }; reset_hour: number; timezone: string; last_reset: string | null };
}

let cached: Promise<AppInfo | null> | null = null;
export const loadAppInfo = () => (cached ??= api.get<AppInfo>('/api/version').catch(() => null));

export function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    let alive = true;
    void loadAppInfo().then((i) => alive && setInfo(i));
    return () => {
      alive = false;
    };
  }, []);
  return info;
}

/** Shown on every page of a demo instance (PGHL_DEMO_MODE=1). */
export function DemoBanner() {
  const t = useT('shell');
  const info = useAppInfo();
  if (!info?.demo?.enabled) return null;
  return (
    <div className="demo-banner" role="status" data-tour="demo-banner">
      <Icon name="academy" size={16} />
      <span className="grow">
        <strong>{t('Demo – Daten werden täglich zurückgesetzt.')}</strong>
        <span className="sb-more"> {t('Alles ist erfunden; E-Mails, SMS, WhatsApp, Social-Posts und Zahlungen werden nur protokolliert, nie verschickt.')}</span>
      </span>
      <LearnLink tour={FIRST_TOUR} label="guided" />
    </div>
  );
}

const LEFT_KEY = 'pghl-demo-left';

/** Remembers for this tab that the person signed out of the demo, so the login page does not sign them straight back in. */
export function leftDemo() {
  try {
    sessionStorage.setItem(LEFT_KEY, '1');
  } catch {
    /* no storage: the demo simply opens again */
  }
}

const hasLeftDemo = () => {
  try {
    return sessionStorage.getItem(LEFT_KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * Login page of a demo instance: opens the demo by itself (nobody should have to click through a login to look around),
 * and keeps the demo login plus a one-click "Demo öffnen" for whoever signed out or arrives while the demo is being seeded.
 */
export function DemoLogin({ onDone, onFill }: { onDone: () => void; onFill: (email: string, password: string) => void }) {
  const t = useT('shell');
  const info = useAppInfo();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const demo = !!info?.demo?.enabled;
  useEffect(() => {
    if (!demo || hasLeftDemo()) return;
    let alive = true;
    setBusy(true);
    api
      .post('/api/demo/login')
      .then(() => alive && onDone())
      .catch(() => undefined)
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [demo]);
  if (!info?.demo?.enabled) return null;
  const { email, password } = info.demo.login;
  return (
    <div className="demo-login" data-tour="demo-login">
      <strong>{t('Demo – Daten werden täglich zurückgesetzt')}</strong>
      <p className="small" style={{ margin: '6px 0 10px' }}>
        {t('E-Mail')} <code>{email}</code> · {t('Passwort')} <code>{password}</code>
      </p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr('');
            try {
              await api.post('/api/demo/login');
              onDone();
            } catch (e) {
              setErr(serverText((e as Error).message));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('Demo öffnen')}
        </button>
        <button type="button" className="btn secondary" onClick={() => onFill(email, password)}>
          {t('Felder ausfüllen')}
        </button>
      </div>
      {err && <p className="small" style={{ color: 'var(--red)', marginBottom: 0 }}>{err}</p>}
    </div>
  );
}

/** "HyperLevel 0.0.18" – sidebar footer. */
export function VersionTag() {
  const t = useT('shell');
  const info = useAppInfo();
  if (!info) return null;
  return (
    <span className="version-tag" data-tour="app-version" title={t('Version dieser Installation')}>
      {info.name} {info.version}
    </span>
  );
}
