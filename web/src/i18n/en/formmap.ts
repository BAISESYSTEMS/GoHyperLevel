import type { Catalog } from '../registry';

/** English – a form field into a company, deal or custom-object field (pages/FormMapping.tsx). */
export default {
  'Zusätzlich speichern in': 'Also save to',
  'Firma, Deal oder eigenes Objekt des Kontakts': "The contact's company, deal or custom object",
  'Nicht zusätzlich': 'Nowhere else',
  Firma: 'Company',
  Deal: 'Deal',
  Feld: 'Field',
  'Deal-Pipeline (für alle Deal-Felder)': 'Deal pipeline (for all deal fields)',
  Stufe: 'Stage',
  'Welcher Deal': 'Which deal',
  'Immer ein neuer Deal': 'Always a new deal',
  'Offenen Deal des Kontakts ergänzen (sonst neu)': "Add to the contact's open deal (else a new one)",
  'Welcher Datensatz': 'Which record',
  'Neuer Datensatz (gleicher eindeutiger Wert: ergänzen)': 'New record (same unique value: add to it)',
  'Zuletzt verknüpften Datensatz ergänzen (sonst neu)': 'Add to the last linked record (else a new one)',
  'Vorhandene Werte überschreiben (sonst nur leere Felder füllen)': 'Overwrite stored values (else only fill empty ones)',
} satisfies Catalog;
