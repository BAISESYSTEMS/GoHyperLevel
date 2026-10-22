import { useEffect, useState } from 'react';
import { api, dt } from '../api';
import { Icon } from '../icons';
import { openInstallGuide } from '../ios/InstallSheet';
import { isIosDevice } from '../ios/platform';
import { pushCopy, pushStep } from '../ios/push-flow';
import { deviceSubscription, disablePush, enablePush, isStandalone, promptInstall, pushSupported, useInstallPrompt } from '../pwa';
import { Badge, Check, Spinner, act, toast, toastError, useLoad } from '../ui';
import { tr, useT } from '../i18n';

const ts = tr('settings');

const deviceLabel = (ua: string) => {
  if (!ua) return ts('Unbekanntes Gerät');
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ts('Gerät');
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ts('Browser');
  return ts('{browser} auf {os}', { browser: br, os });
};

/** Einstellungen → Mein Konto: push notifications on this device, what triggers them, other devices. */
export function PushSettings() {
  const t = useT('settings');
  const st = useLoad(() => api.get<any>('/api/push'), []);
  const [sub, setSub] = useState<PushSubscription | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const install = useInstallPrompt();
  useEffect(() => {
    deviceSubscription().then(setSub, () => setSub(null));
  }, []);
  if (!st.data || sub === undefined) return <Spinner />;
  const devices: any[] = st.data.devices ?? [];
  const on = !!sub && devices.some((d) => d.endpoint === sub.endpoint);
  const supported = pushSupported();
  // Where this device is on the way to notifications (on iPhone/iPad: install first, then an explicit tap – web/src/ios/push-flow.ts).
  const nav = navigator as Navigator & { standalone?: boolean };
  const step = pushStep({ nav, standalone: isStandalone(), hasPushApi: supported, permission: supported ? Notification.permission : 'unsupported', subscribed: on });
  const copy = pushCopy(step, isIosDevice(nav));

  const toggle = async (want: boolean) => {
    setBusy(true);
    try {
      if (want) {
        setSub(await enablePush());
        toast(t('Benachrichtigungen sind an'));
      } else {
        await disablePush();
        setSub(null);
        toast(t('Benachrichtigungen sind aus'));
      }
      await st.reload();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const setPref = async (k: string, v: boolean) => {
    const prefs = await act(() => api.put('/api/push/prefs', { [k]: v }));
    if (prefs) st.setData({ ...st.data, prefs });
  };

  return (
    <>
      <h2 data-tour="account-push">
        <Icon name="notify" /> {t('Benachrichtigungen')} {on ? <Badge tone="green">{t('an')}</Badge> : <Badge>{t('aus')}</Badge>}
      </h2>
      {step !== 'on' && (
        // the texts of ios/push-flow.ts are German message ids of the settings catalog
        <div className="push-step" data-tour="push-step" data-step={step}>
          <strong>{t(copy.title)}</strong>
          <p className={step === 'blocked' ? 'small' : 'muted'} style={step === 'blocked' ? { color: 'var(--red)' } : undefined}>
            {t(copy.text)}
          </p>
          {copy.button && (
            // The permission may only be asked from a tap (iOS): the click handler's first await is Notification.requestPermission().
            <button className="btn push-enable" data-tour="push-enable" disabled={busy} onClick={() => void toggle(true)}>
              <Icon name="notify" /> {t(copy.button)}
            </button>
          )}
          {step === 'needs-install' && (
            <button className="btn secondary" onClick={openInstallGuide}>
              {t('Anleitung zeigen')}
            </button>
          )}
        </div>
      )}
      {step === 'on' && (
        <>
          <Check checked={on} onChange={(v) => !busy && void toggle(v)} label={t('Benachrichtigungen auf diesem Gerät')} />
          <p className="muted small" style={{ marginBottom: 4 }}>
            {t('Benachrichtigen bei (gilt für alle deine Geräte):')}
          </p>
          <div className="push-kinds">
            {/* the server's labels (Neue Nachrichten …) are message ids too */}
            {Object.entries(st.data.kinds as Record<string, string>).map(([k, label]) => (
              <Check key={k} checked={st.data.prefs[k] !== false} onChange={(v) => setPref(k, v)} label={t(label)} />
            ))}
          </div>
          <button className="btn small secondary" disabled={!on || busy} onClick={() => act(() => api.post('/api/push/test'), t('Test gesendet – kommt gleich an'))}>
            {t('Test-Benachrichtigung senden')}
          </button>
        </>
      )}
      {devices.filter((d) => d.endpoint !== sub?.endpoint).length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="muted small">{t('Weitere Geräte mit Benachrichtigungen')}</div>
          {devices
            .filter((d) => d.endpoint !== sub?.endpoint)
            .map((d) => (
              <div key={d.id} className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
                <div>
                  {deviceLabel(d.user_agent)}
                  <div className="muted small">
                    {t('seit {date}', { date: dt(d.created_at) })}
                    {d.last_ok_at ? ` · ${t('zuletzt zugestellt {date}', { date: dt(d.last_ok_at) })}` : ''}
                    {d.last_error ? ` · ${t('Fehler: {error}', { error: d.last_error })}` : ''}
                  </div>
                </div>
                <button className="btn small ghost" onClick={async () => (await act(() => api.del(`/api/push/devices/${d.id}`), t('Entfernt'))) && st.reload()}>
                  {t('Entfernen')}
                </button>
              </div>
            ))}
        </div>
      )}
      {install && (
        <p style={{ marginTop: 12 }}>
          <button className="btn small" onClick={() => void promptInstall()}>
            <Icon name="install" /> {t('App installieren')}
          </button>
        </p>
      )}
    </>
  );
}
