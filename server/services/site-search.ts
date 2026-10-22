/**
 * Site builder: the site search (pure). Documents are the pages, blog posts and CMS items of one site; the search folds case and
 * umlauts ("Bäcker" finds "baecker"/"backer"), matches word beginnings and ranks title hits above text hits.
 */

export interface SearchDoc {
  /** page, post or the CMS collection's name */
  kind: string;
  title: string;
  url: string;
  text: string;
  /** shown in the result list, e.g. the collection name */
  label?: string;
}
export interface SearchHit extends SearchDoc {
  score: number;
  snippet: string;
}

const MAP: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', Ä: 'ae', Ö: 'oe', Ü: 'ue' };

/** Lower case, umlauts as ae/oe/ue/ss, other accents dropped. */
export function fold(s: string): string {
  return String(s ?? '')
    .replace(/[äöüßÄÖÜ]/g, (c) => MAP[c])
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
}

export function terms(q: string): string[] {
  return [...new Set(fold(q).split(/[^a-z0-9]+/).filter((t) => t.length >= 2))].slice(0, 8);
}

function count(hay: string, term: string): { exact: number; prefix: number } {
  let exact = 0;
  let prefix = 0;
  let i = hay.indexOf(term);
  while (i >= 0 && exact + prefix < 50) {
    const before = i === 0 || /[^a-z0-9]/.test(hay[i - 1]);
    if (before) {
      const after = i + term.length >= hay.length || /[^a-z0-9]/.test(hay[i + term.length]);
      if (after) exact++;
      else prefix++;
    }
    i = hay.indexOf(term, i + term.length);
  }
  return { exact, prefix };
}

/** A passage of the text around the first hit, with the hit words in <mark>-free plain text (the page escapes it). */
export function snippet(text: string, ts: string[], max = 170): string {
  const plain = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!plain) return '';
  const f = fold(plain);
  let at = -1;
  for (const t of ts) {
    const i = f.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return plain.length > max ? `${plain.slice(0, max).trimEnd()} …` : plain;
  // folding can change the length (ä → ae); the position is close enough for a window
  const start = Math.max(0, Math.min(plain.length - 1, at) - 50);
  const slice = plain.slice(start, start + max);
  return `${start > 0 ? '… ' : ''}${slice.trim()}${start + max < plain.length ? ' …' : ''}`;
}

/** Documents that contain every word (as a word or the start of one), best first. */
export function search(docs: SearchDoc[], q: string, limit = 20): SearchHit[] {
  const ts = terms(q);
  if (!ts.length) return [];
  const hits: SearchHit[] = [];
  for (const d of docs) {
    const title = fold(d.title);
    const body = fold(d.text);
    let score = 0;
    let all = true;
    for (const t of ts) {
      const a = count(title, t);
      const b = count(body, t);
      const s = a.exact * 10 + a.prefix * 6 + Math.min(b.exact, 8) * 2 + Math.min(b.prefix, 8);
      if (!s) {
        all = false;
        break;
      }
      score += s;
    }
    if (!all) continue;
    if (title.includes(fold(q).trim())) score += 8;
    hits.push({ ...d, score, snippet: snippet(d.text, ts) });
  }
  return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}
