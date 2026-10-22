import type { Module } from '../core/app.js';
import { buildOpenApi, renderDocsHtml } from '../services/openapi.js';
import { getBranding } from './agency.js';

/**
 * Public API description: /api/openapi.json (OpenAPI 3.1) and a reference page rendered by us
 * at /api/docs.html (no CDN, no script). `/api/docs` itself is the project-documents API.
 */
export const openApiModule: Module = {
  name: 'openapi',
  register(app) {
    const brand = () => getBranding(app).name || 'HyperLevel';
    app.router.get('/api/openapi.json', 'public', () => ({
      __raw: true,
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' },
      body: JSON.stringify(buildOpenApi(app.baseUrl()), null, 2),
    }));
    app.router.get('/api/docs.html', 'public', () => ({
      __raw: true,
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=300',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'x-frame-options': 'DENY',
      },
      body: renderDocsHtml(buildOpenApi(app.baseUrl()), brand()),
    }));
  },
};
