import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { PREFERENCES_TOKEN, UNSUBSCRIBE_TOKEN, newBlock, newSection, normalizeDesign, renderEmail, safeUrl, type EmailDesign } from '../server/services/email-render.js';
import { composeEmail } from '../server/services/messaging.js';
import { starterDesign } from './mk-fixtures.js';

const PREFS = 'https://crm.example.de/consent/p/c1/tok';
const UNSUB = 'https://crm.example.de/u/c1/tok';

describe('preference centre link in designer footers', () => {
  const rendered = (d: EmailDesign = starterDesign()) => renderEmail(d, { title: 'x' });

  it('a footer without its own link gets one next to "Abmelden" – same look as that link', () => {
    const r = rendered();
    expect(r.html).not.toContain(PREFERENCES_TOKEN);
    const out = composeEmail({ body: r.html, isHtml: true, text: r.text, unsubUrl: UNSUB, prefsUrl: PREFS, company: 'Firma' });
    expect(out.html).toMatch(new RegExp(`<a href="${PREFS.replace(/[/.]/g, '\\$&')}" target="_blank" style="color:[^"]+;text-decoration:underline;">Einstellungen</a> · <a href="${UNSUB.replace(/[/.]/g, '\\$&')}"`));
    expect(out.html).not.toContain('%%');
    expect(out.text).toContain(`Einstellungen: ${PREFS}\n`);
    expect(out.text).toContain(`Abmelden: ${UNSUB}`);
    // the link comes before "Abmelden"
    expect(out.text.indexOf('Einstellungen:')).toBeLessThan(out.text.indexOf('Abmelden:'));
    expect(out.html.split(PREFS)).toHaveLength(2);
  });

  it('without a preference centre (or for single mails) nothing changes', () => {
    const r = rendered();
    const out = composeEmail({ body: r.html, isHtml: true, text: r.text, unsubUrl: UNSUB, company: 'Firma' });
    expect(out.html).not.toContain('Einstellungen');
    expect(out.html).toContain(UNSUB);
    expect(out.text).not.toContain('Einstellungen');
  });

  it('a footer with its own preferences label is not given a second link', () => {
    const d = starterDesign();
    for (const s of d.sections) for (const c of s.columns) for (const b of c.blocks) if (b.type === 'footer') b.props.preferencesLabel = 'E-Mail-Einstellungen';
    const r = rendered(d);
    expect(r.html).toContain(`<a href="${PREFERENCES_TOKEN}"`);
    expect(r.html).toContain('E-Mail-Einstellungen</a> · <a href="%%unsubscribe_url%%"');
    expect(r.text).toContain(`E-Mail-Einstellungen: ${PREFERENCES_TOKEN}`);
    const out = composeEmail({ body: r.html, isHtml: true, text: r.text, unsubUrl: UNSUB, prefsUrl: PREFS, company: 'Firma' });
    expect(out.html.split(PREFS)).toHaveLength(2);
    expect(out.html).not.toContain('>Einstellungen</a>');
    expect(out.text.split(PREFS)).toHaveLength(2);
    // without a centre the label's link falls back to the unsubscribe link (as the token always did)
    expect(composeEmail({ body: r.html, isHtml: true, text: r.text, unsubUrl: UNSUB, company: 'Firma' }).html).not.toContain('%%');
  });

  it('keeps the label only when set, and cleans it', () => {
    const f = (props: Record<string, unknown>) => normalizeDesign({ sections: [{ columns: [{ blocks: [{ type: 'footer', props }] }] }] }).sections[0].columns[0].blocks[0].props;
    expect(f({ company: 'X' })).not.toHaveProperty('preferencesLabel');
    expect(f({ preferencesLabel: '  Einstellungen  ' }).preferencesLabel).toBe('Einstellungen');
    expect(f({ preferencesLabel: 'x'.repeat(500) }).preferencesLabel).toHaveLength(80);
  });

  it('links to the preference centre and the recovery link are the only token-like URLs allowed in links', () => {
    expect(safeUrl('{{preferences_url}}')).toBe(PREFERENCES_TOKEN);
    expect(safeUrl(' %%preferences_url%% ')).toBe(PREFERENCES_TOKEN);
    expect(safeUrl('{{unsubscribe_url}}')).toBe(UNSUBSCRIBE_TOKEN);
    expect(safeUrl('{{preferences_url}}', 'image')).toBe('');
    expect(safeUrl('{{event.recovery_url}}')).toBe('{{event.recovery_url}}');
    expect(safeUrl('{{ event.checkout_url }}')).toBe('{{ event.checkout_url }}');
    for (const bad of ['{{event.url}}', '{{event.recovery_url}}x', 'x{{event.recovery_url}}', '{{contact.website}}', '{{event.recovery_url|javascript:alert(1)}}', '{{event.recovery_url}}{{event.url}}']) expect(safeUrl(bad), bad).toBe('');
    // a button with such a link is a valid button
    const d = normalizeDesign({ sections: [{ columns: [{ blocks: [{ type: 'button', props: { label: 'Weiter', href: '{{event.recovery_url}}' } }] }] }] });
    expect(renderEmail(d).html).toContain('href="{{event.recovery_url}}"');
    const t = newBlock('button', { label: 'x', href: '{{preferences_url}}' });
    expect(newSection(1, [[t]]).columns[0].blocks).toHaveLength(1);
  });
});

let t: Awaited<ReturnType<typeof startTestApp>>;
const mails: { to: string; html: string; text: string }[] = [];
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  t.app.services.emailTransports = { capture: async (_l: any, mail: any) => (mails.push({ to: mail.to, html: mail.html, text: mail.text }), { status: 'sent', providerId: `m${mails.length}` }) };
  await t.api.patch('/api/location', { address: 'Hauptstraße 1, 80331 München', settings: { email: { provider: 'capture', fromEmail: 'info@absender.example' } } });
});
afterAll(async () => t.close());

describe('campaign footer: the preference centre setting of the consent settings applies', () => {
  const send = async (tag: string) => {
    const c = (await t.api.post('/api/campaigns', { name: `K ${tag}`, subject: 'Hallo', body: '', filter: { tags: [tag] } })).data;
    await t.api.post('/api/email-gallery/newsletter-klassisch/use', { campaign_id: c.id });
    await t.api.post('/api/contacts', { email: `${tag}@kunde.example`, first_name: 'Lena', tags: [tag] });
    mails.length = 0;
    const r = await t.api.post(`/api/campaigns/${c.id}/send`, {});
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    return mails[0];
  };

  it('links the preference centre next to "Abmelden" (default)', async () => {
    const m = await send('mit');
    expect(m.html).toMatch(/consent\/p\/[^"]+"[^>]*>Einstellungen<\/a> · <a href="http:\/\/localhost\/u\//);
  });

  it('leaves it out when the sub-account switched the link off, and the one-click unsubscribe stays', async () => {
    await t.api.put('/api/consent/settings', { footer_link: false });
    const m = await send('ohne');
    expect(m.html).not.toContain('Einstellungen');
    expect(m.html).not.toContain('/consent/p/');
    expect(m.html).toMatch(/href="http:\/\/localhost\/u\/[^"]+"/);
    expect(m.text).not.toContain('Einstellungen:');
    await t.api.put('/api/consent/settings', { footer_link: true });
  });

  it('the tracking leaves the preference link direct (it is no click of a campaign link)', async () => {
    const m = await send('track');
    const tracked = t.app.db.all<{ url: string }>(`SELECT url FROM tracked_links WHERE contact_id = (SELECT id FROM contacts WHERE email = 'track@kunde.example')`).map((l) => l.url);
    expect(tracked.some((u) => u.includes('/consent/p/'))).toBe(false);
    expect(tracked.some((u) => u.includes('/u/'))).toBe(false);
    expect(m.html).toContain('/consent/p/');
  });
});
