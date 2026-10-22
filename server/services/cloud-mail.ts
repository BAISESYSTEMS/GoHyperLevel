import { escapeHtml } from '../core/template.js';

/**
 * System mails of the hosted service (German, short, one action each). `composeMail` returns subject, plain text
 * and a plain HTML version; the module sends them through the operator's mail sub-account.
 */

export type MailKind =
  | 'verify'
  | 'account_exists'
  | 'welcome'
  | 'invite'
  | 'trial_ending'
  | 'trial_expired'
  | 'payment_failed'
  | 'payment_reminder'
  | 'read_only'
  | 'deletion_scheduled'
  | 'self_delete'
  | 'deleted'
  | 'subscribed'
  | 'cancel_scheduled'
  | 'canceled'
  | 'plan_changed'
  /** A free-form notice (abuse decisions, statements of reasons): `subject`, `lines`, optional `button` + `link`. */
  | 'notice';

export interface MailVars {
  brand: string;
  name?: string;
  company?: string;
  link?: string;
  support?: string;
  [k: string]: string | number | string[] | undefined;
}

interface Spec {
  subject: string;
  lines: string[];
  button?: string;
}

const v = (x: unknown) => String(x ?? '');

const SPECS: Record<MailKind, (m: MailVars) => Spec> = {
  verify: (m) => ({
    subject: `Bitte bestätige deine E-Mail-Adresse – ${m.brand}`,
    lines: [`Hallo ${v(m.name) || 'und willkommen'},`, `du hast bei ${m.brand} ein Konto für „${v(m.company)}“ angefragt. Mit einem Klick bestätigst du deine E-Mail-Adresse – danach geht es direkt weiter.`, 'Der Link ist 24 Stunden gültig. Wenn du das nicht warst, ignoriere diese Nachricht einfach.'],
    button: 'E-Mail bestätigen',
  }),
  account_exists: (m) => ({
    subject: `Du hast schon ein Konto bei ${m.brand}`,
    lines: ['Hallo,', `für diese E-Mail-Adresse gibt es bei ${m.brand} bereits ein Konto. Melde dich einfach an – falls du dein Passwort vergessen hast, kannst du es auf der Anmeldeseite zurücksetzen lassen.`, 'Wenn du dich gar nicht angemeldet hast, kannst du diese Nachricht ignorieren.'],
    button: 'Zur Anmeldung',
  }),
  welcome: (m) => ({
    subject: `Willkommen bei ${m.brand} – dein Konto ist bereit`,
    lines: [
      `Hallo ${v(m.name) || ''}`.trim() + ',',
      `dein Konto „${v(m.company)}“ ist startklar (Tarif ${v(m.plan)}${m.trial_end ? `, Testphase bis ${v(m.trial_end)}` : ''}).`,
      'So kommst du am schnellsten ans Ziel:',
      ...((m.checklist as string[] | undefined) ?? []).map((x) => `• ${x}`),
      m.support ? `Fragen? Schreib uns: ${v(m.support)}` : '',
    ].filter(Boolean),
    button: 'Konto öffnen',
  }),
  invite: (m) => ({
    subject: `${v(m.inviter) || 'Dein Team'} hat dich zu ${v(m.company)} eingeladen`,
    lines: [`Hallo ${v(m.name) || ''}`.trim() + ',', `${v(m.inviter) || 'Dein Team'} hat dich zu „${v(m.company)}“ bei ${m.brand} eingeladen. Lege dein Passwort fest und leg los.`, 'Der Link ist 7 Tage gültig und nur einmal nutzbar.'],
    button: 'Passwort festlegen',
  }),
  trial_ending: (m) => ({
    subject: `Deine Testphase endet in ${v(m.days)} Tagen`,
    lines: [`Hallo ${v(m.name) || ''}`.trim() + ',', `deine Testphase bei ${m.brand} endet am ${v(m.trial_end)}. ${m.card ? 'Danach läuft dein Abo automatisch weiter.' : 'Um ohne Unterbrechung weiterzuarbeiten, wähle jetzt Tarif und Zahlungsart – sonst wird dein Konto danach schreibgeschützt.'}`, 'Du kannst jederzeit kündigen und alle Daten exportieren.'],
    button: 'Abo ansehen',
  }),
  trial_expired: (m) => ({
    subject: `Deine Testphase ist abgelaufen – dein Konto ist jetzt schreibgeschützt`,
    lines: [`Hallo ${v(m.name) || ''}`.trim() + ',', 'deine Testphase ist vorbei. Alle deine Daten sind noch da und lesbar; Änderungen sind gesperrt, bis du ein Abo abschließt.', `Du kannst deine Daten jederzeit exportieren. Ohne Abo bieten wir den Export nach ${v(m.retention_days)} Tagen noch einmal an und löschen das Konto danach.`],
    button: 'Abo abschließen',
  }),
  payment_failed: (m) => ({
    subject: 'Zahlung fehlgeschlagen – bitte Zahlungsmethode prüfen',
    lines: [`Hallo ${v(m.name) || ''}`.trim() + ',', `die letzte Zahlung für ${m.brand} ist fehlgeschlagen. Bitte aktualisiere deine Zahlungsmethode${m.grace_until ? ` bis ${v(m.grace_until)}` : ''} – sonst wird dein Konto danach schreibgeschützt (Daten bleiben lesbar und exportierbar).`],
    button: 'Zahlung aktualisieren',
  }),
  payment_reminder: (m) => ({
    subject: m.last ? 'Letzte Erinnerung: Zahlung offen' : 'Erinnerung: Zahlung offen',
    lines: [`Hallo ${v(m.name) || ''}`.trim() + ',', `deine Zahlung ist noch offen. ${m.grace_until ? `Bis ${v(m.grace_until)} bleibt alles wie gewohnt, danach wird dein Konto schreibgeschützt.` : ''}`],
    button: 'Zahlung aktualisieren',
  }),
  read_only: (m) => ({
    subject: 'Dein Konto ist jetzt schreibgeschützt',
    lines: [`Hallo ${v(m.name) || ''}`.trim() + ',', `${v(m.reason) || 'Dein Konto ist schreibgeschützt.'} Alles bleibt lesbar, du kannst deine Daten exportieren. Mit der offenen Zahlung bzw. einem neuen Abo ist sofort wieder alles freigeschaltet.`],
    button: 'Konto öffnen',
  }),
  deletion_scheduled: (m) => ({
    subject: `Dein Konto wird am ${v(m.delete_at)} gelöscht`,
    lines: [`Hallo ${v(m.name) || ''}`.trim() + ',', `dein Konto „${v(m.company)}“ ist seit längerem schreibgeschützt. Wir löschen es am ${v(m.delete_at)} endgültig (Datenschutz: wir behalten Daten nicht länger als nötig).`, 'Du kannst vorher alle Daten als ZIP exportieren (JSON und CSV). Mit einem neuen Abo bleibt dein Konto erhalten.'],
    button: 'Daten exportieren',
  }),
  self_delete: (m) => ({
    subject: `Dein Konto wird am ${v(m.delete_at)} gelöscht`,
    lines: [`Hallo ${v(m.name) || ''}`.trim() + ',', `du hast die Löschung von „${v(m.company)}“ angefordert. Das Konto ist ab sofort schreibgeschützt und wird am ${v(m.delete_at)} endgültig gelöscht. Das Abo wurde beendet.`, 'Bis dahin kannst du alle Daten exportieren oder die Löschung zurücknehmen.'],
    button: 'Löschung verwalten',
  }),
  deleted: (m) => ({
    subject: 'Dein Konto wurde gelöscht',
    lines: [`Hallo ${v(m.name) || ''}`.trim() + ',', `wie angekündigt haben wir „${v(m.company)}“ und alle zugehörigen Daten gelöscht. Danke, dass du ${m.brand} ausprobiert hast.`],
  }),
  subscribed: (m) => ({
    subject: `Danke – dein Abo ${v(m.plan)} läuft`,
    lines: [`Hallo ${v(m.name) || ''}`.trim() + ',', `dein Abo „${v(m.plan)}“ ist aktiv. Rechnungen findest du jederzeit unter Einstellungen → Cloud-Konto.`],
    button: 'Konto öffnen',
  }),
  cancel_scheduled: (m) => ({
    subject: 'Deine Kündigung ist eingegangen',
    lines: [`Hallo ${v(m.name) || ''}`.trim() + ',', `dein Abo endet am ${v(m.end)}. Bis dahin läuft alles wie gewohnt. Du kannst die Kündigung jederzeit zurücknehmen und deine Daten exportieren.`],
    button: 'Cloud-Konto öffnen',
  }),
  canceled: (m) => ({
    subject: 'Dein Abo ist beendet',
    lines: [`Hallo ${v(m.name) || ''}`.trim() + ',', `dein Abo ist beendet. Das Konto ist schreibgeschützt; deine Daten kannst du noch exportieren. Du kannst jederzeit ein neues Abo abschließen.`],
    button: 'Konto öffnen',
  }),
  notice: (m) => ({
    subject: v(m.subject),
    lines: ((m.lines as string[] | undefined) ?? []).filter(Boolean),
    button: m.button ? v(m.button) : undefined,
  }),
  plan_changed: (m) => ({
    subject: `Dein Tarif: ${v(m.plan)}`,
    lines: [`Hallo ${v(m.name) || ''}`.trim() + ',', `dein Tarif wurde auf „${v(m.plan)}“ umgestellt. Die Differenz wird anteilig verrechnet.`],
    button: 'Cloud-Konto öffnen',
  }),
};

export function composeMail(kind: MailKind, vars: MailVars): { subject: string; text: string; html: string } {
  const spec = SPECS[kind](vars);
  const sign = `Viele Grüße\n${vars.brand}`;
  const text = [...spec.lines, spec.button && vars.link ? `${spec.button}: ${vars.link}` : '', vars.support && kind !== 'welcome' ? `Fragen? ${vars.support}` : '', sign].filter(Boolean).join('\n\n');
  const body = spec.lines.map((l) => `<p style="margin:0 0 14px">${escapeHtml(l).replace(/\n/g, '<br>')}</p>`).join('');
  const button = spec.button && vars.link ? `<p style="margin:22px 0"><a href="${escapeHtml(vars.link)}" style="background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:9px;font-weight:600;display:inline-block">${escapeHtml(spec.button)}</a></p><p style="margin:0 0 14px;color:#6b7280;font-size:13px">Falls der Knopf nicht geht: ${escapeHtml(vars.link)}</p>` : '';
  const foot = `<p style="margin:22px 0 0;color:#6b7280;font-size:13px">${vars.support && kind !== 'welcome' ? `Fragen? ${escapeHtml(v(vars.support))}<br>` : ''}Viele Grüße<br>${escapeHtml(vars.brand)}</p>`;
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#1f2937;max-width:560px;margin:0 auto;padding:24px">${body}${button}${foot}</body></html>`;
  return { subject: spec.subject, text, html };
}
