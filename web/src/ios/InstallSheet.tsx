import { useEffect, useState } from 'react';
import { Modal } from '../ui';
import { type InstallState, closeSheet, installKey, installOffer, installSteps, parseState } from './install';
import { type InstallMethod } from './platform';
import './ios-sheet.css';

/**
 * "Zum Home-Bildschirm hinzufügen" for iPhone and iPad: a friendly sheet with the Share icon drawn out, shown a few seconds after
 * signing in on iOS (never in the installed app), remembered per person on this device (install.ts: later = 2 weeks, then 2 months,
 * "Nicht mehr zeigen" = never). The same guide opens from Einstellungen → Mein Konto → iPhone & iPad (event pghl:ios-install).
 */

export const OPEN_INSTALL = 'pghl:ios-install';
export const openInstallGuide = () => window.dispatchEvent(new Event(OPEN_INSTALL));

const read = (userId: string): InstallState => {
  try {
    return parseState(localStorage.getItem(installKey(userId)));
  } catch {
    return parseState(null);
  }
};
const write = (userId: string, s: InstallState) => {
  try {
    localStorage.setItem(installKey(userId), JSON.stringify(s));
  } catch {
    /* private mode: it just shows again next time */
  }
};

const env = () => ({ nav: navigator as Navigator & { standalone?: boolean }, matches: (q: string) => matchMedia(q).matches });
const isIpad = () => /iPad/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Share icon (square with an arrow up), "Zum Home-Bildschirm" row and the finished icon – in the theme's colours. */
export function InstallIllustration({ ipad }: { ipad: boolean }) {
  const share = (x: number, y: number, hot: boolean) => (
    <g transform={`translate(${x} ${y})`} fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" stroke={hot ? 'var(--brand)' : 'currentColor'} opacity={hot ? 1 : 0.55}>
      <path d="M9 3v11M5.5 6.5L9 3l3.5 3.5M4 10H3.5A1.5 1.5 0 0 0 2 11.5v7A1.5 1.5 0 0 0 3.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 14.5 10H14" />
    </g>
  );
  return (
    <svg className="ios-illu" viewBox="0 0 320 132" role="img" aria-label={ipad ? 'Teilen oben rechts in Safari, dann „Zum Home-Bildschirm“' : 'Teilen unten in Safari, dann „Zum Home-Bildschirm“'}>
      {/* 1 – the browser bar with Share */}
      <rect x="4" y="6" width="140" height="120" rx="14" fill="var(--bg)" stroke="var(--line)" />
      {ipad ? (
        <>
          <rect x="4" y="6" width="140" height="26" rx="14" fill="var(--panel)" stroke="var(--line)" />
          <rect x="30" y="13" width="72" height="12" rx="6" fill="var(--line)" />
          {share(112, 8, true)}
        </>
      ) : (
        <>
          <rect x="4" y="94" width="140" height="32" rx="14" fill="var(--panel)" stroke="var(--line)" />
          <circle cx="26" cy="110" r="4" fill="currentColor" opacity=".35" />
          <circle cx="52" cy="110" r="4" fill="currentColor" opacity=".35" />
          {share(66, 99, true)}
          <circle cx="112" cy="110" r="4" fill="currentColor" opacity=".35" />
          <circle cx="130" cy="110" r="4" fill="currentColor" opacity=".35" />
        </>
      )}
      <path d={ipad ? 'M118 40 V58' : 'M84 92 V72'} stroke="var(--brand)" strokeWidth="2.5" strokeLinecap="round" fill="none" />
      <text x="74" y={ipad ? 82 : 52} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--brand)">
        1 · Teilen
      </text>
      {/* 2 – the menu row */}
      <rect x="164" y="6" width="152" height="120" rx="14" fill="var(--bg)" stroke="var(--line)" />
      <rect x="174" y="18" width="132" height="22" rx="8" fill="var(--panel)" stroke="var(--line)" />
      <rect x="174" y="46" width="132" height="26" rx="8" fill="var(--brand)" />
      <g transform="translate(180 50)" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round">
        <rect x="1" y="1" width="16" height="16" rx="4" />
        <path d="M9 5.5v7M5.5 9h7" />
      </g>
      <text x="202" y="63" fontSize="10" fontWeight="700" fill="#fff" textLength="98" lengthAdjust="spacingAndGlyphs">
        Zum Home-Bildschirm
      </text>
      <rect x="174" y="78" width="132" height="22" rx="8" fill="var(--panel)" stroke="var(--line)" />
      <text x="240" y="116" textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--brand)">
        2 · Hinzufügen
      </text>
    </svg>
  );
}

export function InstallSheet({ userId }: { userId: string }) {
  const [method, setMethod] = useState<InstallMethod | null>(null);
  // A few seconds after the app is up: not in the middle of loading.
  useEffect(() => {
    const t = window.setTimeout(() => setMethod(installOffer(env(), read(userId), Date.now())), 4000);
    const open = () => setMethod(installOffer(env(), { closed: 0, until: 0, never: false }, Date.now()));
    window.addEventListener(OPEN_INSTALL, open);
    return () => {
      clearTimeout(t);
      window.removeEventListener(OPEN_INSTALL, open);
    };
  }, [userId]);
  if (!method) return null;
  const ipad = isIpad();
  const later = (forever = false) => {
    write(userId, closeSheet(read(userId), Date.now(), forever));
    setMethod(null);
  };
  return (
    <Modal
      title="Zum Home-Bildschirm hinzufügen"
      onClose={() => later()}
      className="ios-sheet"
      footer={
        <>
          <button className="btn ghost" onClick={() => later(true)}>
            Nicht mehr zeigen
          </button>
          <button className="btn" onClick={() => later()} data-tour="ios-install-ok">
            Verstanden
          </button>
        </>
      }
    >
      <div data-tour="ios-install">
        <p className="ios-lead">
          So startet HyperLevel wie eine App: eigenes Fenster ohne Browserleisten, Mitteilungen bei neuen Nachrichten und eine Zahl auf dem Symbol.
        </p>
        <InstallIllustration ipad={ipad} />
        <ol className="ios-steps">
          {installSteps(method, ipad).map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <p className="muted small">Du bleibst angemeldet. Mitteilungen schaltest du danach in der App unter Einstellungen → Mein Konto ein.</p>
      </div>
    </Modal>
  );
}
