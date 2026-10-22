import type { Manifest } from './manifest.js';
import type { StepsSpec } from './declarative.js';

/**
 * Example plugins: they ship with the app (Werkstatt → „Beispiele“ installs them privately), run in the
 * tests through the real sandbox, and double as few-shot examples in the AI prompt.
 */

export interface ExamplePlugin {
  manifest: Manifest;
  ui_html: string;
  server_js: string;
  steps?: StepsSpec;
  /** The wish that would have led to it (what the Werkstatt shows as the origin). */
  wish: string;
}

/** Date helpers used by the birthday plugin in the page and in the job (plain JavaScript, no libraries). */
const BIRTHDAY_HELPERS = String.raw`
function parseBirthday(v) {
  var s = String(v || '').trim(), m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) return { y: +m[1], m: +m[2], d: +m[3] };
  if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s))) return { y: +m[3], m: +m[2], d: +m[1] };
  return null;
}
function pad(n) { return (n < 10 ? '0' : '') + n; }
function dayNumber(iso) { var p = iso.split('-'); return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000); }
function nextBirthday(b, today) {
  var year = +today.slice(0, 4);
  for (var i = 0; i < 2; i++) {
    var y = year + i, d = b.d, leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    if (b.m === 2 && d === 29 && !leap) d = 28;
    var iso = y + '-' + pad(b.m) + '-' + pad(d);
    if (dayNumber(iso) >= dayNumber(today)) return { iso: iso, in: dayNumber(iso) - dayNumber(today), age: y - b.y };
  }
  return null;
}
`;

const birthdayUi = String.raw`
<div id="app"><p class="muted">Lade Kontakte …</p></div>
<style>
  .bd-top { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; margin-bottom: 12px; }
  .bd-top label { display: grid; gap: 4px; font-size: 12px; color: var(--muted); }
  .bd-today td:first-child { font-weight: 600; }
</style>
<script>
${BIRTHDAY_HELPERS}
gohigh.ready(async function (ctx) {
  var root = document.getElementById('app');
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var settings = (await gohigh.storage.get({ key: 'settings' })) || { days: 14, leadDays: 1 };
  async function allContacts() {
    var all = [];
    for (var page = 0; page < 4; page++) {
      var r = await gohigh.contacts.list({ limit: 500, offset: page * 500 });
      all = all.concat(r.contacts || []);
      if (all.length >= (r.total || 0)) break;
    }
    return all;
  }
  async function render() {
    var contacts;
    try { contacts = await allContacts(); } catch (e) { root.innerHTML = '<p class="gh-empty">Kontakte konnten nicht geladen werden: ' + esc(e.message) + '</p>'; return; }
    var rows = [];
    contacts.forEach(function (c) {
      var b = parseBirthday(c.date_of_birth);
      var n = b && nextBirthday(b, ctx.today);
      if (n && n.in <= settings.days) rows.push({ c: c, n: n });
    });
    rows.sort(function (a, b) { return a.n.in - b.n.in; });
    var html = '<div class="gh-card"><div class="bd-top">' +
      '<label>Vorschau (Tage)<input class="gh-input" id="days" type="number" min="1" max="90" value="' + esc(settings.days) + '"></label>' +
      '<label>Aufgabe anlegen (Tage vorher)<input class="gh-input" id="lead" type="number" min="0" max="14" value="' + esc(settings.leadDays) + '"></label>' +
      '<button class="gh-btn" id="save">Speichern</button></div>' +
      '<p class="muted small">Jeden Morgen legt das Plugin für anstehende Geburtstage eine Aufgabe an. Geburtstage kommen aus dem Feld „Geburtsdatum“ der Kontakte.</p></div>';
    if (!rows.length) html += '<p class="gh-empty">Keine Geburtstage in den nächsten ' + esc(settings.days) + ' Tagen.</p>';
    else {
      html += '<div class="gh-card"><table class="gh-table"><thead><tr><th>Kontakt</th><th>Geburtstag</th><th>In</th><th>Wird</th></tr></thead><tbody>';
      rows.forEach(function (r) {
        var name = [r.c.first_name, r.c.last_name].filter(Boolean).join(' ') || r.c.email || 'Kontakt';
        html += '<tr class="' + (r.n.in === 0 ? 'bd-today' : '') + '"><td>' + esc(name) + '</td><td>' + esc(r.n.iso.split('-').reverse().join('.')) + '</td><td>' + (r.n.in === 0 ? '<span class="gh-badge green">heute</span>' : r.n.in + ' Tage') + '</td><td>' + esc(r.n.age) + '</td></tr>';
      });
      html += '</tbody></table></div>';
    }
    root.innerHTML = html;
    document.getElementById('save').onclick = async function () {
      settings = { days: Math.min(90, Math.max(1, +document.getElementById('days').value || 14)), leadDays: Math.min(14, Math.max(0, +document.getElementById('lead').value || 0)) };
      await gohigh.storage.set({ key: 'settings', value: settings });
      gohigh.toast('Gespeichert');
      render();
    };
  }
  render();
});
</script>
`;

const birthdayJob = `${BIRTHDAY_HELPERS}
gohigh.job('daily', async function () {
  var settings = (await gohigh.storage.get({ key: 'settings' })) || { days: 14, leadDays: 1 };
  var today = gohigh.context.today;
  var done = (await gohigh.storage.get({ key: 'done' })) || { year: today.slice(0, 4), ids: [] };
  if (done.year !== today.slice(0, 4)) done = { year: today.slice(0, 4), ids: [] };
  var created = 0, seen = 0;
  for (var page = 0; page < 8; page++) {
    var r = await gohigh.contacts.list({ limit: 500, offset: page * 500 });
    var list = r.contacts || [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i], b = parseBirthday(c.date_of_birth);
      if (!b) continue;
      seen++;
      var n = nextBirthday(b, today);
      if (!n || n.in > settings.leadDays || done.ids.indexOf(c.id) >= 0) continue;
      var name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Kontakt';
      await gohigh.tasks.create({ title: 'Geburtstag: ' + name + (n.in === 0 ? ' hat heute Geburtstag' : ' hat in ' + n.in + ' Tagen Geburtstag') + ' (wird ' + n.age + ')', description: 'Eine kurze Nachricht oder ein Anruf kommt gut an.', due_at: n.iso + 'T08:00:00.000Z', contact_id: c.id });
      done.ids.push(c.id);
      created++;
    }
    if ((page + 1) * 500 >= (r.total || 0)) break;
  }
  await gohigh.storage.set({ key: 'done', value: done });
  gohigh.log('Geburtstage geprüft:', seen, 'Kontakte, Aufgaben angelegt:', created);
  return { created: created, checked: seen };
});
`;

const ampelUi = String.raw`
<div id="app"><p class="muted">Lade Deals …</p></div>
<style>
  .lights { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 8px; }
  .light { text-align: center; padding: 10px 6px; border-radius: var(--radius); border: 1px solid var(--line); background: var(--panel); }
  .light strong { display: block; font-size: 24px; line-height: 1.1; }
  .light.green { border-color: var(--green); } .light.yellow { border-color: var(--yellow); } .light.red { border-color: var(--red); }
  .stale { display: flex; justify-content: space-between; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
</style>
<script>
gohigh.ready(async function (ctx) {
  var root = document.getElementById('app');
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function eur(n) { return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n || 0); }
  var deals;
  try { deals = await gohigh.opportunities.list({ status: 'open' }); } catch (e) { root.innerHTML = '<p class="gh-empty">Deals konnten nicht geladen werden: ' + esc(e.message) + '</p>'; return; }
  var groups = { green: [], yellow: [], red: [] };
  var now = Date.now();
  deals.forEach(function (d) {
    var days = Math.floor((now - new Date(d.stage_changed_at || d.updated_at).getTime()) / 86400000);
    d.days = days;
    groups[days < 7 ? 'green' : days < 14 ? 'yellow' : 'red'].push(d);
  });
  function sum(list) { return list.reduce(function (s, d) { return s + (d.value || 0); }, 0); }
  var labels = { green: 'In Bewegung', yellow: 'Wird still', red: 'Steht' };
  var html = '<div class="lights">';
  ['green', 'yellow', 'red'].forEach(function (k) {
    html += '<div class="light ' + k + '"><span class="gh-dot ' + k + '"></span> ' + labels[k] + '<strong>' + groups[k].length + '</strong><span class="muted small">' + eur(sum(groups[k])) + '</span></div>';
  });
  html += '</div>';
  var stale = groups.red.sort(function (a, b) { return b.days - a.days; }).slice(0, 6);
  if (stale.length) {
    html += '<h3>Seit über 14 Tagen unverändert</h3>';
    stale.forEach(function (d) { html += '<div class="stale"><span>' + esc(d.name) + ' <span class="muted">· ' + esc([d.first_name, d.last_name].filter(Boolean).join(' ')) + '</span></span><span>' + d.days + ' Tage · ' + eur(d.value) + '</span></div>'; });
    html += '<p><a href="opportunities">Alle Deals öffnen</a></p>';
  } else if (!deals.length) html += '<p class="gh-empty">Keine offenen Deals.</p>';
  else html += '<p class="muted">Alle offenen Deals sind in Bewegung.</p>';
  root.innerHTML = html;
});
</script>
`;

const summaryUi = String.raw`
<div id="app"><p class="muted">Lade …</p></div>
<script>
gohigh.ready(async function (ctx) {
  var root = document.getElementById('app');
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var id = ctx.entity && ctx.entity.id;
  if (!id) { root.innerHTML = '<p class="gh-empty">Dieses Panel gehört auf eine Kontaktseite.</p>'; return; }
  var cache = (await gohigh.storage.get({ key: 'cache' })) || {};
  function show(text, at) {
    root.innerHTML = '<div class="gh-row"><button class="gh-btn" id="go">Neu zusammenfassen</button><span class="muted small">' + (at ? 'Stand ' + esc(new Date(at).toLocaleString('de-DE')) : '') + '</span></div><p style="white-space:pre-wrap">' + esc(text) + '</p>';
    document.getElementById('go').onclick = run;
  }
  async function run() {
    root.innerHTML = '<p class="muted">Die KI fasst die Notizen zusammen …</p>';
    try {
      var c = await gohigh.contacts.get({ id: id });
      var notes = (c.notes || []).slice(0, 25).map(function (n) { return '- ' + n.body; }).join('\n');
      if (!notes) { root.innerHTML = '<p class="gh-empty">Dieser Kontakt hat noch keine Notizen.</p>'; return; }
      var r = await gohigh.ai.complete({ system: 'Fasse die Notizen zu einem Kontakt in höchstens 5 Stichpunkten zusammen: Stand, Wünsche, nächste Schritte.', prompt: notes, max_tokens: 400 });
      cache[id] = { text: r.text, at: new Date().toISOString() };
      var keys = Object.keys(cache);
      if (keys.length > 30) keys.sort(function (a, b) { return cache[a].at < cache[b].at ? -1 : 1; }).slice(0, keys.length - 30).forEach(function (k) { delete cache[k]; });
      await gohigh.storage.set({ key: 'cache', value: cache });
      show(r.text, cache[id].at);
    } catch (e) {
      root.innerHTML = '<p class="gh-empty">' + esc(e.message) + '</p>';
    }
  }
  if (cache[id]) show(cache[id].text, cache[id].at);
  else root.innerHTML = '<button class="gh-btn" id="go">Notizen zusammenfassen</button>', (document.getElementById('go').onclick = run);
});
</script>
`;

export const EXAMPLES: Record<string, ExamplePlugin> = {
  'geburtstags-erinnerungen': {
    wish: 'Ich möchte vor Geburtstagen meiner Kontakte automatisch erinnert werden.',
    manifest: {
      name: 'Geburtstags-Erinnerungen',
      slug: 'geburtstags-erinnerungen',
      icon: 'gift',
      version: '1.0.0',
      description: 'Legt jeden Morgen eine Aufgabe an, wenn ein Kontakt Geburtstag hat, und zeigt die nächsten Geburtstage.',
      category: 'kontakte',
      scopes: ['contacts:read', 'tasks:write'],
      entries: { page: { title: 'Geburtstage', icon: 'gift' }, jobs: [{ id: 'daily', label: 'Täglich Geburtstags-Aufgaben anlegen', every: 'daily', at: '07:30' }] },
      server: { mode: 'script' },
    },
    ui_html: birthdayUi,
    server_js: birthdayJob,
  },
  'deal-ampel': {
    wish: 'Ich will auf einen Blick sehen, welche Deals ins Stocken geraten.',
    manifest: {
      name: 'Deal-Ampel',
      slug: 'deal-ampel',
      icon: 'traffic-cone',
      version: '1.0.0',
      description: 'Zeigt offene Deals als Ampel: in Bewegung, wird still, steht – mit Summen und den ältesten Deals.',
      category: 'vertrieb',
      scopes: ['opportunities:read'],
      entries: { widgets: [{ id: 'ampel', title: 'Deal-Ampel', size: 'm' }], page: { title: 'Deal-Ampel', icon: 'traffic-cone' } },
    },
    ui_html: ampelUi,
    server_js: '',
  },
  'notizen-zusammenfassung': {
    wish: 'Auf der Kontaktseite soll mir die KI die Notizen zusammenfassen.',
    manifest: {
      name: 'Kontakt-Notizen-Zusammenfassung',
      slug: 'notizen-zusammenfassung',
      icon: 'sparkles',
      version: '1.0.0',
      description: 'Fasst die Notizen eines Kontakts mit KI in wenigen Stichpunkten zusammen – direkt auf der Kontaktseite.',
      category: 'ki',
      scopes: ['contacts:read', 'ai:run'],
      entries: { panels: [{ id: 'summary', on: 'contact', title: 'Notizen in Kürze', height: 240 }] },
    },
    ui_html: summaryUi,
    server_js: '',
  },
  'followup-aufgabe': {
    wish: 'Nach einem Formular soll automatisch eine Follow-up-Aufgabe entstehen – als Schritt in meinen Automationen.',
    manifest: {
      name: 'Follow-up-Aufgabe',
      slug: 'followup-aufgabe',
      icon: 'tasks',
      version: '1.0.0',
      description: 'Ein Automations-Schritt, der für den Kontakt eine Follow-up-Aufgabe mit eigenem Titel anlegt.',
      category: 'kontakte',
      scopes: ['tasks:write'],
      entries: { actions: [{ id: 'followup', label: 'Follow-up-Aufgabe anlegen', fields: [{ key: 'title', label: 'Titel (Platzhalter möglich)', type: 'text' }] }] },
      server: { mode: 'declarative' },
    },
    ui_html: '',
    server_js: '',
    steps: { actions: { followup: [{ op: 'tasks.create', args: { title: '{{input.title|Follow-up}} – {{contact.name}}', description: 'Angelegt vom Plugin „Follow-up-Aufgabe“.', contact_id: '{{contact.id}}' }, as: 'task' }, { result: { task_id: '{{task.id}}' } }] } },
  },
};
export const EXAMPLE_KEYS = Object.keys(EXAMPLES);
