import { createHmac } from 'node:crypto';

/**
 * Pure helpers of the cloud site rules (modules/cloud-sites.ts, docs/cloud.md#customer-sites-their-own-origin-and-verified-domains):
 * the separate sites domain, and the TXT record that proves a customer owns the custom domain of a site.
 */

/** PGHL_CLOUD_SITES_DOMAIN: a registrable domain of its own (not under the login domain), e.g. `example-sites.net`. */
export function sitesDomain(env: NodeJS.ProcessEnv = process.env): string {
  const d = String(env.PGHL_CLOUD_SITES_DOMAIN ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '').replace(/\.$/, '');
  return /^(?=.{4,200}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(d) ? d : '';
}

/** `shop.example-sites.net` → `shop` (one label only); undefined for any other host. */
export function slugOfSitesHost(host: string, domain: string): string | undefined {
  if (!domain || !host.endsWith(`.${domain}`)) return undefined;
  const label = host.slice(0, -domain.length - 1);
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label) ? label : undefined;
}

/** Funnel slugs may hold characters a host name cannot: those sites only get a sites-domain address once the slug fits. */
export const hostSafeSlug = (slug: string) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(slug);

export const VERIFY_LABEL = '_pghl-verify';
/** The TXT value that proves `domain` is meant for this sub-account: derived from the instance secret, nothing to store or leak. */
export const verifyToken = (secret: string, locationId: string, domain: string) => `pghl-verify=${createHmac('sha256', secret).update(`site-domain:${locationId}:${domain}`).digest('hex').slice(0, 32)}`;
export const verifyRecordName = (domain: string) => `${VERIFY_LABEL}.${domain}`;

/** TXT answers come as arrays of chunks per record. */
export const txtHas = (records: string[][], want: string) => records.some((chunks) => chunks.join('').trim() === want);
