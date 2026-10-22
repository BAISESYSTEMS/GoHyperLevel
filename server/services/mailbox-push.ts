import { JoseError, decodeJwt, verifyJws, type JwksCache } from './jose.js';

/**
 * Checks for the two push channels – pure functions, tests drive them with generated keys.
 *
 * - Gmail → Cloud Pub/Sub → our endpoint. Pub/Sub can send an OpenID Connect token (a JWT signed by Google for a
 *   service account of the agency's project) with every push; we accept it only for the audience and the service
 *   account the agency configured. Without that setup the endpoint falls back to a shared secret in the URL.
 * - Microsoft Graph change notifications: the validation handshake (echo `validationToken`) and the `clientState`
 *   secret every notification carries.
 */

export const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/** Verifies the Bearer token of a Pub/Sub push request. Throws a JoseError (German) when anything is off. */
export async function verifyPubSubJwt(token: string, o: { jwks: JwksCache; audience: string; serviceAccount: string; now?: number; leewaySec?: number }): Promise<{ email: string }> {
  if (!o.serviceAccount) throw new JoseError('Kein Pub/Sub-Dienstkonto hinterlegt');
  if (!o.audience) throw new JoseError('Keine Pub/Sub-Zielgruppe (audience) hinterlegt');
  const jwt = decodeJwt(token);
  // Google signs these with RS256; nothing else is accepted (no "none", no HMAC).
  if (jwt.header.alg !== 'RS256' || jwt.header.crit !== undefined) throw new JoseError('Signaturverfahren nicht erlaubt');
  const jwk = await o.jwks.keyFor(GOOGLE_JWKS, jwt.header);
  if (!verifyJws(jwt, jwk)) throw new JoseError('Signatur des Pub/Sub-Tokens ist ungültig');
  const c = jwt.payload;
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  const leeway = o.leewaySec ?? 60;
  if (!GOOGLE_ISSUERS.includes(String(c.iss))) throw new JoseError('Pub/Sub-Token stammt nicht von Google (iss)');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(o.audience)) throw new JoseError('Pub/Sub-Token ist für eine andere Adresse ausgestellt (aud)');
  if (typeof c.exp !== 'number' || c.exp <= now - leeway) throw new JoseError('Pub/Sub-Token ist abgelaufen');
  if (typeof c.iat === 'number' && c.iat > now + leeway) throw new JoseError('Pub/Sub-Token hat ein Ausstellungsdatum in der Zukunft');
  if (c.email_verified !== true && c.email_verified !== 'true') throw new JoseError('Die E-Mail-Adresse des Dienstkontos ist nicht bestätigt');
  const email = String(c.email ?? '').toLowerCase();
  if (!email || email !== o.serviceAccount.toLowerCase()) throw new JoseError('Pub/Sub-Token gehört nicht zum hinterlegten Dienstkonto');
  return { email };
}

export interface PubSubNotice {
  /** The mailbox that changed (Gmail address). */
  address: string;
  historyId: string;
  messageId: string;
}

/** The envelope Pub/Sub pushes: { message: { data: base64(JSON { emailAddress, historyId }), messageId }, subscription }. */
export function parsePubSub(body: any): PubSubNotice | null {
  const m = body?.message;
  if (!m || typeof m.data !== 'string') return null;
  try {
    const d = JSON.parse(Buffer.from(m.data, 'base64').toString('utf8'));
    const address = String(d.emailAddress ?? '').trim().toLowerCase();
    if (!address.includes('@')) return null;
    return { address, historyId: String(d.historyId ?? ''), messageId: String(m.messageId ?? '') };
  } catch {
    return null;
  }
}

export interface GraphNotice {
  subscriptionId: string;
  clientState: string;
  changeType: string;
  /** Lifecycle notifications: reauthorizationRequired, subscriptionRemoved, missed. */
  lifecycleEvent: string;
  resource: string;
}

export function parseGraphNotices(body: any): GraphNotice[] {
  const list = Array.isArray(body?.value) ? body.value.slice(0, 200) : [];
  return list
    .filter((n: any) => n && typeof n === 'object' && typeof n.subscriptionId === 'string')
    .map((n: any) => ({
      subscriptionId: String(n.subscriptionId),
      clientState: String(n.clientState ?? ''),
      changeType: String(n.changeType ?? ''),
      lifecycleEvent: String(n.lifecycleEvent ?? ''),
      resource: String(n.resource ?? '').slice(0, 300),
    }));
}
