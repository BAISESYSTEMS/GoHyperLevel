/**
 * Merge fields like GHL's: {{contact.first_name}}, {{contact.custom.budget}}, {{location.name}},
 * with an optional fallback: {{contact.first_name|du}}.
 */
export function render(tpl: string, data: Record<string, unknown>, opts: { escape?: boolean } = {}): string {
  let dropped = false;
  if (PASSES.size && tpl?.includes('{{#')) for (const pass of PASSES) tpl = pass(tpl, data ?? {});
  // bounded quantifiers keep the scan linear: an unclosed '{{a|…' or a long run of spaces must not stall the server (DoS)
  const out = (tpl ?? '').replace(/(,?[ \t]{1,40})?\{\{\s{0,20}([\w.]{1,120})\s{0,20}(?:\|([^}]{0,500}))?\}\}/g, (m: string, lead: string | undefined, path: string, fallback: string | undefined, at: number, whole: string) => {
    let v = lookup(data, path);
    if (v === undefined && NAMESPACES.size) v = fromNamespace(path, data);
    const s = v === undefined || v === null || v === '' ? (fallback ?? '').trim() : String(v);
    const out = opts.escape ? escapeHtml(s) : s;
    // An empty field on a line of its own takes the line with it ("…bestätigt.\n{{calendar.meeting_location}}\n\nTermin…" without a
    // place must not leave two blank lines in a plain-text mail).
    if (!out && (at === 0 || whole.charAt(at - 1) === '\n') && /^(\r?\n)/.test(whole.slice(at + m.length, at + m.length + 2))) {
      dropped = true;
      return DROP_LINE;
    }
    if (out || !lead) return (lead ?? '') + out;
    // An empty field leaves no gap: "Hallo {{contact.first_name|}}," → "Hallo,", "Danke, {{contact.first_name|}}!" → "Danke!",
    // "Rechnung {{invoice.number}} ist" → "Rechnung ist" (a contact without a name must not get "Hallo ,").
    const next = whole.charAt(at + m.length);
    if (next === '' || /[\r\n,.!?;:]/.test(next)) return '';
    if (/[ \t]/.test(next)) return lead.startsWith(',') ? ',' : '';
    return lead;
  });
  return dropped ? out.split(`${DROP_LINE}\r\n`).join('').split(`${DROP_LINE}\n`).join('') : out;
}

/**
 * Block syntax other modules add, run before the merge fields – `{{#if …}}…{{else}}…{{/if}}` (modules/template-conditions.ts).
 * A pass gets the template and the data and returns the template; `templatePass` returns the remover.
 */
type TemplatePass = (tpl: string, data: Record<string, unknown>) => string;
const PASSES = new Set<TemplatePass>();
export function templatePass(fn: TemplatePass): () => void {
  PASSES.add(fn);
  return () => void PASSES.delete(fn);
}

/** Marks a line render() removes (private-use characters – never in a template). */
const DROP_LINE = '\uE000\uE001';

/**
 * Merge-field namespaces other modules answer when the template data has nothing under that name – `{{custom_values.key}}`
 * (modules/custom-values.ts) works in every e-mail, SMS, workflow step and document without each caller loading the values.
 * A resolver gets the rest of the path ("key") and the template data (where it finds the sub-account: `location.id`,
 * `location_id`, `contact.location_id` …) and returns undefined when it cannot tell. `templateNamespace` returns the remover.
 */
type NamespaceResolver = (rest: string, data: Record<string, unknown>) => unknown;
const NAMESPACES = new Map<string, Set<NamespaceResolver>>();
export function templateNamespace(name: string, fn: NamespaceResolver): () => void {
  const set = NAMESPACES.get(name) ?? new Set<NamespaceResolver>();
  set.add(fn);
  NAMESPACES.set(name, set);
  return () => {
    set.delete(fn);
    if (!set.size) NAMESPACES.delete(name);
  };
}
function fromNamespace(path: string, data: Record<string, unknown>): unknown {
  const dot = path.indexOf('.');
  const set = dot > 0 ? NAMESPACES.get(path.slice(0, dot)) : undefined;
  if (!set) return undefined;
  for (const fn of set) {
    try {
      const v = fn(path.slice(dot + 1), data ?? {});
      if (v !== undefined) return v;
    } catch {
      /* a resolver never breaks a message */
    }
  }
  return undefined;
}

export function lookup(data: unknown, path: string): unknown {
  let cur: any = data;
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Plain text with line breaks to simple HTML paragraphs (used for emails written as text). */
export function textToHtml(s: string): string {
  return escapeHtml(s)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
}
