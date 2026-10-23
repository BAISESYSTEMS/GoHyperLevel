/**
 * Shared steps of the screenshot scripts – scripts/screenshots.mjs (README, docs/assets) and scripts/landing-assets.mjs (landing
 * page, web/public/landing): a tidy demo without first-run banners, focus mode with Jarvis' briefing, the Academy with a running
 * tour, the 3D preview of a board (XR) and the collage of four looks (themes, dark mode, icon packs, a white-label logo).
 * Every helper works on a Playwright context or page that is signed in as the demo admin. Dev-only.
 */

const W = { 'x-pghl': '1' };

/** Wait for the app to render after a navigation (live pages keep a stream open, so "network idle" never comes). */
async function open(page, url, settle = 2200) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(settle);
}

/** No first-run banners on the shots: the Einfach-Modus offer answered with "Alles behalten", the Academy welcome card hidden. */
export async function tidy(context, base) {
  await context.addInitScript(() => {
    try {
      localStorage.setItem('pghl.academyWelcome', '1');
    } catch {
      /* private mode */
    }
  });
  await context.request.patch(`${base}/api/appearance`, { data: { goals: ['all'], goal_asked: true }, headers: W });
}

/** Focus mode with the companion: "Was brennt?" – Jarvis' briefing with hot spots and next steps (docs/living-boards.md). */
export async function focusBriefing(page, url) {
  await open(page, url);
  await page.getByRole('button', { name: /Was brennt|burning/i }).first().click();
  await page.waitForTimeout(2500);
}

/** The Academy with its own tour running: the first step points at the 14-chapter guide (docs/academy.md). */
export async function academyTour(page, url) {
  await open(page, url);
  const card = page.locator('.ac-card').filter({ has: page.locator('h3', { hasText: 'Die Akademie & die Übungs-Firma' }) });
  await card.first().locator('button').first().click();
  await page.waitForTimeout(2200);
}

/** Pauses the running tour – otherwise it resumes on the next page load and leads back to its own page. */
export async function endTour(page) {
  await page.getByRole('button', { name: 'Tour schließen' }).click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);
}

/** A shared "Vertrieb" board from the starter template, made once per demo (the seed has no boards). */
export async function salesBoard(context, base, loc) {
  const headers = { ...W, 'x-location-id': loc };
  const list = (await (await context.request.get(`${base}/api/boards`, { headers })).json()).boards ?? [];
  return list.find((b) => b.template_key === 'vertrieb') ?? (await (await context.request.post(`${base}/api/boards`, { data: { template: 'vertrieb', scope: 'shared' }, headers })).json());
}

/** The board as floating panels on a curved wall – the browser's 3D preview (WebGL2; docs/xr.md), turned a little for depth. */
export async function xrPreview(page, url) {
  await open(page, url, 2500);
  const button = page.locator('[data-tour="xr-open"]').first();
  await button.waitFor({ timeout: 15000 });
  await button.click();
  await page.waitForTimeout(5000);
  // Drag on empty space orbits the camera: a slight turn shows the curve of the wall without hiding anything.
  await page.mouse.move(160, 450);
  await page.mouse.down();
  await page.mouse.move(205, 450, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(1500);
}

/** A fictional agency logo for the white-label tile (two colourways: for light and for dark surfaces). */
const agencyLogo = (text, sub) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 60"><defs><linearGradient id="a" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#34d399"/><stop offset=".55" stop-color="#22d3ee"/><stop offset="1" stop-color="#a78bfa"/></linearGradient></defs><rect x="2" y="6" width="48" height="48" rx="13" fill="#0f2a3a"/><path d="M11 43c7-14 16-21 31-24" stroke="url(#a)" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M13 50c8-9 17-13 29-14" stroke="url(#a)" stroke-width="4" fill="none" stroke-linecap="round" opacity=".7"/><circle cx="39" cy="15" r="3" fill="#fef3c7"/><text x="60" y="34" font-family="Inter,Segoe UI,Helvetica,Arial,sans-serif" font-size="27" font-weight="700" fill="${text}">Nordlicht</text><text x="61" y="51" font-family="Inter,Segoe UI,Helvetica,Arial,sans-serif" font-size="12" font-weight="700" letter-spacing="3.4" fill="${sub}">DIGITAL</text></svg>`;

const LOOKS = {
  de: ['HyperLevel Standard · hell', 'Mitternacht · dunkel · Duotone-Icons', 'Wald · kräftige Bereichsfarben · gefüllte Icons', 'White-Label · eigenes Logo und Farbe'],
  en: ['HyperLevel Standard · light', 'Mitternacht · dark · duotone icons', 'Wald · vibrant area colours · solid icons', 'White label · your logo and colour'],
};

/**
 * Four looks of the same dashboard side by side in one 1440×900 image (docs/theming.md): the standard theme, a dark theme with
 * another icon pack, area colours, and a white-label agency with its own logo and colour. Changes the demo admin's look and the
 * agency branding for the shots and puts both back afterwards. Returns PNG bytes.
 */
export async function themeCollage({ browser, context, base, loc, lang = 'de' }) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1152, height: 720 });
  const look = (data) => context.request.patch(`${base}/api/appearance`, { data, headers: W });
  const brand = (data) => context.request.patch(`${base}/api/agency/branding`, { data, headers: W });
  const before = await (await context.request.get(`${base}/api/agency/branding`)).json();
  const upload = async (name, svg) => {
    const r = await context.request.post(`${base}/api/agency/branding/logo`, { data: { name, data: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` }, headers: W });
    return new URL((await r.json()).url).pathname;
  };
  const tiles = [];
  const shot = async () => {
    await open(page, `${base}/app/dashboard?loc=${loc}`, 2600);
    tiles.push((await page.screenshot()).toString('base64'));
  };
  try {
    await look({ theme: 'gohigh', mode: 'light', icons: 'line', dept: 'subtle', dept_palette: 'harmonic', accent: '' });
    await shot();
    await look({ theme: 'mitternacht', mode: 'dark', icons: 'duotone', dept: 'clear', dept_palette: 'harmonic' });
    await shot();
    await look({ theme: 'wald', mode: 'light', icons: 'solid', dept: 'vibrant', dept_palette: 'rainbow' });
    await shot();
    const light = await upload('nordlicht-logo.svg', agencyLogo('#0f2a3a', '#0f766e'));
    const dark = await upload('nordlicht-logo-dark.svg', agencyLogo('#ffffff', '#7dd3c0'));
    await brand({ name: 'Nordlicht Digital', logo_url: light, logo_dark_url: dark, show_name: 'no', color: '#0f766e' });
    await look({ theme: 'nordlicht', mode: 'light', icons: 'fine', dept: 'subtle', dept_palette: 'muted', accent: '#0f766e' });
    await shot();
  } finally {
    await look({ theme: 'gohigh', mode: 'system', icons: 'line', dept: 'subtle', dept_palette: 'harmonic', accent: '' });
    await brand({ name: before.name, logo_url: before.logo_url ?? '', logo_dark_url: before.logo_dark_url ?? '', show_name: before.show_name ?? '', color: before.color || '#2563eb' });
    await page.close();
  }
  const labels = LOOKS[lang] ?? LOOKS.en;
  const sheet = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await sheet.setContent(`<!doctype html><html><head><style>
*{box-sizing:border-box}body{margin:0;width:1440px;height:900px;background:linear-gradient(135deg,#e8edf6,#f6f4ee);font-family:system-ui,sans-serif;display:grid;place-items:center}
.g{display:grid;grid-template-columns:repeat(2,676px);grid-template-rows:repeat(2,423px);gap:16px}
figure{margin:0;position:relative;border-radius:14px;overflow:hidden;box-shadow:0 1px 2px #0f172a1f,0 10px 28px #0f172a24;outline:1px solid #0f172a14}
img{display:block;width:100%;height:100%}
figcaption{position:absolute;right:12px;bottom:12px;background:#0b1020e0;color:#f8fafc;font:600 13px/1 system-ui,sans-serif;padding:7px 11px;border-radius:999px;letter-spacing:.01em}
</style></head><body><div class="g">${tiles.map((t, i) => `<figure><img src="data:image/png;base64,${t}" alt=""><figcaption>${labels[i]}</figcaption></figure>`).join('')}</div></body></html>`);
  await sheet.waitForTimeout(300);
  const png = await sheet.screenshot({ type: 'png' });
  await sheet.close();
  return png;
}

// --- showcases the demo seed does not have: a canvas board, an agent drawing on it, a wiki page, a team-chat channel -------

/** JSON calls as the signed-in demo admin (the context's cookie), in one sub-account. */
const caller = (context, base, loc) => async (method, path, data) => {
  const r = await context.request.fetch(`${base}${path}`, { method, data, headers: { ...W, ...(loc ? { 'x-location-id': loc } : {}) } });
  const body = await r.json().catch(() => null);
  if (!r.ok()) throw new Error(`${method} ${path}: ${r.status()} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
};
const list = (x, key) => (Array.isArray(x) ? x : (x?.[key] ?? x?.items ?? []));

/**
 * The board "Herbst-Kampagne – Planung" (docs/canvas.md): a mind map with sticky notes, a flowchart, live CRM cards (contact,
 * company, deal, task, ticket, appointment, pipeline, report) and two design frames. Returns the board id and the element ids
 * of each section (for `?focus=`).
 */
export async function canvasShowcase(context, base, loc) {
  const call = caller(context, base, loc);
  await call('POST', '/api/companies', { name: 'Brandt & Söhne GmbH', domain: 'brandt-soehne.example', industry: 'Handwerk', city: 'Hamburg' }).catch(() => null);
  const contacts = list(await call('GET', '/api/contacts?limit=5'), 'contacts');
  const companies = list(await call('GET', '/api/companies?limit=3'), 'companies');
  const deals = list(await call('GET', '/api/opportunities?status=open'), 'opportunities');
  const tasks = list(await call('GET', '/api/tasks?status=all'), 'tasks');
  const tickets = list(await call('GET', '/api/tickets?limit=3'), 'tickets');
  const appts = list(await call('GET', '/api/appointments?from=2020-01-01T00:00:00Z&to=2035-01-01T00:00:00Z'), 'appointments');
  const pipes = list(await call('GET', '/api/pipelines'), 'pipelines');
  const report = await call('POST', '/api/reports/library', { name: 'Offene Deals je Stufe', config: { viz: 'bar', query: { source: 'opportunities', measures: ['sum:value'], group_by: ['stage'], filters: [{ field: 'status', op: 'eq', value: 'open' }] } }, visibility: 'team' }).catch(() => null);

  const board = await call('POST', '/api/canvas', { name: 'Herbst-Kampagne – Planung', description: 'Ideen, Ablauf, Live-Daten und Entwürfe an einem Ort' });
  const B = `/api/canvas/${board.id}`;
  await call('PATCH', B, { settings: { grid: 'dots', snap: true } });
  const all = async () => (await call('GET', B)).elements ?? [];
  /** Runs `fn` and returns the elements it created with their bounding box. */
  const zone = async (fn) => {
    const before = new Set((await all()).map((e) => e.id));
    await fn();
    const made = (await all()).filter((e) => !before.has(e.id));
    return { ids: made.map((e) => e.id), x1: Math.min(...made.map((e) => e.x)), y1: Math.min(...made.map((e) => e.y)), x2: Math.max(...made.map((e) => e.x + e.w)), y2: Math.max(...made.map((e) => e.y + e.h)) };
  };
  const heading = (x, y, text) => call('POST', `${B}/elements`, { elements: [{ type: 'text', x, y, w: 700, text, fontSize: 30, bold: true, color: '#364fc7' }] });
  const edges = (pairs) => pairs.map(([from, to]) => ({ from, to }));

  const mind = await zone(() =>
    call('POST', `${B}/layout`, {
      kind: 'mindmap',
      x: 0,
      y: 100,
      nodes: [['r', 'Herbst-Kampagne'], ['k', 'Kanäle'], ['k1', 'E-Mail'], ['k2', 'Social'], ['k3', 'Blog'], ['o', 'Angebot'], ['o1', '15 % Rabatt'], ['o2', 'Webinar'], ['z', 'Zielgruppe'], ['z1', 'Neukunden'], ['z2', 'Bestandskunden']].map(([id, label]) => ({ id, label })),
      edges: edges([['r', 'k'], ['k', 'k1'], ['k', 'k2'], ['k', 'k3'], ['r', 'o'], ['o', 'o1'], ['o', 'o2'], ['r', 'z'], ['z', 'z1'], ['z', 'z2']]),
    }),
  );
  await heading(mind.x1, mind.y1 - 70, '1 · Ideen sammeln');
  const notes = await zone(() =>
    call('POST', `${B}/elements`, {
      elements: [
        { type: 'sticky', x: mind.x1, y: mind.y2 + 60, text: 'Rabatt-Code für Bestandskunden vorbereiten', fill: '#fff3a3' },
        { type: 'sticky', x: mind.x1 + 230, y: mind.y2 + 60, text: 'Webinar-Termin mit Jonas abstimmen', fill: '#ffc9de' },
        { type: 'sticky', x: mind.x1 + 460, y: mind.y2 + 60, text: 'Landingpage texten (bis Freitag)', fill: '#c5e4ff' },
      ],
    }),
  );
  const flow = await zone(() =>
    call('POST', `${B}/mermaid`, {
      x: Math.max(mind.x2, notes.x2) + 180,
      y: 100,
      source: 'flowchart LR\n  A([Formular ausgefüllt]) --> B[Kontakt anlegen]\n  B --> C{Passt zur Zielgruppe?}\n  C -->|Ja| D[Termin vorschlagen]\n  C -->|Nein| E[Newsletter]\n  D --> F([Deal in Pipeline])',
    }),
  );
  await heading(flow.x1, flow.y1 - 70, '2 · Ablauf festlegen');
  const cy = flow.y2 + 200;
  const card = (kind, id, x, y) => (id ? { type: 'card', card: { kind, id }, x, y } : null);
  const cards = await zone(() =>
    call('POST', `${B}/elements`, {
      elements: [card('contact', contacts[0]?.id, flow.x1, cy), card('company', companies[0]?.id, flow.x1 + 330, cy), card('deal', deals[0]?.id, flow.x1 + 660, cy), card('task', tasks[0]?.id, flow.x1, cy + 190), card('ticket', tickets[0]?.id, flow.x1 + 330, cy + 190), card('appointment', appts[0]?.id, flow.x1 + 660, cy + 190)].filter(Boolean),
    }),
  );
  await heading(cards.x1, cards.y1 - 70, '3 · Live aus dem CRM');
  const pipeline = await zone(() => call('POST', `${B}/elements`, { elements: [card('pipeline', pipes[0]?.id, cards.x1, cards.y2 + 40), report ? card('report', report.id, cards.x1 + 920, cards.y2 + 40) : null].filter(Boolean) }));
  const dx = Math.max(flow.x2, cards.x2, pipeline.x2) + 180;
  const Y = 100;
  const t = (x, y, w, text, fontSize, more = {}) => ({ type: 'text', x: dx + x, y: Y + y, w, text, fontSize, ...more });
  const design = await zone(() =>
    call('POST', `${B}/elements`, {
      elements: [
        { ref: 'm', type: 'frame', name: 'Landingpage – Mobil', preset: 'mobile', x: dx, y: Y, w: 390, h: 740 },
        { type: 'rect', x: dx, y: Y, w: 390, h: 240, fill: '#4263eb', stroke: '#4263eb', radius: 0, in: 'm' },
        t(24, 60, 340, 'Herbstaktion', 40, { bold: true, color: '#ffffff', in: 'm' }),
        t(24, 120, 340, '15 % auf alle Kurse – nur bis Ende Oktober', 18, { color: '#dbe4ff', in: 'm' }),
        { type: 'rect', x: dx + 24, y: Y + 172, w: 180, h: 48, fill: '#f08c00', stroke: '#f08c00', radius: 24, text: 'Jetzt sichern', bold: true, color: '#ffffff', fontSize: 18, in: 'm' },
        { type: 'icon', icon: 'rocket', x: dx + 30, y: Y + 280, w: 44, h: 44, stroke: '#4263eb', in: 'm' },
        t(90, 282, 270, 'Schnell starten', 22, { bold: true, in: 'm' }),
        t(90, 316, 270, 'Dein erster Kurs in unter 10 Minuten startklar.', 15, { color: '#495057', in: 'm' }),
        { type: 'icon', icon: 'calendar-days', x: dx + 30, y: Y + 380, w: 44, h: 44, stroke: '#4263eb', in: 'm' },
        t(90, 382, 270, 'Live-Termine', 22, { bold: true, in: 'm' }),
        t(90, 416, 270, 'Jeden Dienstag Fragen stellen.', 15, { color: '#495057', in: 'm' }),
        { type: 'table', x: dx + 24, y: Y + 480, w: 342, h: 120, cells: [['Paket', 'Preis'], ['Basis', '49 €'], ['Pro', '99 €']], header: true, fontSize: 15, in: 'm' },
        { type: 'rect', x: dx + 24, y: Y + 630, w: 342, h: 52, fill: '#4263eb', stroke: '#4263eb', radius: 12, text: 'Zum Kurs', bold: true, color: '#ffffff', fontSize: 18, in: 'm' },
        { ref: 's', type: 'frame', name: 'Social-Post 1080', preset: 'social-square', x: dx + 450, y: Y, w: 540, h: 540 },
        { type: 'rect', x: dx + 450, y: Y, w: 540, h: 540, fill: '#fff3bf', stroke: '#fff3bf', radius: 0, in: 's' },
        { type: 'ellipse', x: dx + 770, y: Y + 320, w: 300, h: 300, fill: '#ffd8a8', stroke: '#ffd8a8', in: 's' },
        t(490, 90, 440, 'Herbst-\nAktion', 72, { bold: true, color: '#e8590c', in: 's' }),
        t(490, 270, 300, '15 % auf alle Onlinekurse', 26, { color: '#343a40', in: 's' }),
        { type: 'rect', x: dx + 490, y: Y + 400, w: 200, h: 54, fill: '#e8590c', stroke: '#e8590c', radius: 27, text: 'Jetzt starten', bold: true, color: '#ffffff', fontSize: 20, in: 's' },
      ],
    }),
  );
  await heading(design.x1, design.y1 - 70, '4 · Entwurf gestalten');
  const els = await all();
  const sticky = els.find((e) => e.type === 'sticky' && /Landingpage/.test(e.text ?? ''));
  if (sticky) await call('POST', `${B}/comments`, { body: 'Kannst du den Text bis Freitag liefern?', element_id: sticky.id }).catch(() => null);
  return { board: board.id, focus: { flow: flow.ids, cards: cards.ids, pipeline: pipeline.ids, design: design.ids.filter((id) => els.find((e) => e.id === id)?.type === 'frame') } };
}

/** An agent ("Claude", through an API key) draws a sketched flow below the pipeline card; returns the ids to focus on. */
export async function agentDraws(context, base, loc, show) {
  const { key } = await caller(context, base, loc)('POST', '/api/api-keys', { name: 'Claude' });
  const call = async (method, path, body) => (await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-location-id': loc }, body: body ? JSON.stringify(body) : undefined })).json();
  const board = await call('GET', `/api/canvas/${show.board}`);
  const pipe = board.elements.find((e) => show.focus.pipeline.includes(e.id) && e.card?.kind === 'pipeline') ?? board.elements.find((e) => show.focus.pipeline.includes(e.id));
  const r = await call('POST', `/api/canvas/${show.board}/layout`, {
    kind: 'flow',
    direction: 'right',
    x: pipe.x + 40,
    y: pipe.y + pipe.h + 110,
    sketch: true,
    nodes: [{ id: 'a', label: 'Gewinnspiel auf Instagram', shape: 'sticky' }, { id: 'b', label: 'Teilnahme per Formular', shape: 'round' }, { id: 'c', label: 'Gewinner:in ziehen', shape: 'diamond' }, { id: 'd', label: 'Rabattcode per E-Mail', shape: 'round' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd', label: 'Ja' }],
  });
  return [...show.focus.pipeline, ...Object.values(r.ids ?? {})];
}

/** Opens a canvas board zoomed to some elements (`?focus=`), with nothing selected. */
export async function openCanvas(page, url, ids, { hideMap = false } = {}) {
  await open(page, `${url}${url.includes('?') ? '&' : '?'}focus=${ids.join('%2C')}`, 2000);
  await page.keyboard.press('Escape');
  if (hideMap) await page.locator('[aria-label="Übersichtskarte"]').click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(400);
}

/** A colleague for chat and wiki (a member of the sub-account) – with a fetch client of their own. */
export async function teamMate(context, base, loc, { name = 'Mia Wagner', email = 'mia.wagner@example.com' } = {}) {
  const password = 'kollegin-demo-1';
  const user = await caller(context, base, '')('POST', '/api/users', { email, name, password, role: 'member', locations: [loc], permissions: null });
  let cookie = '';
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-pghl': '1', 'x-location-id': loc, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie');
    if (set && set.startsWith('pghl_session=')) cookie = set.split(';')[0];
    const out = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(out).slice(0, 200)}`);
    return out;
  };
  await call('POST', '/api/auth/login', { email, password });
  return { id: user.id, name, call };
}

/** The wiki page "Willkommen im Team": mention, checklist, tip, a live contact card and a table; plus a few template pages. */
export async function wikiShowcase(context, base, loc, mate) {
  const call = caller(context, base, loc);
  const contact = list(await call('GET', '/api/contacts?limit=1'), 'contacts')[0];
  const team = await call('POST', '/api/wiki/spaces', { name: 'Team-Wiki', icon: '📚', description: 'Alles, was neue Kolleginnen und Kollegen wissen müssen' });
  const procs = await call('POST', '/api/wiki/spaces', { name: 'Prozesse', icon: '🛠️' });
  const body = [
    `Schön, dass du da bist! Diese Seite führt dich durch die ersten Tage. Fragen gehen an [@${mate.name}](user:${mate.id}).`,
    '',
    '## Deine erste Woche',
    '',
    '- [x] Zugänge erhalten (E-Mail, CRM, Team-Chat)',
    '- [x] Kickoff mit dem Team',
    '- [ ] Ersten Kunden im CRM anlegen',
    '- [ ] Wiki-Seite zu deinem Bereich schreiben',
    '',
    '> [!TIP] Tipp zum Start',
    '> Lege dir Favoriten an (Stern oben) – so findest du deine wichtigsten Seiten sofort.',
    '',
    '## Wichtige Kontakte',
    '',
    'Der Kunde, über den wir am meisten sprechen:',
    '',
    contact ? `[${contact.name ?? [contact.first_name, contact.last_name].filter(Boolean).join(' ')}](card:contact:${contact.id})` : '',
    '',
    '## Zuständigkeiten',
    '',
    '| Bereich | Wer |',
    '| --- | --- |',
    `| Vertrieb | ${mate.name} |`,
    '| Websites | Alex Demo |',
  ].join('\n');
  const page = await call('POST', '/api/wiki/pages', { space_id: team.id, title: 'Willkommen im Team', icon: '👋', body });
  await call('POST', '/api/wiki/pages', { space_id: team.id, template: 'meeting' }).catch(() => null);
  await call('POST', '/api/wiki/pages', { space_id: procs.id, template: 'sop' }).catch(() => null);
  await call('POST', '/api/wiki/pages', { space_id: procs.id, template: 'brief' }).catch(() => null);
  await call('POST', `/api/wiki/pages/${page.id}/favorite`, {}).catch(() => null);
  await mate.call('POST', `/api/wiki/pages/${page.id}/comments`, { body: 'Danke – die Checkliste hat mir den ersten Tag gerettet!' }).catch(() => null);
  return page.id;
}

/** A "#vertrieb" channel: a message with a live contact card, an answer, a task by /aufgabe and a pinned note. */
export async function teamChatShowcase(context, base, loc, mate) {
  const call = caller(context, base, loc);
  const contact = list(await call('GET', '/api/contacts?limit=1'), 'contacts')[0];
  const label = contact ? contact.name ?? [contact.first_name, contact.last_name].filter(Boolean).join(' ') : '';
  const general = list(await call('GET', '/api/team-chat/channels'), 'channels').find((c) => c.name === 'allgemein');
  const ch = await call('POST', '/api/team-chat/channels', { name: 'vertrieb', topic: 'Leads, Angebote, Abschlüsse', members: [mate.id] });
  await mate.call('POST', `/api/team-chat/channels/${ch.id}/join`, {}).catch(() => null);
  const say = (who, text) => who('POST', `/api/team-chat/channels/${ch.id}/messages`, { body: text });
  await say(call, `Wir haben ein neues Angebot an ${contact ? `[${label}](card:contact:${contact.id})` : 'den Kunden'} geschickt – bitte nachfassen [@${mate.name}](user:${mate.id})`);
  await say(mate.call, 'Mache ich morgen früh.');
  await say(call, `/aufgabe Angebot nachfassen [@${mate.name}](user:${mate.id}) morgen`);
  const pin = await say(mate.call, 'Preisliste 2027 liegt im Wiki unter „Prozesse“. Bitte nur diese Zahlen nennen.');
  if (pin?.id) await mate.call('POST', `/api/team-chat/messages/${pin.id}/pin`, {}).catch(() => null);
  if (general) await mate.call('POST', `/api/team-chat/channels/${general.id}/messages`, { body: 'Guten Morgen zusammen! Um 10 Uhr kurzes Stand-up?' }).catch(() => null);
  return ch.id;
}
