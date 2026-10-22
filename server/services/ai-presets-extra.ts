import type { Preset } from './ai-presets.js';

/**
 * More text-model providers for the KI-Anbieter gallery (BYOK). Every entry was checked against the provider's own
 * documentation and a live request to its (unauthenticated) model list or error answer in October 2026 – the source
 * is in `docs`; `eu` is only set where the provider's documentation states where data is processed.
 *
 * Skipped on purpose: Lambda Inference API (Lambda announced its wind-down in May 2026 – docs.lambda.ai).
 * The price is an editable estimate in USD per million tokens; where a provider's model list states real prices
 * (OpenRouter, Vercel, Requesty, Novita, Venice, SambaNova, OVHcloud, Featherless) the gallery shows and uses those.
 */

const P = (p: Preset): Preset => p;
const T = ['text'] as const;
const TV = ['text', 'vision'] as const;

export const EXTRA_PRESETS: Preset[] = [
  // --- Gateways: one key, many models ---
  P({
    id: 'requesty', label: 'Requesty', group: 'text', wire: 'openai', baseUrl: 'https://router.requesty.ai/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'Requesty-API-Schlüssel',
    capabilities: [...TV], models: { text: ['deepseek/deepseek-chat', 'xai/grok-4', 'google/gemini-3.1-flash-lite'] }, listModels: 'openai', infoKind: 'requesty', price: { input: 1, output: 3 },
    keyUrl: 'https://app.requesty.ai/sign-up', docs: 'https://docs.requesty.ai/quickstart', tags: ['gateway'], verified: '2026-10',
    note: 'LLM-Gateway: ein Schlüssel für viele Anbieter (auch EU-gehostete wie Scaleway), mit Preisen je Modell in der Liste.',
  }),
  P({
    id: 'vercel', label: 'Vercel AI Gateway', group: 'text', wire: 'openai', baseUrl: 'https://ai-gateway.vercel.sh/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'AI-Gateway-Schlüssel',
    capabilities: [...TV], models: { text: ['anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-sol', 'deepseek/deepseek-v4.1-flash'] }, listModels: 'openai', infoKind: 'vercel', price: { input: 3, output: 15 },
    keyUrl: 'https://vercel.com/dashboard/ai-gateway', docs: 'https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions', tags: ['gateway'], verified: '2026-10',
    note: 'Modell-IDs mit Anbieter-Präfix (anthropic/claude-sonnet-5.5). Die Liste zeigt Preise je Modell.',
  }),
  P({
    id: 'cloudflare', label: 'Cloudflare (Workers AI & AI Gateway)', group: 'text', wire: 'openai', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1', customUrl: true, auth: 'bearer', headers: { 'cf-aig-gateway-id': 'default' }, keyRequired: true, keyHint: 'Cloudflare-API-Token (Workers AI: Read)',
    capabilities: [...TV], models: { text: ['@cf/openai/gpt-oss-120b', '@cf/moonshotai/kimi-k2.6', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'] }, listModels: 'none', price: { input: 0.5, output: 1.5 },
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens', docs: 'https://developers.cloudflare.com/ai-gateway/usage/rest-api/', tags: ['gateway', 'cheap'], verified: '2026-10',
    note: 'In der Adresse {account_id} durch deine Cloudflare-Konto-ID ersetzen. Workers-AI-Modelle heißen @cf/anbieter/modell, Modelle anderer Anbieter anbieter/modell (Abrechnung über Cloudflare).',
  }),
  // --- Open-model inference ---
  P({
    id: 'nebius', label: 'Nebius Token Factory', group: 'text', wire: 'openai', baseUrl: 'https://api.tokenfactory.nebius.com/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'Nebius-API-Schlüssel',
    capabilities: [...T], models: { text: ['deepseek-ai/DeepSeek-R1-0528'] }, listModels: 'openai', price: { input: 0.5, output: 1.5 },
    keyUrl: 'https://tokenfactory.nebius.com/', docs: 'https://docs.tokenfactory.nebius.com/', tags: ['cheap'], verified: '2026-10',
  }),
  P({
    id: 'novita', label: 'Novita AI', group: 'text', wire: 'openai', baseUrl: 'https://api.novita.ai/openai/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'Novita-API-Schlüssel',
    capabilities: [...TV], models: { text: ['deepseek/deepseek-v4.1-flash', 'zai-org/glm-5.3', 'moonshotai/kimi-k3'] }, listModels: 'openai', infoKind: 'novita', price: { input: 0.4, output: 1.5 },
    keyUrl: 'https://novita.ai/settings/key-management', docs: 'https://docs.novita.ai/guides/llm-api', tags: ['cheap'], verified: '2026-10',
  }),
  P({
    id: 'hyperbolic', label: 'Hyperbolic', group: 'text', wire: 'openai', baseUrl: 'https://api.hyperbolic.xyz/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'Hyperbolic-API-Schlüssel',
    capabilities: [...TV], models: { text: ['meta-llama/Meta-Llama-3.1-70B-Instruct'] }, listModels: 'openai', price: { input: 0.4, output: 0.4 },
    keyUrl: 'https://app.hyperbolic.ai/settings', docs: 'https://www.hyperbolic.ai/docs/inference/quickstart', tags: ['cheap'], verified: '2026-10',
  }),
  P({
    id: 'sambanova', label: 'SambaNova Cloud', group: 'text', wire: 'openai', baseUrl: 'https://api.sambanova.ai/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'SambaNova-API-Schlüssel',
    capabilities: [...T], models: { text: ['DeepSeek-V3.1', 'gpt-oss-120b', 'Meta-Llama-3.3-70B-Instruct'] }, listModels: 'openai', infoKind: 'sambanova', price: { input: 0.6, output: 1.2 },
    keyUrl: 'https://cloud.sambanova.ai/apis', docs: 'https://docs.sambanova.ai/docs/en/features/openai-compatibility', tags: ['fast'], verified: '2026-10',
  }),
  P({
    id: 'featherless', label: 'Featherless', group: 'text', wire: 'openai', baseUrl: 'https://api.featherless.ai/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'Featherless-API-Schlüssel',
    capabilities: [...T], models: { text: ['meta-llama/Llama-3.3-70B-Instruct'] }, listModels: 'openai', infoKind: 'featherless', price: { input: 0.1, output: 0.2 },
    keyUrl: 'https://featherless.ai/account/api-keys', docs: 'https://featherless.ai/docs/api-overview-and-common-options', tags: ['cheap'], verified: '2026-10',
    note: 'Sehr große Auswahl an Open-Source-Modellen (über 20 000), meist im Festpreis-Abo. Die Liste ist lang – oben suchen.',
  }),
  P({
    id: 'venice', label: 'Venice', group: 'text', wire: 'openai', baseUrl: 'https://api.venice.ai/api/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'Venice-API-Schlüssel',
    capabilities: [...TV], models: { text: ['zai-org-glm-5', 'kimi-k2-6'] }, listModels: 'openai', infoKind: 'venice', price: { input: 0.7, output: 2.5 },
    keyUrl: 'https://venice.ai/settings/api', docs: 'https://docs.venice.ai/overview/getting-started', verified: '2026-10',
    note: 'Datenschutz-orientierter Anbieter. Venice dokumentiert den Datenumgang unter docs.venice.ai/overview/privacy – dort prüfen, ob er zu deinem Fall passt.',
  }),
  // --- Models from China, via the international platforms ---
  P({
    id: 'moonshot', label: 'Moonshot AI (Kimi)', group: 'text', wire: 'openai', baseUrl: 'https://api.moonshot.ai/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'sk-…',
    capabilities: [...T], models: { text: ['kimi-k3', 'kimi-k2.6', 'kimi-k2.7-code-highspeed'] }, listModels: 'openai', price: { input: 0.6, output: 2.5 },
    keyUrl: 'https://platform.kimi.ai/console/api-keys', docs: 'https://platform.kimi.ai/docs/guide/start-using-kimi-api', tags: ['cheap'], verified: '2026-10',
    note: 'Internationale Plattform (api.moonshot.ai). Die Verarbeitung findet bei Moonshot statt, nicht in der EU.',
  }),
  P({
    id: 'zai', label: 'Zhipu GLM (Z.ai)', group: 'text', wire: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'Z.ai-API-Schlüssel',
    capabilities: [...TV], models: { text: ['glm-5.3', 'glm-5.3-flash'] }, listModels: 'none', price: { input: 0.6, output: 2.2 },
    keyUrl: 'https://z.ai/manage-apikey/apikey-list', docs: 'https://docs.z.ai/guides/overview/quick-start', tags: ['cheap'], verified: '2026-10',
    note: 'Allgemeine API (paas/v4). Der „GLM Coding Plan“ hat einen eigenen, nur für Coding-Werkzeuge gedachten Zugang und gehört nicht hierher. Verarbeitung bei Z.ai, nicht in der EU.',
  }),
  P({
    id: 'qwen', label: 'Alibaba Qwen (Model Studio)', group: 'text', wire: 'openai', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', customUrl: true, auth: 'bearer', keyRequired: true, keyHint: 'sk-… (Model-Studio-Schlüssel der Region)',
    capabilities: [...TV], models: { text: ['qwen-plus', 'qwen3.8-max'] }, listModels: 'none', price: { input: 0.4, output: 1.2 },
    keyUrl: 'https://modelstudio.console.alibabacloud.com/', docs: 'https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope', tags: ['cheap'], verified: '2026-10',
    note: 'Schlüssel gelten nur für ihre Region. Neuere Konten nutzen eine Adresse mit Workspace-ID (https://<workspace>.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1, USA: https://dashscope-us.aliyuncs.com/compatible-mode/v1) – dann hier eintragen. Es gibt keine Modell-Liste per API.',
  }),
  P({
    id: 'minimax', label: 'MiniMax', group: 'text', wire: 'openai', baseUrl: 'https://api.minimax.io/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'MiniMax-API-Schlüssel',
    capabilities: [...T], models: { text: ['MiniMax-M3', 'MiniMax-M2.7'] }, listModels: 'none', price: { input: 0.3, output: 1.2 },
    keyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key', docs: 'https://platform.minimax.io/docs/api-reference/text-openai-api', tags: ['cheap'], verified: '2026-10',
    note: 'MiniMax-M3.1-Flash-Preview gibt es laut MiniMax derzeit nur über „M Plan“ und „MiniMax Code“, nicht über diese API.',
  }),
  // --- Specialists ---
  P({
    id: 'cohere', label: 'Cohere (Kompatibilitäts-API)', group: 'text', wire: 'openai', baseUrl: 'https://api.cohere.ai/compatibility/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'Cohere-API-Schlüssel',
    capabilities: ['text', 'embeddings'], models: { text: ['command-a-plus-05-2026'], embeddings: ['embed-v5.0-pro'] }, listModels: 'none', price: { input: 2.5, output: 10 },
    keyUrl: 'https://dashboard.cohere.com/api-keys', docs: 'https://docs.cohere.com/docs/compatibility-api', verified: '2026-10',
    note: 'OpenAI-kompatible Schicht von Cohere: Chat (mit Werkzeugen), Embeddings und Transkription. Nicht unterstützt sind u. a. n, logit_bias, parallel_tool_calls.',
  }),
  P({
    id: 'ai21', label: 'AI21 (Jamba)', group: 'text', wire: 'openai', baseUrl: 'https://api.ai21.com/studio/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'AI21-API-Schlüssel',
    capabilities: [...T], models: { text: ['jamba-large', 'jamba-mini'] }, listModels: 'none', price: { input: 2, output: 8 },
    keyUrl: 'https://docs.ai21.com/docs/create-api-key', docs: 'https://docs.ai21.com/reference/jamba-1-6-api-ref', verified: '2026-10',
    note: 'Jamba-Modelle: höchstens 4096 Ausgabe-Tokens je Antwort.',
  }),
  // --- kie.ai as chat provider (the media preset "kie" stays as it is) ---
  P({
    id: 'kie_llm', label: 'kie.ai (Claude-Modelle)', group: 'text', wire: 'anthropic', baseUrl: 'https://api.kie.ai/anthropic', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'kie.ai-API-Schlüssel (derselbe wie für Medien)',
    capabilities: [...TV], models: { text: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5'] }, listModels: 'anthropic', price: { input: 3, output: 15 },
    keyUrl: 'https://kie.ai/api-key', docs: 'https://docs.kie.ai/ai-agent/claude-code.md', referral: 'kie', verified: '2026-10',
    note: 'kie.ai spricht die Anthropic-Schnittstelle (Adresse https://api.kie.ai/anthropic, Anmeldung per Bearer). Die Modell-IDs entsprechen denen von Anthropic. Die GPT- und Gemini-Chatmodelle von kie.ai haben je eine eigene Adresse pro Modell – die lassen sich als „Benutzerdefiniert“ eintragen.',
  }),
  // --- EU hosting (DSGVO): the documentation says where data is processed ---
  P({
    id: 'ionos', label: 'IONOS AI Model Hub', group: 'text', wire: 'openai', baseUrl: 'https://openai.inference.de-txl.ionos.com/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'IONOS-Token (Token Manager)',
    capabilities: ['text', 'vision', 'embeddings'], models: { text: ['meta-llama/Llama-3.3-70B-Instruct', 'openai/gpt-oss-120b'], embeddings: ['BAAI/bge-m3'] }, listModels: 'openai', price: { input: 0.7, output: 0.9 },
    keyUrl: 'https://dcd.ionos.com/', docs: 'https://docs.ionos.com/cloud/ai/ai-model-hub/how-tos/text-generation', verified: '2026-10',
    eu: { region: 'Deutschland', source: 'https://docs.ionos.com/cloud/ai/ai-model-hub/ai-model-hub.md', note: 'Laut IONOS findet die Verarbeitung ausschließlich in Deutschland statt; deine Eingaben werden nicht zum Training genutzt.' },
    note: 'Den Token legst du im IONOS-Datacenter-Designer unter „Verwaltung → Token Manager“ an. Neukunden brauchen dafür zuerst einen Public-Cloud-Vertrag.',
  }),
  P({
    id: 'stackit', label: 'STACKIT AI Model Serving', group: 'text', wire: 'openai', baseUrl: 'https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'STACKIT-Auth-Token',
    capabilities: ['text', 'vision', 'embeddings'], models: { text: [], embeddings: ['intfloat/e5-mistral-7b-instruct'] }, listModels: 'openai', price: { input: 0.7, output: 0.9 },
    keyUrl: 'https://portal.stackit.cloud/', docs: 'https://docs.stackit.cloud/products/data-and-ai/ai-model-serving/how-tos/use-the-models/', verified: '2026-10',
    eu: { region: 'EU', source: 'https://stackit.com/en/products/data-ai', note: 'Laut STACKIT vollständig in europäischen Rechenzentren gehostet und DSGVO-konform; die Anfragen werden nicht gespeichert.' },
    note: 'Auth-Token im STACKIT-Portal unter „AI Model Serving → Auth-Tokens“ anlegen. Die Modell-ID steht in der Liste (Format anbieter/modell).',
  }),
  P({
    id: 'ovh', label: 'OVHcloud AI Endpoints', group: 'text', wire: 'openai', baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'OVHcloud-AI-Endpoints-Schlüssel',
    capabilities: [...TV], models: { text: ['gpt-oss-120b', 'Meta-Llama-3_3-70B-Instruct', 'Mistral-Small-3.2-24B-Instruct-2506'] }, listModels: 'openai', infoKind: 'ovh', price: { input: 0.3, output: 0.5 },
    keyUrl: 'https://www.ovhcloud.com/en/public-cloud/ai-endpoints/', docs: 'https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-getting-started', tags: ['cheap'], verified: '2026-10',
    eu: { region: 'Frankreich', source: 'https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-capabilities', note: 'Laut OVHcloud läuft die Infrastruktur in Gravelines (Frankreich); Daten werden weder gespeichert noch weitergegeben. Die Produktseite nennt die Verfügbarkeit „Worldwide (non-EU)“ – prüfe dort, ob dein Land eingeschlossen ist.' },
    note: 'Den Schlüssel erzeugst du im OVHcloud-Manager unter Public Cloud → AI & Machine Learning → AI Endpoints. Ohne Schlüssel gilt ein sehr kleines Limit (2 Anfragen pro Minute).',
  }),
  P({
    id: 'scaleway', label: 'Scaleway Generative APIs', group: 'text', wire: 'openai', baseUrl: 'https://api.scaleway.ai/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'Scaleway-API-Secret-Key',
    capabilities: ['text', 'vision', 'embeddings'], models: { text: ['gpt-oss-120b', 'llama-3.3-70b-instruct', 'mistral-small-3.2-24b-instruct-2506'], embeddings: ['qwen3-embedding-8b'] }, listModels: 'openai', price: { input: 0.9, output: 0.9 },
    keyUrl: 'https://console.scaleway.com/iam/api-keys', docs: 'https://www.scaleway.com/en/docs/generative-apis/quickstart/', tags: ['cheap'], verified: '2026-10',
    eu: { region: 'EU', source: 'https://www.scaleway.com/en/docs/generative-apis/quickstart.md', note: 'Laut Scaleway in europäischen Rechenzentren gehostet.' },
  }),
  P({
    id: 'mistral_eu', label: 'Mistral AI – EU-Endpunkt', group: 'text', wire: 'openai', baseUrl: 'https://api.eu.mistral.ai/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'Mistral-API-Schlüssel (derselbe wie bei Mistral AI)',
    capabilities: ['text', 'vision', 'embeddings'], models: { text: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'], embeddings: ['mistral-embed'] }, listModels: 'openai', price: { input: 2.2, output: 6.6 },
    keyUrl: 'https://console.mistral.ai/api-keys', docs: 'https://docs.mistral.ai/inference/regional-inference.md', referral: 'mistral', verified: '2026-10',
    eu: { region: 'EU', source: 'https://docs.mistral.ai/inference/regional-inference.md', note: 'Regionale Inferenz: Die Verarbeitung läuft in Rechenzentren in der EU und den EFTA-Ländern. Kontoverwaltung und Abrechnung bleiben bei Mistral außerhalb dieser Region.' },
    note: 'Dasselbe Konto und derselbe Schlüssel wie bei „Mistral AI“, aber über api.eu.mistral.ai. Kostet 10 % Aufschlag. Nicht verfügbar: Agents, Batch und Dateien; als Werkzeug nur Funktionsaufrufe (die der KI-Agent braucht). Modelle je Region unterschiedlich – die Liste zeigt, was verfügbar ist.',
  }),
];
