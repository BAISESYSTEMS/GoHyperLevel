import type { Module } from '../core/app.js';
import { HttpError, text } from '../core/http.js';
import { domainAlias, normalizeDomain } from '../core/domains.js';

/**
 * Caddy on-demand TLS "ask" endpoint: GET /api/tls/ask?domain=shop.example.com answers 200 when the
 * domain (or its www partner) belongs to this install – the app's own address, a funnel/website domain
 * or an agency/client login domain – and 404 otherwise, so Caddy only requests certificates for
 * domains HyperLevel actually serves (deploy/caddy/Caddyfile). Works for any proxy with the same idea.
 */
export function knownDomain(domain: string, own: string, wanted: { domain: string; alias?: string }[]): boolean {
  if (!domain) return false;
  if (domain === own) return true;
  return wanted.some((w) => w.domain === domain || w.alias === domain || domainAlias(w.domain) === domain);
}

export const tlsAskModule: Module = {
  name: 'tls-ask',
  register(app) {
    app.router.get('/api/tls/ask', 'public', (ctx) => {
      let domain = '';
      try {
        domain = normalizeDomain(ctx.query.get('domain'));
      } catch {
        throw new HttpError(400, 'Ungültige Domain');
      }
      const own = new URL(app.config.baseUrl).hostname;
      const wanted: { domain: string; alias?: string }[] = app.services.wantedDomains?.() ?? [];
      if (!knownDomain(domain, own, wanted)) throw new HttpError(404, 'Unbekannte Domain');
      return text('ok');
    });
  },
};
