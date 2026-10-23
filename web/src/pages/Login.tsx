import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DemoLogin } from '../demo';
import { ShieldCheck } from 'lucide-react';
import { api } from '../api';
import type { Branding } from '../session';
import { Field, Input } from '../ui';
import { getPasskey, passkeyError, passkeysSupported } from '../webauthn';
import { Later, lazyPages } from '../lazy';
import { ProviderIcon } from '../provider-icon';
import { resolveDark, usePrefs } from '../theme/store';
import { PRODUCT_ICON } from '../theme/brand-icon';
import { serverText, useT } from '../i18n';
import { LanguageLinks } from '../i18n/LanguageMenu';

// Only the 2FA gate needs these – the settings page they live on is a big chunk of its own.
const { TwoFactor } = lazyPages(() => import('./Settings'), 'TwoFactor');
const { PasskeyList } = lazyPages(() => import('./SignInMethods'), 'PasskeyList');

/**
 * The sign-in page: SSO buttons (Google, Microsoft, GitHub, Apple, the agency's or client's OIDC),
 * „Mit Passkey anmelden“, password or e-mail link – whatever the login policy allows on this domain
 * (also a client's white-label login domain). SSO always navigates (no popups), so it also works in
 * the Android app's WebView: the provider opens in a Custom Tab and this page picks the result up.
 */

interface Provider {
  id: string;
  label: string;
  icon: string;
}
interface Methods {
  password: boolean;
  magic_link: boolean;
  passkey: boolean;
  providers: Provider[];
}

type Step =
  | { kind: 'start' }
  | { kind: 'second'; token?: string; methods: string[]; passkey?: { challenge_id: string; options: any } }
  | { kind: 'link'; token: string; email: string; provider: string; needsCode?: boolean; passkey?: { challenge_id: string; options: any } }
  | { kind: 'magic-sent'; message: string }
  | { kind: 'magic-confirm'; token: string; email: string; invite: boolean };

const inApp = () => /GoHighApp\//.test(navigator.userAgent);
/** Where to go after signing in: the page that asked for the login (e.g. the MCP consent screen). */
const here = () => {
  const q = new URLSearchParams(location.search);
  for (const k of ['magic', 'sso']) q.delete(k);
  const s = q.toString();
  return `${location.pathname}${s ? `?${s}` : ''}`;
};

const errText = (x: unknown) => serverText((x as Error).message);

function Shell({ branding, title, text, children }: { branding: Branding; title: string; text?: ReactNode; children: ReactNode }) {
  const t = useT('login');
  // The card is dark in dark mode: take the logo made for dark surfaces when there is one.
  const dark = resolveDark(usePrefs().mode);
  const logo = (dark ? branding.logo_dark_url : '') || branding.logo_url;
  const mark = (dark ? branding.mark_dark_url : '') || branding.mark_url;
  return (
    <div className="login">
      <div className="card login-card">
        <div className="login-head">
          {/* no wide logo: the uploaded square mark, else the HyperLevel icon (as in the sidebar) – never an initial */}
          {logo ? (
            <img src={logo} alt={branding.name} className="login-logo" />
          ) : (
            <img src={mark || PRODUCT_ICON} alt={branding.name} className="login-icon" width={52} height={52} />
          )}
          <h1 style={{ marginBottom: 6 }}>{title}</h1>
          {text && <p className="muted" style={{ marginTop: 0 }}>{text}</p>}
        </div>
        {children}
        {branding.support_email && (
          <p className="muted small" style={{ textAlign: 'center', marginBottom: 0 }}>
            {t('Hilfe:')} <a href={`mailto:${branding.support_email}`}>{branding.support_email}</a>
          </p>
        )}
        <LanguageLinks />
      </div>
    </div>
  );
}

export function LoginPage({ needsSetup, onDone, branding, hint }: { needsSetup: boolean; onDone: () => void; branding: Branding; hint?: string }) {
  const t = useT('login');
  const [methods, setMethods] = useState<Methods | null>(needsSetup ? { password: true, magic_link: false, passkey: false, providers: [] } : null);
  const [step, setStep] = useState<Step>({ kind: 'start' });
  const [f, setF] = useState({ email: '', password: '', name: '', locationName: '', code: '' });
  const [mode, setMode] = useState<'password' | 'magic'>('password');
  const [sso, setSso] = useState<{ id: string; label: string } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [waiting, setWaiting] = useState('');
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const discovered = useRef('');

  const finish = (next?: string) => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    if (next && next !== location.pathname + location.search) {
      history.replaceState(null, '', next);
      window.dispatchEvent(new Event('pghl:nav'));
    }
    onDone();
  };

  /** One answer shape for all ways in: done, second factor, link confirmation or an error. */
  const handle = (r: any): boolean => {
    if (!r) return false;
    if (r.done || r.user) {
      finish(r.next);
      return true;
    }
    if (r.second_factor) {
      setStep({ kind: 'second', token: r.second_factor.token, methods: r.second_factor.methods ?? ['code'], passkey: r.second_factor.passkey });
      return true;
    }
    if (r.needs_code) {
      setStep((s) => (s.kind === 'link' ? { ...s, needsCode: true, passkey: r.passkey } : { kind: 'second', methods: r.methods ?? ['code'], passkey: r.passkey }));
      return true;
    }
    if (r.link_confirm) {
      setStep({ kind: 'link', token: r.link_confirm.token, email: r.link_confirm.email, provider: r.link_confirm.provider });
      return true;
    }
    if (r.error) {
      setErr(serverText(r.error));
      setWaiting('');
      return true;
    }
    return false;
  };

  const run = async (key: string, fn: () => Promise<any>) => {
    setBusy(key);
    setErr('');
    try {
      return handle(await fn());
    } catch (x) {
      setErr(errText(x));
      return false;
    } finally {
      setBusy('');
    }
  };

  const poll = async () => {
    try {
      const r = await api.post('/api/auth/sso/poll');
      if (r?.pending) return true;
      handle(r);
    } catch {
      /* offline – try again */
      return true;
    }
    return false;
  };

  useEffect(() => {
    if (needsSetup) return;
    api.get<Methods>('/api/auth/methods').then(setMethods).catch(() => setMethods({ password: true, magic_link: false, passkey: false, providers: [] }));
    const q = new URLSearchParams(location.search);
    const magic = q.get('magic');
    if (magic) {
      history.replaceState(null, '', here());
      api
        .post('/api/auth/magic-link/peek', { token: magic })
        .then((r) => setStep({ kind: 'magic-confirm', token: magic, email: r.email, invite: r.invite }))
        .catch((x) => setErr(errText(x)));
    }
    // Back from an SSO provider (or a client domain / the app's Custom Tab): pick up the result.
    void poll();
    const onVisible = () => document.visibilityState === 'visible' && pollTimer.current && void poll();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startSso = async (p: { id: string; label: string }) => {
    setBusy(p.id);
    setErr('');
    try {
      const r = await api.post('/api/auth/sso/start', { provider: p.id, next: here() });
      location.href = r.url;
      // In the Android app the provider opens in a Custom Tab and this page stays: wait for the result.
      setWaiting(inApp() ? t('Anmeldung bei {provider} läuft im Browser-Fenster …', { provider: p.label }) : '');
      if (pollTimer.current) clearInterval(pollTimer.current);
      const until = Date.now() + 10 * 60_000;
      pollTimer.current = setInterval(async () => {
        if (Date.now() > until || !(await poll())) {
          if (pollTimer.current) clearInterval(pollTimer.current);
          pollTimer.current = null;
        }
      }, 2000);
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy('');
    }
  };

  const passkeyLogin = () =>
    run('passkey', async () => {
      const o = await api.post('/api/auth/passkey/options');
      let credential;
      try {
        credential = await getPasskey(o.options);
      } catch (e) {
        throw new Error(passkeyError(e));
      }
      return api.post('/api/auth/passkey/login', { challenge_id: o.challenge_id, credential, next: here() });
    });

  const discover = async (email: string) => {
    if (needsSetup || !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email) || discovered.current === email) return;
    discovered.current = email;
    const r = await api.post('/api/auth/discover', { email }).catch(() => null);
    setSso(r?.sso ?? null);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (sso) return void startSso(sso);
    if (mode === 'magic' && !needsSetup)
      return void run('submit', async () => {
        const r = await api.post('/api/auth/magic-link', { email: f.email, next: here() });
        setStep({ kind: 'magic-sent', message: r.message });
        return true;
      });
    void run('submit', () => api.post(needsSetup ? '/api/auth/setup' : '/api/auth/login', { email: f.email, password: f.password, name: f.name, locationName: f.locationName }));
  };

  // --- steps ------------------------------------------------------------------------------
  if (step.kind === 'second') {
    const viaTicket = !!step.token;
    const send = (extra: Record<string, unknown>) => (viaTicket ? api.post('/api/auth/second-factor', { token: step.token, ...extra }) : api.post('/api/auth/login', { email: f.email, password: f.password, ...extra }));
    const usePasskey = () =>
      run('passkey', async () => {
        let credential;
        try {
          credential = await getPasskey(step.passkey!.options);
        } catch (e) {
          throw new Error(passkeyError(e));
        }
        return send({ passkey: { challenge_id: step.passkey!.challenge_id, credential } });
      });
    return (
      <Shell branding={branding} title={t('Zweiter Schritt')} text={t('Bestätige, dass du es bist.')}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run('code', () => send({ code: f.code }));
          }}
        >
          {step.methods.includes('passkey') && step.passkey && passkeysSupported() && (
            <button type="button" className="btn secondary provider-btn" disabled={!!busy} onClick={usePasskey}>
              <ProviderIcon icon="passkey" /> {t('Mit Passkey bestätigen')}
            </button>
          )}
          {step.methods.includes('code') && (
            <>
              {step.methods.includes('passkey') && <div className="login-or">{t('oder')}</div>}
              <Field label={t('Code aus der Authenticator-App')} hint={t('oder einer deiner Backup-Codes')}>
                <Input value={f.code} onChange={(v) => setF({ ...f, code: v })} autoComplete="one-time-code" inputMode="numeric" autoFocus required />
              </Field>
              <button className="btn login-submit" disabled={!!busy}>
                {t('Bestätigen')}
              </button>
            </>
          )}
          {err && <p className="login-error" role="alert">{err}</p>}
        </form>
        <p className="small" style={{ textAlign: 'center' }}>
          <a href="/app" onClick={() => setStep({ kind: 'start' })}>
            {t('Abbrechen')}
          </a>
        </p>
      </Shell>
    );
  }

  if (step.kind === 'link') {
    return (
      <Shell
        branding={branding}
        title={t('{provider} verknüpfen', { provider: step.provider })}
        text={
          <>
            {t('Für {email} gibt es schon ein Konto.', { email: step.email })} {t('Gib einmal dein Passwort ein – danach geht die Anmeldung mit {provider} direkt.', { provider: step.provider })}
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run('link', () => api.post('/api/auth/sso/link-confirm', { token: step.token, password: f.password, code: f.code || undefined }));
          }}
        >
          <Field label={t('Passwort')}>
            <Input type="password" value={f.password} onChange={(v) => setF({ ...f, password: v })} autoComplete="current-password" autoFocus required />
          </Field>
          {step.needsCode && (
            <Field label={t('Code aus der Authenticator-App')}>
              <Input value={f.code} onChange={(v) => setF({ ...f, code: v })} autoComplete="one-time-code" inputMode="numeric" required />
            </Field>
          )}
          {err && <p className="login-error" role="alert">{err}</p>}
          <button className="btn login-submit" disabled={!!busy}>
            {t('Verknüpfen und anmelden')}
          </button>
        </form>
        <p className="small" style={{ textAlign: 'center' }}>
          <a href="/app">{t('Abbrechen')}</a>
        </p>
      </Shell>
    );
  }

  if (step.kind === 'magic-sent') {
    return (
      <Shell branding={branding} title={t('Schau in dein Postfach')} text={serverText(step.message)}>
        <p className="muted small">{t('Kein Link da? Prüfe den Spam-Ordner oder fordere in ein paar Minuten einen neuen an.')}</p>
        <button className="btn secondary login-submit" onClick={() => setStep({ kind: 'start' })}>
          {t('Zurück')}
        </button>
      </Shell>
    );
  }

  if (step.kind === 'magic-confirm') {
    return (
      <Shell branding={branding} title={step.invite ? t('Einladung annehmen') : t('Anmelden')} text={t('Weiter als {email}?', { email: step.email })}>
        {err && <p className="login-error" role="alert">{err}</p>}
        <button className="btn login-submit" disabled={!!busy} onClick={() => void run('magic', () => api.post('/api/auth/magic-link/consume', { token: step.token }))}>
          {step.invite ? t('Einladung annehmen') : t('Jetzt anmelden')}
        </button>
        <p className="small" style={{ textAlign: 'center' }}>
          <a href="/app" onClick={() => setStep({ kind: 'start' })}>
            {t('Das bin ich nicht')}
          </a>
        </p>
      </Shell>
    );
  }

  // --- start --------------------------------------------------------------------------------
  const m = methods;
  const passkeyOk = !!m?.passkey && passkeysSupported() && !needsSetup;
  const emailWay = !!m && (needsSetup || m.password || m.magic_link);
  const top = !!m && (m.providers.length > 0 || passkeyOk);
  const magicOnly = !!m && !m.password && m.magic_link;
  const useMagic = !needsSetup && (mode === 'magic' || magicOnly);
  return (
    <Shell
      branding={branding}
      title={needsSetup ? t('Willkommen') : branding.login_title || t('Anmelden bei {name}', { name: branding.name })}
      text={needsSetup ? t('Lege dein Admin-Konto und deine Firma an.') : hint || branding.login_text || t('Melde dich an, wie es dir am liebsten ist.')}
    >
      {!m && <div className="spinner" style={{ margin: '16px auto' }} />}
      {!needsSetup && <DemoLogin onDone={onDone} onFill={(email, password) => setF((cur) => ({ ...cur, email, password }))} />}
      {waiting && (
        <p className="login-wait" role="status">
          <ShieldCheck size={16} /> {waiting}
        </p>
      )}
      {top && (
        <div className="login-providers">
          {m!.providers.map((p) => (
            <button key={p.id} type="button" className="btn secondary provider-btn" disabled={!!busy} onClick={() => startSso(p)} data-provider={p.id}>
              <ProviderIcon icon={p.icon} /> {t('Mit {provider} anmelden', { provider: p.label })}
            </button>
          ))}
          {passkeyOk && (
            <button type="button" className="btn secondary provider-btn" disabled={!!busy} onClick={passkeyLogin}>
              <ProviderIcon icon="passkey" /> {t('Mit Passkey anmelden')}
            </button>
          )}
        </div>
      )}
      {top && emailWay && <div className="login-or">{t('oder mit E-Mail')}</div>}
      {emailWay && (
        <form onSubmit={submit}>
          {needsSetup && (
            <>
              <Field label={t('Dein Name')}>
                <Input value={f.name} onChange={(v) => setF({ ...f, name: v })} autoComplete="name" />
              </Field>
              <Field label={t('Firmenname')}>
                <Input value={f.locationName} onChange={(v) => setF({ ...f, locationName: v })} placeholder={t('Meine Firma')} />
              </Field>
            </>
          )}
          <Field label={t('E-Mail')}>
            <Input type="email" value={f.email} onChange={(v) => setF({ ...f, email: v })} onBlur={() => void discover(f.email.trim().toLowerCase())} required autoComplete={passkeyOk ? 'username webauthn' : 'email'} />
          </Field>
          {sso ? (
            <p className="muted small">{t('Für diese Adresse meldest du dich über {provider} an.', { provider: sso.label })}</p>
          ) : (
            !useMagic && (
              <Field label={t('Passwort')} hint={needsSetup ? t('mindestens 8 Zeichen') : undefined}>
                <Input type="password" value={f.password} onChange={(v) => setF({ ...f, password: v })} required autoComplete={needsSetup ? 'new-password' : 'current-password'} />
              </Field>
            )
          )}
          {err && <p className="login-error" role="alert">{err}</p>}
          <button className="btn login-submit" disabled={!!busy}>
            {sso ? (
              <>
                <ProviderIcon icon="key" /> {t('Weiter mit {provider}', { provider: sso.label })}
              </>
            ) : needsSetup ? (
              t('Einrichten')
            ) : useMagic ? (
              <>
                <ProviderIcon icon="mail" /> {t('Anmelde-Link schicken')}
              </>
            ) : (
              t('Anmelden')
            )}
          </button>
          {!needsSetup && !sso && m!.password && m!.magic_link && (
            <p className="small" style={{ textAlign: 'center', marginBottom: 0 }}>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setErr('');
                  setMode(mode === 'magic' ? 'password' : 'magic');
                }}
              >
                {mode === 'magic' ? t('Mit Passwort anmelden') : t('Ohne Passwort: Link per E-Mail')}
              </a>
            </p>
          )}
        </form>
      )}
      {!emailWay && err && <p className="login-error" role="alert">{err}</p>}
    </Shell>
  );
}

/** Admins under the 2FA duty: set up a passkey or the authenticator app before anything else. */
export function SecurityGate({ branding, onDone, onLogout }: { branding: Branding; onDone: () => void; onLogout: () => void }) {
  const t = useT('login');
  return (
    <div className="login">
      <div className="card login-card" style={{ maxWidth: 520 }}>
        <div className="login-head">
          <span className="login-mark">
            <ShieldCheck size={20} />
          </span>
          <h1 style={{ marginBottom: 6 }}>{t('Zwei-Faktor-Login einrichten')}</h1>
          <p className="muted" style={{ marginTop: 0 }}>
            {t('{name} verlangt für Admins einen zweiten Faktor. Richte einen Passkey oder eine Authenticator-App ein – danach geht es direkt weiter.', { name: branding.name })}
          </p>
        </div>
        <Later fallback={<div className="spinner" aria-label={t('Lädt')} />}>
          <PasskeyList onChange={onDone} compact />
          <hr />
          <TwoFactor onChange={onDone} />
        </Later>
        <p className="small" style={{ textAlign: 'center', marginBottom: 0 }}>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onLogout();
            }}
          >
            {t('Abmelden')}
          </a>
        </p>
      </div>
    </div>
  );
}
