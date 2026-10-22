import type { Module } from '../core/app.js';
import { APP_NAME, APP_VERSION } from '../version.js';

/**
 * GET /api/version – public: product name and version (package.json), plus the demo-mode details the
 * login page and the banner need. Monitoring and the setup docs use it to check a deploy.
 */
export const versionModule: Module = {
  name: 'version',
  register(app) {
    app.router.get('/api/version', 'public', () => ({
      name: APP_NAME,
      version: APP_VERSION,
      node: process.versions.node,
      demo: app.services.demo?.info?.() ?? null,
      cloud: app.services.cloud?.info?.() ?? null,
      setup_required: !app.db.get('SELECT id FROM users LIMIT 1'),
    }));
  },
};
