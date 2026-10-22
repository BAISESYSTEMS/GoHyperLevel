import { useEffect, useState } from 'react';
import { Smartphone } from 'lucide-react';
import { Badge, CodeBox } from '../ui';
import { OPEN_INSTALL } from './InstallSheet';
import { installMethod, iosVersion, isIosDevice, isStandalone } from './platform';
import { installSteps } from './install';
import './ios-sheet.css';
import { useT } from '../i18n';

/**
 * Einstellungen → Mein Konto → "iPhone & iPad": whether this device runs HyperLevel as an app, how to install it, what works there
 * (Mitteilungen live in the block below, with the explicit button). Honest about the limits: docs/ios-web-app.md.
 */
export function IosAppCard() {
  const t = useT('settings');
  const [info, setInfo] = useState<{ ios: boolean; ipad: boolean; standalone: boolean; version: string; badge: boolean; method: ReturnType<typeof installMethod> } | null>(null);
  useEffect(() => {
    const nav = navigator as Navigator & { standalone?: boolean };
    const v = iosVersion(nav);
    setInfo({
      ios: isIosDevice(nav),
      ipad: /iPad/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1),
      standalone: isStandalone(nav, (q) => matchMedia(q).matches),
      version: v ? `${v[0]}.${v[1]}` : '',
      badge: 'setAppBadge' in navigator,
      method: installMethod(nav),
    });
  }, []);
  if (!info) return null;
  const { ios, ipad, standalone } = info;
  return (
    <div data-tour="ios-app">
      <h2>
        <Smartphone size={18} style={{ verticalAlign: -3 }} /> iPhone & iPad {ios && standalone ? <Badge tone="green">{t('als App geöffnet')}</Badge> : ios ? <Badge>{t('im Browser')}</Badge> : null}
      </h2>
      {ios && standalone ? (
        <ul className="ios-facts">
          <li>
            {t('HyperLevel läuft hier als App vom Home-Bildschirm: eigenes Fenster, bleibt angemeldet, Mitteilungen möglich.')}
            {info.version ? ` (iOS ${info.version})` : '' /* i18n-ignore */}
          </li>
          <li>{info.badge ? t('Zahl auf dem App-Symbol: wird angezeigt, sobald Mitteilungen erlaubt sind.') : t('Zahl auf dem App-Symbol: dieses iOS unterstützt sie nicht.')}</li>
          <li>{ipad ? t('iPad: Seitenleiste, Zwei-Spalten-Ansichten, Tastaturkürzel (⌘/) und Stift (Scribble) sind eingeschaltet.') : t('Ziehe eine Seite oben nach unten, um sie neu zu laden.')}</li>
        </ul>
      ) : (
        <>
          <p className="muted">
            {ios ? t('Mit einem Tipp auf den Home-Bildschirm wird HyperLevel zur App – mit Mitteilungen, Zahl auf dem Symbol und ohne Browserleisten.') : t('HyperLevel lässt sich auf iPhone und iPad als App installieren – ohne App Store, mit Mitteilungen und Zahl auf dem Symbol.')}
          </p>
          <ol className="ios-steps">
            {/* the steps of ios/install.ts are German message ids */}
            {installSteps(info.method ?? 'safari', ipad).map((s) => (
              <li key={s}>{t(s)}</li>
            ))}
          </ol>
          {!ios && (
            <>
              <p className="muted small">{t('Adresse zum Öffnen auf dem iPhone oder iPad (in Safari):')}</p>
              <CodeBox text={`${location.origin}/app`} />
            </>
          )}
          {ios && (
            <button className="btn small secondary" onClick={() => window.dispatchEvent(new Event(OPEN_INSTALL))}>
              {t('Anleitung mit Bild zeigen')}
            </button>
          )}
        </>
      )}
    </div>
  );
}
