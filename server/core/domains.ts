import { bad } from './http.js';

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** "https://WWW.Example.de/x" -> "www.example.de"; throws on anything that isn't a hostname. */
export function normalizeDomain(v: unknown): string {
  const d = String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
  if (d && !DOMAIN_RE.test(d)) throw bad('Ungültige Domain');
  return d;
}

/** The other half of a www pair: example.com <-> www.example.com (none for deeper subdomains). */
export function domainAlias(d: string): string | undefined {
  if (d.startsWith('www.')) return d.slice(4);
  return d.split('.').length === 2 ? `www.${d}` : undefined;
}
