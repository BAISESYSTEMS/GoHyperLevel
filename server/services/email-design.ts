import { bad } from '../core/http.js';
import { render } from '../core/template.js';
import { designIssues, normalizeDesign, renderEmailHtml, renderEmailText, type EmailDesign } from './email-render.js';

/**
 * Server side of the email builder for everything that stores an email (templates, campaigns,
 * workflow steps): a `design` is rendered on save, so every sender just uses `body` (HTML) and
 * `body_text` (text/plain) and never needs to know about designs.
 */

export function parseDesign(input: unknown): EmailDesign {
  try {
    return normalizeDesign(input);
  } catch (e) {
    throw bad((e as Error).message);
  }
}

export function designFields(input: unknown): { design: EmailDesign; body: string; body_text: string; is_html: 1 } {
  const design = parseDesign(input);
  return { design, body: renderEmailHtml(design), body_text: renderEmailText(design), is_html: 1 };
}

/**
 * Columns to write for a create/update request:
 * - `design` object → rendered HTML in `body`, text in `body_text`, `is_html` = 1;
 * - `design: null` → back to a plain email (the body stays as sent or stored);
 * - a new `body` without design while one is stored → the design no longer matches and is dropped.
 */
export function designPatch(input: Record<string, any>, current?: { design?: unknown } | null): Record<string, any> {
  const d = input.design;
  if ((d && typeof d === 'object') || (typeof d === 'string' && d.trim())) return designFields(d);
  if (d === null || d === '') return { design: null, body_text: '' };
  if (input.body !== undefined && current?.design) return { design: null, body_text: '' };
  return {};
}

/** Campaigns must not go out without footer, unsubscribe link and company address. */
export function assertCampaignDesign(design: unknown, vars: Record<string, unknown> = {}) {
  if (!design) return;
  const d = parseDesign(design);
  const error = designIssues(d, { campaign: true }).find((i) => i.level === 'error');
  if (error) throw bad(error.text);
  // {{location.address}} must actually resolve to something.
  const footer = d.sections.flatMap((s) => s.columns.flatMap((c) => c.blocks)).find((b) => b.type === 'footer');
  if (footer && !render(String(footer.props.address), vars).trim()) throw bad('Im Footer fehlt die Firmenadresse – unter Einstellungen → Firma eintragen oder im Footer-Block angeben');
}
