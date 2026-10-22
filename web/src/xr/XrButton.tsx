import { lazy, Suspense, useEffect, useState } from 'react';
import { Icon } from '../icons';
import { hasWebGL2, xrSupport } from './detect';

/**
 * The button on a board and on a canvas: "In XR öffnen" where the browser offers a WebXR session, otherwise "3D-Vorschau" (the same
 * scene in the browser, moved with the mouse) – and nothing at all where there is not even WebGL2. The 3D code is a lazy chunk:
 * it downloads when the button is pressed, never before.
 */

const XrViewer = lazy(() => import('./XrViewer'));

export function XrButton({ kind, id, name, className = 'btn secondary small' }: { kind: 'board' | 'canvas'; id: string; name: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [xr, setXr] = useState<boolean | null>(null);
  const webgl = hasWebGL2();
  useEffect(() => {
    let live = true;
    void xrSupport().then((s) => live && setXr(s.vr || s.ar));
    return () => {
      live = false;
    };
  }, []);
  if (!webgl) return null;
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} data-tour="xr-open" title={xr ? 'Dieses Board als schwebende Panels im Headset öffnen' : 'Dein Gerät bietet kein WebXR – die 3D-Vorschau läuft im Browser'}>
        <Icon name="glasses" size={14} /> {xr ? 'In XR öffnen' : '3D-Vorschau'}
      </button>
      {open && (
        <Suspense fallback={null}>
          <XrViewer kind={kind} id={id} name={name} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
