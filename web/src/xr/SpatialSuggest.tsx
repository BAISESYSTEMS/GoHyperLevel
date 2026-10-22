import { useEffect, useState } from 'react';
import type { SpatialMode } from '../../../server/services/appearance-model';
import { Icon } from '../icons';
import { spatialOf, update, useLook } from '../theme/store';
import { xrSupport } from './detect';
import './suggest.css';

/**
 * The quiet suggestion for a browser that offers WebXR but is not (yet) recognised as a headset – a PC with a headset, glasses with a
 * WebXR-capable browser, a headset whose user agent we do not know: "Raum-Modus einschalten?". A recognised headset needs no question
 * (the mode is on by itself), and nobody who said *Aus* or *An*, or closed this card once on this browser, is asked again.
 */

const KEY = 'pghl.spatialHint';

export const shouldSuggest = (i: { pref: SpatialMode; active: boolean; supported: boolean; dismissed: boolean }) => i.pref === 'auto' && !i.active && i.supported && !i.dismissed;

const readDismissed = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

export function SpatialSuggest() {
  const look = useLook();
  const [supported, setSupported] = useState(false);
  const [dismissed, setDismissed] = useState(readDismissed);
  useEffect(() => {
    let live = true;
    void xrSupport().then((s) => live && setSupported(s.vr || s.ar));
    return () => {
      live = false;
    };
  }, []);
  if (!shouldSuggest({ pref: look.prefs.spatial, active: spatialOf(look.prefs), supported, dismissed })) return null;
  const close = () => {
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      /* private mode: asked again next time */
    }
    setDismissed(true);
  };
  return (
    <div className="xr-suggest" role="dialog" aria-label="Raum-Modus vorschlagen" data-tour="xr-suggest">
      <Icon name="glasses" size={22} />
      <div className="xr-suggest-text">
        <strong>Mit Brille oder Headset?</strong>
        <span className="muted small">Dein Browser bietet WebXR. Der Raum-Modus macht alles groß genug für Blick und Pinch – du kannst ihn jederzeit unter Einstellungen → Darstellung ändern.</span>
      </div>
      <button type="button" className="btn small" onClick={() => void update({ spatial: 'on' }).then(close)}>
        Raum-Modus einschalten
      </button>
      <button type="button" className="btn secondary small" onClick={close}>
        Nein danke
      </button>
      <button type="button" className="icon-btn" onClick={close} aria-label="Schließen">
        ✕
      </button>
    </div>
  );
}
