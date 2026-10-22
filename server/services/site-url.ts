import type { App } from '../core/app.js';

/** Public address of a funnel page: its own domain when connected, else /p/<funnel>/<page>. */
export function pageUrl(app: App, funnel: any, page?: any, first = false): string {
  const root = funnel.domain ? `https://${funnel.domain}` : `${app.baseUrl()}/p/${funnel.slug}`;
  return page && !first ? `${root}/${page.slug}` : funnel.domain ? `${root}/` : root;
}

export const safeUrl = (u: unknown) => {
  const s = String(u ?? '').trim();
  return /^(https?:\/\/|\/|#|mailto:|tel:)/i.test(s) ? s : '#';
};

/**
 * A link of a block or menu: `page:<id or path>` points at a page of this site (it keeps working when the path changes and in
 * copies of the site), everything else must be an http(s), site/app path, anchor, mailto or tel link.
 */
export function resolveHref(env: { app: App; funnel: any; pages(): any[] }, raw: unknown): string {
  const s = String(raw ?? '').trim();
  const m = /^page:([A-Za-z0-9_-]{1,60})$/.exec(s);
  if (!m) return safeUrl(s);
  const pages = env.pages();
  const p = pages.find((x) => x.id === m[1]) ?? pages.find((x) => x.slug === m[1]);
  return p ? pageUrl(env.app, env.funnel, p, p.id === pages[0]?.id) : '#';
}
