import type { App, Module } from '../core/app.js';
import type { Ctx } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { applyConditions } from '../services/template-conditions.js';

/**
 * URL-Parameter als dynamischer Text – docs/sites.md#dynamic-text. Page text may contain `{{url.name}}` or `{{url.name|Fallback}}`:
 * a visitor of `…/angebot?name=Anna&stadt=Köln` sees "Hallo Anna aus Köln", one without the parameter sees the fallback.
 * Only text between tags is replaced (never inside attributes, scripts or styles) and values are HTML-escaped and shortened,
 * so a crafted link cannot put markup or a `javascript:` address on the page. Pages with placeholders are not cached.
 * Blocks can also be shown by parameter: `{{#if url.quelle == "facebook"}}…{{else}}…{{/if}}` (the parser of
 * services/template-conditions.ts – it only picks a branch, it never prints a value from the link).
 */

const TOKEN = /\{\{\s*(?:url|query)\.([A-Za-z0-9_-]{1,40})\s*(?:\|([^{}]{0,80}))?\}\}/g;
const SKIP = /(<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<textarea\b[\s\S]*?<\/textarea>|<!--[\s\S]*?-->|<[^>]*>)/gi;

/** Replaces the placeholders in the text parts of `html` with values from `params`. */
export function fillUrlParams(html: string, params: URLSearchParams): string {
  return html
    .split(SKIP)
    .map((part, i) => {
      if (!part.includes('{{')) return part;
      // split() with one capture group: odd entries are tags and skipped blocks. Inside a tag (meta description, alt, href) only the
      // static fallback is used – a visitor's value never lands in an attribute; scripts and styles stay untouched.
      if (i % 2 === 1) return /^<(script|style|textarea|!--)/i.test(part) ? part : part.replace(TOKEN, (_m, _n: string, fallback?: string) => (fallback ?? '').trim());
      return part.replace(TOKEN, (_m, name: string, fallback?: string) => {
        const v = (params.get(name) ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
        // The fallback was escaped once by the page renderer; a value from the URL is escaped here.
        return v ? escapeHtml(v) : (fallback ?? '').trim();
      });
    })
    .join('');
}

/** True when a page (its blocks and SEO texts) uses a URL placeholder or condition at all. */
export const usesUrlParams = (page: any) => /\{\{\s*(?:#(?:if|unless)\s+(?:not\s+|!)?)?(?:url|query)\./.test(JSON.stringify([page?.blocks ?? [], page?.seo ?? {}]));

/** Condition blocks first (on the text between tags and in attributes alike – only a branch is chosen), then the placeholders. */
export function renderUrlText(html: string, params: URLSearchParams): string {
  const url = Object.fromEntries([...params.entries()].map(([k, v]) => [k, v.slice(0, 200)]));
  const body = html.includes('{{#') ? applyConditions(html, { url, query: url }) : html;
  return fillUrlParams(body, params);
}

export const siteDyntextModule: Module = {
  name: 'site-dyntext',
  register(app: App) {
    app.services.pageServe = [
      ...(app.services.pageServe ?? []),
      (ctx: Ctx, _f: any, page: any) => (usesUrlParams(page) ? { transform: (h: string) => renderUrlText(h, ctx.query ?? new URLSearchParams()), headers: { 'cache-control': 'private, no-cache' } } : undefined),
    ];
  },
};
