import { createHash } from 'node:crypto';

/**
 * Legal texts of the hosted service as editable templates (AGB, AVV, Datenschutz, Impressum). The defaults are
 * starting points with placeholders – NO legal advice: the operator has them checked and fills them in
 * (Agentur → Cloud → Rechtliches). Each change creates a new version; every signup stores which versions it accepted.
 *
 * Placeholders: {{operator.name}}, {{operator.address}}, {{operator.email}}, {{operator.phone}}, {{operator.vat_id}},
 * {{operator.register}}, {{operator.representative}}, {{operator.hosting}} (hosting provider and server location), {{service}} (product name), {{customer.company}},
 * {{customer.email}}, {{date}}, {{version}}, {{trial_days}}, {{grace_days}}, {{retention_days}}, {{deletion_notice_days}}.
 */

export const LEGAL_DOCS = ['agb', 'avv', 'datenschutz', 'impressum'] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];
export const isLegalDoc = (v: unknown): v is LegalDoc => LEGAL_DOCS.includes(v as LegalDoc);

export const LEGAL_TITLE: Record<LegalDoc, string> = {
  agb: 'Allgemeine Geschäftsbedingungen (AGB)',
  avv: 'Auftragsverarbeitungsvertrag (AVV)',
  datenschutz: 'Datenschutzerklärung',
  impressum: 'Impressum',
};
/** Which documents a signup must accept (the Impressum is information only). */
export const ACCEPTED_DOCS: LegalDoc[] = ['agb', 'avv', 'datenschutz'];

const NOTE = `> **Vorlage – keine Rechtsberatung.** Dieser Text ist ein Ausgangspunkt mit Platzhaltern. Bitte von einer Rechtsanwältin oder einem Rechtsanwalt prüfen und anpassen lassen, bevor du ihn verwendest. Diesen Hinweis danach entfernen.`;

export const DEFAULT_LEGAL: Record<LegalDoc, string> = {
  agb: `${NOTE}

## 1. Geltungsbereich und Vertragspartner

Diese Bedingungen gelten für die Nutzung von {{service}} (die „Cloud“) durch Unternehmerinnen und Unternehmer. Vertragspartner ist {{operator.name}}, {{operator.address}} (der „Anbieter“). Abweichende Bedingungen des Kunden gelten nur, wenn der Anbieter ihnen schriftlich zustimmt.

Das Angebot richtet sich ausschließlich an Unternehmer im Sinne von § 14 BGB, juristische Personen des öffentlichen Rechts und öffentlich-rechtliche Sondervermögen (nur B2B). Verbraucher im Sinne von § 13 BGB können keinen Vertrag schließen. Der Kunde bestätigt bei der Anmeldung, dass er als Unternehmer handelt – durch Angabe seiner Umsatzsteuer-Identifikationsnummer oder eine ausdrückliche Erklärung. Der Anbieter darf dafür Nachweise verlangen und einen Vertrag, der entgegen dieser Erklärung mit einem Verbraucher geschlossen wurde, fristlos kündigen.

## 2. Leistung

Der Anbieter stellt die Software {{service}} als gehostete Anwendung (Software as a Service) im gewählten Tarif bereit. Alle Funktionen stehen in jedem Tarif zur Verfügung; die Tarife unterscheiden sich in der Zahl der Nutzer sowie – beim Tarif Agentur – in White-Label und Kunden-Accounts. Der Leistungsumfang richtet sich nach der Beschreibung auf der Preisseite zum Zeitpunkt des Vertragsschlusses.

## 3. Vertragsschluss und Testphase

Der Vertrag kommt mit der Bestätigung der E-Mail-Adresse und dem Abschluss der Anmeldung zustande. Die Testphase dauert {{trial_days}} Tage und ist kostenlos. Wird nicht vor Ablauf gekündigt bzw. wurde ein Zahlungsmittel hinterlegt, geht der Vertrag in das kostenpflichtige Abonnement über.

## 4. Preise und Zahlung

Es gelten die Preise der Preisseite zum Zeitpunkt des Vertragsschlusses. Es wird ein fester Preis je Firma berechnet, keine Gebühr pro Nutzer. Die Abrechnung erfolgt im Voraus, monatlich oder jährlich, über den Zahlungsdienstleister Stripe. Verbrauch oberhalb der Fair-Use-Grenzen (z. B. SMS) kann zum Selbstkostenpreis zuzüglich Aufschlag berechnet werden; die Grenzen sind in der Anwendung einsehbar.

## 5. Laufzeit und Kündigung

Das Abonnement läuft auf unbestimmte Zeit und kann jederzeit zum Ende des bezahlten Zeitraums gekündigt werden – in der Anwendung unter „Cloud-Konto“. Das Recht zur außerordentlichen Kündigung bleibt unberührt.

## 6. Zahlungsverzug

Schlägt eine Zahlung fehl, informiert der Anbieter den Kunden und gewährt {{grace_days}} Tage Kulanz. Danach wird das Konto schreibgeschützt (Daten bleiben lesbar und exportierbar). Nach {{retention_days}} weiteren Tagen bietet der Anbieter den Datenexport an und kündigt die Löschung an; die Daten werden nach {{deletion_notice_days}} Tagen gelöscht, wenn bis dahin keine Zahlung eingegangen ist.

## 7. Pflichten des Kunden

Der Kunde schützt seine Zugangsdaten, nutzt die Cloud rechtmäßig und stellt sicher, dass er die für seine Kontakte erforderlichen Einwilligungen und Rechtsgrundlagen hat. Missbrauch (z. B. Spam, Phishing, rechtswidrige Inhalte) berechtigt den Anbieter, den Versand zu pausieren, Websites und Formulare offline zu nehmen oder das Konto zu sperren; überschreiten Beschwerde- oder Bounce-Rate der versandten E-Mails die in der Anwendung genannten Grenzen, pausiert der Versand automatisch. Der Anbieter teilt dem Kunden jede solche Maßnahme mit Begründung mit; Meldungen rechtswidriger Inhalte nimmt er über das Meldeformular auf seiner Website entgegen.

## 8. Verfügbarkeit und Wartung

Der Anbieter bemüht sich um eine hohe Verfügbarkeit. Wartungsarbeiten werden nach Möglichkeit vorher angekündigt. Den aktuellen Betriebszustand zeigt die Status-Seite.

## 9. Datenschutz, Daten des Kunden und Export

Der Anbieter verarbeitet personenbezogene Daten der Kontakte des Kunden als Auftragsverarbeiter nach dem Auftragsverarbeitungsvertrag (AVV). Die Daten gehören dem Kunden. Er kann sie jederzeit vollständig exportieren (ZIP mit JSON und CSV) und sein Konto löschen.

## 10. Haftung

Der Anbieter haftet unbeschränkt bei Vorsatz und grober Fahrlässigkeit, bei Verletzung von Leben, Körper und Gesundheit sowie nach dem Produkthaftungsgesetz. Bei leicht fahrlässiger Verletzung wesentlicher Vertragspflichten ist die Haftung auf den vorhersehbaren, vertragstypischen Schaden begrenzt. Im Übrigen ist die Haftung ausgeschlossen.

## 11. Änderungen

Der Anbieter kann diese Bedingungen mit Wirkung für die Zukunft ändern. Änderungen werden dem Kunden rechtzeitig mitgeteilt und gelten, wenn er nicht innerhalb von vier Wochen widerspricht.

## 12. Schlussbestimmungen

Es gilt deutsches Recht unter Ausschluss des UN-Kaufrechts. Gerichtsstand ist, soweit zulässig, der Sitz des Anbieters.

Stand: {{date}} · Version {{version}}`,

  avv: `${NOTE}

## Vereinbarung zur Auftragsverarbeitung nach Art. 28 DSGVO

zwischen **{{customer.company}}** (Verantwortlicher, „Kunde“) und **{{operator.name}}**, {{operator.address}} (Auftragsverarbeiter, „Anbieter“).

## 1. Gegenstand und Dauer

Der Anbieter verarbeitet im Auftrag des Kunden personenbezogene Daten bei der Bereitstellung von {{service}}. Die Dauer richtet sich nach dem Hauptvertrag (AGB).

## 2. Art und Zweck der Verarbeitung

Speicherung, Anzeige, Verknüpfung und Übermittlung von Kontakt-, Kommunikations-, Termin-, Rechnungs- und weiteren Daten, die der Kunde in die Anwendung einträgt, importiert oder über Formulare, Kanäle und Integrationen sammelt – zum Zweck des Betriebs von CRM, Kommunikation, Marketing und Verwaltung durch den Kunden.

## 3. Arten der Daten und Kreis der Betroffenen

Daten: Name, Kontaktdaten, Kommunikationsinhalte, Termine, Vertrags- und Rechnungsdaten, Nutzungsdaten. Betroffene: Kunden, Interessenten, Mitarbeitende und Geschäftspartner des Kunden.

## 4. Pflichten des Anbieters

- Verarbeitung nur auf dokumentierte Weisung des Kunden (die Nutzung der Anwendung gilt als Weisung).
- Verpflichtung der Mitarbeitenden zur Vertraulichkeit.
- Angemessene technische und organisatorische Maßnahmen nach Art. 32 DSGVO (siehe Anlage 1).
- Unterstützung bei Betroffenenanfragen (Auskunft, Berichtigung, Löschung) – die Anwendung bietet Export und Löschung je Kontakt.
- Unterstützung bei Datenschutz-Folgenabschätzungen und Meldungen von Datenschutzverletzungen; der Anbieter meldet Verletzungen unverzüglich.
- Löschung oder Rückgabe aller Daten nach Vertragsende (Export in der Anwendung; Löschung nach den Fristen der AGB).
- Nachweise und Kontrollen: der Anbieter stellt die nötigen Informationen bereit und ermöglicht Überprüfungen.

## 5. Unterauftragsverarbeiter

Der Kunde stimmt dem Einsatz der in Anlage 2 genannten Unterauftragsverarbeiter zu. Über Änderungen informiert der Anbieter rechtzeitig; der Kunde kann aus wichtigem Grund widersprechen.

## 6. Support-Zugriff

Der Anbieter greift auf das Konto des Kunden nur zu, wenn der Kunde den Support-Zugriff in der Anwendung freigegeben hat. Jeder Zugriff wird protokolliert und ist für den Kunden im Protokoll sichtbar.

## 7. Drittlandübermittlung

Die Server, auf denen die Daten verarbeitet werden, betreibt {{operator.hosting}}. Eine Übermittlung in Drittländer erfolgt nur unter den Voraussetzungen der Art. 44 ff. DSGVO. [Ggf. Garantien für Unterauftragsverarbeiter außerhalb der EU eintragen.]

## Anlage 1 – Technische und organisatorische Maßnahmen

[Zutrittskontrolle, Zugangskontrolle, Zugriffskontrolle, Verschlüsselung (Übertragung und gespeicherte Zugangsdaten), Mandantentrennung, Protokollierung, Datensicherung, Wiederherstellbarkeit – vom Anbieter auszufüllen]

## Anlage 2 – Unterauftragsverarbeiter

- Zahlungsabwicklung: Stripe Payments Europe, Ltd.
- Hosting: {{operator.hosting}}
- E-Mail-Versand für Systemnachrichten: [Anbieter eintragen]

Stand: {{date}} · Version {{version}} · Kunde: {{customer.company}}`,

  datenschutz: `${NOTE}

## 1. Verantwortlicher

{{operator.name}}, {{operator.address}} · E-Mail: {{operator.email}}

## 2. Welche Daten wir verarbeiten und warum

- **Besuch der Preis- und Anmeldeseite:** Es werden keine Cookies gesetzt und keine Tracking-Dienste eingebunden. Der Server verarbeitet technisch notwendige Verbindungsdaten (IP-Adresse, Zeitpunkt) kurzzeitig zur Auslieferung und zur Missbrauchsabwehr (Art. 6 Abs. 1 lit. f DSGVO).
- **Anmeldung:** Firmenname, Name, E-Mail-Adresse, gewählter Tarif und Passwort-Hash bzw. Google-Kennung zur Vertragsdurchführung (Art. 6 Abs. 1 lit. b DSGVO). Nach dem Absenden setzen wir ein technisch notwendiges Cookie, das den Abschluss der Anmeldung demselben Browser zuordnet.
- **Zahlung:** Über Stripe. Zahlungsdaten gelangen direkt zu Stripe, nicht zu uns.
- **Nachweis der Zustimmung:** Version und Zeitpunkt der akzeptierten AGB, des AVV und dieser Erklärung (Art. 6 Abs. 1 lit. c, f DSGVO).
- **Anmeldung mit Google:** Wir erhalten die bestätigte E-Mail-Adresse und den Namen.

## 3. Empfänger

Stripe (Zahlungsabwicklung), {{operator.hosting}} (Hosting), [E-Mail-Dienst]. Mit allen besteht ein Vertrag zur Auftragsverarbeitung bzw. ein gleichwertiger Rahmen.

## 4. Speicherdauer

Vertragsdaten, solange das Konto besteht und gesetzliche Aufbewahrungsfristen es verlangen; Anmelde-Entwürfe ohne Abschluss werden nach kurzer Zeit gelöscht.

## 5. Deine Rechte

Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit (in der Anwendung als Export), Widerspruch und Beschwerde bei einer Aufsichtsbehörde.

Stand: {{date}} · Version {{version}}`,

  impressum: `${NOTE}

## Angaben nach § 5 DDG

{{operator.name}}
{{operator.address}}

Vertreten durch: {{operator.representative}}

Kontakt: {{operator.email}} · {{operator.phone}}

Registereintrag: {{operator.register}}

Umsatzsteuer-ID: {{operator.vat_id}}

Verantwortlich für den Inhalt: {{operator.representative}}`,
};

export interface LegalVars {
  operator: { name: string; street: string; zip_city: string; country: string; email: string; phone: string; vat_id: string; register: string; representative: string; hosting?: string };
  service: string;
  company?: string;
  email?: string;
  trial_days: number;
  grace_days: number;
  retention_days: number;
  deletion_notice_days: number;
  version: number;
  date: string;
}

/** Fills the placeholders; empty values and unknown names stay visible as {{…}} so nothing is published half-done. */
export function fillLegal(body: string, v: LegalVars): string {
  const o = v.operator;
  const address = [o.street, o.zip_city, o.country].filter(Boolean).join(', ');
  const map: Record<string, string> = {
    'operator.name': o.name,
    'operator.address': address,
    'operator.email': o.email,
    'operator.phone': o.phone,
    'operator.vat_id': o.vat_id,
    'operator.register': o.register,
    'operator.representative': o.representative,
    'operator.hosting': o.hosting ?? '',
    service: v.service,
    'customer.company': v.company ?? '',
    'customer.email': v.email ?? '',
    date: v.date,
    version: String(v.version),
    trial_days: String(v.trial_days),
    grace_days: String(v.grace_days),
    retention_days: String(v.retention_days),
    deletion_notice_days: String(v.deletion_notice_days),
  };
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k: string) => (map[k] ? map[k] : m));
}

/** Placeholders still unfilled in a rendered text (for the operator's warning). */
export const openPlaceholders = (rendered: string): string[] => [...new Set([...rendered.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]))];

export const legalHash = (body: string) => createHash('sha256').update(body).digest('hex');
