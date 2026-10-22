import { useState } from 'react';
import { api, d } from '../api';
import { Icon } from '../icons';
import { Badge, Field, Input, Modal, Select, act, useLoad } from '../ui';
import type { CloudMe } from './CloudKit';

/** Cloud-Konto → Daten & Konto: export, support access, contracts (AVV) and deleting the account. */

const SUPPORT: [string, string][] = [
  ['0', 'Aus – niemand vom Support kann mein Konto öffnen'],
  ['1', '1 Stunde'],
  ['24', '24 Stunden'],
  ['168', '7 Tage'],
  ['720', '30 Tage'],
];

function DeleteModal({ me, onClose, onDone }: { me: CloudMe; onClose: () => void; onDone: () => void }) {
  const [confirm, setConfirm] = useState('');
  const [password, setPassword] = useState('');
  const t = me.tenant;
  return (
    <Modal
      title="Konto löschen"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="btn danger"
            disabled={confirm !== t.name}
            onClick={async () => {
              if (await act(() => api.post('/api/cloud/delete', { confirm, password }), 'Löschung angefordert')) {
                onDone();
                onClose();
              }
            }}
          >
            Konto löschen lassen
          </button>
        </>
      }
    >
      <p>
        Dein Abo wird sofort beendet und das Konto schreibgeschützt. Nach einer Frist werden <strong>alle Daten endgültig gelöscht</strong> – Kontakte, Nachrichten, Dateien, Nutzer{t.entitlements.client_accounts ? ' und alle Kunden-Accounts' : ''}. Bis dahin kannst du die Löschung zurücknehmen und alles exportieren.
      </p>
      <Field label={`Zur Bestätigung „${t.name}“ eintippen`}>
        <Input value={confirm} onChange={setConfirm} autoFocus />
      </Field>
      <Field label="Passwort" hint="Bei Anmeldung nur mit Google bleibt das Feld leer.">
        <Input type="password" value={password} onChange={setPassword} autoComplete="current-password" />
      </Field>
    </Modal>
  );
}

export function CloudData({ me, reload }: { me: CloudMe; reload: () => void }) {
  const t = me.tenant;
  const legal = useLoad(() => api.get<{ current: { doc: string; version: number }[]; accepted: { doc: string; version: number; at: string }[] }>('/api/cloud/legal'), []);
  const [del, setDel] = useState(false);
  const [support, setSupport] = useState('24');
  const last = (doc: string) => legal.data?.accepted.find((a) => a.doc === doc);
  return (
    <>
      <div className="card" data-tour="cloud-export">
        <h3 style={{ marginTop: 0 }}>Daten exportieren</h3>
        <p className="muted">
          Alle deine Daten als ZIP: je Tabelle eine JSON- und eine CSV-Datei (Kontakte, Aufgaben, Nachrichten, Rechnungen …) plus deine hochgeladenen Dateien – ohne Passwörter und Schlüssel. Das geht jederzeit, auch wenn das Konto schreibgeschützt ist.
        </p>
        <a className="btn" href="/api/cloud/export" download>
          <Icon name="download" /> Export herunterladen
        </a>
      </div>

      <div className="card" data-tour="cloud-support">
        <h3 style={{ marginTop: 0 }}>
          Support-Zugriff {t.support.active ? <Badge tone="yellow">freigegeben bis {d(t.support.until)}</Badge> : <Badge>aus</Badge>}
        </h3>
        <p className="muted">
          Standardmäßig kann niemand vom Anbieter dein Konto öffnen. Wenn du Hilfe möchtest, gib den Zugriff für eine Zeit frei. Jeder Zugriff steht in deinem Protokoll (Einstellungen → Protokoll).
        </p>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="grow">
            <Field label="Freigabe">
              <Select value={support} onChange={setSupport} options={SUPPORT} />
            </Field>
          </div>
          <button className="btn" style={{ marginBottom: 12 }} onClick={async () => (await act(() => api.put('/api/cloud/support', { hours: Number(support) }), Number(support) ? 'Freigegeben' : 'Widerrufen')) && reload()}>
            Speichern
          </button>
          {t.support.active && (
            <button className="btn secondary" style={{ marginBottom: 12 }} onClick={async () => (await act(() => api.put('/api/cloud/support', { hours: 0 }), 'Widerrufen')) && reload()}>
              Jetzt widerrufen
            </button>
          )}
        </div>
      </div>

      <div className="card" data-tour="cloud-contracts">
        <h3 style={{ marginTop: 0 }}>Verträge</h3>
        <p className="muted">Der Auftragsverarbeitungsvertrag (AVV) mit deiner Firma, in der Version, der du zugestimmt hast.</p>
        <div className="actions">
          <a className="btn secondary" href="/api/cloud/avv" download>
            <Icon name="doc" /> AVV als PDF
          </a>
          <a className="btn secondary" href="/api/cloud/avv?format=html" download>
            AVV als HTML
          </a>
          <a className="btn ghost" href="/cloud/legal/agb" target="_blank" rel="noopener noreferrer">
            AGB lesen
          </a>
          <a className="btn ghost" href="/cloud/legal/datenschutz" target="_blank" rel="noopener noreferrer">
            Datenschutz lesen
          </a>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Zugestimmt: {(['agb', 'avv', 'datenschutz'] as const).map((k) => (last(k) ? `${k.toUpperCase()} v${last(k)!.version} (${d(last(k)!.at)})` : null)).filter(Boolean).join(' · ') || '–'}
        </p>
      </div>

      <div className="card cloud-danger" data-tour="cloud-delete">
        <h3 style={{ marginTop: 0 }}>Konto löschen</h3>
        {t.deletion?.reason === 'self' ? (
          <>
            <p>Die Löschung ist für den {d(t.deletion.at)} geplant. Bis dahin kannst du sie zurücknehmen.</p>
            <button className="btn secondary" onClick={async () => (await act(() => api.post('/api/cloud/delete/undo', {}), 'Löschung zurückgenommen')) && reload()}>
              Löschung zurücknehmen
            </button>
          </>
        ) : (
          <>
            <p className="muted">Beendet dein Abo und löscht nach einer Frist alle Daten endgültig. Exportiere vorher, was du behalten möchtest.</p>
            <button className="btn danger" onClick={() => setDel(true)}>
              Konto löschen …
            </button>
          </>
        )}
      </div>
      {del && <DeleteModal me={me} onClose={() => setDel(false)} onDone={reload} />}
    </>
  );
}
