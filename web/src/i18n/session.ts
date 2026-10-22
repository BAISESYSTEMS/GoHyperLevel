import { api } from '../api';
import { browserLocale, isLocale, setLocale, storedLocale, type Locale, type Namespace } from './index';

/**
 * Which language the app starts in, and where a choice is kept (docs/translating.md):
 * - signed in: the language saved at the user (Mein Konto, the sidebar's language menu) – else the browser's;
 * - signed out (login, setup, consent screen): this device's last choice – else what the browser asks for (Accept-Language,
 *   answered by GET /api/language).
 * A language picked on the login screen is saved to the profile with the sign-in that follows.
 */

let pickedSignedOut: Locale | null = null;

const save = (lang: Locale | null) => api.put('/api/me/language', { lang }).catch(() => undefined);

export async function startSignedIn(user: { lang?: unknown }, also: Namespace[] = []): Promise<void> {
  const saved = isLocale(user.lang) ? user.lang : null;
  // A choice made on this device before signing in (login screen) wins and becomes the profile's language.
  const local = pickedSignedOut ?? (saved ? null : storedLocale());
  pickedSignedOut = null;
  if (local && local !== saved) void save(local);
  const lang = local ?? saved ?? browserLocale();
  await setLocale(lang, { remember: !!(local ?? saved), also });
}

export async function startSignedOut(also: Namespace[] = []): Promise<void> {
  const lang = storedLocale() ?? (await api.get<{ lang?: string }>('/api/language').then((r) => (isLocale(r?.lang) ? r.lang : browserLocale()), () => browserLocale()));
  await setLocale(lang, { remember: false, also });
}

/** The language switch: on screen at once (after its texts are loaded), saved to the profile when signed in. */
export async function chooseLocale(lang: Locale, signedIn: boolean): Promise<void> {
  await setLocale(lang);
  if (signedIn) await save(lang);
  else pickedSignedOut = lang;
}
