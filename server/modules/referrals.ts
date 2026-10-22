import type { Module } from '../core/app.js';
import { bad, type RawResult } from '../core/http.js';
import { now } from '../core/util.js';
import type { Tool } from './mcp.js';

/**
 * Provider sign-up links ("Konto anlegen") next to every place where HyperLevel asks for a third-party
 * key or account. A link may be a referral (partner) link of the maintainer – always labelled in
 * the UI, and replaceable or switchable off by every self-hoster:
 *
 *   1. Agentur → Partner-Links (agency_settings key `referrals`: { enabled, links: { id: url | "" } },
 *      "" = plain sign-up link)
 *   2. env PGHL_REFERRALS (JSON map { id: url | "" })
 *   3. REFERRAL_DEFAULTS below
 *   4. the provider's plain sign-up URL
 *
 * PGHL_REFERRALS_DISABLED=1 or `enabled: false` → plain sign-up links only. Only https URLs count.
 * Clicks go through /go/:provider (302 to the resolved URL, counted per provider – no personal data);
 * only catalogue ids redirect, and only to their resolved URL, so it is no open redirect.
 * Docs: docs/referrals.md.
 */

export interface ReferralProvider {
  id: string;
  name: string;
  category: string;
  /** Plain sign-up page without any referral code; null = none known (only a configured link is shown). */
  signup: string | null;
}

const P = (id: string, name: string, category: string, signup: string | null): ReferralProvider => ({ id, name, category, signup });

export const REFERRAL_CATEGORIES = ['KI-Modelle', 'KI-Medien', 'Daten & Recherche', 'Automatisierung', 'E-Mail', 'SMS & Telefonie', 'Kanäle', 'Zahlungen & Finanzen', 'Hosting & Daten', 'Produktivität', 'Marketing & Analyse'] as const;

/** Every provider HyperLevel (or a feature branch) asks the user to connect. Ids are stable – UI and links use them. */
export const REFERRAL_PROVIDERS: ReferralProvider[] = [
  // AI models (KI-Assistent, BYOK presets of the agent)
  P('openai', 'OpenAI', 'KI-Modelle', 'https://platform.openai.com/signup'),
  P('anthropic', 'Anthropic (Claude)', 'KI-Modelle', 'https://console.anthropic.com/'),
  P('gemini', 'Google Gemini (AI Studio)', 'KI-Modelle', 'https://aistudio.google.com/apikey'),
  P('openrouter', 'OpenRouter', 'KI-Modelle', 'https://openrouter.ai/'),
  P('groq', 'Groq', 'KI-Modelle', 'https://console.groq.com/'),
  P('deepseek', 'DeepSeek', 'KI-Modelle', 'https://platform.deepseek.com/'),
  P('mistral', 'Mistral AI', 'KI-Modelle', 'https://console.mistral.ai/'),
  P('xai', 'xAI (Grok)', 'KI-Modelle', 'https://console.x.ai/'),
  P('together', 'Together AI', 'KI-Modelle', 'https://api.together.ai/'),
  P('fireworks', 'Fireworks AI', 'KI-Modelle', 'https://fireworks.ai/'),
  P('perplexity', 'Perplexity API', 'KI-Modelle', 'https://www.perplexity.ai/settings/api'),
  P('cerebras', 'Cerebras', 'KI-Modelle', 'https://cloud.cerebras.ai/'),
  P('huggingface', 'Hugging Face', 'KI-Modelle', 'https://huggingface.co/join'),
  P('requesty', 'Requesty', 'KI-Modelle', 'https://app.requesty.ai/sign-up'),
  P('vercel', 'Vercel AI Gateway', 'KI-Modelle', 'https://vercel.com/ai-gateway'),
  P('nebius', 'Nebius Token Factory', 'KI-Modelle', 'https://tokenfactory.nebius.com/'),
  P('novita', 'Novita AI', 'KI-Modelle', 'https://novita.ai/'),
  P('hyperbolic', 'Hyperbolic', 'KI-Modelle', 'https://app.hyperbolic.ai/'),
  P('sambanova', 'SambaNova Cloud', 'KI-Modelle', 'https://cloud.sambanova.ai/'),
  P('featherless', 'Featherless', 'KI-Modelle', 'https://featherless.ai/register'),
  P('venice', 'Venice', 'KI-Modelle', 'https://venice.ai/'),
  P('moonshot', 'Moonshot AI (Kimi)', 'KI-Modelle', 'https://platform.kimi.ai/console/api-keys'),
  P('zai', 'Zhipu GLM (Z.ai)', 'KI-Modelle', 'https://z.ai/model-api'),
  P('qwen', 'Alibaba Qwen (Model Studio)', 'KI-Modelle', 'https://modelstudio.console.alibabacloud.com/'),
  P('minimax', 'MiniMax', 'KI-Modelle', 'https://platform.minimax.io/'),
  P('cohere', 'Cohere', 'KI-Modelle', 'https://dashboard.cohere.com/welcome/register'),
  P('ai21', 'AI21 (Jamba)', 'KI-Modelle', 'https://docs.ai21.com/docs/create-api-key'),
  P('ionos', 'IONOS AI Model Hub (EU-Hosting)', 'KI-Modelle', 'https://cloud.ionos.com/'),
  P('stackit', 'STACKIT AI Model Serving (EU-Hosting)', 'KI-Modelle', 'https://portal.stackit.cloud/'),
  P('ovh', 'OVHcloud AI Endpoints (EU-Hosting)', 'KI-Modelle', 'https://www.ovhcloud.com/en/public-cloud/ai-endpoints/'),
  P('scaleway', 'Scaleway Generative APIs (EU-Hosting)', 'KI-Modelle', 'https://console.scaleway.com/register'),
  P('ollama', 'Ollama (lokal)', 'KI-Modelle', null),
  // AI media (images, video, voice)
  P('kie', 'kie.ai', 'KI-Medien', 'https://kie.ai/'),
  P('fal', 'fal.ai', 'KI-Medien', 'https://fal.ai/dashboard'),
  P('replicate', 'Replicate', 'KI-Medien', 'https://replicate.com/signin'),
  P('elevenlabs', 'ElevenLabs', 'KI-Medien', 'https://elevenlabs.io/app/sign-up'),
  P('stability', 'Stability AI', 'KI-Medien', 'https://platform.stability.ai/'),
  P('runway', 'Runway', 'KI-Medien', 'https://dev.runwayml.com/'),
  P('luma', 'Luma AI', 'KI-Medien', 'https://lumalabs.ai/api'),
  // Data & research
  P('monid', 'Monid', 'Daten & Recherche', null),
  P('exa', 'Exa', 'Daten & Recherche', 'https://dashboard.exa.ai/'),
  // Automation
  P('composio', 'Composio', 'Automatisierung', 'https://platform.composio.dev/'),
  P('zapier', 'Zapier', 'Automatisierung', 'https://zapier.com/sign-up'),
  P('make', 'Make', 'Automatisierung', 'https://www.make.com/en/register'),
  P('n8n', 'n8n Cloud', 'Automatisierung', 'https://app.n8n.cloud/register'),
  P('nango', 'Nango', 'Automatisierung', 'https://app.nango.dev/signup'),
  // Email
  P('resend', 'Resend', 'E-Mail', 'https://resend.com/signup'),
  P('postmark', 'Postmark', 'E-Mail', 'https://account.postmarkapp.com/sign_up'),
  P('brevo', 'Brevo', 'E-Mail', 'https://onboarding.brevo.com/account/register'),
  P('mailgun', 'Mailgun', 'E-Mail', 'https://signup.mailgun.com/new/signup'),
  P('aws_ses', 'Amazon SES (AWS)', 'E-Mail', 'https://portal.aws.amazon.com/billing/signup'),
  // SMS & telephony
  P('twilio', 'Twilio', 'SMS & Telefonie', 'https://www.twilio.com/try-twilio'),
  P('seven', 'seven.io', 'SMS & Telefonie', 'https://app.seven.io/signup'),
  P('vonage', 'Vonage', 'SMS & Telefonie', 'https://dashboard.nexmo.com/sign-up'),
  P('plivo', 'Plivo', 'SMS & Telefonie', 'https://console.plivo.com/accounts/register/'),
  P('bird', 'Bird (MessageBird)', 'SMS & Telefonie', 'https://bird.com/'),
  // Channels (developer portals)
  P('telegram', 'Telegram (BotFather)', 'Kanäle', 'https://t.me/BotFather'),
  P('discord', 'Discord Developer Portal', 'Kanäle', 'https://discord.com/developers/applications'),
  P('slack', 'Slack API', 'Kanäle', 'https://api.slack.com/apps'),
  P('meta', 'Meta for Developers', 'Kanäle', 'https://developers.facebook.com/'),
  // Payments & finance
  P('stripe', 'Stripe', 'Zahlungen & Finanzen', 'https://dashboard.stripe.com/register'),
  P('norman', 'Norman Finance', 'Zahlungen & Finanzen', 'https://norman.finance/'),
  // Hosting & data
  P('hostinger', 'Hostinger', 'Hosting & Daten', 'https://www.hostinger.com/vps-hosting'),
  P('hetzner', 'Hetzner', 'Hosting & Daten', 'https://accounts.hetzner.com/signUp'),
  P('supabase', 'Supabase', 'Hosting & Daten', 'https://supabase.com/dashboard/sign-up'),
  P('lovable', 'Lovable', 'Hosting & Daten', 'https://lovable.dev/'),
  P('google_cloud', 'Google Cloud', 'Hosting & Daten', 'https://console.cloud.google.com/'),
  P('cloudflare', 'Cloudflare', 'Hosting & Daten', 'https://dash.cloudflare.com/sign-up'),
  P('sentry', 'Sentry', 'Hosting & Daten', 'https://sentry.io/signup/'),
  // Productivity
  P('todoist', 'Todoist', 'Produktivität', 'https://todoist.com/auth/signup'),
  P('notion', 'Notion', 'Produktivität', 'https://www.notion.so/signup'),
  P('google_workspace', 'Google Workspace', 'Produktivität', 'https://workspace.google.com/'),
  P('microsoft365', 'Microsoft 365', 'Produktivität', 'https://www.microsoft.com/microsoft-365/business'),
  P('calendly', 'Calendly', 'Produktivität', 'https://calendly.com/signup'),
  P('canva', 'Canva', 'Produktivität', 'https://www.canva.com/signup'),
  P('github', 'GitHub', 'Produktivität', 'https://github.com/signup'),
  P('linear', 'Linear', 'Produktivität', 'https://linear.app/signup'),
  P('atlassian', 'Atlassian (Jira & Confluence)', 'Produktivität', 'https://www.atlassian.com/try'),
  // Marketing & analytics
  P('postiz', 'Postiz', 'Marketing & Analyse', 'https://postiz.com/'),
  P('posthog', 'PostHog', 'Marketing & Analyse', 'https://app.posthog.com/signup'),
  P('bitly', 'Bitly', 'Marketing & Analyse', 'https://bitly.com/a/sign_up'),
];

/**
 * ═══ MAINTAINER'S PARTNER LINKS ═══════════════════════════════════════════════════════════════
 * Referral links of the HyperLevel maintainer. Clicking one supports the development of HyperLevel and
 * changes nothing for the person signing up. Empty = the plain sign-up link is used.
 * Self-hosters: replace them under Agentur → Partner-Links, with PGHL_REFERRALS, or switch all of
 * them off with PGHL_REFERRALS_DISABLED=1 (see docs/referrals.md). Only https URLs are used.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
export const REFERRAL_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  // AI models
  openai: '',
  anthropic: '',
  gemini: '',
  openrouter: '',
  groq: '',
  deepseek: '',
  mistral: '',
  xai: '',
  together: '',
  fireworks: '',
  perplexity: '',
  cerebras: '',
  huggingface: '',
  requesty: '',
  vercel: '',
  nebius: '',
  novita: '',
  hyperbolic: '',
  sambanova: '',
  featherless: '',
  venice: '',
  moonshot: '',
  zai: '',
  qwen: '',
  minimax: '',
  cohere: '',
  ai21: '',
  ionos: '',
  stackit: '',
  ovh: '',
  scaleway: '',
  // AI media
  kie: '',
  fal: '',
  replicate: '',
  elevenlabs: '',
  stability: '',
  runway: '',
  luma: '',
  // data & research
  monid: '',
  exa: '',
  // automation
  composio: '',
  zapier: '',
  make: '',
  n8n: '',
  nango: '',
  // email
  resend: '',
  postmark: '',
  brevo: '',
  mailgun: '',
  aws_ses: '',
  // SMS & telephony
  twilio: '',
  seven: '',
  vonage: '',
  plivo: '',
  bird: '',
  // payments & finance
  stripe: '',
  norman: '',
  // hosting & data
  hostinger: '',
  hetzner: '',
  supabase: '',
  lovable: '',
  google_cloud: '',
  cloudflare: '',
  sentry: '',
  // productivity
  todoist: '',
  notion: '',
  google_workspace: '',
  microsoft365: '',
  calendly: '',
  canva: '',
  github: '',
  linear: '',
  atlassian: '',
  // marketing & analytics
  postiz: '',
  posthog: '',
  bitly: '',
});

const BY_ID = new Map(REFERRAL_PROVIDERS.map((p) => [p.id, p]));
export const referralProvider = (id: unknown): ReferralProvider | undefined => (typeof id === 'string' ? BY_ID.get(id) : undefined);

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/i;

/** The URL as https link (normalised), or null: no other schemes, no credentials, no IPs or bare hosts. */
export function safeHttpsUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 2048 || /[\s<>"'`\\]/.test(s) || /[\u0000-\u001f\u007f]/.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !HOST.test(u.hostname)) return null;
  return u.href;
}

export interface ReferralConfig {
  enabled: boolean;
  /** id → own link, or "" for the plain sign-up link. */
  links: Record<string, string>;
}

export type LinkSource = 'agency' | 'env' | 'default' | 'signup';
export interface ResolvedLink {
  url: string | null;
  /** The link differs from the plain sign-up page (partner link). */
  is_referral: boolean;
  source: LinkSource | null;
}

export interface ResolveOptions {
  agency?: ReferralConfig | null;
  env?: Record<string, string> | null;
  defaults?: Readonly<Record<string, string>>;
  /** PGHL_REFERRALS_DISABLED=1 */
  disabled?: boolean;
}

/** Where a provider's "Konto anlegen" goes: agency override → env → defaults → plain sign-up URL. */
export function resolveLink(p: ReferralProvider, o: ResolveOptions = {}): ResolvedLink {
  const plain: ResolvedLink = { url: p.signup, is_referral: false, source: p.signup ? 'signup' : null };
  if (o.disabled || o.agency?.enabled === false) return plain;
  const layers: [LinkSource, Readonly<Record<string, string>> | null | undefined][] = [
    ['agency', o.agency?.links],
    ['env', o.env],
    ['default', o.defaults ?? REFERRAL_DEFAULTS],
  ];
  for (const [source, map] of layers) {
    if (!map || !Object.hasOwn(map, p.id)) continue;
    const v = map[p.id];
    // "" in an override = plain sign-up link on purpose; in the defaults it only means "none yet".
    if (v === '') {
      if (source === 'default') continue;
      return plain;
    }
    const url = safeHttpsUrl(v);
    if (!url) continue;
    return { url, is_referral: url !== p.signup, source };
  }
  return plain;
}

/** PGHL_REFERRALS as map; unknown ids and non-https values are dropped. `invalid` when it is set but no JSON object. */
export function parseEnvLinks(raw: string | undefined): { links: Record<string, string>; invalid: boolean } {
  if (!raw || !raw.trim()) return { links: {}, invalid: false };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { links: {}, invalid: true };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { links: {}, invalid: true };
  const links: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!BY_ID.has(k) || typeof v !== 'string') continue;
    if (v === '') links[k] = '';
    else {
      const url = safeHttpsUrl(v);
      if (url) links[k] = url;
    }
  }
  return { links, invalid: false };
}

export const referralsDisabledByEnv = () => /^(1|true|yes|on)$/i.test(String(process.env.PGHL_REFERRALS_DISABLED ?? '').trim());

/** Stored agency settings, cleaned (unknown ids and invalid URLs are ignored). */
export function cleanConfig(raw: unknown): ReferralConfig {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, any>) : {};
  const links: Record<string, string> = {};
  if (r.links && typeof r.links === 'object' && !Array.isArray(r.links)) {
    for (const [k, v] of Object.entries(r.links)) {
      if (!BY_ID.has(k) || typeof v !== 'string') continue;
      if (v === '') links[k] = '';
      else {
        const url = safeHttpsUrl(v);
        if (url) links[k] = url;
      }
    }
  }
  return { enabled: r.enabled !== false, links };
}

/** Validates PUT /api/agency/referrals; missing fields keep their value, `links[id] = null` removes an override. */
export function patchConfig(prev: ReferralConfig, body: unknown): ReferralConfig {
  const b = body && typeof body === 'object' ? (body as Record<string, any>) : {};
  let enabled = prev.enabled;
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') throw bad('„enabled“ muss true oder false sein');
    enabled = b.enabled;
  }
  let links = prev.links;
  if (b.links !== undefined) {
    if (!b.links || typeof b.links !== 'object' || Array.isArray(b.links)) throw bad('„links“ muss ein Objekt sein');
    links = {};
    for (const [k, v] of Object.entries(b.links as Record<string, unknown>)) {
      const p = BY_ID.get(k);
      if (!p) throw bad(`Unbekannter Anbieter: ${k.slice(0, 40)}`);
      if (v === null || v === undefined) continue;
      if (v === '') {
        links[k] = '';
        continue;
      }
      const url = safeHttpsUrl(v);
      if (!url) throw bad(`${p.name}: nur https-Links sind erlaubt`);
      links[k] = url;
    }
  }
  return { enabled, links };
}

const SETTINGS_KEY = 'referrals';

export const referralsModule: Module = {
  name: 'referrals',
  migrations: [
    [
      '001-init',
      // Only a counter per provider and the day of the last click – no IP, user or browser data.
      `CREATE TABLE referral_clicks (
        provider TEXT PRIMARY KEY, clicks INTEGER NOT NULL DEFAULT 0, partner_clicks INTEGER NOT NULL DEFAULT 0, last_click_on TEXT
      );`,
    ],
  ],
  register(app) {
    const { db, router } = app;

    let cached: ReferralConfig | null = null;
    const config = (): ReferralConfig => {
      if (!cached) {
        const row = db.get('SELECT value FROM agency_settings WHERE key = ?', SETTINGS_KEY);
        let raw: unknown = null;
        try {
          raw = row ? JSON.parse(row.value) : null;
        } catch {
          raw = null;
        }
        cached = cleanConfig(raw);
      }
      return cached;
    };
    const save = (c: ReferralConfig) => {
      db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', SETTINGS_KEY, JSON.stringify(c));
      cached = null;
    };
    const env = () => parseEnvLinks(process.env.PGHL_REFERRALS);
    // Test hook: app.services.referralDefaults replaces REFERRAL_DEFAULTS.
    const defaults = (): Readonly<Record<string, string>> => app.services.referralDefaults ?? REFERRAL_DEFAULTS;
    const resolve = (p: ReferralProvider) => resolveLink(p, { agency: config(), env: env().links, defaults: defaults(), disabled: referralsDisabledByEnv() });

    /** For other modules (e.g. BYOK presets server-side): the /go/ link of a provider, or null. */
    app.services.signupLink = (id: string) => {
      const p = referralProvider(id);
      if (!p) return null;
      const r = resolve(p);
      return r.url ? { id: p.id, name: p.name, url: `${app.baseUrl()}/go/${p.id}`, is_referral: r.is_referral } : null;
    };

    // --- redirect + click counter ---------------------------------------------------------------
    // Only catalogue ids, only to their resolved URL; query strings are ignored (no open redirect).
    router.get('/go/:provider', 'public', (ctx): RawResult => {
      const p = referralProvider(ctx.params.provider);
      const r = p ? resolve(p) : null;
      if (!p || !r?.url) return { __raw: true, status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body: 'Unbekannter Anbieter' };
      db.run(
        `INSERT INTO referral_clicks (provider, clicks, partner_clicks, last_click_on) VALUES (?, 1, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET clicks = clicks + 1, partner_clicks = partner_clicks + excluded.partner_clicks, last_click_on = excluded.last_click_on`,
        p.id,
        r.is_referral ? 1 : 0,
        now().slice(0, 10),
      );
      return { __raw: true, status: 302, headers: { location: r.url, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow' }, body: '' };
    });

    // --- for every logged-in user: what the "Konto anlegen" links show ------------------------
    router.get('/api/referrals', 'user', () => {
      // `sponsor` says whose partner link it is: the maintainer's default or one the operator set.
      const out: Record<string, { name: string; url: string; is_referral: boolean; sponsor?: 'gohigh' | 'operator' }> = {};
      for (const p of REFERRAL_PROVIDERS) {
        const r = resolve(p);
        if (r.url) out[p.id] = { name: p.name, url: `/go/${p.id}`, is_referral: r.is_referral, ...(r.is_referral ? { sponsor: r.source === 'default' ? 'gohigh' : 'operator' } : {}) };
      }
      return out;
    });

    // --- agency: catalogue, defaults, overrides, clicks ------------------------------------------
    const overview = () => {
      const c = config();
      const e = env();
      const clicks = new Map(db.all('SELECT * FROM referral_clicks').map((r) => [r.provider as string, r]));
      const providers = REFERRAL_PROVIDERS.map((p) => {
        const r = resolve(p);
        const k = clicks.get(p.id);
        return {
          id: p.id,
          name: p.name,
          category: p.category,
          signup: p.signup,
          default_url: Object.hasOwn(defaults(), p.id) ? safeHttpsUrl(defaults()[p.id]) : null,
          env_url: Object.hasOwn(e.links, p.id) ? e.links[p.id] : null,
          override: Object.hasOwn(c.links, p.id) ? c.links[p.id] : null,
          url: r.url,
          is_referral: r.is_referral,
          source: r.source,
          go: r.url ? `/go/${p.id}` : null,
          clicks: Number(k?.clicks ?? 0),
          partner_clicks: Number(k?.partner_clicks ?? 0),
          last_click_on: k?.last_click_on ?? null,
        };
      });
      return {
        enabled: c.enabled,
        disabled_by_env: referralsDisabledByEnv(),
        env_set: Object.keys(e.links).length > 0,
        env_invalid: e.invalid,
        categories: REFERRAL_CATEGORIES.filter((cat) => providers.some((p) => p.category === cat)),
        total_clicks: providers.reduce((n, p) => n + p.clicks, 0),
        providers,
      };
    };
    router.get('/api/agency/referrals', 'admin', overview);
    router.put('/api/agency/referrals', 'admin', (ctx) => {
      save(patchConfig(config(), ctx.body));
      return overview();
    });
    router.delete('/api/agency/referrals/clicks', 'admin', () => {
      db.run('DELETE FROM referral_clicks');
      return overview();
    });

    // --- MCP: the agent recommends the right sign-up link ------------------------------------------
    const TOOLS: Tool[] = [
      {
        name: 'ghl_provider_signup_link',
        title: 'Anmelde-Link eines Anbieters',
        description: `Link „Konto anlegen“ für einen Anbieter, den der Nutzer für eine Integration braucht (z. B. KI-Schlüssel, E-Mail/SMS-Versand, Zahlungen). Gibt die Weiterleitung /go/<id> zurück. is_referral=true heißt: Partner-Link (sponsor gohigh = Maintainer von HyperLevel, operator = Betreiber dieser Installation) – beim Empfehlen offen als Partner-Link kennzeichnen. Anbieter-IDs: ${REFERRAL_PROVIDERS.map((p) => p.id).join(', ')}.`,
        inputSchema: { type: 'object', properties: { provider: { type: 'string', description: 'Anbieter-ID oder Name, z. B. kie, fal, openai, twilio, resend, stripe' } }, required: ['provider'], additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
        run: async (_call, a) => {
          const q = String(a.provider ?? '').trim().toLowerCase();
          const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
          const p = referralProvider(q) ?? REFERRAL_PROVIDERS.find((x) => norm(x.name) === norm(q) || (norm(q).length >= 3 && norm(x.name).startsWith(norm(q))));
          if (!p) throw bad(`Unbekannter Anbieter „${q.slice(0, 40)}“ – bekannt: ${REFERRAL_PROVIDERS.map((x) => x.id).join(', ')}`);
          const r = resolve(p);
          if (!r.url) throw bad(`Für ${p.name} ist kein Anmelde-Link hinterlegt`);
          return {
            provider: p.id,
            name: p.name,
            category: p.category,
            url: `${app.baseUrl()}/go/${p.id}`,
            is_referral: r.is_referral,
            ...(r.is_referral ? { sponsor: r.source === 'default' ? 'gohigh' : 'operator' } : {}),
            label: r.is_referral ? 'Partner-Link' : 'Anmelde-Link',
            note: !r.is_referral
              ? 'Normaler Anmelde-Link des Anbieters.'
              : r.source === 'default'
                ? 'Partner-Link: Über diesen Link unterstützt der Nutzer die Entwicklung von HyperLevel – für ihn ändert sich nichts. Bitte als Partner-Link kennzeichnen.'
                : 'Partner-Link des Betreibers dieser Installation – für den Nutzer ändert sich nichts. Bitte als Partner-Link kennzeichnen.',
          };
        },
      },
    ];
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};
