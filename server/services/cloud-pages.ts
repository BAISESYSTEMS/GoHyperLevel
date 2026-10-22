import { escapeHtml as h } from '../core/template.js';
import { PERMISSIONS } from '../core/permissions.js';
import { FAIR_USE_LABEL, METRICS, PLAN_KEYS, type FairUse, type PlanKey } from './cloud.js';
import { LEGAL_TITLE, type LegalDoc } from './cloud-legal.js';
import { WAITLIST_ANCHOR, waitlistFormHtml, wlText, type WaitlistView, type WlClasses } from './cloud-waitlist.js';

/**
 * The public pages of the hosted service, server-rendered without any script, cookie, font or tracker:
 * pricing (/cloud), signup (/start) and the small message and legal pages. Light and dark follow the visitor's
 * system; the interval switch is CSS only. Everything the operator can set (brand, colour, links) arrives as data.
 * In waitlist mode (`PricingData.waitlist`, services/cloud-waitlist.ts) the plans are marked as planned, every buy or trial
 * button becomes "Auf die Warteliste", and /start is the waitlist page (`waitlistPage`, German or English).
 */

export interface PageBrand {
  name: string;
  logo_url: string;
  color: string;
}
export interface PageCtx {
  brand: PageBrand;
  status_url: string;
  docs_url: string;
  support_email: string;
  legal: { doc: LegalDoc; version: number }[];
}
export interface PlanCard {
  key: PlanKey;
  name: string;
  tagline: string;
  price_month_cents: number;
  price_year_cents: number;
  users: number | null;
  highlights: string[];
  fair_use: FairUse;
}

const eur = (cents: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(cents / 100);
const num = (n: number) => n.toLocaleString('de-DE');
const vat = (note: string) => (note === 'net' ? 'zzgl. USt.' : note === 'gross' ? 'inkl. USt.' : '');

export const CSS = `
:root{color-scheme:light dark;--brand:#2563eb;--bg:#f6f7fb;--card:#ffffff;--text:#0f172a;--muted:#566075;--line:#e2e6ee;--soft:#eef3ff;--ok:#047857;--okbg:#d1fae5;--err:#991b1b;--errbg:#fef2f2;--shadow:0 10px 30px rgba(15,23,42,.07)}
@media(prefers-color-scheme:dark){:root{--bg:#0a0e16;--card:#121a27;--text:#e9edf5;--muted:#9aa5ba;--line:#243247;--soft:#16233a;--ok:#6ee7b7;--okbg:#0d3a2c;--err:#fecaca;--errbg:#3b1416;--shadow:0 10px 30px rgba(0,0,0,.35)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--brand)}
.wrap{max-width:1160px;margin:0 auto;padding:0 20px}
.top{display:flex;align-items:center;gap:18px;padding:18px 0;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:19px;color:var(--text);text-decoration:none}
.brand img{max-height:38px;max-width:170px}
.brand .dot{width:34px;height:34px;border-radius:10px;background:var(--brand);color:#fff;display:grid;place-items:center;font-size:17px}
.nav{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}
.nav a{padding:12px 14px;border-radius:10px;text-decoration:none;color:var(--muted);font-weight:600;min-height:44px;display:inline-flex;align-items:center}
.nav a:hover,.nav a:focus-visible{background:var(--soft);color:var(--text)}
.hero{padding:44px 0 20px;max-width:880px}
.hero h1{font-size:clamp(30px,5vw,52px);line-height:1.08;letter-spacing:-.025em;margin:0 0 14px}
.hero p{font-size:clamp(17px,2vw,20px);color:var(--muted);margin:0 0 22px;max-width:720px}
.chips{display:flex;flex-wrap:wrap;gap:8px;padding:0;margin:0;list-style:none}
.chips li{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:7px 14px;font-weight:600;font-size:14px}
.chips li::before{content:"✓ ";color:var(--ok)}
.chipnote{color:var(--muted);font-size:14px;margin:10px 0 0}
.taxnote{color:var(--muted);font-size:14px;margin:16px 0 0;max-width:860px}
.wlgrid{list-style:none;padding:0;margin:0 0 14px;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:12px}
.wlgrid li{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px}
section.block>p.lead.small{font-size:14px}
.choose{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))}
.choose h3{margin:0 0 12px;font-size:22px}
.ticks{list-style:none;padding:0;margin:0 0 16px;display:grid;gap:8px}
.ticks li{padding-left:26px;position:relative}
.ticks li::before{content:"✓";position:absolute;left:0;color:var(--ok);font-weight:800}
.verdict{margin:0;padding:12px 14px;border-radius:12px;background:var(--soft);font-weight:700}
.toggle{display:inline-flex;background:var(--card);border:1px solid var(--line);border-radius:999px;padding:4px;margin:26px 0 18px}
.toggle label{position:relative;margin:0;font-weight:600;font-size:15px;padding:10px 16px;white-space:nowrap;border-radius:999px;cursor:pointer;display:flex;gap:8px;align-items:center;min-height:44px}
.vh,.plan input{position:absolute;opacity:0;width:1px;height:1px;margin:0}
.pricing:has(#iv-month:checked) .toggle label[for=iv-month],.pricing:has(#iv-year:checked) .toggle label[for=iv-year]{background:var(--brand);color:#fff}
.pricing:has(#iv-month:focus-visible) .toggle label[for=iv-month],.pricing:has(#iv-year:focus-visible) .toggle label[for=iv-year]{outline:3px solid var(--text);outline-offset:2px}
.save{font-size:12px;font-weight:700;color:var(--ok);background:var(--okbg);border-radius:999px;padding:2px 9px;white-space:nowrap}
.pricing:has(#iv-month:checked) .toggle label[for=iv-month] .save,.pricing:has(#iv-year:checked) .toggle label[for=iv-year] .save{background:rgba(255,255,255,.25);color:#fff}
.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:18px;align-items:stretch}
.pcard{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:26px;display:flex;flex-direction:column;box-shadow:var(--shadow);position:relative}
.pcard.pop{border:2px solid var(--brand)}
.pcard .tag{position:absolute;top:-13px;left:24px;background:var(--brand);color:#fff;font-size:12px;font-weight:700;padding:4px 12px;border-radius:999px}
.pcard h2{margin:0;font-size:22px}
.pcard .tagline{color:var(--muted);margin:6px 0 16px;min-height:48px}
.price{font-size:44px;font-weight:800;letter-spacing:-.03em;line-height:1}
.price small{font-size:16px;font-weight:600;color:var(--muted);letter-spacing:0}
.priceNote{color:var(--muted);font-size:13px;min-height:20px;margin:6px 0 18px}
.pcard ul{list-style:none;padding:0;margin:0 0 22px;flex:1}
.pcard li{padding:6px 0 6px 26px;position:relative}
.pcard li::before{content:"✓";position:absolute;left:0;color:var(--ok);font-weight:800}
.p-year{display:none}
.pricing:has(#iv-year:checked) .p-year{display:block}
.pricing:has(#iv-year:checked) .p-month{display:none}
.btn,button.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--brand);color:#fff;border:0;border-radius:12px;padding:14px 22px;font:inherit;font-weight:700;text-decoration:none;cursor:pointer;min-height:48px;text-align:center}
.btn:hover{filter:brightness(1.08)}
.btn:focus-visible{outline:3px solid var(--brand);outline-offset:3px}
.btn.ghost{background:var(--card);color:var(--text);border:1px solid var(--line)}
.btn.wide{width:100%}
.trialnote{color:var(--muted);font-size:13px;text-align:center;margin:10px 0 0}
section.block{margin:56px 0}
section.block h2{font-size:clamp(24px,3vw,32px);letter-spacing:-.02em;margin:0 0 8px}
section.block>p.lead{color:var(--muted);margin:0 0 20px;max-width:760px}
.selfhost{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:26px;display:flex;gap:22px;align-items:center;flex-wrap:wrap;justify-content:space-between}
.selfhost h2{margin:0 0 4px}
.selfhost p{margin:0;color:var(--muted);max-width:620px}
.areas{display:flex;flex-wrap:wrap;gap:8px}
.areas span{background:var(--soft);border-radius:999px;padding:6px 13px;font-size:14px;font-weight:600}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:16px;background:var(--card)}
table.fair{width:100%;border-collapse:collapse;min-width:560px}
.fair th,.fair td{padding:14px 16px;text-align:left;border-bottom:1px solid var(--line)}
.fair tr:last-child td{border-bottom:0}
.fair th{font-size:14px;color:var(--muted);font-weight:700}
.faq details{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:4px 18px;margin:0 0 10px}
.faq summary{cursor:pointer;font-weight:700;padding:14px 0;min-height:44px}
.faq p{margin:0 0 14px;color:var(--muted)}
.foot{border-top:1px solid var(--line);margin-top:64px;padding:26px 0 44px;color:var(--muted);font-size:14px;display:flex;gap:10px 22px;flex-wrap:wrap}
.foot a{color:var(--muted);padding:10px 0;display:inline-block;min-height:44px}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px;box-shadow:var(--shadow)}
.signup{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:26px;align-items:start;margin-top:16px}
.signup h1{font-size:clamp(28px,4vw,40px);letter-spacing:-.02em;margin:26px 0 8px}
.mini{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr));gap:12px;margin:18px 0}
.mini label.plan{position:relative;margin:0;cursor:pointer;display:block}
.mini .pb{display:block;border:2px solid var(--line);border-radius:16px;padding:16px;background:var(--card);height:100%}
.mini input:checked+.pb{border-color:var(--brand);box-shadow:0 0 0 3px var(--soft)}
.mini input:focus-visible+.pb{outline:3px solid var(--brand);outline-offset:2px}
.mini .pb strong{display:block;font-size:17px}
.mini .pb .pr{display:block;font-size:26px;font-weight:800;margin-top:6px;line-height:1.2}
.mini .pb small{color:var(--muted);display:block;font-size:13px}
.mini .pb .pr small{display:inline;font-size:14px;font-weight:600}
.mini .pb .pr .p-month,.mini .pb .pr .p-year{display:inline}
.mini .pb small.p-year{display:none}
.pricing:has(#iv-year:checked) .mini .pb small.p-year{display:block}
.pricing:has(#iv-year:checked) .mini .pb .pr .p-month,.pricing:not(:has(#iv-year:checked)) .mini .pb .pr .p-year{display:none}
label.f{display:block;font-weight:600;font-size:14px;margin:16px 0 6px}
input.in,select.in{width:100%;padding:13px 14px;border:1px solid var(--line);border-radius:12px;font:inherit;background:var(--bg);color:var(--text);min-height:48px}
input.in:focus{outline:3px solid var(--brand);outline-offset:0;border-color:transparent}
.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.chk{display:flex;gap:12px;align-items:flex-start;font-weight:400;font-size:15px;margin:12px 0}
.chk input{width:22px;height:22px;margin-top:2px;flex:none;accent-color:var(--brand)}
.alert{background:var(--errbg);color:var(--err);border-radius:12px;padding:13px 16px;margin:16px 0}
.okbox{background:var(--okbg);color:var(--ok);border-radius:12px;padding:13px 16px;margin:16px 0}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.or{display:flex;align-items:center;gap:12px;color:var(--muted);margin:18px 0;font-size:14px}
.or::before,.or::after{content:"";flex:1;border-top:1px solid var(--line)}
.side h3{margin:0 0 10px}
.side ol{padding-left:20px;margin:0;color:var(--muted)}
.side li{margin:7px 0}
.msg{max-width:620px;margin:56px auto}
.msg h1{font-size:28px;margin:0 0 10px}
.msg p{color:var(--muted)}
.legal{max-width:820px;margin:20px auto;overflow-wrap:anywhere;hyphens:auto}
.legal h1{font-size:clamp(24px,7vw,34px);line-height:1.15}
.legal h2{font-size:20px;margin:26px 0 8px}
.legal blockquote{background:var(--soft);border-left:4px solid var(--brand);margin:0 0 18px;padding:2px 16px;border-radius:8px}
.legal .meta{color:var(--muted);font-size:14px}
details.coupon summary{cursor:pointer;color:var(--brand);font-weight:600;padding:10px 0;min-height:44px}
.skip{position:absolute;left:12px;top:-60px;background:var(--card);color:var(--text);padding:10px 14px;border-radius:10px;font-weight:600;z-index:10}
.skip:focus{top:12px}
.soonbox{background:var(--soft);border:1px solid var(--line);border-left:4px solid var(--brand);border-radius:12px;padding:12px 16px;margin:0 0 22px;max-width:760px}
.ctas{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 22px}
.pcard .tag.soon,.soonchip{background:var(--okbg);color:var(--ok)}
.soonchip{display:inline-block;font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px;margin:0 0 8px}
.planned{color:var(--muted);font-size:13px;font-weight:600;margin:0 0 4px}
.wlpage h1{font-size:clamp(28px,4vw,40px);letter-spacing:-.02em;margin:26px 0 8px}
.wlpage>p.lead{color:var(--muted);max-width:760px;margin:0 0 8px}
.wlf h2,.card>h2{margin:0 0 6px;font-size:22px}
.side .btn{margin-top:4px}
@media(max-width:820px){.signup{grid-template-columns:1fr}.two{grid-template-columns:1fr}.nav{margin-left:0}}
@media(min-width:1700px){.wrap{max-width:1500px}.plans{gap:26px}}
`;

function shell(c: PageCtx, o: { title: string; body: string; description?: string; nav?: boolean; lang?: 'de' | 'en' }): string {
  const en = o.lang === 'en';
  const color = /^#[0-9a-f]{6}$/i.test(c.brand.color) ? c.brand.color : '#2563eb';
  const mark = c.brand.logo_url ? `<img src="${h(c.brand.logo_url)}" alt="${h(c.brand.name)}">` : `<span class="dot" aria-hidden="true">${h(c.brand.name.slice(0, 1).toUpperCase())}</span><span>${h(c.brand.name)}</span>`;
  const legal = c.legal.map((l) => `<a href="/cloud/legal/${l.doc}">${h(LEGAL_TITLE[l.doc].replace(/ \(.*$/, ''))}</a>`);
  return `<!doctype html>
<html lang="${en ? 'en' : 'de'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${h(o.title)} – ${h(c.brand.name)}</title>
${o.description ? `<meta name="description" content="${h(o.description)}">` : ''}
<style>:root{--brand:${color}}${CSS}</style>
</head>
<body>
<a class="skip" href="#inhalt">${en ? 'Skip to content' : 'Zum Inhalt springen'}</a>
<div class="wrap">
<header class="top"><a class="brand" href="/cloud">${mark}</a>${
    o.nav === false
      ? ''
      : `<nav class="nav" aria-label="${en ? 'Main menu' : 'Hauptmenü'}"><a href="/cloud">${en ? 'Pricing' : 'Preise'}</a>${c.docs_url ? `<a href="${h(c.docs_url)}" rel="noopener">${en ? 'Self-host' : 'Selbst hosten'}</a>` : ''}<a href="/app">${en ? 'Sign in' : 'Anmelden'}</a></nav>`
  }</header>
${o.body.replace('<main', '<main id="inhalt"')}
<footer class="foot"><span>© ${new Date().getFullYear()} ${h(c.brand.name)}</span>${legal.join('')}<a href="/abuse">${en ? 'Report abuse' : 'Missbrauch melden'}</a>${c.status_url ? `<a href="${h(c.status_url)}" rel="noopener">Status</a>` : ''}${c.support_email ? `<a href="mailto:${h(c.support_email)}">${h(c.support_email)}</a>` : ''}</footer>
</div>
</body>
</html>`;
}

export const CSP = "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; form-action 'self' https://checkout.stripe.com https://accounts.google.com; base-uri 'none'; frame-ancestors 'none'";

// --- pricing -------------------------------------------------------------------------------------------------------

export interface PricingData {
  plans: PlanCard[];
  trial_days: number;
  card_required: boolean;
  yearly_discount_percent: number;
  price_note: string;
  signup_open: boolean;
  agency_max_clients: number;
  /** Stripe Tax computes the VAT at checkout (said under the prices when they are net). */
  stripe_tax?: boolean;
  /** Hosting provider and location from the operator's details (named in "Cloud oder selbst hosten?" when set). */
  hosting?: string;
  /** Only businesses may sign up (the form asks for a VAT ID or the confirmation). */
  b2b_only?: boolean;
  /** Waitlist mode: nothing can be ordered; the page shows planned prices and the waitlist form (services/cloud-waitlist.ts). */
  waitlist?: WaitlistView;
}

/** The waitlist form in the look of these pages. */
const WL_CLASSES: WlClasses = { form: 'wlf', row: 'two', label: 'f', input: 'in', check: 'chk', button: 'btn wide', note: 'trialnote', ok: 'okbox', err: 'alert', hp: 'hp' };

const tick = (items: string[]) => `<ul class="ticks">${items.map((x) => `<li>${h(x)}</li>`).join('')}</ul>`;

/** Cloud or self-hosted: the same software, the difference is who runs the server – a fair two-column comparison. */
function chooseBlock(d: PricingData, docsUrl: string): string {
  if (d.waitlist) return chooseWaitlist(d, docsUrl);
  const cloud = tick([
    'In wenigen Minuten startklar – ohne Server, Docker oder Linux-Kenntnisse.',
    'Updates und Sicherheits-Patches spielen wir ein.',
    'Tägliche Server-Backups; deinen Datenexport (ZIP) machst du jederzeit selbst.',
    'TLS-Zertifikate und Betrieb übernehmen wir; eigene Domains im Tarif Cloud Agentur.',
    `${d.hosting ? `Gehostet bei ${d.hosting}. ` : ''}Den Auftragsverarbeitungsvertrag (AVV) schließt du bei der Anmeldung ab und lädst ihn als PDF.`,
    'Keine Grenzen für Kontakte, Funnels und Workflows (Fair Use für E-Mails, KI und Speicher).',
    'Tarif Cloud Agentur: White-Label und Kunden-Sub-Accounts.',
  ]);
  const self = tick([
    'Volle Kontrolle: dein Server, deine Daten, deine Regeln.',
    '0 € ohne Grenzen, mit dem ganzen Quellcode (AGPL) – anpassbar bis ins Letzte.',
    'Inklusive SaaS-Modus: Sub-Accounts mit eigenen Tarifen über dein Stripe verkaufen.',
    'Updates, Backups, Sicherheit, TLS und E-Mail-Zustellbarkeit liegen bei dir – mit Anleitungen.',
    'Hilfe aus der Community.',
  ]);
  return `<section class="block" aria-labelledby="choose-h"><h2 id="choose-h">Cloud oder selbst hosten?</h2><p class="lead">Dieselbe Software, alle Funktionen. Der Unterschied ist, wer den Server betreibt.</p>
<div class="choose"><div class="card"><h3>Cloud</h3>${cloud}<p class="verdict">Für alle, die arbeiten wollen statt Server zu pflegen.</p></div>
<div class="card"><h3>Selbst hosten · 0 €</h3>${self}<p class="verdict">Für alle, die ihren Server selbst betreiben wollen – oder müssen.${docsUrl ? ` <a href="${h(docsUrl)}" rel="noopener">Zur Anleitung</a>` : ''}</p></div></div>
<p class="lead small">Wechseln: Aus der Cloud exportierst du jederzeit alles als ZIP (JSON, CSV und Dateien); Kontakte liest der CSV-Import wieder ein. Einen kompletten Umzug zwischen Cloud und eigenem Server auf Knopfdruck gibt es noch nicht.</p></section>`;
}

/** The same comparison while the cloud is not open: self-hosting first (it works today), the cloud as planned. */
function chooseWaitlist(d: PricingData, docsUrl: string): string {
  const self = tick([
    'Volle Kontrolle: dein Server, deine Daten, deine Regeln.',
    '0 € ohne Grenzen, mit dem ganzen Quellcode (AGPL) – anpassbar bis ins Letzte.',
    'Inklusive SaaS-Modus: Sub-Accounts mit eigenen Tarifen über dein Stripe verkaufen.',
    'Updates, Backups, Sicherheit, TLS und E-Mail-Zustellbarkeit liegen bei dir – mit Anleitungen.',
    'Hilfe aus der Community.',
  ]);
  const cloud = tick([
    'Startklar ohne Server, Docker oder Linux-Kenntnisse.',
    'Updates, Sicherheits-Patches, Server-Backups und TLS-Zertifikate übernimmt der Betrieb.',
    `${d.hosting ? `Geplanter Standort: ${d.hosting}. ` : ''}Mit Auftragsverarbeitungsvertrag (AVV).`,
    'Keine Grenzen für Kontakte, Funnels und Workflows (Fair Use für E-Mails, KI und Speicher).',
    'Tarif Cloud Agentur: White-Label und Kunden-Sub-Accounts.',
  ]);
  return `<section class="block" aria-labelledby="choose-h"><h2 id="choose-h">Cloud oder selbst hosten?</h2><p class="lead">Dieselbe Software, alle Funktionen. Selbst hosten geht heute schon – die Cloud ist geplant.</p>
<div class="choose"><div class="card"><h3>Selbst hosten · 0 €</h3>${self}<p class="verdict">Heute verfügbar.${docsUrl ? ` <a href="${h(docsUrl)}" rel="noopener">Zur Anleitung</a>` : ''}</p></div>
<div class="card"><span class="soonchip">Bald verfügbar</span><h3>Cloud (geplant)</h3>${cloud}<p class="verdict">Noch nicht buchbar. <a href="#${WAITLIST_ANCHOR}">Auf die Warteliste</a></p></div></div></section>`;
}

function fairRow(label: string, vals: string[]) {
  return `<tr><th scope="row">${h(label)}</th>${vals.map((v) => `<td>${v}</td>`).join('')}</tr>`;
}
const lim = (v: number | null, unit = '') => (v === null ? 'unbegrenzt' : `${num(v)}${unit}`);

export function pricingPage(c: PageCtx, d: PricingData): string {
  const wl = d.waitlist;
  const note = vat(d.price_note);
  const trial = d.trial_days > 0 ? `${d.trial_days} Tage kostenlos testen` : 'Jetzt starten';
  const trialNote = d.trial_days > 0 ? (d.card_required ? 'Zahlungsmittel nötig, erst nach der Testphase wird abgebucht.' : 'Ohne Zahlungsmittel testen.') : 'Jederzeit kündbar.';
  const cards = d.plans
    .map((p) => {
      const perMonthYear = Math.round(p.price_year_cents / 12);
      const cta = (iv: string) =>
        wl
          ? `<a class="btn ghost wide" href="/cloud?plan=${p.key}#${WAITLIST_ANCHOR}">Auf die Warteliste</a><p class="trialnote">Noch nicht buchbar – wir melden uns zum Start.</p>`
          : d.signup_open
            ? `<a class="btn wide" href="/start?plan=${p.key}&amp;interval=${iv}">${h(trial)}</a><p class="trialnote">${h(trialNote)}</p>`
            : '<p class="trialnote">Neue Anmeldungen sind gerade pausiert.</p>';
      const tag = wl ? '<span class="tag soon">Bald verfügbar</span>' : p.key === 'team' ? '<span class="tag">Beliebt</span>' : '';
      const planned = wl ? '<div class="planned">voraussichtlich</div>' : '';
      return `<article class="pcard${p.key === 'team' && !wl ? ' pop' : ''}">${tag}
<h2>${h(p.name)}</h2><p class="tagline">${h(p.tagline)}</p>
<div class="p-month">${planned}<div class="price">${eur(p.price_month_cents)}<small> / Monat</small></div><div class="priceNote">${note ? `${h(note)} · ` : ''}${wl ? 'geplanter Preis' : 'monatlich kündbar'}</div></div>
<div class="p-year">${planned}<div class="price">${eur(perMonthYear)}<small> / Monat</small></div><div class="priceNote">${eur(p.price_year_cents)} pro Jahr${note ? ` ${h(note)}` : ''}</div></div>
<ul>${p.highlights.map((x) => `<li>${h(x)}</li>`).join('')}</ul>
<div class="p-month">${cta('month')}</div><div class="p-year">${cta('year')}</div>
</article>`;
    })
    .join('');
  const rows = [
    ...METRICS.map((m) => fairRow(FAIR_USE_LABEL[m], d.plans.map((p) => (m === 'sms' && p.fair_use.sms === 0 ? 'zum Selbstkostenpreis' : lim(p.fair_use[m]))))),
    fairRow(FAIR_USE_LABEL.storage_mb, d.plans.map((p) => lim(p.fair_use.storage_mb, ' MB'))),
  ].join('');
  const areas = (Object.values(PERMISSIONS) as string[]).map((x) => `<span>${h(x.replace(/ \(.*$/, ''))}</span>`).join('');
  // The switch itself: two labels bound to the radios above (CSS only).
  const taxLine = wl
    ? `Geplante Preise${d.price_note === 'net' ? ', netto zzgl. gesetzlicher Umsatzsteuer' : d.price_note === 'gross' ? ' inklusive Umsatzsteuer' : ''}. Noch nicht buchbar – es gibt noch keine Konten und keine Zahlungen.`
    : d.price_note === 'net'
      ? `Alle Preise netto zzgl. gesetzlicher Umsatzsteuer.${d.stripe_tax ? ' Die Steuer berechnet Stripe Tax beim Bezahlen nach deinem Land; Unternehmen in der EU mit USt-IdNr. zahlen im Reverse-Charge-Verfahren.' : ''}`
      : d.price_note === 'gross'
        ? 'Alle Preise inklusive Umsatzsteuer.'
        : '';
  const toggle = `<div class="toggle" role="group" aria-label="Abrechnung"><label for="iv-month">Monatlich</label><label for="iv-year">Jährlich${d.yearly_discount_percent > 0 ? ` <span class="save">-${d.yearly_discount_percent} %</span>` : ''}</label></div>`;
  const docs = c.docs_url ? h(c.docs_url) : '';
  const heroTop = wl
    ? `<p class="soonbox"><strong>Bald verfügbar.</strong> Die gehostete Cloud ist in Vorbereitung: Konten und Zahlungen gibt es noch nicht. Die Tarife und Preise unten sind geplant.</p>`
    : '';
  const heroCtas = wl ? `<div class="ctas">${docs ? `<a class="btn" href="${docs}" rel="noopener">Kostenlos selbst hosten</a>` : ''}<a class="btn ghost" href="#${WAITLIST_ANCHOR}">Auf die Warteliste</a></div>` : '';
  const faq = wl
    ? `<section class="block faq"><h2>Häufige Fragen</h2>
<details><summary>Wann startet die Cloud?</summary><p>Wir bereiten sie gerade vor; einen festen Termin gibt es noch nicht. Wer auf der Warteliste steht, erfährt es zuerst.</p></details>
<details><summary>Was passiert mit meinem Eintrag auf der Warteliste?</summary><p>${
      wl.consentLabel
        ? 'Wir verwenden deine Angaben so, wie es die Einwilligung im Formular beschreibt.'
        : 'Wir speichern deine E-Mail-Adresse und – wenn du sie angibst – deinen Namen und Tarifwunsch, nur um dich zum Start zu informieren. Kein Newsletter, keine Werbung.'
    } Austragen kannst du dich jederzeit${c.support_email ? ` per E-Mail an ${h(c.support_email)}` : ''}.</p></details>
<details><summary>Kann ich schon heute loslegen?</summary><p>Ja – selbst gehostet, kostenlos und mit allen Funktionen. Du brauchst einen Server mit Docker und eine Domain; die Anleitung führt dich durch.</p></details>
<details><summary>Sind die Preise schon fest?</summary><p>Es sind die geplanten Preise. Bevor du etwas bezahlst, siehst du den endgültigen Preis und die Bedingungen.</p></details>
<details><summary>Was kostet jeder weitere Nutzer?</summary><p>Selbst gehostet nichts. Auch die geplanten Tarife Cloud Team &amp; Company und Cloud Agentur sollen unbegrenzt Nutzer zum gleichen Preis haben.</p></details>
</section>`
    : `<section class="block faq"><h2>Häufige Fragen</h2>
<details><summary>Gibt es eine Mindestlaufzeit?</summary><p>Nein. Du kannst jederzeit zum Ende des bezahlten Zeitraums kündigen – mit einem Klick im Konto.</p></details>
<details><summary>Was kostet jeder weitere Nutzer?</summary><p>Nichts. Cloud Team &amp; Company und Cloud Agentur haben unbegrenzt Nutzer zum gleichen Preis. Cloud Solo ist für eine Person gedacht.</p></details>
<details><summary>Kann ich meine Daten mitnehmen?</summary><p>Jederzeit: Im Konto exportierst du alles als ZIP (JSON und CSV, dazu deine Dateien). Und weil die Software Open Source ist, kannst du sie auch selbst betreiben.</p></details>
<details><summary>Wie läuft die Testphase?</summary><p>${d.trial_days > 0 ? `${d.trial_days} Tage mit allen Funktionen. ${d.card_required ? 'Du hinterlegst ein Zahlungsmittel, abgebucht wird erst nach der Testphase.' : 'Du brauchst dafür kein Zahlungsmittel; danach wählst du Tarif und Zahlungsart.'}` : 'Du startest direkt mit dem Tarif deiner Wahl.'}</p></details>
<details><summary>Wie bezahle ich?</summary><p>Über Stripe: Karte, SEPA-Lastschrift und weitere Zahlungsarten. ${d.price_note === 'net' ? 'Die Preise sind netto; die Umsatzsteuer kommt beim Bezahlen dazu. ' : ''}Rechnungen mit Umsatzsteuer findest du jederzeit im Konto; Unternehmen in der EU können ihre USt-ID angeben.</p></details>
<details><summary>Was passiert, wenn eine Zahlung scheitert?</summary><p>Du bekommst eine Nachricht und eine Kulanzzeit. Danach wird das Konto schreibgeschützt – deine Daten bleiben lesbar und exportierbar. Erst viel später werden sie nach Ankündigung gelöscht.</p></details>
</section>`;
  const waitlistBlock = wl
    ? (() => {
        const t = wlText('de', c.brand.name);
        return `<section class="block" id="${WAITLIST_ANCHOR}" aria-labelledby="wl-form-h"><div class="signup"><div class="card"><h2 id="wl-form-h">${h(t.h2)}</h2><p class="lead" style="color:var(--muted)">${h(t.lead)}</p>${waitlistFormHtml(wl, WL_CLASSES, 'cwl')}</div>
<aside class="card side"><h3>${h(t.page.sideH)}</h3><p style="color:var(--muted)">${h(t.page.side)}</p>${docs ? `<p><a class="btn ghost" href="${docs}" rel="noopener">${h(t.selfCta)}</a></p>` : ''}<p style="color:var(--muted);margin:18px 0 0">${h(t.page.login)} <a href="/app">${h(t.page.account)}</a></p></aside></div></section>`;
      })()
    : '';
  return shell(c, {
    title: wl ? 'Cloud – bald verfügbar' : 'Preise',
    description: wl
      ? 'Die gehostete Cloud ist geplant: alle Funktionen in jedem Tarif, keine Gebühr pro Nutzer. Trag dich auf die Warteliste ein – selbst hosten ist kostenlos.'
      : 'Alle Funktionen in jedem Tarif, keine Gebühr pro Nutzer. Solo, Team & Company und Agentur mit White-Label.',
    body: `<main class="pricing">
<input type="radio" name="iv" id="iv-month" checked class="vh" aria-label="Monatlich"><input type="radio" name="iv" id="iv-year" class="vh" aria-label="Jährlich">
<section class="hero">${heroTop}<h1>Software, die sich an dich anpasst. Nicht andersrum.</h1>
<p>CRM, Postfach, Funnels, Automationen, KI und Büro-Werkzeuge in einer Anwendung – zu einem fairen Preis pro Firma, nicht pro Platz.</p>
${heroCtas}<ul class="chips"><li>Alle Funktionen in jedem Tarif</li><li>Keine Gebühr pro Nutzer</li><li>Kein Kontakt-Limit</li><li>Datenexport jederzeit</li><li>Open Source</li></ul>
<p class="chipnote">White-Label und Kunden-Accounts nur im Tarif Cloud Agentur.</p>
${toggle}</section>
<section class="plans" aria-label="${wl ? 'Geplante Tarife' : 'Tarife'}">${cards}</section>
${taxLine ? `<p class="taxnote">${h(taxLine)}</p>` : ''}
${waitlistBlock}
<section class="block wl" aria-labelledby="wl-h"><h2 id="wl-h">White-Label im Tarif Cloud Agentur${wl ? ' (geplant)' : ''}</h2><p class="lead">${wl ? 'Deine Kunden sehen deine Marke, nicht unsere – ohne Aufpreis pro Kunde. Selbst gehostet gibt es White-Label schon heute, kostenlos.' : 'Deine Kunden sehen deine Marke, nicht unsere. Alles inklusive, ohne Aufpreis pro Kunde.'}</p>
<ul class="wlgrid"><li><strong>Dein Name, Logo und deine Farben</strong> im Login, in der App und im Browser-Tab</li><li><strong>Eigene Login-Domain</strong> für dich und <strong>eigene Domains</strong> für jeden Kunden – das Zertifikat kommt von selbst</li><li><strong>Installierbare App mit deinem Namen und Icon</strong> (Web-App für Android, iPhone und iPad); eine eigene Android-APK baust du mit der dokumentierten Anleitung selbst</li><li><strong>Kunden-Sub-Accounts</strong> für deine Kunden, getrennt voneinander, mit eigenen Logins</li></ul>
<p class="lead small">Weiterverkaufen mit eigenen Tarifen und eigenem Stripe-Konto (SaaS-Modus) gehört zum selbst gehosteten Betrieb und ist in der Cloud nicht enthalten.</p></section>
<section class="block"><div class="selfhost"><div><h2>${wl ? 'Heute schon loslegen: selbst hosten, 0 €' : 'Selbst hosten: 0 €'}</h2><p>Dieselbe Software, alle Funktionen, auf deinem eigenen Server – Open Source unter AGPL. ${wl ? 'Das geht schon heute, ohne Warteliste.' : 'Wenn du die Technik lieber selbst betreibst, bist du hier nicht verpflichtet.'}</p></div>${docs ? `<a class="btn${wl ? '' : ' ghost'}" href="${docs}" rel="noopener">${wl ? 'Kostenlos selbst hosten' : 'Zur Anleitung'}</a>` : ''}</div></section>
${chooseBlock(d, c.docs_url)}
<section class="block"><h2>Alle Funktionen in jedem Tarif</h2><p class="lead">Kein Tarif sperrt einen Bereich – einzige Ausnahme: White-Label und Kunden-Accounts gibt es nur im Tarif Cloud Agentur. Der Unterschied: Cloud Solo ist für eine Person, Cloud Team &amp; Company für beliebig viele Nutzer, Cloud Agentur kommt mit White-Label und Kunden-Accounts${d.agency_max_clients ? ` (bis ${num(d.agency_max_clients)})` : ' ohne Aufpreis'}.</p><div class="areas">${areas}</div></section>
<section class="block"><h2>${wl ? 'Fair Use – die geplanten Grenzen' : 'Fair Use – transparent'}</h2><p class="lead">Teure Ressourcen haben großzügige Grenzen, damit wenige Vielnutzer nicht alle anderen bezahlen lassen. Das sind Grenzen für Verbrauch, keine gesperrten Funktionen. Mit eigenem KI-Schlüssel (BYOK) rechnest du KI direkt mit deinem Anbieter ab. Die Zahlen gelten pro Sub-Account und Monat.</p>
<div class="tablewrap"><table class="fair"><thead><tr><th></th>${d.plans.map((p) => `<th scope="col">${h(p.name)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div></section>
${faq}</main>`,
  });
}

/** /start while the cloud is not open: the waitlist form instead of the signup (German or English). */
export function waitlistPage(c: PageCtx, o: { view: WaitlistView; notice?: string }): string {
  const v = o.view;
  const t = wlText(v.lang, c.brand.name);
  const en = v.lang === 'en';
  const docs = c.docs_url ? h(c.docs_url) : '';
  return shell(c, {
    title: t.page.title,
    lang: v.lang,
    description: t.page.lead,
    body: `<main class="pricing wlpage"><h1>${h(t.page.h1)}</h1><p class="lead">${h(t.page.lead)}</p>
${o.notice ? `<div class="alert" role="alert">${h(o.notice)}</div>` : ''}
<div class="signup" id="${WAITLIST_ANCHOR}"><div class="card"><h2>${h(t.h2)}</h2>${waitlistFormHtml(v, WL_CLASSES, 'swl')}</div>
<aside class="card side"><h3>${h(t.page.sideH)}</h3><p style="color:var(--muted)">${h(t.page.side)}</p>${docs ? `<p><a class="btn" href="${docs}" rel="noopener">${h(t.selfCta)}</a></p>` : ''}
<p style="color:var(--muted);margin:18px 0 0">${h(t.page.login)} <a href="/app">${h(t.page.account)}</a></p>
<p style="margin:10px 0 0"><a href="/start?lang=${en ? 'de' : 'en'}" hreflang="${en ? 'de' : 'en'}" lang="${en ? 'de' : 'en'}">${en ? 'Deutsch' : 'English'}</a></p></aside></div></main>`,
  });
}

// --- signup --------------------------------------------------------------------------------------------------------

export interface SignupData extends PricingData {
  values: { plan: string; interval: string; company: string; name: string; email: string; coupon: string; vat_id?: string; business?: string };
  error?: string;
  token: string;
  google: boolean;
  closed?: boolean;
  canceled?: boolean;
}

export function signupPage(c: PageCtx, d: SignupData): string {
  const note = vat(d.price_note);
  const v = d.values;
  const chosen = d.plans.find((p) => p.key === v.plan) ?? d.plans.find((p) => p.key === 'team') ?? d.plans[0];
  const iv = v.interval === 'year' ? 'year' : 'month';
  if (d.closed) return messagePage(c, { title: 'Anmeldung pausiert', text: 'Neue Konten können gerade nicht online angelegt werden. Bitte versuche es später noch einmal.', action: ['/cloud', 'Zu den Preisen'] });
  const cards = d.plans
    .map(
      (p) => `<label class="plan"><input type="radio" name="plan" value="${p.key}"${p.key === chosen.key ? ' checked' : ''}><span class="pb"><strong>${h(p.name)}</strong>
<span class="pr"><span class="p-month">${eur(p.price_month_cents)}</span><span class="p-year">${eur(Math.round(p.price_year_cents / 12))}</span><small> / Monat ${note ? h(note) : ''}</small></span>
<small class="p-year">${eur(p.price_year_cents)} jährlich</small><small>${p.users === 1 ? '1 Nutzer' : 'Unbegrenzt Nutzer'}</small></span></label>`,
    )
    .join('');
  const legalLink = (doc: LegalDoc, label: string) => `<a href="/cloud/legal/${doc}" target="_blank" rel="noopener">${label}</a>`;
  const trial = d.trial_days > 0;
  const submit = trial ? (d.card_required ? 'Weiter zur Zahlung' : `${d.trial_days} Tage kostenlos testen`) : 'Weiter zur Zahlung';
  const field = (name: string, label: string, type: string, extra = '', val = '') => `<label class="f" for="f-${name}">${label}</label><input class="in" id="f-${name}" name="${name}" type="${type}" value="${h(val)}" ${extra}>`;
  return shell(c, {
    title: 'Konto anlegen',
    nav: true,
    body: `<main class="pricing"><form method="post" action="/start" autocomplete="on" novalidate>
<input type="radio" name="interval" value="month" id="iv-month"${iv === 'month' ? ' checked' : ''} class="vh" aria-label="Monatlich"><input type="radio" name="interval" value="year" id="iv-year"${iv === 'year' ? ' checked' : ''} class="vh" aria-label="Jährlich">
<h1>Konto anlegen</h1>
<p class="muted" style="color:var(--muted);margin:0">${trial ? `${d.trial_days} Tage kostenlos testen – ${d.card_required ? 'abgebucht wird erst danach' : 'ohne Zahlungsmittel'}.` : 'Du startest direkt mit dem gewählten Tarif.'} Jederzeit kündbar.</p>
${d.canceled ? '<div class="okbox" role="status">Die Zahlung wurde abgebrochen. Du kannst es jederzeit noch einmal versuchen – dein Konto wurde nicht angelegt.</div>' : ''}
${d.error ? `<div class="alert" role="alert">${h(d.error)}</div>` : ''}
<div class="signup"><div class="card">
<div class="toggle" role="group" aria-label="Abrechnung"><label for="iv-month">Monatlich</label><label for="iv-year">Jährlich${d.yearly_discount_percent > 0 ? ` <span class="save">-${d.yearly_discount_percent} %</span>` : ''}</label></div>
<div class="mini">${cards}</div>
${field('company', 'Firmenname', 'text', 'required maxlength="120" autocomplete="organization"', v.company)}
${d.b2b_only ? `${field('vat_id', 'USt-IdNr. (falls vorhanden)', 'text', 'maxlength="20" autocomplete="off" placeholder="DE123456789"', v.vat_id ?? '')}<label class="chk"><input type="checkbox" name="business" value="1"${v.business ? ' checked' : ''}><span>Ich bestelle als Unternehmen (§ 14 BGB). Das Angebot richtet sich nur an Unternehmen, nicht an Verbraucher.</span></label>` : ''}
<div class="two"><div>${field('name', 'Dein Name', 'text', 'maxlength="120" autocomplete="name"', v.name)}</div><div>${field('email', 'E-Mail (dein Login)', 'email', 'required maxlength="200" autocomplete="email"', v.email)}</div></div>
${field('password', 'Passwort (mindestens 8 Zeichen)', 'password', 'minlength="8" maxlength="200" autocomplete="new-password"')}
<details class="coupon"><summary>Gutscheincode?</summary>${field('coupon', 'Gutscheincode', 'text', 'maxlength="60" autocomplete="off"', v.coupon)}</details>
<div class="hp" aria-hidden="true"><label for="f-website">Website</label><input id="f-website" name="website" tabindex="-1" autocomplete="off"></div>
<input type="hidden" name="t" value="${h(d.token)}">
<label class="chk"><input type="checkbox" name="agb" value="1" required><span>Ich akzeptiere die ${legalLink('agb', 'AGB')}.</span></label>
<label class="chk"><input type="checkbox" name="avv" value="1" required><span>Ich schließe den ${legalLink('avv', 'Auftragsverarbeitungsvertrag (AVV)')} ab.</span></label>
<label class="chk"><input type="checkbox" name="datenschutz" value="1" required><span>Ich habe die ${legalLink('datenschutz', 'Datenschutzerklärung')} gelesen.</span></label>
<button class="btn wide" type="submit" name="via" value="email">${h(submit)}</button>
${d.google ? '<div class="or">oder</div><button class="btn wide ghost" type="submit" name="via" value="google" formnovalidate>Mit Google fortfahren</button>' : ''}
<p class="trialnote">Keine Cookies, kein Tracking auf dieser Seite.</p>
</div>
<aside class="card side"><h3>So geht es weiter</h3><ol><li>Du bestätigst deine E-Mail-Adresse${d.google ? ' (mit Google entfällt das)' : ''}.</li><li>${trial && !d.card_required ? 'Dein Konto ist sofort bereit.' : 'Du gibst bei Stripe dein Zahlungsmittel an.'}</li><li>Dein Konto wird eingerichtet – Pipeline und Vorlagen sind schon da.</li><li>Du arbeitest sofort weiter, im Browser oder in der Android-App.</li></ol>
<p style="color:var(--muted);margin:18px 0 0">Schon ein Konto? <a href="/app">Zur Anmeldung</a></p></aside></div>
</form></main>`,
  });
}

// --- small pages ---------------------------------------------------------------------------------------------------

export function messagePage(c: PageCtx, o: { title: string; text: string; action?: [string, string]; extra?: string; head?: string; error?: string; method?: { action: string; label: string; fields?: Record<string, string>; /** Asks for a new password (twice): the sign-up's verification in another browser than the form. */ passwords?: boolean } }): string {
  const pw = (id: string, name: string, label: string, focus: boolean) => `<label class="f" for="${id}">${label}</label><input class="in" id="${id}" name="${name}" type="password" minlength="8" maxlength="200" required autocomplete="new-password"${focus ? ' autofocus' : ''}>`;
  const form = o.method
    ? `<form method="post" action="${h(o.method.action)}">${Object.entries(o.method.fields ?? {}).map(([k, x]) => `<input type="hidden" name="${h(k)}" value="${h(x)}">`).join('')}${o.method.passwords ? `${pw('p1', 'password', 'Passwort (mindestens 8 Zeichen)', true)}${pw('p2', 'password2', 'Passwort wiederholen', false)}<p></p>` : ''}<button class="btn" type="submit">${h(o.method.label)}</button></form>`
    : '';
  const page = shell(c, { title: o.title, body: `<main class="msg"><div class="card"><h1>${h(o.title)}</h1><p>${h(o.text)}</p>${o.error ? `<div class="alert" role="alert">${h(o.error)}</div>` : ''}${o.extra ?? ''}${o.action ? `<p><a class="btn" href="${h(o.action[0])}">${h(o.action[1])}</a></p>` : ''}${form}</div></main>` });
  return o.head ? page.replace('</head>', `${o.head}</head>`) : page;
}

export function legalPage(c: PageCtx, o: { doc: LegalDoc; html: string; version: number; date: string }): string {
  return shell(c, { title: LEGAL_TITLE[o.doc], body: `<main class="legal"><h1>${h(LEGAL_TITLE[o.doc])}</h1><p class="meta">Version ${o.version} · Stand ${h(o.date)}</p>${o.html}</main>` });
}

export { PLAN_KEYS };
