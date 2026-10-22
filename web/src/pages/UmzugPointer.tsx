import { Link } from '../ui';

/** A small card on the Settings tabs that points to the Umzug assistant and the delivery check (both are lazy pages of their own). */
export function UmzugPointer({ kind }: { kind: 'umzug' | 'deliverability' }) {
  return kind === 'umzug' ? (
    <div className="card notice-card" data-tour="umzug-pointer">
      <strong>Wechsel von Mailchimp, Klaviyo, Zendesk, Salesforce, monday.com, Notion, Typeform, Calendly, sevDesk oder einem anderen Tool?</strong>
      <p className="muted">Der Umzugsassistent holt Kontakte, Deals, Tickets, Projekte, Wiki-Seiten, Formulare, Termine und mehr per Schlüssel oder Export-Datei – mit Vorschau, Probelauf und Rückgängig.</p>
      <Link to="settings/umzug" className="btn secondary">
        Zum Umzugsassistenten
      </Link>
    </div>
  ) : (
    <div className="card notice-card" data-tour="deliverability-pointer">
      <strong>Kommen deine Mails an?</strong>
      <p className="muted">Prüfe SPF, DKIM und DMARC deiner Absender-Domain und kopiere die fehlenden DNS-Einträge.</p>
      <Link to="settings/deliverability" className="btn secondary">
        E-Mail-Zustellung prüfen
      </Link>
    </div>
  );
}
