import { createHmac } from 'node:crypto';
import { attrs, twiml, xml } from './twilio.js';

/**
 * Pure helpers of the browser phone (Twilio Voice JS SDK): the Access Token (a JWT with a VoiceGrant,
 * signed HS256 with an API key secret – what Twilio's own libraries produce), client identities and
 * the TwiML for outgoing calls and hold/resume. No database, no network.
 */

export const API_KEY_SID = /^SK[0-9a-fA-F]{32}$/;
export const APP_SID = /^AP[0-9a-fA-F]{32}$/;
export const CALL_SID = /^CA[0-9a-fA-F]{32}$/;
export const PHONE_MODES = ['off', 'parallel', 'browser_only'] as const;
export type PhoneMode = (typeof PHONE_MODES)[number];
/** Twilio edges the SDK may connect to (signalling over wss://voice-js.<edge>.twilio.com). */
export const EDGES = ['roaming', 'frankfurt', 'dublin', 'ashburn', 'umatilla', 'sydney', 'tokyo', 'singapore', 'sao-paulo'] as const;

/** Origins the SDK needs in the admin app's CSP: signalling per edge and the ringtones. Insights are switched off. */
export const TWILIO_CSP_CONNECT = [...EDGES.map((e) => `wss://voice-js.${e}.twilio.com`), 'https://sdk.twilio.com'];

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

export interface TokenInput {
  accountSid: string;
  apiKeySid: string;
  apiSecret: string;
  identity: string;
  appSid: string;
  incoming: boolean;
  ttl?: number;
  now?: number;
}

/** Twilio Access Token with a VoiceGrant (incoming + outgoing through the TwiML app). */
export function voiceAccessToken(t: TokenInput): string {
  const iat = Math.floor((t.now ?? Date.now()) / 1000);
  const ttl = Math.min(Math.max(60, t.ttl ?? 3600), 86_400);
  const voice: Record<string, unknown> = { outgoing: { application_sid: t.appSid } };
  if (t.incoming) voice.incoming = { allow: true };
  const header = { alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' };
  const payload = { jti: `${t.apiKeySid}-${iat}`, iss: t.apiKeySid, sub: t.accountSid, iat, nbf: iat, exp: iat + ttl, grants: { identity: t.identity, voice } };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${body}.${createHmac('sha256', t.apiSecret).update(body).digest('base64url')}`;
}

/** Client identity per user and sub-account, so a browser only rings for the sub-account it is open in. */
export const identityFor = (userId: string, locationId: string) => `u_${userId}_${locationId}`;

export function parseIdentity(from: string | undefined): { userId: string; locationId: string } | null {
  const m = String(from ?? '')
    .replace(/^client:/, '')
    .match(/^u_([A-Za-z0-9]{1,64})_([A-Za-z0-9]{1,64})$/);
  return m ? { userId: m[1], locationId: m[2] } : null;
}

export const holdRoom = (callId: string) => `hold-${callId}`;

/** Browser → phone: ring the number with the sub-account's Twilio number as caller ID. */
export function outgoingTwiml(o: { callerId: string; number: string; action: string; legCallback: string; record?: boolean; recordingCallback?: string; announceUrl?: string }): string {
  const rec = o.record ? { record: 'record-from-answer-dual', recordingStatusCallback: o.recordingCallback, recordingStatusCallbackMethod: 'POST' } : {};
  return twiml(
    `<Dial${attrs({ callerId: o.callerId, timeout: 30, answerOnBridge: true, action: o.action, method: 'POST', ...rec })}><Number${attrs({ url: o.record ? o.announceUrl : undefined, method: o.record && o.announceUrl ? 'POST' : undefined, statusCallback: o.legCallback, statusCallbackEvent: 'answered completed', statusCallbackMethod: 'POST' })}>${xml(o.number)}</Number></Dial>`,
  );
}

/** Hold: the other party waits alone in a conference room with Twilio's hold music. */
export function holdTwiml(room: string, action: string): string {
  return twiml(`<Dial${attrs({ action, method: 'POST' })}><Conference${attrs({ startConferenceOnEnter: 'false', endConferenceOnExit: 'true', beep: 'false' })}>${xml(room)}</Conference></Dial>`);
}

/** Resume: the browser joins the room again; whoever leaves ends it. */
export function resumeTwiml(room: string, action: string): string {
  return twiml(`<Dial${attrs({ action, method: 'POST' })}><Conference${attrs({ startConferenceOnEnter: 'true', endConferenceOnExit: 'true', beep: 'false' })}>${xml(room)}</Conference></Dial>`);
}
