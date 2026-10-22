import { useEffect, useState } from 'react';
import { SPATIAL_MODES, type Prefs, type SpatialMode } from '../../../server/services/appearance-model';
import { Icon } from '../icons';
import { navigate } from '../ui';
import { spatialOf, update } from '../theme/store';
import { currentXr, hasWebGL2, xrSupport, type XrSupport } from './detect';
import { INSTALL_HINTS, hintFor } from './install';
import './card.css';

/**
 * Einstellungen → Darstellung → Raum-Modus: the switch (Automatisch / An / Aus), what this device is, and the way to the rest of the XR
 * features (Arbeitsfläche, Boards and Canvas in XR) and to installing the app on a headset. Never locked by an agency: it describes the
 * device a person wears, not the brand.
 */

const LABEL: Record<SpatialMode, [string, string]> = {
  auto: ['Automatisch', 'An, sobald ein XR-Gerät erkannt wird (Apple Vision Pro, Meta Quest, Android XR).'],
  on: ['An', 'Immer: große Ziele, mehr Abstand, größere Schrift, Glasflächen – auch auf einer Display-Brille.'],
  off: ['Aus', 'Normale Darstellung, auch auf einem XR-Gerät.'],
};

export function SpatialCard({ p }: { p: Prefs }) {
  const device = currentXr();
  const [support, setSupport] = useState<XrSupport | null>(null);
  useEffect(() => {
    let live = true;
    void xrSupport().then((s) => live && setSupport(s));
    return () => {
      live = false;
    };
  }, []);
  const on = spatialOf(p);
  const mine = hintFor(device?.device ?? null);
  return (
    <div className="card ap-section" data-tour="appearance-spatial">
      <h2>
        Raum-Modus <span className="badge blue">{on ? 'aktiv' : 'aus'}</span>
      </h2>
      <p className="muted small" style={{ marginTop: -4 }}>
        Für Brillen und Headsets: bedienbar mit Blick und Pinch oder mit Controllern. Ziele von mindestens 60 px, mehr Abstand, größere Schrift, ein sanftes Leuchten beim Anschauen, nichts ist nur beim Darüberfahren erreichbar – und Glasflächen, deren Text lesbar bleibt (Kontrast AA).
      </p>
      <div className="ap-seg" role="radiogroup" aria-label="Raum-Modus">
        {SPATIAL_MODES.map((m) => (
          <button key={m} role="radio" aria-checked={p.spatial === m} className={p.spatial === m ? 'on' : ''} onClick={() => void update({ spatial: m })} data-tour={`spatial-${m}`}>
            {LABEL[m][0]}
          </button>
        ))}
      </div>
      <p className="muted small">{LABEL[p.spatial][1]}</p>
      <ul className="sp-facts small">
        <li>
          <Icon name="glasses" size={14} /> Dieses Gerät: {device ? <b>{device.label}</b> : 'kein XR-Gerät erkannt'}
          {device && p.spatial === 'auto' ? ' – der Raum-Modus ist deshalb an.' : ''}
        </li>
        <li>
          <Icon name="sparkles" size={14} /> WebXR-Sitzung:{' '}
          {support === null ? 'wird geprüft …' : support.vr || support.ar ? <b>{[support.vr && 'VR', support.ar && 'AR'].filter(Boolean).join(' und ')} möglich</b> : 'nicht verfügbar – Boards und Canvas zeigen die 3D-Vorschau im Browser' + (hasWebGL2() ? '' : ' (dieser Browser kann auch kein WebGL2)')}
        </li>
      </ul>
      <div className="actions" style={{ marginTop: 10 }}>
        <button type="button" className="btn secondary" onClick={() => navigate('workspace')} data-tour="appearance-workspace">
          <Icon name="workspace" size={16} /> Arbeitsfläche öffnen
        </button>
        <button type="button" className="btn secondary" onClick={() => navigate('boards')}>
          <Icon name="boards" size={16} /> Boards: „In XR öffnen“
        </button>
      </div>
      <details className="sp-install" style={{ marginTop: 14 }} open={!!mine}>
        <summary>App auf dem Headset installieren</summary>
        {(mine ? [mine, ...INSTALL_HINTS.filter((h) => h.id !== mine.id)] : INSTALL_HINTS).map((h) => (
          <div key={h.id} className={`sp-install-item${h === mine ? ' mine' : ''}`}>
            <b>{h.title}</b>
            <ol>
              {h.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </div>
        ))}
      </details>
    </div>
  );
}
