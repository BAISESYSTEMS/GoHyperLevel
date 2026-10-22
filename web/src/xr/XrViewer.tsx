import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons';
import { xrSupport, type XrSupport } from './detect';
import { openBoardXr } from './engine/board-scene';
import { openCanvasXr } from './engine/canvas-scene';
import { Runtime, type XrMode } from './engine/runtime';
import { DARK_THEME, LIGHT_THEME, type XrTheme } from './engine/textures';
import { canRecord } from '../agent/voice';
import { warmUpMicrophone } from './engine/voice';
import './viewer.css';

/**
 * "In XR öffnen": the 3D view of a Living Board or a Canvas. A full-screen layer with a canvas: the browser preview (orbit with the
 * mouse, move panels by dragging) – and, where the browser offers WebXR, the buttons that start the immersive session on the same
 * scene. It is a chunk of its own (the renderer, the scene, the painters) that loads only when somebody opens it.
 */

const HEX = /^#[0-9a-f]{6}$/i;

/** The colours of the app as it looks right now, so the panels match the theme the person chose. */
export function readTheme(): XrTheme {
  const dark = document.documentElement.dataset.theme === 'dark';
  const base = dark ? DARK_THEME : LIGHT_THEME;
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => {
    const x = cs.getPropertyValue(name).trim();
    return HEX.test(x) ? x : fallback;
  };
  return {
    dark,
    bg: v('--bg', base.bg),
    panel: v('--panel', base.panel),
    text: v('--text', base.text),
    muted: v('--muted', base.muted),
    line: v('--line', base.line),
    brand: v('--brand', base.brand),
    brandText: v('--brand-text', base.brandText),
    onBrand: v('--on-brand', base.onBrand),
    soft: v('--brand-soft', base.soft),
    green: base.green,
    red: base.red,
    yellow: base.yellow,
  };
}

export default function XrViewer({ kind, id, name, onClose }: { kind: 'board' | 'canvas'; id: string; name: string; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const runtime = useRef<Runtime | null>(null);
  const [status, setStatus] = useState('Lädt …');
  const [error, setError] = useState('');
  const [support, setSupport] = useState<XrSupport>({ vr: false, ar: false });
  const [inSession, setInSession] = useState(false);
  const [mic, setMic] = useState<string | null>(null);
  const exit = useRef(onClose);
  exit.current = onClose;

  useEffect(() => {
    let live = true;
    void xrSupport().then((s) => live && setSupport(s));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let closed = false;
    let content: { close(): void } | null = null;
    let rt: Runtime;
    try {
      rt = new Runtime({ canvas: el, theme: readTheme(), onSessionEnd: () => !closed && setInSession(false) });
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    runtime.current = rt;
    const common = { scene: rt.scene, onStatus: (t: string) => !closed && setStatus(t), onError: (t: string) => !closed && setError(t), onExit: () => (rt.immersive ? void rt.end() : exit.current()) };
    (kind === 'board' ? openBoardXr({ ...common, boardId: id }) : openCanvasXr({ ...common, canvasId: id, name }))
      .then((c) => (closed ? c.close() : (content = c)))
      .catch((e: Error) => !closed && setError(e.message || 'Das lässt sich nicht öffnen.'));
    el.focus({ preventScroll: true });
    return () => {
      closed = true;
      content?.close();
      rt.dispose();
      runtime.current = null;
    };
  }, [kind, id, name]);

  // Esc closes (not while the headset shows the session: the page is hidden then); focus goes back to what opened it
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !runtime.current?.immersive && exit.current();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener && opener !== document.body && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, []);

  const start = async (mode: XrMode) => {
    setError('');
    try {
      if (kind === 'board' && canRecord()) {
        const m = await warmUpMicrophone();
        if (m) setMic(m);
      }
      await runtime.current?.start(mode);
      setInSession(true);
    } catch (e) {
      setError((e as Error).message || 'Die XR-Sitzung konnte nicht gestartet werden.');
    }
  };

  const canXr = support.vr || support.ar;
  return createPortal(
    <div className="xr-layer" role="dialog" aria-modal="true" aria-label={`3D-Ansicht: ${name}`} data-tour="xr-viewer">
      <canvas ref={canvas} className="xr-canvas" tabIndex={0} aria-label="3D-Szene. Maus ziehen dreht, Mausrad zoomt, Panels lassen sich ziehen." />
      <header className="xr-bar">
        <div className="xr-title">
          <Icon name="glasses" size={20} />
          <div>
            <b>{name}</b>
            <span className="xr-status" role="status">{error || status}</span>
          </div>
        </div>
        <div className="xr-actions">
          {support.vr && (
            <button type="button" className="btn" onClick={() => void start('immersive-vr')} disabled={inSession} data-tour="xr-start">
              <Icon name="glasses" size={16} /> In XR starten
            </button>
          )}
          {support.ar && (
            <button type="button" className="btn secondary" onClick={() => void start('immersive-ar')} disabled={inSession}>
              Mit Durchblick (AR)
            </button>
          )}
          {kind === 'board' && canRecord() && (
            <button type="button" className="btn secondary" onClick={async () => setMic((await warmUpMicrophone()) ?? 'Mikrofon ist erlaubt.')} title="Für die Sprachsteuerung im Headset: den Browser jetzt fragen, nicht erst im Raum">
              <Icon name="mic" size={16} /> Mikrofon erlauben
            </button>
          )}
          <button type="button" className="btn secondary" onClick={() => runtime.current?.orbit.reset()}>
            <Icon name="reset" size={16} /> Ansicht
          </button>
        </div>
        <button type="button" className="icon-btn xr-close" onClick={onClose} aria-label="Schließen">
          ✕
        </button>
      </header>
      <footer className="xr-help">
        {mic && <span className="xr-mic">{mic}</span>}
        {!canXr && <span>Dieses Gerät bietet kein WebXR – du siehst die 3D-Vorschau. </span>}
        <span>Maus ziehen: drehen · Rad: Zoom · Panel ziehen: verschieben (beim Ziehen: Rad näher/ferner, Umschalt+Rad größer/kleiner) · Pfeiltasten: drehen · Esc: schließen</span>
      </footer>
    </div>,
    document.body,
  );
}
