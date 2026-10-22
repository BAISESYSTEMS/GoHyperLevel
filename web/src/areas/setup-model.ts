/**
 * "Was muss ich einrichten?" – the short checklist at the top of Einstellungen in the Einfach-Modus (pure – shared by
 * web/src/areas/SetupChecklist.tsx and tests/easy-settings.test.ts). It lists only what is still missing, each step with
 * the settings section that fixes it. A fact that could not be loaded (undefined/null) never produces a step – the list
 * must not nag about something it does not know.
 */

export interface SetupFacts {
  goals: readonly string[];
  admin: boolean;
  /** GET /api/location */
  location?: { name?: string | null; email?: string | null; address?: string | null; settings?: { email?: { provider?: string } | null } | null } | null;
  /** A text model is connected (GET /api/ai-connections → routing.effective.agent/text). */
  ai?: boolean | null;
  /** GET /api/invoice-settings → settings */
  invoice?: { street?: string | null; city?: string | null; tax_number?: string | null; vat_id?: string | null } | null;
  /** Some payment provider (Stripe, PayPal, Mollie) is ready (GET /api/pay/providers). */
  payments?: boolean | null;
  /** The signed-in person uses two-factor login (GET /api/me/2fa). */
  twoFactor?: boolean | null;
}

export type SetupKey = 'company' | 'email' | 'ai' | 'invoice' | 'payments' | 'twofactor';

export interface SetupStep {
  key: SetupKey;
  /** The settings section that fixes it (route below /app). */
  to: string;
  done: boolean;
}

const filled = (v: unknown) => typeof v === 'string' && v.trim() !== '';
const sells = (goals: readonly string[]) => goals.includes('office') || goals.includes('courses');

/** Every step that applies to this login, done or not, in the order they should be tackled. */
export function setupSteps(f: SetupFacts): SetupStep[] {
  const out: SetupStep[] = [];
  const loc = f.location;
  if (loc) {
    out.push({ key: 'company', to: 'settings/company', done: filled(loc.name) && filled(loc.email) && filled(loc.address) });
    const provider = loc.settings?.email?.provider;
    out.push({ key: 'email', to: 'settings/messaging', done: !!provider && provider !== 'log' });
  }
  if (typeof f.ai === 'boolean') out.push({ key: 'ai', to: 'settings/ai-providers', done: f.ai });
  if (sells(f.goals) && f.invoice) out.push({ key: 'invoice', to: 'settings/billing', done: filled(f.invoice.street) && filled(f.invoice.city) && (filled(f.invoice.tax_number) || filled(f.invoice.vat_id)) });
  if (sells(f.goals) && typeof f.payments === 'boolean') out.push({ key: 'payments', to: 'settings/stripe', done: f.payments });
  if (f.admin && typeof f.twoFactor === 'boolean') out.push({ key: 'twofactor', to: 'settings/account', done: f.twoFactor });
  return out;
}

/** Only the open steps – what the checklist shows (empty = nothing to do, the card disappears). */
export const missingSetup = (f: SetupFacts): SetupStep[] => setupSteps(f).filter((s) => !s.done);
