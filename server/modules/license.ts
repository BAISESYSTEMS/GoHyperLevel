import type { Module } from '../core/app.js';
import type { LicenseService } from '../services/werkstatt/license.js';

/**
 * License check stub. A few Werkstatt/Marktplatz features are marked Pro and ask `app.services.license.has('pro')`
 * (see services/werkstatt/license.ts). There is no license system yet, so the stub says yes to everything – a
 * future license module only has to assign its own `app.services.license` (registered earlier or later, the one
 * that is set when a request arrives counts). Self-hosters change nothing.
 */
export const licenseModule: Module = {
  name: 'license',
  register(app) {
    const stub: LicenseService = { has: () => true, stub: true };
    app.services.license ??= stub;
  },
};
