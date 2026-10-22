# Provider sign-up links and partner links

Wherever HyperLevel asks you to connect a third-party provider – an AI key, an email or SMS API, Stripe,
Twilio, Composio, a Telegram bot and so on – it shows a small **"Konto anlegen ↗"** ("create account")
link next to the field, so you can open an account at that provider in one click.

Some of these links can be **referral (partner) links**. If one is configured, it is clearly labelled
with a **"Partner-Link"** chip whose tooltip says: *"Über diesen Link unterstützt du die Entwicklung von
HyperLevel – für dich ändert sich nichts."* ("This link supports the development of HyperLevel – nothing changes
for you."). If the partner link was set by the operator of the installation (not the maintainer), the
tooltip says so instead.

Nothing is hidden: every link goes through a visible redirect, partner links are always labelled, and
every self-hoster can replace or switch them off.

## What happens when someone clicks

1. The link points to `https://<your-domain>/go/<provider>` (for example `/go/kie`).
2. HyperLevel increments a counter for that provider and answers with a `302` redirect to the resolved
   address (see below). It sends `Referrer-Policy: no-referrer`, so the provider does not learn which
   page of your installation the click came from.
3. Only a **counter per provider** and the **day of the last click** are stored (table
   `referral_clicks`). No user, IP address, cookie or browser data is recorded.

`/go/` only accepts ids from the built-in catalogue and only redirects to the address resolved for that
id – query strings are ignored, so it cannot be abused as an open redirect. Unknown ids (or providers
without any link) answer `404`.

## Which address a link resolves to

For each provider the first match wins:

| Order | Source | Where it is set |
| --- | --- | --- |
| 1 | Agency override | **Agentur → Partner-Links** (stored in `agency_settings`, key `referrals`) |
| 2 | Environment | `PGHL_REFERRALS` – a JSON map `{ "<id>": "<url>" }` |
| 3 | Maintainer defaults | `REFERRAL_DEFAULTS` in [`server/modules/referrals.ts`](../server/modules/referrals.ts) |
| 4 | Plain sign-up page | the provider's normal sign-up URL from the catalogue |

- An empty string `""` as override (agency or `PGHL_REFERRALS`) means **"use the plain sign-up page"**
  for that provider, even if a later layer has a partner link. In the admin page this is the per-provider
  "Partner-Link" toggle.
- Only `https://` URLs with a normal host name are accepted (no `http:`, `javascript:`, IP addresses,
  ports or credentials). Invalid entries in `PGHL_REFERRALS` or the defaults are skipped; the admin page
  refuses them.
- A link counts as partner link when it differs from the provider's plain sign-up URL.
- Providers without a known sign-up page (e.g. `monid`, `ollama`) only show a link when one is configured.

## Replacing or disabling the links

**In the app (admins):** *Agentur → Partner-Links* lists every provider with category filter and search,
the default link, an input for your own link, a toggle per provider, a global toggle and the click counts.

- Global toggle off (`enabled: false`) → plain sign-up links everywhere.
- Own link → replaces the default for that provider (it is then labelled as the operator's partner link).
- Provider toggle off → plain sign-up link for that provider.
- "Zähler zurücksetzen" sets all click counters to 0.

**On the server:**

| Variable | Effect |
| --- | --- |
| `PGHL_REFERRALS_DISABLED=1` | Plain sign-up links only, regardless of agency settings, `PGHL_REFERRALS` and the defaults. |
| `PGHL_REFERRALS` | JSON map of your own links, e.g. `{"kie":"https://kie.ai/?ref=me","stripe":""}`. Applies when the agency has no override for that provider. |

**In a fork:** edit `REFERRAL_DEFAULTS` in `server/modules/referrals.ts` (one clearly marked constant;
all entries are empty in this repository until the maintainer fills them in).

## API and MCP

- `GET /api/referrals` (any signed-in user) → `{ "<id>": { name, url: "/go/<id>", is_referral, sponsor? } }`
  for every provider that has a link. `sponsor` is `gohigh` (maintainer default) or `operator`
  (agency override or `PGHL_REFERRALS`) and only present on partner links.
- `GET /api/agency/referrals` (admins) → catalogue, defaults, env links, overrides, resolved target,
  source and click counts. `PUT /api/agency/referrals` with `{ enabled?: boolean, links?: { "<id>": "<https-url>" | "" } }`
  saves (sending `links` replaces all overrides; `null` removes one). `DELETE /api/agency/referrals/clicks`
  resets the counters.
- MCP tool **`ghl_provider_signup_link`** (`{ provider: "kie" }`, also accepts names like "ElevenLabs")
  returns the absolute `/go/` link, `is_referral`, `sponsor` and a note asking the agent to label partner links
  when it recommends them.

## Catalogue

| Category | Ids |
| --- | --- |
| KI-Modelle (AI models) | `openai`, `anthropic`, `gemini`, `openrouter`, `groq`, `deepseek`, `mistral`, `xai`, `together`, `fireworks`, `perplexity`, `cerebras`, `huggingface`, `ollama` (no link) |
| KI-Medien (AI media) | `kie`, `fal`, `replicate`, `elevenlabs`, `stability`, `runway`, `luma` |
| Daten & Recherche | `monid` (no public sign-up URL yet), `exa` |
| Automatisierung | `composio`, `zapier`, `make`, `n8n` |
| E-Mail | `resend`, `postmark`, `brevo`, `mailgun`, `aws_ses` |
| SMS & Telefonie | `twilio`, `seven`, `vonage`, `plivo`, `bird` |
| Kanäle | `telegram` (BotFather), `discord` (developer portal), `slack` (api.slack.com), `meta` (Meta for Developers) |
| Zahlungen & Finanzen | `stripe`, `norman` |
| Hosting & Daten | `hostinger`, `hetzner`, `supabase`, `lovable`, `google_cloud` |
| Produktivität | `todoist`, `notion`, `google_workspace`, `microsoft365`, `calendly`, `canva`, `github` |
| Marketing & Analyse | `postiz`, `posthog`, `bitly` |

## For developers

Render the link next to any provider key field with one line:

```tsx
import { SignupLink } from '../referrals';

<Field label="kie.ai-Schlüssel" hint={<>Unter kie.ai → API Keys. <SignupLink id="kie" /></>}>
```

- `useReferrals()` (from `web/src/referrals.tsx`) loads `/api/referrals` once per page load and shares it.
- `<SignupLink id=… />` renders nothing for unknown ids or providers without a link, so ids that come
  from data are fine. A few aliases are mapped (`ses` → `aws_ses`, `connector_<id>` → `<id>`,
  `google_sheets` → `google_workspace`).
- It always renders `target="_blank" rel="noopener sponsored"` and, for partner links, the
  "Partner-Link" chip.
- Server side, other modules can call `app.services.signupLink(id)` → `{ id, name, url, is_referral } | null`.
- New provider? Add it to `REFERRAL_PROVIDERS` (and an empty entry to `REFERRAL_DEFAULTS`) in
  `server/modules/referrals.ts`; ids are lowercase with underscores and must never change.
- Test hook: `app.services.referralDefaults` replaces `REFERRAL_DEFAULTS`.

**Parallel feature branches:** the BYOK presets of `feat/agent` and the media providers of
`feat/genmedia` render `<SignupLink id=… />` in their preset/provider cards, using the ids above
(`kie`, `fal`, `replicate`, `stability`, `runway`, `luma`, `elevenlabs`, `groq`, `together`, `fireworks`,
`perplexity`, `cerebras`, `huggingface`, `openrouter`, `openai`, `anthropic`, `gemini`, `deepseek`,
`mistral`, `xai`; `ollama` has no link).

## Where the links appear

AI settings (Anthropic and OpenAI keys, agency default), Composio (agency and sub-account key), email &
SMS providers (Resend, Postmark, Amazon SES, Brevo, Mailgun, seven.io, Bird, Vonage, Plivo, Twilio SMS),
more channels (Telegram, Discord, Slack), telephony (Twilio), Stripe, Todoist, Supabase mirror, Postiz
(agency setup and the empty Social Planner), Video-Studio (Gemini, ElevenLabs, fal.ai), Google &
Microsoft OAuth apps, GitHub sign-in and GitHub for Codex, Meta channels and Meta Ads, Google Places key,
Gmail mailboxes, direct connectors (Notion, Slack/Discord webhooks, Google Sheets) and the integrations
catalogue (cards and guide).
