import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import {
  UNSUBSCRIBE_TOKEN,
  cleanHtmlBlock,
  designIssues,
  htmlToText,
  newBlock,
  newSection,
  normalizeDesign,
  renderEmail,
  safeColor,
  safeUrl,
  type EmailDesign,
} from '../server/services/email-render.js';
import { STARTERS } from '../server/services/email-starters.js';
import { composeEmail } from '../server/services/messaging.js';

const design = (...sections: any[]): EmailDesign => normalizeDesign({ sections });
const one = (...blocks: any[]) => ({ columns: [{ blocks }] });
const footer = { type: 'footer', props: { company: '{{location.name}}', address: '{{location.address}}' } };

describe('email renderer', () => {
  it('escapes user content everywhere', () => {
    const { html, text } = renderEmail(
      design(
        one(
          { type: 'heading', props: { text: '<script>alert(1)</script> & Co' } },
          { type: 'text', props: { text: 'Hallo <b onclick="x()">du</b>' } },
          { type: 'button', props: { label: '"><img src=x onerror=alert(1)>', href: 'https://example.com/?a=1&b=2' } },
          { type: 'image', props: { src: 'https://example.com/a.png', alt: 'Ein "Bild" <hier>' } },
        ),
      ),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co');
    expect(html).toContain('Hallo &lt;b onclick=&quot;x()&quot;&gt;du&lt;/b&gt;');
    expect(html).not.toMatch(/<img src=x/);
    expect(html).toContain('href="https://example.com/?a=1&amp;b=2"');
    expect(html).toContain('alt="Ein &quot;Bild&quot; &lt;hier&gt;"');
    // Plain text is not HTML: no escaping, no tags.
    expect(text).toContain('<script>alert(1)</script> & Co');
  });

  it('only lets http(s), mailto and tel links through', () => {
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', '//evil.com', '{{contact.website}}', 'https://']) expect(safeUrl(bad)).toBe('');
    expect(safeUrl('https://example.com/a b')).toBe('https://example.com/a%20b');
    expect(safeUrl('mailto:info@example.com')).toBe('mailto:info@example.com');
    expect(safeUrl('tel:+49301234')).toBe('tel:+49301234');
    expect(safeUrl('www.example.com')).toBe('https://www.example.com');
    expect(safeUrl('https://x.de/?id={{contact.id}}')).toBe('https://x.de/?id={{contact.id}}');
    expect(safeUrl('{{unsubscribe_url}}')).toBe(UNSUBSCRIBE_TOKEN);
    expect(safeUrl('mailto:x@y.de', 'image')).toBe('');
    const { html } = renderEmail(
      design(
        one(
          { type: 'button', props: { label: 'Klick', href: 'javascript:alert(1)' } },
          { type: 'text', props: { text: '[böse](javascript:alert(1)) und [gut](https://example.com)' } },
          { type: 'image', props: { src: 'javascript:alert(1)', alt: 'x' } },
          { type: 'social', props: { items: [{ network: 'facebook', url: 'javascript:alert(1)' }, { network: 'x', url: 'https://x.com/firma' }] } },
        ),
      ),
    );
    expect(html.toLowerCase()).not.toContain('javascript:');
    expect(html).toContain('<span style="background-color:#2563eb');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="https://x.com/firma"');
  });

  it('keeps colours and numbers inside safe bounds', () => {
    expect(safeColor('red;background:url(x)', '#fff')).toBe('#fff');
    expect(safeColor('#ABC')).toBe('#abc');
    const d = normalizeDesign({ settings: { width: 99999, background: '"><script>', fontFamily: 'Comic; x' }, sections: [one({ type: 'spacer', props: { height: -5 } })] });
    expect(d.settings.width).toBe(900);
    expect(d.settings.background).toBe('#f3f4f6');
    expect(d.settings.fontFamily).toBe('Arial, Helvetica, sans-serif');
    expect(d.sections[0].columns[0].blocks[0].props.height).toBe(4);
    expect(() => normalizeDesign({ sections: [one({ type: 'iframe' })] })).toThrow('Unbekannter Block');
    expect(() => normalizeDesign({ sections: [{ columns: [{}, {}, {}, {}] }] })).toThrow('1 bis 3 Spalten');
    expect(() => normalizeDesign('kein json')).toThrow('JSON');
  });

  it('lays out columns as tables that stack on phones, with Outlook buttons', () => {
    const d = design(
      { columns: [{ blocks: [{ type: 'text', props: { text: 'Links' } }] }, { blocks: [{ type: 'button', props: { label: 'Rechts', href: 'https://example.com' } }] }], widths: [33, 67] },
      { columns: [{ blocks: [] }, { blocks: [] }, { blocks: [] }], widths: [10, 10, 10] },
    );
    expect(d.sections[1].widths).toEqual([33, 33, 33]);
    const { html } = renderEmail(d);
    expect(html.match(/class="pg-col"/g)).toHaveLength(5);
    expect(html).toContain('width="33%"');
    expect(html).toContain('width="67%"');
    expect(html).toMatch(/@media only screen and \(max-width: 620px\) \{[\s\S]*\.pg-col \{ display: block !important; width: 100% !important;/);
    expect(html).toContain('<v:roundrect');
    expect(html).toContain('<!--[if !mso]><!--><a href="https://example.com"');
    expect(html).toContain('role="presentation"');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('@media (prefers-color-scheme: dark)');
  });

  it('always carries an unsubscribe footer', () => {
    const withFooter = renderEmail(design(one({ type: 'text', props: { text: 'Hi' } }, footer)));
    expect(withFooter.html).toContain(`href="${UNSUBSCRIBE_TOKEN}"`);
    expect(withFooter.html).toContain('{{location.address}}');
    expect(withFooter.text).toContain(`Abmelden: ${UNSUBSCRIBE_TOKEN}`);
    expect(withFooter.html.match(new RegExp(UNSUBSCRIBE_TOKEN.replace(/%/g, '%'), 'g'))).toHaveLength(1);
    // No footer block: a small legal footer is added automatically.
    const auto = renderEmail(design(one({ type: 'text', props: { text: 'Hi – [abmelden]({{unsubscribe_url}})' } })));
    expect(auto.html).toContain(`href="${UNSUBSCRIBE_TOKEN}"`);
    expect(auto.html).toContain('{{location.name}}');
    expect(auto.html).not.toContain('{{unsubscribe_url}}');
    expect(auto.text).toContain(UNSUBSCRIBE_TOKEN);
    // Campaigns insist on a real footer with an address.
    expect(designIssues(design(one({ type: 'text', props: { text: 'Hi' } })), { campaign: true }).some((i) => i.level === 'error' && i.text.includes('Footer'))).toBe(true);
    expect(designIssues(design(one({ type: 'footer', props: { address: '' } })), { campaign: true }).some((i) => i.text.includes('Firmenadresse'))).toBe(true);
    expect(designIssues(design(one({ type: 'text', props: { text: 'Hi' } }, footer)), { campaign: true }).filter((i) => i.level === 'error')).toHaveLength(0);
  });

  it('keeps merge fields for personalisation at send time', () => {
    const { html, text } = renderEmail(
      design(one({ type: 'heading', props: { text: 'Hallo {{contact.first_name|du}}!' } }, { type: 'text', props: { text: '**Liebe(r) {{contact.first_name}}**, dein [Link](https://x.de/?id={{contact.id}}) und {{contact.custom.budget|keins}}' } })),
    );
    expect(html).toContain('Hallo {{contact.first_name|du}}!');
    expect(html).toContain('<strong>Liebe(r) {{contact.first_name}}</strong>');
    expect(html).toContain('href="https://x.de/?id={{contact.id}}"');
    expect(html).toContain('{{contact.custom.budget|keins}}');
    expect(text).toContain('Hallo {{contact.first_name|du}}!');
    expect(text).toContain('Liebe(r) {{contact.first_name}}, dein Link (https://x.de/?id={{contact.id}})');
    // A link inside a merge-field fallback is not turned into an anchor.
    expect(renderEmail(design(one({ type: 'text', props: { text: '{{contact.website|https://example.com}}' } }))).html).toContain('{{contact.website|https://example.com}}');
  });

  it('builds a readable text/plain part from the design', () => {
    const { text } = renderEmail(
      design(
        one(
          { type: 'heading', props: { text: 'Neuigkeiten' } },
          { type: 'text', props: { text: 'Intro mit *Betonung*.\n\n- Punkt eins\n- Punkt zwei\n\n1. Erstens\n2. Zweitens' } },
          { type: 'button', props: { label: 'Jetzt ansehen', href: 'https://example.com/a' } },
          { type: 'image', props: { src: 'https://example.com/i.png', alt: 'Produktfoto', href: 'https://example.com/p' } },
          { type: 'image', props: { src: 'https://example.com/deko.png', alt: 'Deko' } },
          { type: 'divider' },
          { type: 'social', props: { items: [{ network: 'instagram', url: 'https://instagram.com/firma' }] } },
          { type: 'video', props: { url: 'https://youtu.be/dQw4w9WgXcQ', caption: '▶ Video ansehen' } },
          { type: 'html', props: { html: '<p>Eigener <a href="https://example.com/h">Link</a></p><style>p{color:red}</style>' } },
          footer,
        ),
      ),
    );
    expect(text).toContain('Neuigkeiten\n\nIntro mit Betonung.\n\n- Punkt eins\n- Punkt zwei\n\n1. Erstens\n2. Zweitens');
    expect(text).toContain('Jetzt ansehen: https://example.com/a');
    expect(text).toContain('Produktfoto: https://example.com/p');
    expect(text).not.toContain('Deko');
    expect(text).toContain('Instagram: https://instagram.com/firma');
    expect(text).toContain('Video ansehen: https://youtu.be/dQw4w9WgXcQ');
    expect(text).toContain('Eigener Link (https://example.com/h)');
    expect(text).not.toMatch(/<[a-z]/i);
    expect(text).not.toContain('color:red');
  });

  it('renders YouTube thumbnails and cleans HTML blocks', () => {
    expect(renderEmail(design(one({ type: 'video', props: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } }))).html).toContain('https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    const cleaned = cleanHtmlBlock('<p onclick="x()">Hi</p><script>alert(1)</script><a href="jav&#x61;script:alert(1)">a</a><img src="https://x.de/a.png" onerror=alert(1)><iframe src="https://x.de"></iframe><a href=\'https://ok.de\'>ok</a>');
    expect(cleaned).toBe('<p>Hi</p><a href="#">a</a><img src="https://x.de/a.png"><a href=\'https://ok.de\'>ok</a>');
  });

  it('turns email HTML into text and composes the final mail', () => {
    expect(htmlToText('<html><head><style>p{x:y}</style></head><body><div style="display:none">pre</div><h1>Titel</h1><p>Hallo&nbsp;<a href="https://a.de">hier</a></p><ul><li>eins</li></ul></body></html>')).toBe('Titel\n\nHallo hier (https://a.de)\n\n- eins');
    const { html, text } = renderEmail(design(one({ type: 'text', props: { text: 'Hi' } }, footer)));
    const mail = composeEmail({ body: html, isHtml: true, text, unsubUrl: 'https://crm.de/u/1/abc', company: 'Firma', address: 'Weg 1' });
    expect(mail.html).toContain('href="https://crm.de/u/1/abc"');
    expect(mail.html).not.toContain(UNSUBSCRIBE_TOKEN);
    expect(mail.html.match(/<html/g)).toHaveLength(1);
    expect(mail.text).toContain('Abmelden: https://crm.de/u/1/abc');
    expect(mail.text).not.toContain('--\nFirma\nAbmelden');
    // A complete document without the token still gets the legal footer, once.
    const foreign = composeEmail({ body: '<!doctype html><html><body><p>Hi</p></body></html>', isHtml: true, unsubUrl: 'https://crm.de/u/2', company: 'Firma' });
    expect(foreign.html).toMatch(/Abmelden<\/a><\/p><\/body>/);
    expect(foreign.html.match(/<html/g)).toHaveLength(1);
    expect(foreign.text).toBe('Hi\n\n--\nFirma\nAbmelden: https://crm.de/u/2');
    // Plain text emails keep the old wrapper (a stray token still becomes the link).
    const plain = composeEmail({ body: `Hallo\n\nAbmelden: ${UNSUBSCRIBE_TOKEN}`, unsubUrl: 'https://crm.de/u/3', company: 'Firma' });
    expect(plain.html).toContain('<p>Hallo</p>');
    expect(plain.html).not.toContain(UNSUBSCRIBE_TOKEN);
    expect(plain.text).toContain('Abmelden: https://crm.de/u/3');
  });

  it('ships starter designs that render with a footer', () => {
    expect(STARTERS.map((s) => s.key)).toEqual(['newsletter', 'offer', 'event', 'review', 'welcome', 'letter']);
    for (const s of STARTERS) {
      const { html, text, design: d } = renderEmail(s.build());
      expect(d.sections.length).toBeGreaterThan(0);
      expect(html).toContain(`href="${UNSUBSCRIBE_TOKEN}"`);
      expect(text).toContain(UNSUBSCRIBE_TOKEN);
      expect(designIssues(d, { campaign: true }).some((i) => i.text.includes('Footer'))).toBe(false);
    }
    // Fresh ids each time, so two copies never clash.
    expect(STARTERS[0].build().sections[0].id).not.toBe(STARTERS[0].build().sections[0].id);
    expect(newSection(2, [[newBlock('text')]]).columns[0].blocks[0].type).toBe('text');
  });
});

describe('email builder API', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
  });
  afterAll(async () => {
    await t.close();
  });

  const simple = () => ({ settings: { preheader: 'Kurz vorab' }, sections: [one({ type: 'heading', props: { text: 'Hallo {{contact.first_name|du}}' } }, { type: 'button', props: { label: 'Los', href: 'https://example.com/los' } }, footer)] });

  it('stores a design next to the template and renders it on the server', async () => {
    const r = await t.api.post('/api/templates', { name: 'Newsletter', subject: 'News', design: simple() });
    expect(r.status).toBe(200);
    expect(r.data.is_html).toBe(1);
    expect(r.data.body).toMatch(/^<!doctype html>/);
    expect(r.data.body).toContain('Hallo {{contact.first_name|du}}');
    expect(r.data.body).toContain('Kurz vorab');
    expect(r.data.body_text).toContain('Los: https://example.com/los');
    const got = (await t.api.get(`/api/templates/${r.data.id}`)).data;
    expect(got.design.sections[0].columns[0].blocks.map((b: any) => b.type)).toEqual(['heading', 'button', 'footer']);
    expect(got.design.settings.width).toBe(600);
    // Changing the design re-renders; the list carries the design too.
    const d = got.design;
    d.sections[0].columns[0].blocks[0].props.text = 'Neuer Titel';
    const p = (await t.api.patch(`/api/templates/${r.data.id}`, { design: d })).data;
    expect(p.body).toContain('Neuer Titel');
    expect((await t.api.get('/api/templates')).data.find((x: any) => x.id === r.data.id).design).toBeTruthy();
    // A new plain body drops the design; plain templates keep working as before.
    const plain = (await t.api.patch(`/api/templates/${r.data.id}`, { body: 'Nur Text', is_html: false })).data;
    expect(plain.design).toBeNull();
    expect(plain.body).toBe('Nur Text');
    expect(plain.body_text).toBe('');
    expect((await t.api.post('/api/templates', { name: 'Kaputt', design: { sections: [one({ type: 'marquee' })] } })).status).toBe(400);
    expect((await t.api.post('/api/templates', { name: 'SMS', channel: 'sms', body: 'Hi' })).data.design).toBeUndefined();
  });

  it('sends designed campaigns with personal data, unsubscribe link and footer check', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'lea@example.com', first_name: 'Lea <b>', tags: ['nl-design'] })).data;
    const noFooter = { sections: [one({ type: 'text', props: { text: 'Hallo {{contact.first_name}}' } })] };
    const camp = (await t.api.post('/api/campaigns', { name: 'Design', subject: 'Hi {{contact.first_name}}', design: noFooter, filter: { tags: ['nl-design'] } })).data;
    expect(camp.design.sections).toHaveLength(1);
    let r = await t.api.post(`/api/campaigns/${camp.id}/send`);
    expect(r.status).toBe(400);
    expect(r.data.error).toContain('Footer');
    // Footer with {{location.address}} needs an address on the sub-account.
    await t.api.patch(`/api/campaigns/${camp.id}`, { design: simple() });
    r = await t.api.post(`/api/campaigns/${camp.id}/send`);
    expect(r.status).toBe(400);
    expect(r.data.error).toContain('Firmenadresse');
    await t.api.patch('/api/location', { address: 'Hauptstraße 1, 10115 Berlin' });
    r = await t.api.post(`/api/campaigns/${camp.id}/send`);
    expect(r.status).toBe(200);
    const msgs = (await t.api.get(`/api/contacts/${c.id}/messages`)).data;
    const m = msgs.find((x: any) => x.source === 'Kampagne: Design');
    expect(m.status).toBe('logged');
    expect(m.body).toContain('Hallo Lea &lt;b&gt;');
    expect(m.body).toContain('Hauptstraße 1, 10115 Berlin');
    expect(m.body).not.toContain('{{');
    // Scheduled campaigns keep their footer; SMS campaigns ignore designs.
    const later = (await t.api.post('/api/campaigns', { name: 'Später', subject: 'S', design: simple(), filter: { tags: ['nl-design'] } })).data;
    expect((await t.api.post(`/api/campaigns/${later.id}/send`, { scheduled_at: new Date(Date.now() + 864e5).toISOString() })).data.status).toBe('scheduled');
    expect((await t.api.patch(`/api/campaigns/${later.id}`, { design: noFooter })).status).toBe(400);
    const sms = (await t.api.post('/api/campaigns', { name: 'SMS', channel: 'sms', body: 'Hi', design: simple() })).data;
    expect(sms).toMatchObject({ body: 'Hi', is_html: 0 });
    expect(sms.design).toBeUndefined();
    const conv = (await t.api.get('/api/conversations')).data.find((x: any) => x.contact_id === c.id);
    expect(conv.last_message).toMatch(/^Hallo Lea Los \(https:\/\/example\.com\/los\) Testfirma Hauptstraße 1, 10115 Berlin Abmelden$/);
    expect(conv.last_message).not.toContain('%%');
  });

  it('renders designed workflow emails on save and sends them', async () => {
    const wf = (await t.api.post('/api/workflows', { name: 'Willkommen', trigger: { type: 'webhook' }, steps: [{ type: 'send_email', subject: 'Willkommen', design: simple() }] })).data;
    const step = wf.steps[0];
    expect(step.isHtml).toBe(true);
    expect(step.body).toMatch(/^<!doctype html>/);
    expect(step.text).toContain('Los: https://example.com/los');
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const url = new URL(wf.webhook_url);
    const hook = await t.api.post(url.pathname + url.search, { email: 'wf@example.com', first_name: 'Wanda' });
    expect(hook.data.enrolled).toBe(true);
    await t.app.tick();
    const msgs = (await t.api.get(`/api/contacts/${hook.data.contactId}/messages`)).data;
    expect(msgs.some((x: any) => x.source === 'Workflow' && x.body.includes('Hallo Wanda'))).toBe(true);
    // Switching back to plain text removes design and text.
    const plain = (await t.api.patch(`/api/workflows/${wf.id}`, { steps: [{ ...step, design: null, body: 'Nur Text', isHtml: false }] })).data;
    expect(plain.steps[0].design).toBeUndefined();
    expect(plain.steps[0].text).toBeUndefined();
  });

  it('offers starters, render check, reusable sections and test sends', async () => {
    const starters = (await t.api.get('/api/email-builder/starters')).data;
    expect(starters).toHaveLength(6);
    expect(starters[0].design.sections.length).toBeGreaterThan(0);

    const check = (await t.api.post('/api/email-builder/render', { design: { sections: [one({ type: 'text', props: { text: 'x' } })] }, campaign: true })).data;
    expect(check.html).toContain('<!doctype html>');
    expect(check.issues.some((i: any) => i.level === 'error')).toBe(true);

    const sec = (await t.api.post('/api/email-builder/sections', { name: 'Kopfzeile', section: one({ type: 'heading', props: { text: 'Logo' } }) })).data;
    expect(sec.section.columns[0].blocks[0].props.text).toBe('Logo');
    expect((await t.api.get('/api/email-builder/sections')).data.map((x: any) => x.name)).toContain('Kopfzeile');
    expect((await t.api.post('/api/email-builder/sections', { name: 'Leer' })).status).toBe(400);
    expect((await t.api.del(`/api/email-builder/sections/${sec.id}`)).status).toBe(200);
    expect((await t.api.get('/api/email-builder/sections')).data).toHaveLength(0);

    const test = await t.api.post('/api/email-builder/test', { design: simple(), subject: 'Hallo {{contact.first_name}}', to: 'chef@example.com' });
    expect(test.status).toBe(200);
    expect(test.data).toMatchObject({ status: 'logged', to: 'chef@example.com' });
    expect((await t.api.post('/api/email-builder/test', { design: simple(), to: 'kein-mail' })).status).toBe(400);
  });

  it('lets MCP clients save designed templates', async () => {
    const key = (await t.api.post('/api/agency/api-keys', { name: 'Claude' })).data.key;
    const call = async (name: string, args: any) => {
      const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      const res = (await r.json()).result;
      return res.isError ? { error: res.content[0].text } : JSON.parse(res.content[0].text);
    };
    const saved = await call('ghl_save_email_template', { location_id: t.api.location, name: 'Von Claude', starter: 'welcome' });
    expect(saved).toMatchObject({ name: 'Von Claude', has_design: true });
    expect(saved.subject).toContain('Willkommen');
    const list = await call('ghl_list_email_templates', { location_id: t.api.location });
    expect(list.templates.find((x: any) => x.id === saved.id).has_design).toBe(true);
    expect(list.starters).toHaveLength(6);
  });
});
