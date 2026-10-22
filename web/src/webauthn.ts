/** Browser side of passkeys: JSON options from the server ⇄ navigator.credentials (base64url ⇄ ArrayBuffer). */
import { tr } from './i18n';

const t = tr('login');

const toBuf = (s: string): ArrayBuffer => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};
const toB64u = (b: ArrayBuffer | null): string => {
  if (!b) return '';
  const bytes = new Uint8Array(b);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const passkeysSupported = () => typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;

const descriptors = (list: any[] | undefined) => (list ?? []).map((c) => ({ ...c, id: toBuf(c.id) }));

/** Readable message for the usual WebAuthn errors (in the UI language). */
export function passkeyError(e: unknown): string {
  const name = (e as DOMException)?.name;
  if (name === 'NotAllowedError') return t('Abgebrochen oder kein passender Passkey gefunden');
  if (name === 'InvalidStateError') return t('Dieser Passkey ist auf dem Gerät schon registriert');
  if (name === 'SecurityError') return t('Passkeys gehen nur über HTTPS auf der richtigen Domain');
  if (name === 'NotSupportedError') return t('Dieses Gerät unterstützt keine Passkeys');
  return (e as Error)?.message || t('Passkey hat nicht geklappt');
}

export async function createPasskey(options: any) {
  const cred = (await navigator.credentials.create({
    publicKey: { ...options, challenge: toBuf(options.challenge), user: { ...options.user, id: toBuf(options.user.id) }, excludeCredentials: descriptors(options.excludeCredentials) },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error(t('Kein Passkey erstellt'));
  const r = cred.response as AuthenticatorAttestationResponse;
  return { id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, response: { clientDataJSON: toB64u(r.clientDataJSON), attestationObject: toB64u(r.attestationObject), transports: r.getTransports?.() ?? [] } };
}

export async function getPasskey(options: any) {
  const cred = (await navigator.credentials.get({ publicKey: { ...options, challenge: toBuf(options.challenge), allowCredentials: descriptors(options.allowCredentials) } })) as PublicKeyCredential | null;
  if (!cred) throw new Error(t('Kein Passkey gewählt'));
  const r = cred.response as AuthenticatorAssertionResponse;
  return { id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, response: { clientDataJSON: toB64u(r.clientDataJSON), authenticatorData: toB64u(r.authenticatorData), signature: toB64u(r.signature), userHandle: r.userHandle ? toB64u(r.userHandle) : null } };
}
