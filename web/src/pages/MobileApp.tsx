import { useRef, useState } from 'react';
import { api, ApiError, dt } from '../api';
import { Icon } from '../icons';
import { useSession } from '../session';
import { Badge, Field, Input, Spinner, Textarea, act, confirmAsk, toast, toastError, useLoad } from '../ui';
import { useT } from '../i18n';

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;

/** Einstellungen → Mein Konto: the Android app – download link, paired phones (revoke), and for admins the APK upload. */
export function AppDevices() {
  // Part of Mein Konto: translated with it (settings catalog); the APK upload below stays German in phase 1.
  const t = useT('settings');
  const session = useSession();
  const admin = session.user.role === 'admin';
  const devices = useLoad(() => api.get<any[]>('/api/mobile/devices'), []);
  const release = useLoad(() => api.get<any>('/api/mobile/app').catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e))), []);
  const revoke = async (d: any) => {
    if (!confirmAsk(t('„{name}“ abmelden? Die App auf diesem Gerät muss sich danach neu anmelden.', { name: d.name }))) return;
    if (await act(() => api.del(`/api/mobile/devices/${d.id}`), t('Gerät abgemeldet'))) devices.reload();
  };
  return (
    <>
      <div className="app-card" data-tour="app-card">
        <Icon name="mobile" size={28} />
        <div style={{ flex: 1 }}>
          <strong>{t('App fürs Handy')}</strong>
          <div className="muted small">
            {release.data ? `${t('Android-App')} ${release.data.version_name} · ${mb(release.data.size)}` : release.loading ? t('Android-App') : t('Die Android-App ist noch nicht hochgeladen.')}
          </div>
        </div>
        <a className="btn small" href="/android" target="_blank" rel="noopener">
          <Icon name="download" /> {t('Zur App')}
        </a>
      </div>
      <h2 data-tour="app-devices">{t('Geräte (App)')}</h2>
      {!devices.data ? (
        <Spinner />
      ) : !devices.data.length ? (
        <p className="muted small">{t('Noch kein Handy mit der App gekoppelt – App installieren und dort anmelden.')}</p>
      ) : (
        devices.data.map((d) => (
          <div key={d.id} className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <div>
              {d.name} {d.platform && <Badge>{d.platform === 'android' ? 'Android' : d.platform}</Badge>}
              <div className="muted small">
                {d.app_version ? `App ${d.app_version} · ` : '' /* i18n-ignore */}
                {t('zuletzt {date}', { date: dt(d.last_used_at ?? d.created_at) })}
                {d.last_ip ? ` · ${d.last_ip}` : ''} · {t('gekoppelt {date}', { date: dt(d.created_at) })}
              </div>
            </div>
            <button className="btn small ghost" onClick={() => revoke(d)}>
              {t('Abmelden')}
            </button>
          </div>
        ))
      )}
      {admin && <ApkUpload current={release.data} onDone={release.reload} />}
    </>
  );
}

/** Admins: upload a new signed APK (raw body) and set the App-Links certificate. */
function ApkUpload({ current, onDone }: { current: any; onDone: () => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ code: '', name: '', changelog: '' });
  const [busy, setBusy] = useState(false);
  const cfg = useLoad(() => (open ? api.get<any>('/api/agency/mobile-app') : Promise.resolve(null)), [open]);
  const [cert, setCert] = useState<string | null>(null);
  const upload = async () => {
    const apk = file.current?.files?.[0];
    if (!apk) return toastError(new Error('Bitte die APK-Datei wählen'));
    setBusy(true);
    try {
      const r = await fetch('/api/mobile/app', {
        method: 'PUT',
        headers: { 'x-pghl': '1', 'content-type': 'application/vnd.android.package-archive', 'x-version-code': f.code, 'x-version-name': f.name, 'x-changelog': encodeURIComponent(f.changelog) },
        body: apk,
        credentials: 'same-origin',
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `Fehler ${r.status}`);
      toast(`Version ${data.version_name} ist online`);
      setF({ code: '', name: '', changelog: '' });
      if (file.current) file.current.value = '';
      onDone();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <p>
        <button className="btn small secondary" onClick={() => setOpen(true)}>
          Neue App-Version hochladen (Agentur)
        </button>
      </p>
    );
  return (
    <div className="card" style={{ background: 'var(--bg)', marginTop: 12 }}>
      <h3>Neue App-Version</h3>
      <p className="muted small">
        Signierte Release-APK von <code>{cfg.data?.effective_package_name ?? 'org.gohigh.android'}</code>. Erscheint sofort unter <a href="/android">/android</a>; die App meldet das Update.
        {current ? ` Aktuell: ${current.version_name} (${current.version_code}).` : ''}
      </p>
      <Field label="APK-Datei">
        <input ref={file} type="file" accept=".apk,application/vnd.android.package-archive" />
      </Field>
      <div className="row">
        <Field label="Versionscode (versionCode)">
          <Input value={f.code} onChange={(v) => setF({ ...f, code: v })} inputMode="numeric" placeholder={current ? String(current.version_code + 1) : '1'} />
        </Field>
        <Field label="Versionsname">
          <Input value={f.name} onChange={(v) => setF({ ...f, name: v })} placeholder="1.0.0" />
        </Field>
      </div>
      <Field label="Was ist neu?">
        <Textarea value={f.changelog} onChange={(v) => setF({ ...f, changelog: v })} rows={3} />
      </Field>
      <button className="btn" disabled={busy || !f.code || !f.name} onClick={upload}>
        {busy ? 'Lädt hoch…' : 'Hochladen'}
      </button>
      {cfg.data && (
        <>
          <hr />
          <Field label="App Links: SHA-256 des Signatur-Zertifikats" hint={cfg.data.effective_cert_sha256.length ? `Wirksam: ${cfg.data.effective_cert_sha256.join(', ')}` : 'Noch keins – App Links sind aus, bis du den Fingerabdruck deines Signatur-Zertifikats einträgst.'}>
            <Input value={cert ?? cfg.data.cert_sha256} onChange={setCert} placeholder="AB:CD:EF:… (keytool -list -v -keystore …)" />
          </Field>
          <button
            className="btn small secondary"
            onClick={async () => {
              const r = await act(() => api.put('/api/agency/mobile-app', { cert_sha256: cert ?? cfg.data.cert_sha256 }), 'Gespeichert');
              if (r) (cfg.setData(r), setCert(null));
            }}
          >
            Speichern
          </button>
        </>
      )}
    </div>
  );
}
