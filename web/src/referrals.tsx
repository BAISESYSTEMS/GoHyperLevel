import { useEffect, useState } from 'react';
import { api } from './api';
import { useT } from './i18n';

/**
 * „Konto anlegen ↗“ next to every provider key field. The links come from /api/referrals (server/modules/referrals.ts)
 * and always point at /go/<id>, which counts the click and forwards to the provider – a partner link when one is
 * configured (labelled „Partner-Link“), otherwise the plain sign-up page. Admins manage them under Agentur → Partner-Links.
 *
 * Usage: <SignupLink id="kie" /> – unknown ids (or providers without a link) render nothing, so it is safe to pass
 * ids that come from data (e.g. a provider key).
 */

export interface ReferralLink {
  name: string;
  /** Always the counting redirect /go/<id>. */
  url: string;
  is_referral: boolean;
  /** Whose partner link: the HyperLevel maintainer's default or one this installation's operator set. */
  sponsor?: 'gohigh' | 'operator';
}
export type Referrals = Record<string, ReferralLink>;

let cache: Referrals | null = null;
let pending: Promise<Referrals> | null = null;
const listeners = new Set<(r: Referrals) => void>();

function load(force = false): Promise<Referrals> {
  if (!pending || force) {
    pending = api
      .get<Referrals>('/api/referrals')
      .then((r) => {
        cache = r;
        for (const l of listeners) l(r);
        return r;
      })
      .catch(() => {
        pending = null;
        return cache ?? {};
      });
  }
  return pending;
}

/** Reload after the agency changed its partner links. */
export const refreshReferrals = () => load(true);

/** All sign-up links, loaded once per page load and shared by every <SignupLink>. */
export function useReferrals(): Referrals | null {
  const [data, setData] = useState<Referrals | null>(cache);
  useEffect(() => {
    listeners.add(setData);
    if (cache) setData(cache);
    else void load();
    return () => void listeners.delete(setData);
  }, []);
  return data;
}

/** Other spellings the app uses for the same provider (settings keys, catalogue keys). */
const ALIAS: Record<string, string> = {
  ses: 'aws_ses',
  amazon_ses: 'aws_ses',
  messagebird: 'bird',
  seven_io: 'seven',
  claude: 'anthropic',
  google_sheets: 'google_workspace',
};
export const referralId = (id: string) => {
  const k = id.replace(/^connector_/, '');
  return ALIAS[k] ?? k;
};

// German texts (message ids of the core catalog), shown through t()
export const PARTNER_HINT = 'Über diesen Link unterstützt du die Entwicklung von HyperLevel – für dich ändert sich nichts.';
export const OPERATOR_HINT = 'Partner-Link des Betreibers dieser Installation – für dich ändert sich nichts.';

/** The small „Partner-Link“ chip with its explanation as tooltip. */
export function PartnerChip({ sponsor }: { sponsor?: ReferralLink['sponsor'] }) {
  const t = useT('core');
  const hint = t(sponsor === 'operator' ? OPERATOR_HINT : PARTNER_HINT);
  return (
    <span className="partner-chip" title={hint} aria-label={t('Partner-Link: {hint}', { hint })} tabIndex={0}>
      {t('Partner-Link')}
    </span>
  );
}

export function SignupLink({ id, label }: { id: string; label?: string }) {
  const t = useT('core');
  const refs = useReferrals();
  const link = refs?.[referralId(id)];
  if (!link) return null;
  return (
    <span className="signup-link">
      {/* "sponsored": /go/ may forward to a partner link; it is counted, never personalised. */}
      <a href={link.url} target="_blank" rel="noopener sponsored" title={t('Konto bei {name} anlegen', { name: link.name })}>
        {label ?? t('Konto anlegen')} ↗
      </a>
      {link.is_referral && <PartnerChip sponsor={link.sponsor} />}
    </span>
  );
}
