import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Module } from '../core/app.js';
import type { RawResult } from '../core/http.js';

/**
 * The two files every crawler and browser asks the app's own domain for, which used to get the web app's HTML page:
 * - `/robots.txt`: public pages (websites under /p/, forms, booking and webinar pages, help centre, communities) may be
 *   crawled; the app, the API and every personal or one-time link (invoices, quotes, contracts, tracking, unsubscribe,
 *   consent, member area …) may not. Websites and help centres on their own domain keep their own robots.txt – the domain
 *   rewrite sends them to the site before this route is matched.
 * - `/favicon.ico`: the app icon of the build (a PNG – browsers take it for the .ico name); nothing (204) without a build.
 */

/** Paths of the app's own domain that crawlers stay out of (prefixes, RFC 9309). */
export const ROBOTS_DISALLOW = [
  '/app',
  '/api/',
  '/mcp',
  '/hooks/',
  '/oauth/',
  '/auth/',
  // tracking pixel and links, trigger links, unsubscribe and consent links – a crawler must not count, unsubscribe or confirm
  '/t/',
  '/l/',
  '/u/',
  '/consent/',
  '/go/',
  // personal links: invoice, quote, contract, review, subscription, dunning letter, SEPA mandate, upsell, survey, invitation, calendar feed
  '/i/',
  '/q/',
  '/s/',
  '/r/',
  '/abo/',
  '/mahnung/',
  '/sepa/',
  '/upsell/',
  '/survey/',
  '/invite/',
  '/cal/',
  '/start/verify/',
  '/book/manage/',
  '/book/paid/',
  '/book/waitlist/',
  '/book/ics/',
  '/canvas/s/',
  '/wiki/s/',
  // member area, chat widget, push sign-up, plugin frames
  '/portal/',
  '/chat/',
  '/push/',
  '/plugin-',
];

/** `extra`: lines other modules add through `app.services.robotsExtra` (e.g. the landing page's `Sitemap:`). */
export function robotsTxt(extra: string[] = []): string {
  return ['# The app\'s own domain. Websites on their own domain have their own robots.txt.', 'User-agent: *', ...ROBOTS_DISALLOW.map((p) => `Disallow: ${p}`), 'Allow: /', ...extra, ''].join('\n');
}

/** The icon the build puts next to index.html (web/public); the first one that exists. */
const ICONS = ['apple-touch-icon.png', 'icon-192.png'];

export const rootFilesModule: Module = {
  name: 'root-files',
  register(app) {
    const extra = () => ((app.services.robotsExtra as (() => string[])[] | undefined) ?? []).flatMap((fn) => fn());
    const robots = (): RawResult => ({ __raw: true, status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' }, body: robotsTxt(extra()) });
    const favicon = (): RawResult => {
      for (const name of ICONS) {
        const file = join(app.config.webDir, name);
        if (existsSync(file)) return { __raw: true, status: 200, headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' }, body: readFileSync(file) };
      }
      return { __raw: true, status: 204, headers: { 'cache-control': 'public, max-age=3600' }, body: '' };
    };
    for (const method of ['GET', 'HEAD']) {
      app.router.add(method, '/robots.txt', 'public', robots);
      app.router.add(method, '/favicon.ico', 'public', favicon);
    }
  },
};
