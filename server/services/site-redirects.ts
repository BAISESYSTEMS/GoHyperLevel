/**
 * Site builder: redirect rules of a site (pure). A rule sends a path of the site (`/alt-seite`, or with a wildcard `/blog/*`)
 * to another path or address with 301 (dauerhaft) or 302 (vorübergehend). Wildcards capture what `*` stood for: `/blog/*` →
 * `/news/$1` (also `:splat`) turns `/blog/2020/post` into `/news/2020/post`. Exact rules win over wildcards, longer wildcards over
 * shorter ones; the query string (UTM parameters …) is kept unless the target has its own.
 */

export const REDIRECT_CODES = [301, 302, 307, 308] as const;
export const MAX_RULES = 500;

export interface RedirectRule {
  id: string;
  source: string;
  target: string;
  code: number;
  wildcard: boolean;
  keep_query: boolean;
  position?: number;
}

/** `/Foo//bar/?x=1#y` → `/foo/bar` – what rules and requests are compared as (case-insensitive, no trailing slash). */
export function normPath(p: string): string {
  let s = String(p ?? '').split('#')[0].split('?')[0].trim();
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep as typed */
  }
  s = `/${s}`.replace(/\/{2,}/g, '/').toLowerCase();
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s || '/';
}

/** Source of a rule as typed: a path (never a full address), `*` allowed. Throws a German message when it cannot be one. */
export function cleanSource(raw: unknown): { source: string; wildcard: boolean } {
  let s = String(raw ?? '').trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      s = new URL(s).pathname;
    } catch {
      /* falls through to the check below */
    }
  }
  if (!s) throw new Error('Quelle fehlt – z. B. /alte-seite');
  if (s.length > 300 || /[\s"'<>\\?#]/.test(s)) throw new Error('Quelle: nur ein Pfad ohne Leerzeichen, ? und # (z. B. /alte-seite oder /blog/*)');
  const source = normPath(s).replace(/%2a/gi, '*');
  const wildcard = source.includes('*');
  if (source === '/' && !wildcard) throw new Error('Die Startseite lässt sich nicht umleiten');
  // The app's own paths (a connected domain passes them through to the app, see funnels.ts).
  if (/^\/api(\/|$)|^\/(f|book|uploads|uploads-opt|i|r|u|chat|l|t|s)\//.test(source)) throw new Error('Dieser Pfad gehört der App und kann nicht umgeleitet werden');
  return { source, wildcard };
}

/** Target as typed: a path of the site or an https/http address. */
export function cleanTarget(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error('Ziel fehlt – ein Pfad wie /neue-seite oder eine https-Adresse');
  if (s.length > 800 || /[\s"'<>\\]/.test(s.replace(/\$\d|:splat/g, ''))) throw new Error('Ziel: keine Leerzeichen oder Sonderzeichen');
  if (/^https?:\/\/[^\s/]+/i.test(s)) {
    try {
      new URL(s.replace(/\$\d|:splat/g, 'x'));
    } catch {
      throw new Error('Ziel ist keine gültige Adresse');
    }
    return s;
  }
  if (!s.startsWith('/') || s.startsWith('//')) throw new Error('Ziel: ein Pfad mit / am Anfang (z. B. /neue-seite) oder eine https-Adresse');
  return s;
}

const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

function regexOf(source: string): RegExp {
  // `/blog/*` also matches `/blog` itself (the folder page); other stars match any run of characters.
  const body = source.endsWith('/*') ? `${source.slice(0, -2).split('*').map(esc).join('(.*)')}(?:/(.*))?` : source.split('*').map(esc).join('(.*)');
  return new RegExp(`^${body}$`, 'i');
}

export interface Match {
  rule: RedirectRule;
  /** The target with captures filled in (path or address). */
  to: string;
}

/** The rule a path falls under (exact first, then the longest wildcard), with the finished target. */
export function matchRedirect(rules: RedirectRule[], path: string): Match | undefined {
  const p = normPath(path);
  const sorted = [...rules].sort((a, b) => Number(a.wildcard) - Number(b.wildcard) || b.source.replace(/\*/g, '').length - a.source.replace(/\*/g, '').length || (a.position ?? 0) - (b.position ?? 0));
  for (const r of sorted) {
    if (!r.wildcard) {
      if (normPath(r.source) === p) return { rule: r, to: r.target };
      continue;
    }
    const m = regexOf(normPath(r.source).replace(/%2a/g, '*')).exec(p);
    if (!m) continue;
    const caps = m.slice(1).map((c) => c ?? '');
    const to = r.target.replace(/\$(\d)/g, (_x, n) => caps[Number(n) - 1] ?? '').replace(/:splat/g, caps.filter(Boolean).join('/'));
    return { rule: r, to };
  }
  return undefined;
}

/** Would adding/changing this rule make a loop (a → b → a)? Follows up to 10 hops over the site's own rules. */
export function findLoop(rules: RedirectRule[], next: RedirectRule): string | undefined {
  const all = [...rules.filter((r) => r.id !== next.id), next];
  let at = next.wildcard ? normPath(next.source.replace(/\*/g, 'x')) : normPath(next.source);
  const seen = new Set<string>([at]);
  let to = next.target;
  for (let i = 0; i < 10; i++) {
    if (/^https?:\/\//i.test(to)) return undefined;
    const path = normPath(to.replace(/\$\d|:splat/g, 'x'));
    if (seen.has(path)) return `Umleitungs-Schleife: ${[...seen, path].join(' → ')}`;
    seen.add(path);
    const m = matchRedirect(all, path);
    if (!m) return undefined;
    to = m.to;
    at = path;
  }
  return `Zu viele Umleitungen hintereinander ab ${at}`;
}

/** The absolute address the visitor is sent to: relative targets live on the site's own root. */
export function resolveTarget(to: string, root: string, query: string, keepQuery: boolean): string {
  const base = /^https?:\/\//i.test(to) ? to : to === '/' ? root : `${root.replace(/\/$/, '')}${to}`;
  if (!keepQuery || !query || base.includes('?')) return base;
  const hash = base.indexOf('#');
  return hash >= 0 ? `${base.slice(0, hash)}${query}${base.slice(hash)}` : `${base}${query}`;
}

/** Lines like `/alt -> /neu`, `/alt /neu 302` or `/blog/* → /news/$1` (also a CSV with `;` or `,`): rules to import, with problems per line. */
export function parseRuleLines(text: string): { rules: { source: string; target: string; code: number }[]; errors: string[] } {
  const rules: { source: string; target: string; code: number }[] = [];
  const errors: string[] = [];
  String(text ?? '')
    .split(/\r?\n/)
    .slice(0, 1000)
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const parts = line.split(/\s*(?:->|→|=>|;|,|\t)\s*|\s+/).filter(Boolean);
      const code = /^30[1278]$/.test(parts[2] ?? '') ? Number(parts[2]) : 301;
      try {
        rules.push({ source: cleanSource(parts[0]).source, target: cleanTarget(parts[1]), code });
      } catch (e) {
        errors.push(`Zeile ${i + 1}: ${(e as Error).message}`);
      }
    });
  return { rules, errors };
}
