import { useEffect, useRef, useState } from 'react';
import { api, dt } from '../api';
import { Badge, Field, Input, Spinner, act, confirmAsk, toast, toastError, useLoad } from '../ui';
import { createPasskey, passkeyError, passkeysSupported } from '../webauthn';
import { ProviderIcon } from '../provider-icon';
import { tr, useT } from '../i18n';

const ts = tr('settings');

/** „Mein Konto“: linked sign-in accounts (Google, Microsoft, GitHub, Apple, SSO), passkeys, first password. */

export function PasskeyList({ onChange, compact }: { onChange?: () => void; compact?: boolean }) {
  const t = useT('settings');
  const list = useLoad(() => api.get<any[]>('/api/me/passkeys'), []);
  const [name, setName] = useState('');
  const [edit, setEdit] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      const o = await api.post('/api/me/passkeys/options');
      let credential;
      try {
        credential = await createPasskey(o.options);
      } catch (e) {
        throw new Error(passkeyError(e));
      }
      await api.post('/api/me/passkeys', { challenge_id: o.challenge_id, name, credential });
      toast(ts('Passkey gespeichert'));
      setName('');
      await list.reload();
      onChange?.();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const H = compact ? 'h3' : 'h2';
  return (
    <div data-tour="account-passkeys">
      <H>{t('Passkeys')}</H>
      <p className="muted small">{t('Anmelden mit Fingerabdruck, Gesicht oder Geräte-PIN – ohne Passwort. Ein Passkey gilt für die Adresse, auf der du ihn anlegst ({host}).', { host: location.hostname })}</p>
      {!list.data ? (
        <Spinner />
      ) : (
        list.data.map((k) => (
          <div key={k.id} className="signin-row">
            <ProviderIcon icon="passkey" />
            <div className="signin-main">
              {edit && edit.id === k.id ? (
                <div className="row" style={{ gap: 6 }}>
                  <Input value={edit.name} onChange={(v) => setEdit({ id: k.id, name: v })} aria-label={t('Name')} autoFocus />
                  <button className="btn small" onClick={async () => (await act(() => api.patch(`/api/me/passkeys/${k.id}`, { name: edit.name }), t('Umbenannt'))) && (setEdit(null), list.reload())}>
                    {t('Speichern')}
                  </button>
                </div>
              ) : (
                <strong>{k.name}</strong>
              )}{' '}
              {k.backed_up && <Badge tone="blue">{t('synchronisiert')}</Badge>} {!k.here && <Badge>{k.rp_id}</Badge>}
              <div className="muted small">
                {t('angelegt {date}', { date: dt(k.created_at) })}
                {k.last_used_at ? ` · ${t('zuletzt {date}', { date: dt(k.last_used_at) })}` : ''}
              </div>
            </div>
            {edit?.id !== k.id && (
              <span className="actions">
                <button className="btn small ghost" onClick={() => setEdit({ id: k.id, name: k.name })}>
                  {t('Umbenennen')}
                </button>
                <button className="btn small ghost" onClick={async () => confirmAsk(t('Passkey „{name}“ entfernen?', { name: k.name })) && (await act(() => api.del(`/api/me/passkeys/${k.id}`), t('Entfernt'))) && list.reload()}>
                  {t('Entfernen')}
                </button>
              </span>
            )}
          </div>
        ))
      )}
      {passkeysSupported() ? (
        <div className="row" style={{ alignItems: 'flex-end', marginTop: 8 }}>
          <Field label={t('Name (optional)')}>
            <Input value={name} onChange={setName} placeholder={t('z. B. MacBook, iPhone')} />
          </Field>
          <button className="btn" disabled={busy} onClick={add} style={{ marginBottom: 12 }}>
            <ProviderIcon icon="passkey" size={16} /> {t('Passkey hinzufügen')}
          </button>
        </div>
      ) : (
        <p className="muted small">{t('Dieser Browser kann keine Passkeys anlegen. In einem aktuellen Chrome, Safari, Edge oder Firefox geht es.')}</p>
      )}
    </div>
  );
}

export function SignInMethods() {
  const t = useT('settings');
  const data = useLoad(() => api.get<any>('/api/me/identities'), []);
  const [pw, setPw] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Back from linking at Google & Co. (or the app's Custom Tab finished): pick up the result.
  const poll = async () => {
    const r = await api.post('/api/auth/sso/poll').catch(() => null);
    if (r?.linked) {
      toast(ts('{provider} ist verknüpft', { provider: r.linked }));
      void data.reload();
    } else if (r?.error) toastError(new Error(r.error));
    return !!r?.pending;
  };
  useEffect(() => {
    void poll();
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const link = async (provider: string) => {
    const r = await act(() => api.post('/api/me/identities/link', { provider }));
    if (!r) return;
    location.href = r.url;
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(async () => {
      if (!(await poll()) && timer.current) clearInterval(timer.current);
    }, 2000);
  };

  if (!data.data) return <Spinner />;
  const d = data.data;
  return (
    <div data-tour="account-signin">
      <h2>{t('Anmelden mit')}</h2>
      {d.enforced && <p className="muted small">{t('Deine Firma meldet dich über „{provider}“ an.', { provider: d.enforced.label })}</p>}
      {d.identities.map((i: any) => (
        <div key={i.id} className="signin-row">
          <ProviderIcon icon={i.icon} />
          <div className="signin-main">
            <strong>{i.label}</strong> <span className="muted">{i.email}</span>
            <div className="muted small">
              {t('verknüpft {date}', { date: dt(i.created_at) })}
              {i.last_login_at ? ` · ${t('zuletzt {date}', { date: dt(i.last_login_at) })}` : ''}
            </div>
          </div>
          <button className="btn small ghost" onClick={async () => confirmAsk(t('{provider} ({email}) trennen?', { provider: i.label, email: i.email })) && (await act(() => api.del(`/api/me/identities/${i.id}`), t('Getrennt'))) && data.reload()}>
            {t('Trennen')}
          </button>
        </div>
      ))}
      {!d.identities.length && <p className="muted small">{t('Noch kein Konto verknüpft.')}</p>}
      {d.available.some((p: any) => !d.identities.some((i: any) => i.provider === p.id)) && (
        <div className="actions" style={{ marginTop: 8 }}>
          {d.available.filter((p: any) => !d.identities.some((i: any) => i.provider === p.id)).map((p: any) => (
            <button key={p.id} className="btn small secondary" onClick={() => link(p.id)}>
              <ProviderIcon icon={p.icon} size={15} /> {t('{provider} verknüpfen', { provider: p.label })}
            </button>
          ))}
        </div>
      )}
      {!d.password_set && (
        <div style={{ marginTop: 12 }}>
          <p className="muted small">{t('Du meldest dich bisher ohne Passwort an. Optional kannst du eins festlegen.')}</p>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Field label={t('Passwort festlegen')}>
              <Input type="password" value={pw} onChange={setPw} autoComplete="new-password" />
            </Field>
            <button className="btn secondary" style={{ marginBottom: 12 }} onClick={async () => (await act(() => api.post('/api/me/password/set', { password: pw }), t('Passwort gespeichert'))) && (setPw(''), data.reload())}>
              {t('Speichern')}
            </button>
          </div>
        </div>
      )}
      <hr />
      <PasskeyList onChange={() => data.reload()} />
    </div>
  );
}
