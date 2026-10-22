import { escapeHtml } from './template.js';

/** Shell for the public, server-rendered pages (booking, forms, funnels, invoices, reviews). */
export function publicPage(opts: { title: string; body: string; head?: string; color?: string; embed?: boolean; description?: string }): string {
  const color = /^#[0-9a-f]{3,8}$/i.test(opts.color ?? '') ? opts.color : '#2563eb';
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
${opts.description ? `<meta name="description" content="${escapeHtml(opts.description)}">` : ''}
<style>
:root { --brand: ${color}; --text: #111827; --muted: #6b7280; --line: #e5e7eb; --bg: #f9fafb; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text); background: ${opts.embed ? 'transparent' : 'var(--bg)'}; line-height: 1.5; overflow-wrap: break-word; }
.wrap { max-width: 720px; margin: 0 auto; padding: ${opts.embed ? '8px' : '40px 16px'}; }
.card { background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 28px; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
h1 { font-size: 26px; margin: 0 0 8px; } h2 { font-size: 20px; margin: 0 0 8px; }
h1, h2, h3 { overflow-wrap: anywhere; hyphens: auto; }
p.muted, .muted { color: var(--muted); }
label { display: block; font-weight: 600; font-size: 14px; margin: 14px 0 6px; }
input, select, textarea { width: 100%; padding: 11px 12px; border: 1px solid #d1d5db; border-radius: 9px; font: inherit; background: #fff; }
input:focus, select:focus, textarea:focus { outline: 2px solid var(--brand); outline-offset: 0; border-color: transparent; }
textarea { min-height: 110px; resize: vertical; }
.btn, button { display: inline-block; background: var(--brand); color: #fff; border: 0; border-radius: 9px; padding: 12px 20px; font: inherit; font-weight: 600; cursor: pointer; text-decoration: none; }
button[disabled] { opacity: .6; cursor: default; }
.btn.secondary { background: #fff; color: var(--text); border: 1px solid var(--line); }
.row { display: flex; gap: 12px; flex-wrap: wrap; } .row > * { flex: 1 1 200px; }
.check { display: flex; gap: 8px; align-items: flex-start; font-weight: 400; } .check input { width: auto; margin-top: 4px; }
.error { color: #b91c1c; font-size: 14px; margin-top: 10px; }
.ok { background: #ecfdf5; color: #065f46; padding: 14px 16px; border-radius: 10px; }
table { width: 100%; border-collapse: collapse; } td, th { padding: 10px 8px; border-bottom: 1px solid var(--line); text-align: left; }
@media (max-width: 560px) { .card { padding: 20px; } .wrap { padding: ${opts.embed ? '4px' : '20px 12px'}; } }
</style>
${opts.head ?? ''}
</head>
<body>
${opts.body}
</body>
</html>`;
}

export function messagePage(title: string, message: string): string {
  return publicPage({ title, body: `<div class="wrap"><div class="card"><h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(message)}</p></div></div>` });
}

/** For public pages that only work with JavaScript (booking, webinar, review): a short hint for visitors without it, like the forms have. */
export function noscriptNotice(what: string): string {
  return `<noscript><p class="error">Bitte JavaScript einschalten, um ${escapeHtml(what)}.</p></noscript>`;
}

/** Serializes data for a <script> block without letting it close the tag. */
export function jsonForScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}
