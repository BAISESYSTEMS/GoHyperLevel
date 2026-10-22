import { bad } from '../core/http.js';
import { addDaysYmd, weekdayKey, ymdInTz, zonedToUtc, type DayKey } from '../core/time.js';
import { newBlock, newSection, emptyDesign, type EmailDesign } from './email-render.js';

/**
 * Content-Recycling for the Video-Studio – pure building blocks: which pieces exist, the prompts and
 * JSON schemas for the AI assistant, cleaning AI output and user edits, the Markdown/e-mail design a
 * piece becomes, RSS/Atom parsing for the autopilot and its posting slots. No database, no network.
 */

export type RecycleKind = 'blog' | 'newsletter' | 'linkedin' | 'x_thread' | 'instagram' | 'facebook' | 'youtube' | 'shownotes' | 'community' | 'lesson';
type Needs = 'blog' | 'campaigns' | 'social' | 'community' | 'courses' | null;

export const RECYCLE_KINDS: Record<RecycleKind, { label: string; icon: string; needs: Needs; platforms?: string[]; draft: boolean }> = {
  blog: { label: 'Blog-Beitrag', icon: 'blog', needs: 'blog', draft: true },
  newsletter: { label: 'Newsletter', icon: 'email', needs: 'campaigns', draft: true },
  linkedin: { label: 'LinkedIn-Beitrag', icon: 'social', needs: 'social', platforms: ['linkedin', 'linkedin-page'], draft: true },
  x_thread: { label: 'X-Thread', icon: 'social', needs: 'social', platforms: ['x'], draft: true },
  instagram: { label: 'Instagram-Caption', icon: 'instagram', needs: 'social', platforms: ['instagram', 'instagram-standalone'], draft: true },
  facebook: { label: 'Facebook-Beitrag', icon: 'social', needs: 'social', platforms: ['facebook'], draft: true },
  youtube: { label: 'YouTube-Beschreibung & 10 Titel', icon: 'play', needs: null, draft: false },
  shownotes: { label: 'Podcast-Shownotes', icon: 'doc', needs: null, draft: false },
  community: { label: 'Community-Beitrag', icon: 'community', needs: 'community', draft: false },
  lesson: { label: 'Lektion-Teaser', icon: 'courses', needs: 'courses', draft: false },
};
export const KIND_KEYS = Object.keys(RECYCLE_KINDS) as RecycleKind[];
export const isKind = (k: unknown): k is RecycleKind => typeof k === 'string' && k in RECYCLE_KINDS;
export const SOCIAL_KINDS: RecycleKind[] = ['linkedin', 'x_thread', 'instagram', 'facebook'];

export const LANGUAGES: Record<string, string> = { auto: 'Sprache des Videos', de: 'Deutsch', en: 'Englisch', es: 'Spanisch', fr: 'Französisch', it: 'Italienisch', nl: 'Niederländisch' };

// --- transcript ---------------------------------------------------------------------------------

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

/** Word timeline ({w, s, e} from OpenShorts' EDL) → lines with a time mark about every 30 s. */
export function transcriptFromWords(words: { w?: unknown; s?: unknown; e?: unknown }[], every = 30, maxChars = 120_000): string {
  const lines: string[] = [];
  let cur: string[] = [];
  let start = -1;
  for (const x of Array.isArray(words) ? words : []) {
    const w = String(x?.w ?? '').trim();
    const s = Number(x?.s);
    if (!w || !Number.isFinite(s)) continue;
    if (start < 0) start = s;
    if (s - start >= every && cur.length) {
      lines.push(`[${fmtTime(start)}] ${cur.join(' ')}`);
      cur = [];
      start = s;
    }
    cur.push(w);
  }
  if (cur.length) lines.push(`[${fmtTime(Math.max(0, start))}] ${cur.join(' ')}`);
  const text = lines.join('\n').replace(/ ([,.!?;:])/g, '$1');
  if (text.length <= maxChars) return text;
  // Very long videos: keep beginning and end, the middle is summarised by the clips anyway.
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n[…]\n${text.slice(-half)}`;
}

export interface RecycleContext {
  title: string;
  sourceUrl: string | null;
  language: string;
  locationName: string;
  durationSec: number | null;
  clips: { title: string; description: string; start: number | null; end: number | null; score: number | null; hook: string }[];
}

export function systemBlocks(c: RecycleContext, transcript: string) {
  const lang = c.language === 'auto' || !LANGUAGES[c.language] ? 'in der Sprache des Transkripts' : `auf ${LANGUAGES[c.language]}`;
  const clips = c.clips
    .slice(0, 8)
    .map((x) => `- ${x.start !== null && x.end !== null ? `[${fmtTime(x.start)}–${fmtTime(x.end)}] ` : ''}${x.title}${x.score !== null ? ` (Viralität ${x.score}/100)` : ''}${x.description ? ` – ${x.description}` : ''}`)
    .join('\n');
  return [
    {
      text:
        `Du bist Content-Redakteur für „${c.locationName}“ und machst aus einem Video weitere Inhalte. ` +
        'Nutze nur, was im Transkript und in den Clip-Infos steht: keine erfundenen Fakten, Zahlen, Namen oder Zitate. ' +
        'Schreibe klar und konkret, ohne Floskeln und ohne Emojis-Spam. ' +
        `Schreibe ${lang}. Antworte ausschließlich im verlangten JSON.`,
    },
    {
      text: `Video: ${c.title}\n${c.sourceUrl ? `Quelle: ${c.sourceUrl}\n` : ''}${c.durationSec ? `Länge: ${fmtTime(c.durationSec)}\n` : ''}${clips ? `Beste Clips:\n${clips}\n` : ''}\nTranskript mit Zeitmarken:\n${transcript || '(kein Transkript verfügbar – nur die Clip-Infos nutzen)'}`,
      cache: true,
    },
  ];
}

// --- prompts and schemas -------------------------------------------------------------------------

const S = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra });
const obj = (props: Record<string, unknown>) => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });
const arr = (items: unknown) => ({ type: 'array', items });
const chapter = obj({ time: S('string'), title: S('string') });

export function promptFor(kind: RecycleKind): { user: string; schema: Record<string, unknown>; maxTokens: number } {
  switch (kind) {
    case 'blog':
      return {
        user: 'Schreibe daraus einen Blog-Beitrag: Titel (max. 80 Zeichen), Kurzbeschreibung (max. 300 Zeichen), Text in Markdown mit kurzer Einleitung und 3–6 Zwischenüberschriften (## …), konkrete Tipps und Beispiele aus dem Video, Schluss mit Handlungsaufforderung, 700–1200 Wörter, keine H1. Dazu SEO-Titel (max. 60 Zeichen), Meta-Beschreibung (max. 155 Zeichen) und 3–6 Tags.',
        schema: obj({ title: S('string'), excerpt: S('string'), markdown: S('string'), seo_title: S('string'), seo_description: S('string'), tags: arr(S('string')) }),
        maxTokens: 6000,
      };
    case 'newsletter':
      return {
        user: 'Schreibe daraus einen Newsletter: Betreff (max. 60 Zeichen, neugierig machend), Vorschautext (max. 110 Zeichen), Überschrift, Einleitung (2–3 Sätze, ohne Anrede – die setzen wir), genau 3 wichtigste Erkenntnisse (je Titel + 1–2 Sätze) und einen Button-Text (max. 30 Zeichen) zum Video.',
        schema: obj({ subject: S('string'), preheader: S('string'), headline: S('string'), intro: S('string'), takeaways: arr(obj({ title: S('string'), text: S('string') })), cta_label: S('string') }),
        maxTokens: 2500,
      };
    case 'linkedin':
      return {
        user: 'Schreibe daraus einen LinkedIn-Beitrag (1200–2000 Zeichen): starke erste Zeile, kurze Absätze, eine konkrete Erkenntnis oder Geschichte aus dem Video, Frage an die Leser am Ende, 3–5 passende Hashtags in der letzten Zeile.',
        schema: obj({ text: S('string') }),
        maxTokens: 1800,
      };
    case 'x_thread':
      return {
        user: 'Schreibe daraus einen X-Thread mit 4–8 Posts, jeder höchstens 270 Zeichen: Post 1 ist der Hook, dann je ein Gedanke, der letzte Post verweist auf das Video. Keine Nummerierung wie „1/“ nötig.',
        schema: obj({ tweets: arr(S('string')) }),
        maxTokens: 1800,
      };
    case 'instagram':
      return {
        user: 'Schreibe daraus eine Instagram-Caption für den besten Clip (Reel): Hook in der ersten Zeile, 3–6 kurze Zeilen Inhalt, Handlungsaufforderung, höchstens 1800 Zeichen ohne Hashtags. Dazu 6–10 passende Hashtags separat.',
        schema: obj({ caption: S('string'), hashtags: arr(S('string')) }),
        maxTokens: 1400,
      };
    case 'facebook':
      return {
        user: 'Schreibe daraus einen Facebook-Beitrag (400–900 Zeichen): persönlich, ein konkreter Nutzen aus dem Video, Frage oder Handlungsaufforderung am Ende, höchstens 3 Hashtags.',
        schema: obj({ text: S('string') }),
        maxTokens: 1200,
      };
    case 'youtube':
      return {
        user: 'Erstelle für das lange Video auf YouTube: genau 10 Titel-Ideen (je max. 70 Zeichen, neugierig, ehrlich), eine Beschreibung (Einleitung in 2–3 Sätzen) und Kapitelmarken aus den Zeitmarken des Transkripts (erstes Kapitel 00:00, 4–12 Kapitel, Format mm:ss oder h:mm:ss) sowie 3–5 Hashtags.',
        schema: obj({ titles: arr(S('string')), intro: S('string'), chapters: arr(chapter), hashtags: arr(S('string')) }),
        maxTokens: 2500,
      };
    case 'shownotes':
      return {
        user: 'Schreibe Podcast-Shownotes: Titel, Zusammenfassung (3–5 Sätze), Kapitel aus den Zeitmarken (erstes 00:00), 3–7 Kernaussagen und 0–3 wörtliche Zitate (nur exakt so, wie sie im Transkript stehen).',
        schema: obj({ title: S('string'), summary: S('string'), chapters: arr(chapter), key_points: arr(S('string')), quotes: arr(S('string')) }),
        maxTokens: 2500,
      };
    case 'community':
      return {
        user: 'Schreibe einen Beitrag für die Community (Mitgliederbereich): Titel (max. 100 Zeichen) und Text in Markdown (600–1200 Zeichen) mit der wichtigsten Erkenntnis aus dem Video und einer Frage an die Mitglieder am Ende.',
        schema: obj({ title: S('string'), body: S('string') }),
        maxTokens: 1400,
      };
    case 'lesson':
      return {
        user: 'Schreibe einen Teaser für eine Kurs-Lektion, der den besten Clip als Vorschau zeigt: kurze Überschrift (max. 60 Zeichen) und 2–3 Sätze, warum sich die Lektion lohnt.',
        schema: obj({ title: S('string'), teaser: S('string') }),
        maxTokens: 800,
      };
  }
}

/** The AI answers JSON (structured outputs); tolerate code fences anyway. */
export function parseJsonAnswer(text: string): any {
  const t = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Die KI hat kein gültiges JSON geliefert');
  }
}

// --- cleaning (AI output and user edits) -----------------------------------------------------------

const txt = (v: unknown, max: number) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
const list = (v: unknown, maxItems: number, maxLen: number) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : []).map((x) => txt(x, maxLen)).filter(Boolean).slice(0, maxItems);
const tags = (v: unknown, max = 15) => [...new Set(list(v, 40, 60).flatMap((t) => t.split(/[\s,]+/)).map((t) => t.replace(/^#*/, '')).filter((t) => /^[\p{L}\p{N}_]{1,60}$/u.test(t)).map((t) => `#${t}`))].slice(0, max);
const TIME = /^(\d{1,2}:)?\d{1,2}:\d{2}$/;
const chapters = (v: unknown) =>
  (Array.isArray(v) ? v : [])
    .map((c: any) => ({ time: txt(c?.time, 9), title: txt(c?.title, 120) }))
    .filter((c) => TIME.test(c.time) && c.title)
    .slice(0, 30);

export function cleanContent(kind: RecycleKind, raw: any): Record<string, any> {
  const r = raw && typeof raw === 'object' ? raw : {};
  switch (kind) {
    case 'blog':
      return { title: txt(r.title, 200), excerpt: txt(r.excerpt, 600), markdown: txt(r.markdown, 60_000), seo_title: txt(r.seo_title, 200), seo_description: txt(r.seo_description, 400), tags: list(r.tags, 20, 40).map((t) => t.replace(/^#/, '')) };
    case 'newsletter':
      return {
        subject: txt(r.subject, 200),
        preheader: txt(r.preheader, 200),
        headline: txt(r.headline, 200),
        intro: txt(r.intro, 3000),
        takeaways: (Array.isArray(r.takeaways) ? r.takeaways : []).slice(0, 5).map((t: any) => ({ title: txt(t?.title, 200), text: txt(t?.text, 1000) })).filter((t: any) => t.title || t.text),
        cta_label: txt(r.cta_label, 60) || 'Video ansehen',
        cta_url: /^https:\/\/\S+$/i.test(String(r.cta_url ?? '')) ? txt(r.cta_url, 1000) : '',
      };
    case 'linkedin':
    case 'facebook':
      return { text: txt(r.text, kind === 'linkedin' ? 3000 : 5000) };
    case 'x_thread':
      return { tweets: list(r.tweets, 15, 280) };
    case 'instagram':
      return { caption: txt(r.caption, 2100), hashtags: tags(r.hashtags, 20) };
    case 'youtube':
      return { titles: list(r.titles, 12, 100), intro: txt(r.intro, 3000), chapters: chapters(r.chapters), hashtags: tags(r.hashtags, 8) };
    case 'shownotes':
      return { title: txt(r.title, 200), summary: txt(r.summary, 3000), chapters: chapters(r.chapters), key_points: list(r.key_points, 10, 400), quotes: list(r.quotes, 5, 400) };
    case 'community':
      return { title: txt(r.title, 120), body: txt(r.body, 10_000) };
    case 'lesson':
      return { title: txt(r.title, 120), teaser: txt(r.teaser, 1500) };
  }
}

/** A piece must have its essential parts before it can be used. */
export function assertUsable(kind: RecycleKind, c: Record<string, any>) {
  const need: Record<RecycleKind, [string, string][]> = {
    blog: [['title', 'Titel'], ['markdown', 'Text']],
    newsletter: [['subject', 'Betreff'], ['intro', 'Einleitung']],
    linkedin: [['text', 'Text']],
    facebook: [['text', 'Text']],
    x_thread: [['tweets', 'Posts']],
    instagram: [['caption', 'Caption']],
    youtube: [['titles', 'Titel']],
    shownotes: [['summary', 'Zusammenfassung']],
    community: [['title', 'Titel'], ['body', 'Text']],
    lesson: [['teaser', 'Teaser']],
  };
  for (const [k, label] of need[kind]) {
    const v = c[k];
    if (Array.isArray(v) ? !v.length : !String(v ?? '').trim()) throw bad(`${label} fehlt`);
  }
}

// --- what a piece becomes ----------------------------------------------------------------------------

export function chaptersText(ch: { time: string; title: string }[]): string {
  return ch.map((c) => `${c.time} ${c.title}`).join('\n');
}

export function youtubeDescription(c: Record<string, any>): string {
  return [c.intro, c.chapters?.length ? `Kapitel:\n${chaptersText(c.chapters)}` : '', (c.hashtags ?? []).join(' ')].filter(Boolean).join('\n\n');
}

/** Plain text of a piece (copy button, documents, social posts). */
export function asText(kind: RecycleKind, c: Record<string, any>): string {
  switch (kind) {
    case 'blog':
      return `# ${c.title}\n\n${c.markdown}`;
    case 'newsletter':
      return [`Betreff: ${c.subject}`, c.headline, c.intro, ...(c.takeaways ?? []).map((t: any, i: number) => `${i + 1}. ${t.title}: ${t.text}`)].filter(Boolean).join('\n\n');
    case 'linkedin':
    case 'facebook':
      return c.text;
    case 'x_thread':
      return (c.tweets ?? []).join('\n\n');
    case 'instagram':
      return [c.caption, (c.hashtags ?? []).join(' ')].filter(Boolean).join('\n\n');
    case 'youtube':
      return `${(c.titles ?? []).map((t: string, i: number) => `${i + 1}. ${t}`).join('\n')}\n\n${youtubeDescription(c)}`;
    case 'shownotes':
      return [c.title, c.summary, c.chapters?.length ? `Kapitel:\n${chaptersText(c.chapters)}` : '', c.key_points?.length ? `Kernaussagen:\n${c.key_points.map((p: string) => `• ${p}`).join('\n')}` : '', c.quotes?.length ? `Zitate:\n${c.quotes.map((q: string) => `„${q}“`).join('\n')}` : ''].filter(Boolean).join('\n\n');
    case 'community':
      return `${c.title}\n\n${c.body}`;
    case 'lesson':
      return `${c.title}\n\n${c.teaser}`;
  }
}

/** Blog Markdown with the video (a URL on its own line embeds as player) after the introduction. */
export function blogMarkdown(c: Record<string, any>, embedUrl: string | null): string {
  const md = String(c.markdown ?? '').trim();
  if (!embedUrl) return md;
  const at = md.search(/^##\s/m);
  return at > 0 ? `${md.slice(0, at).trimEnd()}\n\n${embedUrl}\n\n${md.slice(at)}` : `${embedUrl}\n\n${md}`;
}

export function youtubeId(url: string | null | undefined): string | null {
  const m = String(url ?? '').match(/(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{6,})/i);
  return m ? m[1] : null;
}

/** Newsletter as e-mail-builder design: greeting, video, 3 takeaways, clips, button, footer (needed for campaigns). */
export function newsletterDesign(c: Record<string, any>, media: { videoUrl: string | null; videoThumb: string | null; clips: { title: string; url: string; thumb: string | null }[]; ctaUrl: string | null; color?: string }): EmailDesign {
  const d = emptyDesign();
  d.settings.preheader = String(c.preheader ?? '').slice(0, 200);
  const color = /^#[0-9a-f]{6}$/i.test(media.color ?? '') ? media.color! : '#2563eb';
  const one = (...blocks: ReturnType<typeof newBlock>[]) => d.sections.push(newSection(1, [blocks]));
  one(newBlock('heading', { text: c.headline || c.subject, level: 1 }, { paddingY: 18 }), newBlock('text', { text: `Hallo {{contact.first_name|du}},\n\n${c.intro}` }));
  if (media.videoUrl && media.videoThumb) one(newBlock('video', { url: media.videoUrl, thumbnail: media.videoThumb, alt: 'Video ansehen', caption: '▶ Video ansehen' }));
  if (c.takeaways?.length) {
    one(
      newBlock('heading', { text: c.takeaways.length === 3 ? 'Die 3 wichtigsten Punkte' : 'Die wichtigsten Punkte', level: 2 }),
      newBlock('text', { text: c.takeaways.map((t: any, i: number) => `**${i + 1}. ${t.title}**\n${t.text}`).join('\n\n') }),
    );
  }
  const clips = media.clips.slice(0, 3);
  if (clips.length) {
    one(newBlock('heading', { text: 'Die besten Momente als Kurzvideo', level: 3 }, { paddingY: 8 }));
    if (clips.every((x) => x.thumb)) {
      const widths = clips.length === 3 ? [33, 34, 33] : clips.length === 2 ? [50, 50] : [100];
      d.sections.push(newSection(clips.length, clips.map((x) => [newBlock('image', { src: x.thumb, alt: x.title, href: x.url, width: 0 }, { paddingX: 8 }), newBlock('text', { text: `[▶ ${x.title}](${x.url})` }, { paddingX: 8, fontSize: 14, align: 'center' })]), widths));
    } else one(newBlock('text', { text: clips.map((x) => `▶ [${x.title}](${x.url})`).join('\n') }));
  }
  const cta = c.cta_url || media.ctaUrl;
  if (cta) one(newBlock('button', { label: c.cta_label || 'Video ansehen', href: cta, background: color }));
  one(newBlock('footer', {}));
  return d;
}

// --- autopilot: feeds and slots --------------------------------------------------------------------

const decodeXml = (s: string) =>
  s
    .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();
const tagOf = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeXml(m[1]) : '';
};
const attrOf = (xml: string, name: string, attr: string) => {
  const m = xml.match(new RegExp(`<${name}\\b([^>]*)/?>`, 'i'));
  const a = m?.[1].match(new RegExp(`\\b${attr}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return a ? decodeXml(a[1]) : '';
};

export interface FeedEntry {
  id: string;
  title: string;
  url: string | null;
  published: string | null;
  /** audio = podcast without video (OpenShorts needs a picture). */
  media: 'video' | 'audio' | 'none';
}

export function parseYouTubeFeed(xml: string): FeedEntry[] {
  return [...String(xml).matchAll(/<entry\b[\s\S]*?<\/entry>/gi)]
    .map((m) => {
      const e = m[0];
      const id = tagOf(e, 'yt:videoId');
      const href = e.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)?.[1] ?? (id ? `https://www.youtube.com/watch?v=${id}` : '');
      return { id, title: tagOf(e, 'title').slice(0, 300), url: href ? decodeXml(href) : null, published: tagOf(e, 'published') || null, media: 'video' as const };
    })
    .filter((x) => /^[\w-]{6,20}$/.test(x.id));
}

export function parsePodcastFeed(xml: string): FeedEntry[] {
  return [...String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi)]
    .map((m) => {
      const it = m[0];
      const encUrl = attrOf(it, 'enclosure', 'url');
      const encType = attrOf(it, 'enclosure', 'type').toLowerCase();
      const link = tagOf(it, 'link');
      const guid = tagOf(it, 'guid') || encUrl || link;
      const video = encType.startsWith('video/') || /\.(mp4|m4v|mov|webm)(\?|$)/i.test(encUrl);
      const yt = youtubeId(link) ? link : null;
      const url = video ? encUrl : yt ?? (encUrl || null);
      const media: FeedEntry['media'] = video || yt ? 'video' : encUrl ? 'audio' : 'none';
      return { id: guid.slice(0, 300), title: tagOf(it, 'title').slice(0, 300), url: url && /^https?:\/\//i.test(url) ? url : null, published: tagOf(it, 'pubDate') || null, media };
    })
    .filter((x) => x.id);
}

/** Channel ID (UC…), channel URL or feed URL → the channel's Atom feed; null for @handles (no ID in the URL). */
export function youtubeFeedUrl(input: string): string | null {
  const s = String(input ?? '').trim();
  const direct = s.match(/^(UC[\w-]{22})$/);
  if (direct) return `https://www.youtube.com/feeds/videos.xml?channel_id=${direct[1]}`;
  try {
    const u = new URL(s);
    if (!/(^|\.)youtube\.com$/i.test(u.hostname)) return null;
    const id = u.searchParams.get('channel_id') ?? u.pathname.match(/^\/channel\/(UC[\w-]{22})/)?.[1];
    if (id && /^UC[\w-]{22}$/.test(id)) return `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;
    const pl = u.pathname === '/feeds/videos.xml' ? u.searchParams.get('playlist_id') : u.pathname === '/playlist' ? u.searchParams.get('list') : null;
    if (pl && /^[\w-]{10,64}$/.test(pl)) return `https://www.youtube.com/feeds/videos.xml?playlist_id=${pl}`;
  } catch {
    /* not a URL */
  }
  return null;
}

export const DAY_LABELS: [DayKey, string][] = [
  ['mon', 'Mo'],
  ['tue', 'Di'],
  ['wed', 'Mi'],
  ['thu', 'Do'],
  ['fri', 'Fr'],
  ['sat', 'Sa'],
  ['sun', 'So'],
];

/** The next `count` posting slots after `after` (local times on the chosen weekdays). */
export function nextSlots(count: number, o: { times: string[]; days: string[]; tz: string; after: Date }): Date[] {
  const times = [...new Set(o.times.filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))].sort();
  const days = o.days.length ? o.days : ['mon', 'tue', 'wed', 'thu', 'fri'];
  if (!times.length || count < 1) return [];
  const out: Date[] = [];
  const first = ymdInTz(o.after, o.tz);
  for (let i = 0; i < 120 && out.length < count; i++) {
    const day = addDaysYmd(first, i);
    if (!days.includes(weekdayKey(day))) continue;
    for (const t of times) {
      const at = zonedToUtc(day, t, o.tz);
      if (at.getTime() > o.after.getTime()) out.push(at);
      if (out.length >= count) break;
    }
  }
  return out;
}
