import type { Catalog } from '../registry';

/** English – own numbers as caller ID under Settings → Telephony (pages/CallerIds.tsx). */
export default {
  'Bestätigungsanruf starten': 'Start verification call',
  'Bezeichnung (optional)': 'Label (optional)',
  'Danach ist die Nummer als Absender wählbar. Kam kein Anruf, schließe das Fenster und starte es neu.': 'Then the number can be chosen as caller ID. If no call came, close the window and start again.',
  'Eigene Nummer als Absender': 'Your own number as caller ID',
  'Eigene Nummer bestätigen': 'Verify your own number',
  'Erste Twilio-Nummer ({n})': 'First Twilio number ({n})',
  Gespeichert: 'Saved',
  'Ich habe den Code eingegeben': 'I have entered the code',
  'Im Format +49…; die Nummer muss gerade erreichbar sein.': 'In the format +49…; the number has to be reachable right now.',
  'Nummer bestätigen': 'Verify number',
  Nummer: 'Number',
  Prüfen: 'Check',
  'Ruf mit deiner bestehenden Festnetz- oder Handynummer an, statt mit der Twilio-Nummer: Twilio ruft die Nummer einmal an, du tippst den angezeigten Code ein. Gilt für Browser-Telefon, Power-Dialer, Klick-Anruf und KI-Anrufe. Eingehende Anrufe auf diese Nummer laufen weiter wie bisher.':
    'Call with your existing landline or mobile number instead of the Twilio number: Twilio calls the number once and you type the code shown. Applies to the browser phone, power dialer, click-to-call and AI calls. Inbound calls to that number work as before.',
  'Standard-Absender': 'Default caller ID',
  Status: 'Status',
  'Twilio ruft jetzt {n} an. Nimm ab und tippe diesen Code ein:': 'Twilio is calling {n} now. Pick up and type this code:',
  bestätigt: 'verified',
  fehlgeschlagen: 'failed',
  'wartet auf Code {code}': 'waiting for code {code}',
  'z. B. Büro': 'e.g. Office',
  '{n} als Absender entfernen?': 'Remove {n} as caller ID?',
  '{n} entfernen': 'Remove {n}',
} satisfies Catalog;
