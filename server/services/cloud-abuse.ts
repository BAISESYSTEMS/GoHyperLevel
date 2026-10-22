import { escapeHtml as h } from '../core/template.js';

/**
 * Abuse handling of the hosted service (modules/cloud-abuse.ts, docs/cloud.md#abuse-handling): the notice form of the Digital
 * Services Act (Art. 16), its checks, and the rule that pauses a customer's e-mail sending when complaints or bounces pile up.
 * Pure.
 */

export const CATEGORIES: Record<string, string> = {
  phishing: 'Phishing / Abgreifen von Zugangsdaten',
  spam: 'Spam / unerwünschte Werbung',
  malware: 'Schadsoftware',
  fraud: 'Betrug / Fake-Shop',
  ip: 'Urheber- oder Markenrecht',
  privacy: 'Persönlichkeitsrecht / Datenschutz',
  hate: 'Hassrede / strafbare Inhalte',
  csam: 'Darstellung von Kindesmissbrauch',
  other: 'Sonstiges',
};
export const REPORT_STATUS: Record<string, string> = { new: 'Neu', in_review: 'In Prüfung', actioned: 'Maßnahme ergriffen', rejected: 'Abgelehnt' };

export interface ReportInput {
  category: string;
  urls: string[];
  explanation: string;
  name: string;
  email: string;
  good_faith: boolean;
}

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;

/** An http(s) address with a real host name (a dot in it, or localhost); the scheme may be left out. */
function validUrl(u: string): boolean {
  try {
    const x = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`);
    return (x.protocol === 'https:' || x.protocol === 'http:') && (x.hostname.includes('.') || x.hostname === 'localhost');
  } catch {
    return false;
  }
}

/** Checks a notice; name and e-mail are required except for child sexual abuse material (Art. 16(2)(c) DSA). */
export function cleanReport(b: Record<string, unknown>): { values: ReportInput; error?: string } {
  const s = (k: string, max: number) => String(b[k] ?? '').trim().slice(0, max);
  const urls = s('urls', 4000)
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter(Boolean)
    .slice(0, 20);
  const values: ReportInput = { category: s('category', 20), urls, explanation: s('explanation', 5000), name: s('name', 120), email: s('email', 200).toLowerCase(), good_faith: !!b.good_faith };
  const error = !CATEGORIES[values.category]
    ? 'Bitte eine Art des Verstoßes wählen.'
    : !urls.length
      ? 'Bitte die genaue Adresse (URL) des Inhalts angeben.'
      : urls.some((u) => !validUrl(u))
        ? 'Mindestens eine Adresse ist keine gültige URL.'
        : values.explanation.length < 20
          ? 'Bitte begründe kurz, warum der Inhalt rechtswidrig ist oder gegen die Regeln verstößt (mindestens 20 Zeichen).'
          : values.category !== 'csam' && (!values.name || !EMAIL.test(values.email))
            ? 'Bitte Namen und E-Mail-Adresse angeben – wir bestätigen den Eingang und teilen dir unsere Entscheidung mit.'
            : values.email && !EMAIL.test(values.email)
              ? 'Die E-Mail-Adresse ist ungültig.'
              : !values.good_faith
                ? 'Bitte bestätige, dass deine Angaben nach bestem Wissen richtig und vollständig sind.'
                : undefined;
  return { values, error };
}

/** Auto-pause: the last 500 sent e-mails of a customer, judged once at least 100 went out. */
export const WINDOW = 500;
export const MIN_SENDS = 100;
export const COMPLAINT_LIMIT = 0.001;
export const BOUNCE_LIMIT = 0.05;

export function sendRates(statuses: string[]): { sent: number; bounced: number; complained: number; bounceRate: number; complaintRate: number } {
  const sent = statuses.length;
  const bounced = statuses.filter((s) => s === 'bounced').length;
  const complained = statuses.filter((s) => s === 'complained').length;
  return { sent, bounced, complained, bounceRate: sent ? bounced / sent : 0, complaintRate: sent ? complained / sent : 0 };
}

const pct = (v: number) => `${(Math.round(v * 1000) / 10).toString().replace('.', ',')} %`;

/** The reason to pause, or undefined. */
export function pauseReason(statuses: string[]): string | undefined {
  const r = sendRates(statuses);
  if (r.sent < MIN_SENDS) return undefined;
  if (r.complaintRate > COMPLAINT_LIMIT) return `Beschwerderate ${pct(r.complaintRate)} (${r.complained} von ${r.sent} E-Mails als Spam gemeldet, erlaubt 0,1 %)`;
  if (r.bounceRate > BOUNCE_LIMIT) return `Bounce-Rate ${pct(r.bounceRate)} (${r.bounced} von ${r.sent} E-Mails unzustellbar, erlaubt 5 %)`;
  return undefined;
}

/** The form (inside the cloud pages' card). */
export function reportForm(o: { values?: Partial<ReportInput>; error?: string; token: string; abuseEmail?: string }): string {
  const v = o.values ?? {};
  const opt = Object.entries(CATEGORIES)
    .map(([k, label]) => `<option value="${k}"${v.category === k ? ' selected' : ''}>${h(label)}</option>`)
    .join('');
  return `${o.error ? `<div class="alert" role="alert">${h(o.error)}</div>` : ''}
<form method="post" action="/abuse" novalidate>
<label class="f" for="a-cat">Art des Verstoßes</label><select class="in" id="a-cat" name="category" required><option value="">Bitte wählen …</option>${opt}</select>
<label class="f" for="a-urls">Genaue Adresse(n) des Inhalts (URL, eine pro Zeile)</label><textarea class="in" id="a-urls" name="urls" rows="3" required maxlength="4000">${h((v.urls ?? []).join('\n'))}</textarea>
<label class="f" for="a-exp">Warum ist der Inhalt rechtswidrig oder verstößt gegen die Regeln?</label><textarea class="in" id="a-exp" name="explanation" rows="6" required maxlength="5000">${h(v.explanation ?? '')}</textarea>
<label class="f" for="a-name">Dein Name</label><input class="in" id="a-name" name="name" maxlength="120" autocomplete="name" value="${h(v.name ?? '')}">
<label class="f" for="a-mail">Deine E-Mail-Adresse</label><input class="in" id="a-mail" name="email" type="email" maxlength="200" autocomplete="email" value="${h(v.email ?? '')}">
<p style="color:var(--muted);font-size:14px">Name und E-Mail brauchen wir für die Eingangsbestätigung und unsere Entscheidung. Bei Darstellungen von Kindesmissbrauch kannst du anonym melden.</p>
<div class="hp" aria-hidden="true"><label for="a-website">Website</label><input id="a-website" name="website" tabindex="-1" autocomplete="off"></div>
<input type="hidden" name="t" value="${h(o.token)}">
<label class="chk"><input type="checkbox" name="good_faith" value="1" required${v.good_faith ? ' checked' : ''}><span>Ich bin in gutem Glauben davon überzeugt, dass die Angaben in dieser Meldung richtig und vollständig sind.</span></label>
<button class="btn wide" type="submit">Meldung absenden</button>
</form>
${o.abuseEmail ? `<p style="color:var(--muted);font-size:14px">Oder per E-Mail an <a href="mailto:${h(o.abuseEmail)}">${h(o.abuseEmail)}</a>.</p>` : ''}`;
}
