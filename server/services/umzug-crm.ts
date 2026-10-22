import type { Consent, ConsentProof, RActivity, RPipeline, RStage } from './umzug-core.js';

/**
 * What the CRM importers (Salesforce, Zoho CRM, and the later ones) have in common: how a CRM treats consent, and how a deal's stage
 * becomes a status. A CRM knows an opt-out flag but no opt-in – so a contact that has not opted out is NOT recorded as consenting:
 * the ledger says "no advertising consent carried over" (service mails work, newsletters wait for a new opt-in).
 */

export function crmConsent(label: string, optOut: unknown, extra: { channel?: 'email' } = {}): { consent: Consent; native?: string; proof: ConsentProof[] } {
  const out = optOut === true || /^(true|1|yes|ja)$/i.test(String(optOut ?? ''));
  if (out) return { consent: 'unsubscribed', native: 'Opt-out', proof: [{ basis: 'revoked', reason: `${label}: Opt-out für E-Mails gesetzt`, ...extra }] };
  return { consent: 'unknown', proof: [{ basis: 'none', method: `${label}-Kontakt (das CRM kennt nur ein Opt-out, keine Werbeeinwilligung)`, ...extra }] };
}

/** Won / lost / open from the CRM's flags, else from the stage's name ("Closed Won", "Gewonnen" …). */
export function dealStatus(flags: { closed?: unknown; won?: unknown }, stageName: string): 'open' | 'won' | 'lost' {
  const closed = flags.closed === true || flags.closed === 'true';
  const won = flags.won === true || flags.won === 'true';
  if (closed) return won ? 'won' : 'lost';
  if (/closed won|gewonnen|\bwon\b/i.test(stageName)) return 'won';
  if (/closed lost|verloren|\blost\b/i.test(stageName)) return 'lost';
  return 'open';
}

/** A pipeline from the stages the CRM configures, plus stages that only deals mention (kept in the order they were seen, at the end). */
export function pipelineOf(ext: string, name: string, stages: RStage[], seen: Iterable<string> = []): RPipeline {
  const have = new Set(stages.map((s) => s.name));
  const extra: RStage[] = [];
  for (const n of seen) if (n && !have.has(n)) (have.add(n), extra.push({ ext: `st:${n}`, name: n }));
  return { kind: 'pipeline', ext, name, stages: [...stages, ...extra] };
}

/**
 * A document of the old accounting tool (invoice, credit note, quotation …) as an entry in the contact's history: number, date, amount and
 * status as the old tool had them. It is read-only history – NOT an invoice of HyperLevel: it takes no number of the invoice ranges, is not
 * frozen, archived or sent, and changes nothing in the bookkeeping. The original (with its PDF) stays in the old tool.
 */
export function documentActivity(o: { vendor: string; ext: string; contact: string; label: string; number?: string; date?: string; due?: string; status?: string; total?: number; open?: number; currency?: string; link?: string; contactName?: string }): RActivity {
  const money = (n: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: /^[A-Z]{3}$/.test(o.currency ?? '') ? o.currency! : 'EUR' }).format(n);
  const parts = [`${o.label}${o.number ? ` ${o.number}` : ''}`, o.total !== undefined && Number.isFinite(o.total) ? money(o.total) : '', o.status ?? '', `aus ${o.vendor}`].filter(Boolean);
  return {
    kind: 'activity',
    ext: o.ext,
    contact: o.contact,
    type: 'document.imported',
    summary: parts.join(' · ').slice(0, 300),
    data: { source: o.vendor, document: o.label, number: o.number ?? '', date: o.date ?? '', due: o.due ?? '', status: o.status ?? '', total: o.total ?? null, open: o.open ?? null, currency: o.currency ?? 'EUR', link: o.link ?? '', note: 'Nur zur Ansicht übernommen – das Original liegt beim alten Anbieter; keine Rechnung dieses Systems' },
    at: o.date,
  };
}
