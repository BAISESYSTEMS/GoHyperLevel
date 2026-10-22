import type { Catalog } from '../registry';

/** English – outbound AI calls under the AI phone agent (pages/VoiceOutbound.tsx). */
export default {
  Absendernummer: 'Caller ID',
  'Anruf läuft – das Telefon des Kontakts klingelt.': 'Calling – the contact’s phone is ringing.',
  'Ausgehende KI-Anrufe': 'Outbound AI calls',
  'Der KI-Telefonagent ruft Kontakte an – zum Qualifizieren, für einen Termin oder als Erinnerung. Im großen Stil über die Workflow-Aktion „KI-Anruf starten“; die Ergebnisse (angenommen, Termin gebucht, nicht erreicht, Mailbox) starten eigene Auslöser.':
    'The AI phone agent calls contacts – to qualify them, to book an appointment or as a reminder. At scale through the workflow action “Start AI call”; the results (answered, booked, no answer, voicemail) start triggers of their own.',
  Ergebnis: 'Result',
  Gespeichert: 'Saved',
  'Heute: {n} von {max}': 'Today: {n} of {max}',
  'Höchstens Anrufe pro Tag': 'Calls per day at most',
  'Jetzt anrufen': 'Call now',
  'KI-Anruf starten': 'Start AI call',
  Kontakt: 'Contact',
  'Leitfaden / Prompt': 'Script / prompt',
  'Mailbox-Nachricht (Standard)': 'Voicemail message (default)',
  'Name, E-Mail oder Telefon…': 'Name, e-mail or phone…',
  'Nicht angerufen: {reason}': 'Not called: {reason}',
  'Noch keine ausgehenden KI-Anrufe.': 'No outbound AI calls yet.',
  Speichern: 'Save',
  Standard: 'Default',
  'Twilio-Nummer oder eine bestätigte eigene Nummer (Einstellungen → Telefonie).': 'A Twilio number or a verified own number (Settings → Telephony).',
  'Vorher prüft der Server Nicht stören, Einwilligung (§ 7 UWG – für Werbeanrufe eine bestätigte), Anrufzeiten, Feiertage und das Tageslimit.':
    'First the server checks do-not-disturb, consent (§ 7 UWG – a confirmed one for sales calls), calling hours, public holidays and the daily limit.',
  'Was der Agent fragen, anbieten oder vermeiden soll. Platzhalter wie {{contact.first_name}} gehen.': 'What the agent should ask, offer or avoid. Placeholders like {{contact.first_name}} work.',
  'Wird gesprochen, wenn ein Anrufbeantworter abnimmt. Leer = auflegen.': 'Spoken when an answering machine picks up. Empty = hang up.',
  Zeit: 'Time',
  Ziel: 'Goal',
  Zusammenfassung: 'Summary',
  'keine Nummer': 'no number',
  läuft: 'running',
  'nicht angerufen': 'not called',
  ändern: 'change',
  // sent by the server: goals and results
  Qualifizieren: 'Qualify',
  'Termin vereinbaren': 'Book an appointment',
  'Termin-Erinnerung': 'Appointment reminder',
  Angenommen: 'Answered',
  'Termin gebucht': 'Booked',
  'Nicht erreicht': 'No answer',
  Mailbox: 'Voicemail',
} satisfies Catalog;
