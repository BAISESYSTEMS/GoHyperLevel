import type { Module } from '../core/app.js';
import { HttpError } from '../core/http.js';
import { NAMES, ROUTES } from '../services/werkstatt/names.js';
import { loadPolicy, mayBuild } from '../services/werkstatt/policy.js';
import type { Tool } from './mcp.js';

/**
 * MCP tools for the Werkstatt and the Marktplatz (also the HyperLevel Agent's tools, which uses every MCP tool):
 * list and install plugins, build from a wish, ask for the status, change a plugin, discard it, and – for admins –
 * the lifecycle (approve, review, publish, roll back, switch off). They are thin relays onto the REST routes, so
 * the same policy, model gate, approval, budget and consent rules apply as in the app.
 *
 * In the agent chat the results become cards (web/src/werkstatt/ChatCards.tsx): the plan with a confirm button, live
 * progress, an inline sandboxed preview with Öffnen / Ändern lassen / Verwerfen, and the diff of a new version. The
 * cards read the order themselves (`build_id`), so a tool result only has to say which order it is about. The agent
 * never confirms a plan by itself: the card's button is the person's click.
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = (s: unknown) => encodeURIComponent(String(s));
const buildLink = (id: string) => `${ROUTES.werkstatt}/${id}`;
const pluginLink = (id: string) => `${ROUTES.werkstatt}/plugins/${id}`;

/** Polls an order until it leaves the given states (at most `seconds`), the way a person would refresh the page. */
async function waitFor(call: Parameters<Tool['run']>[0], id: string, location: string | undefined, states: string[], seconds: number): Promise<any> {
  let b: any;
  for (let i = 0; i < Math.max(1, Math.round(seconds / 2)); i++) {
    b = await call.api('GET', `/api/werkstatt/builds/${enc(id)}`, { location });
    if (!states.includes(b.status)) return b;
    await sleep(2000);
  }
  return b;
}

/** What the model and the chat card need to know about an order (never more than the order page shows). */
const planOf = (id: string, b: any) => ({
  build_id: id,
  link: buildLink(id),
  status: b.status,
  stage: b.stage_label,
  title: b.plan?.title ?? b.title,
  summary: b.plan?.summary,
  steps: (b.plan?.steps ?? []).map((s: any) => s.title),
  notes: b.plan?.notes,
  permissions: [...(b.plan?.scopes ?? []).map((s: any) => `${s.key} (${s.label})`), ...(b.plan?.areas ?? []).map((x: string) => `Bereich ${x}`)],
  estimated_cost_usd: b.plan?.estimate?.typical_usd ?? 0,
  model: b.plan?.ai?.model ?? b.plan?.estimate?.model,
  denkstufe: b.plan?.ai?.effort?.label,
  model_gate: b.plan?.model_gate?.ok === false ? b.plan.model_gate.message : undefined,
  budget: b.budget,
  missing_areas: b.plan?.missing_areas,
  needs_approval: b.status === 'planned' ? undefined : b.needs_approval,
});

const TOOLS: Tool[] = [
  {
    name: 'ghl_list_plugins',
    title: 'Plugins auflisten',
    description: `Listet ${NAMES.plugins}: die im Sub-Account installierten (scope "installed", Standard) oder die im ${NAMES.marktplatz} verfügbaren (scope "marktplatz", mit query/category). Zeigt Name, Version, angefragte Berechtigungen, Bewertung, Installationen und Status. Nutze es, bevor du ein Plugin bauen lässt: vielleicht gibt es schon eins.`,
    inputSchema: obj({ ...LOC, scope: { type: 'string', enum: ['installed', 'marktplatz'] }, query: { type: 'string' }, category: { type: 'string' } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      if (a.scope === 'marktplatz') {
        const q = new URLSearchParams({ ...(a.query ? { q: String(a.query) } : {}), ...(a.category ? { category: String(a.category) } : {}) }).toString();
        const r = await call.api('GET', `/api/marktplatz${q ? `?${q}` : ''}`, { location: a.location_id });
        return { plugins: r.plugins.map((p: any) => ({ id: p.id, name: p.name, description: p.description, category: p.category_label, version: p.version, rating: p.rating, reviews: p.reviews, installs: p.installs, risk: p.risk, permissions: p.scopes.map((s: any) => `${s.key} (${s.label})`), installed: p.installed, update_available: p.update_available })) };
      }
      const r = await call.api('GET', '/api/plugins', { location: a.location_id });
      return { plugins: r.plugins.map((p: any) => ({ id: p.id, name: p.name, version: p.version, scope: p.scope, status: p.status, active_here: p.active_here, permissions: p.scopes.map((s: any) => s.key), killed_reason: p.killed_reason || undefined, link: pluginLink(p.id) })) };
    },
  },
  {
    name: 'ghl_install_plugin',
    title: 'Plugin installieren',
    description: `Installiert ein Plugin aus dem ${NAMES.marktplatz} im Sub-Account (scope "location", Standard) oder nur für den Nutzer (scope "private"). Ohne accept_permissions zeigt das Werkzeug nur, welche Berechtigungen das Plugin anfragt – zeige sie dem Nutzer und rufe es mit accept_permissions: true erneut auf, wenn er zustimmt. Der Nutzer braucht für den ganzen Sub-Account das Recht „Einstellungen“.`,
    inputSchema: obj({ ...LOC, plugin_id: { type: 'string' }, scope: { type: 'string', enum: ['location', 'private'] }, accept_permissions: { type: 'boolean', description: 'Der Nutzer hat die angefragten Berechtigungen gesehen und akzeptiert.' } }, ['plugin_id']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (call, a) => {
      const id = enc(a.plugin_id);
      const p = await call.api('GET', `/api/marktplatz/${id}`, { location: a.location_id });
      const permissions = p.scopes.map((s: any) => ({ key: s.key, label: s.label, hint: s.hint, risk: s.risk }));
      if (!a.accept_permissions) return { needs_consent: true, plugin: p.name, version: p.version, description: p.description, risk: p.risk, permissions, hint: 'Zeige die Berechtigungen dem Nutzer und rufe das Werkzeug mit accept_permissions: true erneut auf.' };
      const r = await call.api('POST', `/api/marktplatz/${id}/install`, { location: a.location_id, body: { consent: permissions.map((s: any) => s.key), scope: a.scope === 'private' ? 'private' : 'location' } });
      return { installed: r.installed, plugin: r.name, scope: r.installed_scope, version: r.version };
    },
  },
  {
    name: 'ghl_build_from_wish',
    title: 'Aus Wunsch bauen lassen',
    description: `Lässt den Wunsch eines Nutzers in der ${NAMES.werkstatt} bauen (wish_id aus ghl_list_wishes oder freier text). Die KI analysiert ihn und liefert einen Plan: Stufe 1 „${NAMES.stage1}“ (ohne Code: Automationen, Felder, Objekte, Berichte, Agenten, Vorlagen, Formulare) oder Stufe 2 „${NAMES.stage2}“ (ein abgeschottetes Plugin). Der Nutzer sieht den Plan im Chat als Karte – was gebaut wird, Berechtigungen, Kosten, Modell und Denkstufe – und bestätigt dort mit einem Klick; danach zeigt dieselbe Karte den Fortschritt und vorab eine Vorschau. Du planst nur (ohne confirm). Gebaut wird erst mit confirm: true UND accept_permissions: true, wenn der Nutzer im Chat ausdrücklich „ja, bauen“ sagt, statt die Karte zu benutzen. Es gelten Richtlinie (wer bauen darf), Mindest-Modell, Freigabe durch einen Admin und das Monatsbudget des Sub-Accounts. Mit wait: false kommt die Antwort sofort (der Plan erscheint dann live in der Karte).`,
    inputSchema: obj({ ...LOC, wish_id: { type: 'string' }, text: { type: 'string', description: 'Der Wunsch in ein bis zwei Sätzen (wenn kein wish_id)' }, build_id: { type: 'string', description: 'Ein schon geplanter Auftrag, der bestätigt werden soll' }, confirm: { type: 'boolean' }, accept_permissions: { type: 'boolean' }, wait: { type: 'boolean', description: 'Auf den Plan warten (Standard: ja, höchstens etwa 100 Sekunden).' } }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    // Planning only spends a few cents and builds nothing; confirming a build is the sensitive step.
    klassFor: (a) => (a.confirm ? 'sensitive' : 'write'),
    run: async (call, a) => {
      let id = String(a.build_id ?? '');
      if (!id) {
        if (!a.wish_id && !a.text) throw new HttpError(400, 'wish_id oder text fehlt.');
        const b = await call.api('POST', '/api/werkstatt/builds', { location: a.location_id, body: { wish_id: a.wish_id, text: a.text } });
        id = b.id;
        if (a.wait === false) return { build_id: id, link: buildLink(id), status: 'planning', hint: 'Die Analyse läuft – der Plan erscheint live in der Karte. Später mit ghl_plugin_status (build_id) nachsehen.' };
      }
      // The AI analyses in the background; wait for the plan (at most about 100 seconds).
      const b = await waitFor(call, id, a.location_id, ['planning'], 100);
      if (b.status === 'planning') return { build_id: id, link: buildLink(id), status: 'planning', hint: 'Die Analyse läuft noch – der Plan erscheint live in der Karte; später mit ghl_plugin_status (build_id) nachsehen.' };
      if (b.status === 'failed') return { build_id: id, link: buildLink(id), status: 'failed', error: b.error };
      const plan = planOf(id, b);
      if (b.status !== 'planned' || !a.confirm) return { ...plan, hint: b.status === 'planned' ? 'Der Nutzer sieht den Plan als Karte und bestätigt dort. Bestätige selbst nur, wenn er im Chat ausdrücklich „ja, bauen“ sagt: build_id, confirm: true, accept_permissions: true.' : undefined };
      if (!a.accept_permissions) throw new HttpError(400, 'accept_permissions: true fehlt – der Nutzer muss die Berechtigungen des Plans akzeptieren.');
      const c = await call.api('POST', `/api/werkstatt/builds/${enc(id)}/confirm`, { location: a.location_id, body: { accept_scopes: b.plan.scopes.map((s: any) => s.key), accept_areas: b.plan.areas } });
      return { ...plan, status: c.status, status_label: c.status_label, hint: c.status === 'awaiting_approval' ? 'Ein Admin muss den Bau noch freigeben – die Karte zeigt „Wartet auf Freigabe“.' : 'Der Bau läuft – die Karte zeigt den Fortschritt live; mit ghl_plugin_status (build_id) kannst du den Stand abfragen.' };
    },
  },
  {
    name: 'ghl_change_plugin',
    title: 'Plugin ändern lassen',
    description: `Ändert ein Plugin des Nutzers nach seinem Wunsch („Ändern lassen“): Die KI schreibt eine neue Version, prüft sie und – bei einem privaten Plugin ohne neue Berechtigungen – schaltet sie ein; die alte Version bleibt und lässt sich zurückrollen. Das Ergebnis enthält eine Zusammenfassung der Änderung (diff: neue Berechtigungen, Oberfläche, Server-Logik). Nutze es, wenn der Nutzer im Chat etwas an einem seiner Plugins anders haben will („Mach die Farben dunkler“, „Zeig auch die Firma an“). Es gelten dieselben Regeln wie beim Bauen (Richtlinie, Mindest-Modell, Freigabe, Budget). Mit wait: false kommt die Antwort sofort (die Karte zeigt den Fortschritt).`,
    inputSchema: obj({ ...LOC, plugin_id: { type: 'string' }, feedback: { type: 'string', description: 'Was soll anders sein? Konkret, in ein bis drei Sätzen.' }, wait: { type: 'boolean' } }, ['plugin_id', 'feedback']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (call, a) => {
      const pid = String(a.plugin_id);
      const b0 = await call.api('POST', `/api/werkstatt/plugins/${enc(pid)}/change`, { location: a.location_id, body: { feedback: a.feedback } });
      const id = String(b0.id);
      const base = { build_id: id, plugin_id: pid, link: buildLink(id) };
      if (b0.status === 'awaiting_approval') return { ...base, status: 'awaiting_approval', hint: 'Ein Admin muss die Änderung noch freigeben – die Karte zeigt „Wartet auf Freigabe“.' };
      if (a.wait === false) return { ...base, status: b0.status, hint: 'Die Änderung wird gebaut – die Karte zeigt den Fortschritt live.' };
      const b = await waitFor(call, id, a.location_id, ['building', 'planning'], 100);
      if (b.status === 'failed') return { ...base, status: 'failed', error: b.error };
      if (b.status !== 'done') return { ...base, status: b.status, hint: 'Die Änderung wird noch gebaut – die Karte zeigt den Fortschritt; später mit ghl_plugin_status (build_id) nachsehen.' };
      const d = b.plan?.diff;
      return { ...base, status: 'done', version: d?.to, previous_version: d?.from, diff: d?.summary ?? [], new_permissions: b.plan?.new_scopes ?? [], needs_activation: (b.plan?.new_scopes ?? []).length > 0, model: b.ai?.model, denkstufe: b.ai?.label, hint: (b.plan?.new_scopes ?? []).length ? 'Die neue Version fragt zusätzliche Berechtigungen an – der Nutzer muss sie beim Plugin bestätigen und aktivieren.' : 'Die neue Version ist aktiv; die alte bleibt in der Versionsliste (zurückrollen möglich). Fasse dem Nutzer die Änderung in zwei Sätzen zusammen.' };
    },
  },
  {
    name: 'ghl_discard_plugin',
    title: 'Plugin verwerfen',
    description: `Löscht ein Plugin des Nutzers endgültig (mit seinen Versionen und gespeicherten Daten; Datensätze, die es angelegt hat, bleiben). Nur auf ausdrücklichen Wunsch („verwirf das“). Wer nur zurück zur vorigen Version will, nutzt ghl_plugin_admin (rollback) bzw. die Versionsliste – das ist harmloser.`,
    inputSchema: obj({ ...LOC, plugin_id: { type: 'string' } }, ['plugin_id']),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    run: async (call, a) => {
      const r = await call.api('DELETE', `/api/plugins/${enc(a.plugin_id)}`, { location: a.location_id });
      return { discarded: !!r?.ok, plugin_id: a.plugin_id };
    },
  },
  {
    name: 'ghl_plugin_status',
    title: 'Plugin- oder Bau-Status',
    description: `Stand eines Bau-Auftrags der ${NAMES.werkstatt} (build_id: Status, Fortschritt, Log, Kosten, Fehler, entstandenes Plugin, Modell und Denkstufe, bei einer Änderung die Zusammenfassung) oder eines Plugins (plugin_id: Version, Berechtigungen, aktiv?, abgeschaltet?, Versionen mit Prüfsiegeln, Gesundheit). Ohne ID: die letzten Aufträge dieses Sub-Accounts.`,
    inputSchema: obj({ ...LOC, build_id: { type: 'string' }, plugin_id: { type: 'string' } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      if (a.build_id) {
        const b = await call.api('GET', `/api/werkstatt/builds/${enc(a.build_id)}`, { location: a.location_id });
        return { build_id: b.id, link: buildLink(b.id), id: b.id, status: b.status_label, stage: b.stage_label, title: b.title, progress: b.progress?.label || undefined, error: b.error || undefined, plugin_id: b.plugin_id || undefined, cost_usd: b.cost_usd, model: b.ai?.model || undefined, denkstufe: b.ai?.label || undefined, diff: b.plan?.diff?.summary, created: b.created.map((c: any) => `${c.block}: ${c.name}${c.undone ? ' (rückgängig)' : ''}`), log: b.log.slice(-8).map((l: any) => l.text) };
      }
      if (a.plugin_id) {
        const p = await call.api('GET', `/api/plugins/${enc(a.plugin_id)}`, { location: a.location_id });
        const mark = (ok: boolean | null) => (ok === null ? '–' : ok ? '✓' : '✗');
        return {
          plugin_id: p.id,
          link: pluginLink(p.id),
          id: p.id,
          name: p.name,
          version: p.version,
          scope: p.scope,
          status: p.status,
          active_here: p.active_here,
          killed_reason: p.killed_reason || undefined,
          permissions: p.scopes.map((s: any) => s.key),
          versions: p.versions.map((v: any) => `${v.version}${v.active ? ' (aktiv)' : ''} – ${v.status}${v.badges ? ` · statisch ${mark(v.badges.static)}, Tests ${mark(v.badges.tests)}, Prüfung ${v.badges.review ? v.badges.review.verdict : '–'}${v.badges.second_opinion ? `, Zweitmeinung ${v.badges.second_opinion.verdict}` : ''}${v.badges.model ? ` · ${v.badges.model}, Denkstufe ${v.badges.effort}` : ''}` : ''}`),
          health: p.health,
        };
      }
      const list = await call.api('GET', '/api/werkstatt/builds', { location: a.location_id });
      return { builds: list.slice(0, 10).map((b: any) => ({ build_id: b.id, id: b.id, link: buildLink(b.id), title: b.title, stage: b.stage_label, status: b.status_label, plugin_id: b.plugin_id || undefined })) };
    },
  },
  {
    name: 'ghl_plugin_overview',
    title: 'Werkstatt-Überblick (Admin)',
    description: `Für Admins: Aufträge, die auf Freigabe warten, und alle Plugins mit Gesundheit, Prüfung und Marktplatz-Stand – der Einstieg, bevor du mit ghl_plugin_admin etwas freigibst, veröffentlichst oder zurückrollst.`,
    inputSchema: obj({ ...LOC }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    agencyOnly: true,
    run: async (call, a) => {
      const [agency, plugins] = await Promise.all([call.api('GET', '/api/werkstatt/agency', { location: a.location_id }), call.api('GET', '/api/marktplatz/admin/plugins', { location: a.location_id })]);
      return {
        awaiting_approval: agency.builds.filter((b: any) => b.status === 'awaiting_approval').map((b: any) => ({ build_id: b.id, link: buildLink(b.id), title: b.title, stage: b.stage_label, by: b.user, location: b.location, estimated_cost_usd: b.est_cost_usd })),
        plugins: plugins.plugins.slice(0, 40).map((p: any) => ({ plugin_id: p.id, link: pluginLink(p.id), name: p.name, version: p.version, scope: p.scope, status: p.status, owner: p.owner, installs: p.health?.installs, errors_24h: p.health?.errors_24h, avg_ms_24h: p.health?.avg_ms_24h, review: p.review ? `${p.review.verdict} (${p.review.model})` : undefined, marktplatz_version: p.market_version || undefined, killed_reason: p.killed_reason || undefined })),
      };
    },
  },
  {
    name: 'ghl_plugin_admin',
    title: 'Plugin verwalten (Admin)',
    description: `Für Admins: der Lebenszyklus eines Plugins oder Auftrags. Aktionen: approve_build / reject_build (Auftrag freigeben oder ablehnen, build_id, note), review (Sicherheitsprüfung mit einem Spitzenmodell), second_opinion (Zweitmeinung eines anderen Spitzenmodells, Pro), publish (im ${NAMES.marktplatz} veröffentlichen – braucht review_id UND approve: true; accept_warnings, wenn die Prüfung Hinweise hat), unpublish, rollback (zurück zur Vorversion oder zu version_id; schaltet ein abgeschaltetes Plugin wieder ein), disable (abschalten, reason), enable, scope (private | location | agency), core_proposal (als Kernfeature vorschlagen: GitHub-Issue). Frage den Nutzer immer ausdrücklich, bevor du freigibst, veröffentlichst oder abschaltest, und nenne ihm vorher das Ergebnis der Prüfung.`,
    inputSchema: obj(
      {
        ...LOC,
        action: { type: 'string', enum: ['approve_build', 'reject_build', 'review', 'second_opinion', 'publish', 'unpublish', 'rollback', 'disable', 'enable', 'scope', 'core_proposal'] },
        plugin_id: { type: 'string' },
        build_id: { type: 'string' },
        review_id: { type: 'string', description: 'Die Prüfung, auf die sich die Veröffentlichung stützt (Ergebnis von review).' },
        version_id: { type: 'string' },
        approve: { type: 'boolean', description: 'Der Nutzer hat die Veröffentlichung ausdrücklich bestätigt.' },
        accept_warnings: { type: 'boolean', description: 'Der Nutzer hat die Hinweise der Prüfung gelesen.' },
        note: { type: 'string' },
        reason: { type: 'string' },
        scope: { type: 'string', enum: ['private', 'location', 'agency'] },
        agent: { type: 'string', enum: ['codex', 'claude'] },
      },
      ['action'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    agencyOnly: true,
    run: async (call, a) => {
      const loc = a.location_id;
      const need = (k: string) => {
        if (!a[k]) throw new HttpError(400, `${k} fehlt.`);
        return enc(a[k]);
      };
      const brief = (r: any) => ({ build_id: r.id, link: buildLink(r.id), status: r.status_label ?? r.status, title: r.title });
      const review = (r: any) => ({ review_id: r.id, kind: r.kind, verdict: r.verdict, summary: r.summary, model: r.model, denkstufe: r.effort?.label, failed_checks: (r.checks ?? []).filter((c: any) => !c.ok).map((c: any) => `${c.label}: ${c.note}`) });
      switch (a.action) {
        case 'approve_build':
          return brief(await call.api('POST', `/api/werkstatt/builds/${need('build_id')}/approve`, { location: loc, body: { note: a.note } }));
        case 'reject_build':
          return brief(await call.api('POST', `/api/werkstatt/builds/${need('build_id')}/reject`, { location: loc, body: { note: a.note } }));
        case 'review':
          return { link: pluginLink(String(a.plugin_id)), ...review(await call.api('POST', `/api/marktplatz/${need('plugin_id')}/security-review`, { location: loc, body: { version_id: a.version_id } })) };
        case 'second_opinion': {
          const r = await call.api('POST', `/api/marktplatz/${need('plugin_id')}/second-opinion`, { location: loc, body: { version_id: a.version_id } });
          return { link: pluginLink(String(a.plugin_id)), ...review(r.second_opinion), first_review: r.review ? review(r.review) : undefined, comparison: r.comparison };
        }
        case 'publish': {
          if (!a.review_id) throw new HttpError(400, 'review_id fehlt – zuerst mit action „review“ prüfen lassen.');
          const r = await call.api('POST', `/api/marktplatz/${need('plugin_id')}/publish`, { location: loc, body: { review_id: a.review_id, approve: a.approve === true, accept_warnings: a.accept_warnings === true } });
          return { published: true, plugin_id: r.id, name: r.name, version: r.version, link: `${ROUTES.marktplatz}/${r.id}` };
        }
        case 'unpublish':
          await call.api('POST', `/api/marktplatz/${need('plugin_id')}/unpublish`, { location: loc });
          return { unpublished: true, plugin_id: a.plugin_id, link: pluginLink(String(a.plugin_id)) };
        case 'rollback': {
          const r = await call.api('POST', `/api/plugins/${need('plugin_id')}/rollback`, { location: loc, body: { version_id: a.version_id } });
          return { rolled_back: true, from: r.from, to: r.to, revived: r.revived, unpublished: r.unpublished, plugin_id: a.plugin_id, link: pluginLink(String(a.plugin_id)) };
        }
        case 'disable':
          await call.api('POST', `/api/plugins/${need('plugin_id')}/kill`, { location: loc, body: { reason: a.reason } });
          return { disabled: true, plugin_id: a.plugin_id, link: pluginLink(String(a.plugin_id)) };
        case 'enable':
          await call.api('POST', `/api/plugins/${need('plugin_id')}/revive`, { location: loc });
          return { enabled: true, plugin_id: a.plugin_id, link: pluginLink(String(a.plugin_id)) };
        case 'scope': {
          const r = await call.api('POST', `/api/plugins/${need('plugin_id')}/scope`, { location: loc, body: { scope: a.scope } });
          return { plugin_id: r.id, scope: r.scope, link: pluginLink(r.id) };
        }
        case 'core_proposal': {
          const r = await call.api('POST', `/api/werkstatt/plugins/${need('plugin_id')}/core-proposal`, { location: loc, body: { agent: a.agent } });
          return { proposal_id: r.id, status: r.status, title: r.title, issue_url: r.issue_url || undefined, issue_error: r.issue_error || undefined, hint: r.issue_error ? 'Das Issue wurde nicht angelegt (Hinweis oben) – die Spezifikation ist gespeichert und lässt sich unter Werkstatt → Kernfeatures nachreichen.' : 'Nichts wird automatisch ausgeliefert: CI, Review durch einen Menschen und ein Feature-Flag stehen davor.' };
        }
        default:
          throw new HttpError(400, 'Unbekannte Aktion.');
      }
    },
  },
];

/** The tools whose results the agent chat shows as cards (web/src/werkstatt/ChatCards.tsx knows the same names). */
export const WERKSTATT_TOOL_NAMES = TOOLS.map((t) => t.name);

export const werkstattToolsModule: Module = {
  name: 'werkstatt-tools',
  register(app) {
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    // The HyperLevel Agent offers a build when a request is not covered – only to people who may build.
    app.services.agentPromptExtras = [
      ...(app.services.agentPromptExtras ?? []),
      (i: { user: any; locationId: string; automatic: boolean }) => {
        if (i.automatic || !mayBuild(loadPolicy(app), i.user, i.locationId).ok) return '';
        const admin = i.user?.role === 'admin';
        return [
          `# ${NAMES.plugins} (${NAMES.werkstatt})`,
          `Äußert der Nutzer einen Funktionswunsch („Ich hätte gern …“, „Kann das System …?“), den weder deine Werkzeuge noch vorhandene Funktionen abdecken (z. B. „eine Ampel für Deals“, „Geburtstags-Erinnerungen“), prüfe erst mit ghl_list_plugins (scope "marktplatz"), ob es im ${NAMES.marktplatz} schon ein passendes Plugin gibt, und schlage dann ghl_install_plugin vor.`,
          'Gibt es keins, rufe ghl_build_from_wish auf (nur planen, ohne confirm): Der Nutzer bestätigt den Aufruf und sieht den Plan danach als Karte im Chat – was gebaut wird, Berechtigungen, Kosten, Modell und Denkstufe. Bestätige den Plan nie selbst: Er bestätigt mit dem Knopf der Karte (oder sagt im Chat ausdrücklich „ja, bauen“). Schreibe danach nur einen kurzen Satz; Plan, Fortschritt und Vorschau zeigt die Karte.',
          'Will der Nutzer an einem fertigen Plugin etwas ändern („mach die Farben dunkler“), rufe ghl_change_plugin mit seinem Wunsch auf und fasse danach die Änderung (diff) in zwei Sätzen zusammen; die alte Version bleibt, zurückrollen ist möglich.',
          'Meldet ein Werkzeug, dass ein Spitzenmodell nötig ist (Mindest-Modell), sage das so und nenne den Ort der Einstellung (Einstellungen → KI-Anbieter bei „Werkstatt“) – bau nichts anderes als Ersatz.',
          ...(admin ? ['Als Admin hilfst du auch beim Lebenszyklus: ghl_plugin_overview zeigt wartende Freigaben und die Plugins mit Gesundheit; ghl_plugin_admin gibt frei, lehnt ab, lässt prüfen, veröffentlicht, rollt zurück oder schaltet ab. Frage vor jeder dieser Aktionen ausdrücklich nach und nenne vorher das Prüfergebnis. Nichts wird automatisch ausgeliefert.'] : []),
        ].join('\n');
      },
    ];
  },
};
