import type { App, Module } from '../core/app.js';
import { templatePass } from '../core/template.js';
import { applyConditions } from '../services/template-conditions.js';

/**
 * Bedingte Inhalte: `{{#if contact.tags has "VIP"}}…{{else}}…{{/if}}` in every e-mail, SMS, workflow message and document that goes
 * through the merge fields – docs/email-marketing.md#conditional-content. The parser lives in services/template-conditions.ts.
 */
let installed = false;
export const templateConditionsModule: Module = {
  name: 'template-conditions',
  register(app: App) {
    // One pass per process (the template engine is shared by every app instance, like its namespaces).
    if (!installed) {
      templatePass((tpl, data) => {
        try {
          return applyConditions(tpl, data);
        } catch {
          return tpl;
        }
      });
      installed = true;
    }
    app.services.templateConditions = { apply: applyConditions };
  },
};
