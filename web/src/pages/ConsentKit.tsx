/** Small pieces shared by the "Einwilligung & Recht" pages. */

export const LEGAL_NOTE = 'Keine Rechtsberatung – bitte prüfen. Alle Texte und Voreinstellungen hier sind Vorlagen nach deutschem Recht (DSGVO, UWG, TDDDG, BGB). Lass sie von einer Anwältin oder einem Anwalt bzw. deinem Datenschutzbeauftragten prüfen.';

export function LegalNotice() {
  return (
    <p className="card legal-note" data-tour="consent-notice">
      <strong>{LEGAL_NOTE}</strong>
    </p>
  );
}

/** Workflow steps (E-Mail / SMS): a service message (invoice, appointment, confirmation) is not advertising and ignores the send rule. */
export function ServiceMessageFlag({ step, set }: { step: object; set: (patch: Record<string, unknown>) => void }) {
  return (
    <label className="check" data-tour="wf-service-flag">
      <input type="checkbox" checked={(step as { purpose?: string }).purpose === 'transactional'} onChange={(e) => set({ purpose: e.target.checked ? 'transactional' : undefined })} /> Service-Nachricht (keine Werbung) – wird auch ohne Werbe-Einwilligung zugestellt und als solche markiert
    </label>
  );
}

export interface ImportConsent {
  consent: 'legacy' | 'confirmed' | 'doi';
  consent_note: string;
  source_label: string;
}
export const IMPORT_CONSENT_DEFAULT: ImportConsent = { consent: 'legacy', consent_note: '', source_label: '' };

/** CSV import: what is known about the consent of the people in the file (recorded in the consent ledger). */
export function ImportConsentFields({ value, onChange }: { value: ImportConsent; onChange: (v: ImportConsent) => void }) {
  const set = (patch: Partial<ImportConsent>) => onChange({ ...value, ...patch });
  return (
    <fieldset className="card" style={{ margin: '10px 0' }} data-tour="import-consent">
      <legend className="small">Einwilligung der Kontakte</legend>
      <label className="field">
        <span>Was weißt du über die Einwilligung?</span>
        <select value={value.consent} onChange={(e) => set({ consent: e.target.value as ImportConsent['consent'] })}>
          <option value="legacy">Altbestand – kein Nachweis (Status „unbekannt“, nur Vermerk der Quelle)</option>
          <option value="confirmed">Die Einwilligung liegt mir anderweitig nachweisbar vor</option>
          <option value="doi">Per Double-Opt-in bestätigen lassen (jede Person bekommt eine Bestätigungs-Mail)</option>
        </select>
      </label>
      <label className="field">
        <span>Herkunft der Liste</span>
        <input value={value.source_label} onChange={(e) => set({ source_label: e.target.value })} placeholder="z. B. Messe-Liste 2026 oder Export aus dem alten CRM" />
      </label>
      {value.consent !== 'doi' && (
        <label className="field">
          <span>{value.consent === 'confirmed' ? 'Wie wurde eingewilligt? (Pflicht für den Nachweis)' : 'Vermerk (optional)'}</span>
          <input value={value.consent_note} onChange={(e) => set({ consent_note: e.target.value })} placeholder={value.consent === 'confirmed' ? 'z. B. Anmeldeformular der alten Website, Double-Opt-in im Altsystem' : ''} />
        </label>
      )}
      {value.consent === 'confirmed' && <small className="muted">Nur wählen, wenn du es belegen kannst – der Vermerk steht im Nachweis jedes Kontakts. Ohne Beleg wähle „Altbestand“.</small>}
      {value.consent === 'doi' && <small className="muted">Achtung: Auch eine Bestätigungs-Mail an Adressen ohne vorherigen Kontakt kann als unerlaubte Werbung gelten. Nutze das nur, wenn es dafür eine Rechtsgrundlage gibt.</small>}
    </fieldset>
  );
}
