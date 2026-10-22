#!/usr/bin/env node
/**
 * Live smoke test of the Werkstatt (wish → build) on a running instance – it reads, it never builds and it never
 * spends: the "dry run" checks policy, AI connection, budget, estimate and prompt size WITHOUT asking the model.
 *
 *   PGHL_BASE_URL=https://crm.example.com PGHL_AGENCY_KEY=pghla_… node scripts/werkstatt-smoke.mjs
 *   node scripts/werkstatt-smoke.mjs --base https://crm.example.com --session <pghl_session cookie> --location "Praxis Sonnenweg"
 *
 * Options
 *   --base <url>        address of the instance (or PGHL_BASE_URL)
 *   --key <pghla_…>     agency API key, admin rights (or PGHL_AGENCY_KEY) – Einstellungen → Agentur → API-Schlüssel
 *   --session <value>   the pghl_session cookie of an admin login instead of a key (or PGHL_SESSION)
 *   --location <x>      sub-account (id or name) to check; default: the first one
 *   --user <email>      also tell whether this person may build ("Mia darf bauen: ja/nein")
 *   --wish "<text>"     sample wish for the dry run
 *   --live-plan         OPT-IN, spends a few cents: really asks the AI for a plan, prints it, then cancels the order
 *   --json              machine-readable result
 *
 * Exit code 0 = everything needed is in place, 1 = something blocks building (see the lines marked FAIL).
 */

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, env) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : (env && process.env[env]) || '';
};
if (flag('help') || flag('h')) {
  console.log(`Usage: PGHL_BASE_URL=… PGHL_AGENCY_KEY=pghla_… node scripts/werkstatt-smoke.mjs [--location <id|name>] [--user <email>] [--wish "…"] [--live-plan] [--json]`);
  process.exit(0);
}

const base = opt('base', 'PGHL_BASE_URL').replace(/\/$/, '');
const key = opt('key', 'PGHL_AGENCY_KEY');
const session = opt('session', 'PGHL_SESSION');
const wish = opt('wish') || 'Ich möchte auf einen Blick sehen, welche Deals seit über 14 Tagen nicht angefasst wurden – als Ampel (grün, gelb, rot).';
const json = flag('json');
if (!base || (!key && !session)) {
  console.error('Es fehlt die Adresse (PGHL_BASE_URL) oder ein Agentur-Schlüssel (PGHL_AGENCY_KEY) bzw. eine Sitzung (PGHL_SESSION). Mit --help siehst du alles.');
  process.exit(2);
}

const results = [];
const out = (level, title, detail = '') => {
  results.push({ level, title, detail });
  if (!json) console.log(`${{ ok: ' OK  ', warn: 'WARN ', fail: 'FAIL ', info: ' ··  ' }[level]} ${title}${detail ? `\n       ${String(detail).split('\n').join('\n       ')}` : ''}`);
};
const head = (t) => !json && console.log(`\n== ${t}`);

let location = '';
async function call(method, path, body, extra = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-pghl': '1',
      ...(key ? { authorization: `Bearer ${key}` } : { cookie: `pghl_session=${session}` }),
      ...(location ? { 'x-location-id': location } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e.message || e) }));
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { ok: res.ok, status: res.status, data };
}
const err = (r) => (r.status === 0 ? `Keine Verbindung: ${r.data}` : `${r.status} ${typeof r.data === 'object' && r.data?.error ? r.data.error : String(r.data).slice(0, 120)}`);
const usd = (n) => `${Number(n).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;

async function main() {
  head(`Verbindung zu ${base}`);
  const health = await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false);
  out(health ? 'ok' : 'warn', health ? 'Server antwortet (/healthz)' : 'Kein /healthz – Adresse prüfen');

  const locs = await call('GET', '/api/locations');
  if (!locs.ok) {
    out('fail', 'Anmeldung mit diesem Schlüssel/dieser Sitzung abgelehnt', `${err(locs)}\nBraucht Admin-Rechte (Agentur-Schlüssel mit „schreiben“ oder Admin-Sitzung).`);
    return;
  }
  out('ok', 'Anmeldung als Admin', `${locs.data.length} Sub-Account${locs.data.length === 1 ? '' : 's'}`);
  const want = opt('location').toLowerCase();
  const pick = want ? locs.data.find((l) => l.id === opt('location') || String(l.name).toLowerCase() === want) ?? locs.data.find((l) => String(l.name).toLowerCase().includes(want)) : locs.data[0];
  if (!pick) {
    out('fail', `Sub-Account „${opt('location')}“ nicht gefunden`, `Vorhanden: ${locs.data.map((l) => l.name).join(', ')}`);
    return;
  }
  location = pick.id;
  out('info', `Geprüft wird Sub-Account „${pick.name}“`, pick.id);

  head('Richtlinie (Werkstatt → Richtlinien)');
  const pol = await call('GET', '/api/werkstatt/policy');
  if (!pol.ok) out('fail', 'Richtlinie nicht lesbar', err(pol));
  else {
    const p = pol.data.policy;
    const names = (ids, list, f) => ids.map((id) => list.find((x) => x.id === id)).filter(Boolean).map(f);
    out('info', `Wer darf bauen: ${{ admins: 'nur Admins (Standard)', team: 'das Team', everyone: 'alle Personen' }[p.who] ?? p.who}`);
    const users = names(p.allow_users, pol.data.users, (u) => `${u.name} (${u.email})`);
    const locsAllowed = names(p.allow_locations, pol.data.locations, (l) => l.name);
    out('info', `Zusätzlich freigeschaltet: ${users.length ? users.join(', ') : 'keine Person'}${locsAllowed.length ? ` · Sub-Accounts: ${locsAllowed.join(', ')}` : ''}`);
    out('info', `Freigabe durch Admin: ${p.approval ? 'ja (mit App-Hinweis, Push und E-Mail)' : 'nein'} · Monatsbudget ${usd(p.budgets?.[pick.id] ?? p.budget_usd)} je Sub-Account · Korrekturrunden der KI: ${p.repair_rounds}`);
    const gate = p.model_gate;
    out('info', `Mindest-Modell: ${gate.enabled ? `nur Spitzenmodelle${gate.newer ? ' (auch neuere Versionen)' : ''}${gate.extra.length ? `, eigene Muster: ${gate.extra.join(', ')}` : ''}; Einrichtungen mit dem normalen Modell: ${gate.stage1_normal ? 'ja' : 'nein'}` : 'ausgeschaltet – jedes Modell ist erlaubt'}`);
    const lic = pol.data.license;
    out('info', `Pro-Funktionen (Marktplatz, signierte Plugins, Zweitmeinung, Prozent-Rollout): ${lic.pro ? `freigeschaltet${lic.stub ? ' (kein Lizenzsystem eingebaut – alles an)' : ''}` : 'GESPERRT – keine Pro-Lizenz'} · eigene Signatur-Schlüssel: ${p.trusted_keys.length}`);
    out('info', `Server-Logik: ${p.server_logic} · Kernfeatures: ${p.core.repo ? `${p.core.repo} (${p.core.agent === 'claude' ? '@claude' : '@codex'})` : 'noch kein Repository'}`);
    const sb = pol.data.sandbox;
    out(sb.ok ? 'ok' : 'warn', sb.ok ? `Skript-Sandbox bereit (Node ${sb.node}, Netzwerk: ${sb.network === 'namespace' ? 'eigener Namensraum' : 'Sperre im Prozess'})` : 'Skript-Sandbox nicht verfügbar – nur deklarative Plugins', sb.reason ?? '');
    const who = opt('user').toLowerCase();
    if (who) {
      const u = pol.data.users.find((x) => String(x.email).toLowerCase() === who);
      if (!u) out('warn', `Person ${who} nicht gefunden`);
      else {
        const granted = p.allow_users.includes(u.id);
        const may = u.role === 'admin' || granted || p.who === 'everyone' || p.who === 'team';
        out(may ? 'ok' : 'warn', `${u.name} darf bauen: ${may ? 'ja' : 'nein'}`, u.role === 'admin' ? 'Admin' : granted ? 'ausdrücklich freigeschaltet' : p.who === 'team' ? 'Team (Recht „Einstellungen“ nötig)' : p.who === 'everyone' ? 'alle dürfen' : 'nur Admins – unter „Zusätzlich erlaubte Personen“ freischalten');
      }
    }
  }

  head('KI-Verbindungen (Einstellungen → KI-Anbieter)');
  const ai = await call('GET', '/api/ai-connections');
  if (!ai.ok) out('warn', 'KI-Verbindungen nicht lesbar', err(ai));
  else {
    const list = ai.data.connections.filter((c) => (c.capabilities ?? []).includes('text'));
    if (!list.length) out('info', 'Keine eigene Text-Verbindung eingetragen (dann zählt der Anthropic-/OpenAI-Schlüssel des KI-Assistenten)');
    for (const c of list) out(c.enabled && c.key_set ? 'ok' : 'warn', `${c.label || c.provider_label} (${c.scope === 'agency' ? 'Agentur' : 'Sub-Account'}, ${c.provider}) – Modell ${c.models?.text || c.model || '?'}`, `${c.enabled ? 'an' : 'AUS'} · Schlüssel ${c.key_set ? c.key_hint : 'FEHLT'}${c.status ? ` · letzte Prüfung: ${c.status}` : ''}`);
    const eff = ai.data.routing?.effective?.text;
    out(eff ? 'ok' : 'info', eff ? `Text-Anfragen laufen über „${eff.label}“ (${eff.model})` : 'Kein Routing für Text – es gilt der Anbieter des KI-Assistenten');
  }

  head('Trockenlauf: Plan für einen Beispielwunsch (ohne KI-Aufruf, ohne Kosten)');
  const dry = await call('GET', `/api/werkstatt/dry-run?text=${encodeURIComponent(wish)}`);
  if (!dry.ok) out('fail', 'Trockenlauf fehlgeschlagen', err(dry));
  else {
    const d = dry.data;
    out('info', `Wunsch: ${wish.slice(0, 110)}${wish.length > 110 ? ' …' : ''}`);
    out(d.policy.allowed ? 'ok' : 'fail', d.policy.allowed ? 'Richtlinie erlaubt das Bauen' : 'Richtlinie verbietet das Bauen', d.policy.allowed ? `Freigabe nötig: ${d.policy.needs_approval ? 'ja' : 'nein'}` : d.problems[0]);
    out(d.ai.ready ? 'ok' : 'fail', d.ai.ready ? `KI bereit: ${d.ai.label} · ${d.ai.model}${d.ai.key_source ? ` (Schlüssel: ${d.ai.key_source})` : ''}` : 'KI nicht bereit', d.ai.problem ?? '');
    const g = d.model_gate;
    out(g.ok ? 'ok' : 'warn', g.ok ? `Modell für Mini-Apps: ${g.model}${g.matched ? ` (${g.matched})` : ''}` : `Das Modell „${g.model}“ ist kein Spitzenmodell – Mini-Apps lassen sich damit nicht bauen`, g.ok ? `Denkstufe ${g.effort.label || 'nicht gesendet'}${g.effort.note ? ` – ${g.effort.note}` : ''}` : `${g.message}\nEinrichtungen (Stufe 1) planen und bauen: ${g.plan_ok ? 'ja' : 'nein'}`);
    out(g.review.model ? (g.review.ok && g.review.differs ? 'ok' : 'warn') : 'info', g.review.model ? `Zweitmeinung (Pro): ${g.review.model}${g.review.ok ? '' : ' – kein Spitzenmodell'}${g.review.differs ? '' : ' – dasselbe Modell wie beim Bauen'}` : 'Zweitmeinung (Pro): noch kein zweites Modell eingestellt (KI-Anbieter → „Werkstatt: Zweitmeinung“)');
    out(d.budget.problem ? 'fail' : 'ok', `Budget: ${usd(d.budget.used_usd)} von ${usd(d.budget.limit_usd)} verbraucht`, d.budget.problem ?? '');
    out('info', `Kosten (geschätzt): Plan ≈ ${usd(d.estimate.plan.typical_usd)} · Mini-App ≈ ${usd(d.estimate.build.typical_usd)} (höchstens ${usd(d.estimate.build.max_usd)}) · Änderung ≈ ${usd(d.estimate.change.typical_usd)}`);
    out('info', `Prompt: etwa ${d.prompt.approx_tokens} Token + Schema ${d.prompt.schema_bytes} Byte`);
    out(d.sandbox.ok ? 'ok' : 'warn', d.sandbox.ok ? 'Sandbox für Plugin-Skripte bereit' : 'Sandbox nicht verfügbar', d.sandbox.reason ?? '');
    for (const p of d.problems) if (!results.some((r) => r.detail === p || r.title === p)) out('fail', p);
    out('info', d.note);
  }

  head('Kernfeature-Vorschläge (GitHub)');
  const gh = await call('GET', '/api/werkstatt/core/github');
  if (!gh.ok) out('warn', 'GitHub-Status nicht lesbar', err(gh));
  else out(gh.data.ready ? 'ok' : 'warn', gh.data.ready ? 'GitHub-Token und Repository sind eingerichtet' : 'Kernfeature-Issues noch nicht möglich', gh.data.hint);

  if (flag('live-plan')) {
    head('Echter Plan (verbraucht KI-Budget!)');
    const b = await call('POST', '/api/werkstatt/builds', { text: wish });
    if (!b.ok) out('fail', 'Auftrag nicht angelegt', err(b));
    else {
      let cur = b.data;
      for (let i = 0; i < 90 && cur.status === 'planning'; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const g = await call('GET', `/api/werkstatt/builds/${b.data.id}`);
        if (g.ok) {
          cur = g.data;
          if (!json && cur.progress?.label) process.stdout.write(`\r       … ${cur.progress.label}          `);
        }
      }
      if (!json) process.stdout.write('\n');
      if (cur.status === 'planned') out('ok', `Plan: ${cur.plan.title} (Stufe ${cur.stage}: ${cur.stage_label})`, `${cur.plan.summary}\nKosten bisher ${usd(cur.cost_usd)}`);
      else out('fail', `Plan nicht erstellt (${cur.status_label})`, cur.error);
      await call('POST', `/api/werkstatt/builds/${b.data.id}/cancel`);
      out('info', 'Auftrag wieder abgebrochen – es wurde nichts gebaut');
    }
  }
}

await main();
const fails = results.filter((r) => r.level === 'fail').length;
const warns = results.filter((r) => r.level === 'warn').length;
if (json) console.log(JSON.stringify({ ok: fails === 0, fails, warns, results }, null, 2));
else console.log(`\n${fails ? `${fails} Problem${fails === 1 ? '' : 'e'}` : 'Alles Nötige ist da'}${warns ? `, ${warns} Hinweis${warns === 1 ? '' : 'e'}` : ''}.`);
process.exit(fails ? 1 : 0);
