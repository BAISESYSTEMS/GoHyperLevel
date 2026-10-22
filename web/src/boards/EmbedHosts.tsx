import { useEffect, useState } from 'react';
import { api } from '../api';
import { Field, Modal, Spinner, Textarea, act, useLoad } from '../ui';

/** The addresses the "Einbettung" widget may show – a built-in list plus the agency's own (admins only). Applies to every sub-account. */
export function EmbedHosts({ onClose }: { onClose: () => void }) {
  const { data, error } = useLoad(() => api.get<{ defaults: string[]; custom: string[]; can_edit: boolean }>('/api/boards/embed-hosts'), []);
  const [text, setText] = useState('');
  useEffect(() => {
    if (data) setText(data.custom.join('\n'));
  }, [data]);
  return (
    <Modal
      title="Freigegebene Einbettungs-Adressen"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Schließen
          </button>
          {data?.can_edit && (
            <button
              className="btn"
              onClick={async () => {
                const hosts = text.split(/[\s,;]+/).filter(Boolean);
                if (await act(() => api.put('/api/boards/embed-hosts', { hosts }), 'Gespeichert')) onClose();
              }}
            >
              Speichern
            </button>
          )}
        </>
      }
    >
      <p className="muted small">Das Widget „Einbettung“ zeigt nur Seiten von diesen Adressen (immer per https, ohne Zugangsdaten). Wer eine Adresse entfernt, schaltet sie sofort in allen Boards ab.</p>
      {error && <p className="bd-error">{error}</p>}
      {!data && !error && <Spinner />}
      {data && (
        <>
          <h4 className="bd-h4">Immer erlaubt</h4>
          <div className="chips">
            {data.defaults.map((h) => (
              <span key={h} className="chip">
                {h}
              </span>
            ))}
          </div>
          <Field label="Eigene Adressen (eine pro Zeile)" hint="Zum Beispiel berichte.firma.de – Unterseiten und Subdomains sind mit eingeschlossen.">
            <Textarea value={text} onChange={setText} rows={5} disabled={!data.can_edit} placeholder="berichte.example.org" />
          </Field>
        </>
      )}
    </Modal>
  );
}
