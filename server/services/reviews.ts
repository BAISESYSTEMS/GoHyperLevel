import type { App } from '../core/app.js';
import { render } from '../core/template.js';
import { id, now, token } from '../core/util.js';
import { contactVars, getContact } from './contacts.js';
import { sendToContact, type Channel } from './messaging.js';

export const DEFAULT_REVIEW_MESSAGE =
  'Hallo {{contact.first_name|du}},\n\ndanke, dass du bei {{location.name}} warst! Wie zufrieden bist du? Deine Bewertung dauert nur 30 Sekunden:\n{{review.url}}\n\nVielen Dank!';

/**
 * Sends a review request link; 4–5 stars are sent on to the public review site, lower ratings stay internal. A review request is
 * advertising in German law: it goes through the consent gate (DND, withdrawal, the sub-account's policy) with an unsubscribe
 * link, and a request that may not go out is an error (the stored request is dropped again).
 */
export async function sendReviewRequest(app: App, locationId: string, contactId: string, channel: Channel = 'email') {
  const contact = getContact(app, locationId, contactId);
  if (!contact) throw new Error('Kontakt nicht gefunden');
  const loc = app.location(locationId)!;
  const row = { id: id(), location_id: locationId, contact_id: contactId, token: token(16), channel, rating: null, comment: '', created_at: now() };
  app.db.insert('review_requests', row);
  const vars = { contact: contactVars(contact), location: loc, review: { url: `${app.baseUrl()}/r/${row.token}` } };
  const r = loc.settings.reviews ?? {};
  const m = await sendToContact(app, locationId, {
    contactId,
    channel,
    subject: render(r.subject || 'Wie war es bei {{location.name}}?', vars),
    body: render(r.message || DEFAULT_REVIEW_MESSAGE, vars),
    source: 'Bewertungsanfrage',
    purpose: 'marketing',
    bulk: true,
  });
  if (m.status === 'failed') {
    app.db.run('DELETE FROM review_requests WHERE id = ?', row.id);
    throw new Error(m.error || 'Bewertungsanfrage nicht gesendet');
  }
  return row;
}
