import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { chunks, googleEmail, googleIdentifiers, googlePhone, metaEmail, metaName, metaPhone, metaRow, metaZip, sha256, META_SCHEMA } from '../server/services/ads-hash.js';
import { cleanSpec, reviewOf, tracking, validateSpec, withUtm, type AdSpec } from '../server/services/ads-manager.js';
import { adPayload, adsetPayload, campaignPayload, creativePayload, leadFormPayload, optimisation, targetingOf, targetsEu } from '../server/services/ads-meta.js';
import { dailyCents, languageConstant, pmaxMutate, searchMutate, statusMutate } from '../server/services/ads-google.js';
import { cleanRule, evaluate, metricValue } from '../server/services/ads-rules.js';
import { mapLead } from '../server/services/ads-leads.js';

const hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('audience hashing (normalisation + SHA-256 per platform spec)', () => {
  it('hashes with SHA-256 (hex, lower case)', () => {
    // FIPS 180-2 test vector
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('Meta: e-mail trimmed and lower case, invalid addresses dropped', () => {
    expect(metaEmail('  Anna.Beispiel@Example.COM ')).toBe('anna.beispiel@example.com');
    expect(metaEmail('kein-email')).toBe('');
    expect(metaEmail(null)).toBe('');
  });

  it('Meta: phone numbers become digits with country code (no +, no 00, no leading zeros)', () => {
    expect(metaPhone('+49 (151) 234-5678')).toBe('491512345678');
    expect(metaPhone('0049 151 2345678')).toBe('491512345678');
    expect(metaPhone('0151 2345678')).toBe('491512345678');
    expect(metaPhone('0151 2345678', '43')).toBe('431512345678');
    expect(metaPhone('+0049151')).toBe('');
    expect(metaPhone('12')).toBe('');
    expect(metaPhone('')).toBe('');
  });

  it('Meta: names without spaces, digits and punctuation; umlauts stay; ZIP without spaces and dashes', () => {
    expect(metaName("  Anna-Lena  O'Brien ")).toBe('annalenaobrien');
    expect(metaName('Müller')).toBe('müller');
    expect(metaName('Jürgen 2')).toBe('jürgen');
    expect(metaZip(' 10 115-A ')).toBe('10115a');
  });

  it('Meta: one upload row in the documented column order, every value a SHA-256 hash', () => {
    expect(META_SCHEMA).toEqual(['EMAIL', 'PHONE', 'FN', 'LN', 'CT', 'ZIP', 'COUNTRY']);
    const row = metaRow({ email: ' Anna@Example.com ', phone: '0151 2345678', first_name: 'Anna-Lena', last_name: 'Müller', city: 'Köln', postal_code: '50667', country: 'DE' })!;
    expect(row).toEqual([hex('anna@example.com'), hex('491512345678'), hex('annalena'), hex('müller'), hex('köln'), hex('50667'), hex('de')]);
    for (const v of row) expect(v).toMatch(/^[0-9a-f]{64}$/);
    // Missing values stay empty instead of hashing the empty string.
    expect(metaRow({ email: 'a@b.de' })).toEqual([hex('a@b.de'), '', '', '', '', '', '']);
    // Nothing to match on: no row at all.
    expect(metaRow({ first_name: 'Nur', last_name: 'Name' })).toBeNull();
  });

  it('Google: e-mail lower case, dots removed in gmail.com / googlemail.com only', () => {
    expect(googleEmail(' Anna.Beispiel@Gmail.com ')).toBe('annabeispiel@gmail.com');
    expect(googleEmail('a.b@googlemail.com')).toBe('ab@googlemail.com');
    expect(googleEmail('a.b@firma.de')).toBe('a.b@firma.de');
    expect(googleEmail('x')).toBe('');
  });

  it('Google: phone as E.164 with +, hashed including the +', () => {
    expect(googlePhone('0151 2345678')).toBe('+491512345678');
    expect(googlePhone('0049 151 2345678')).toBe('+491512345678');
    const ids = googleIdentifiers({ email: 'A.B@gmail.com', phone: '0151 2345678', first_name: 'Anna', last_name: 'Müller', postal_code: '50667', country: 'de' });
    expect(ids).toEqual([
      { hashedEmail: hex('ab@gmail.com') },
      { hashedPhoneNumber: hex('+491512345678') },
      { addressInfo: { hashedFirstName: hex('anna'), hashedLastName: hex('müller'), countryCode: 'DE', postalCode: '50667' } },
    ]);
    // Address info needs all four parts.
    expect(googleIdentifiers({ email: 'a@b.de', first_name: 'Anna' })).toEqual([{ hashedEmail: hex('a@b.de') }]);
    expect(googleIdentifiers({})).toEqual([]);
  });

  it('splits long lists into batches', () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunks([], 3)).toEqual([]);
  });
});

const meta = (over: any = {}): AdSpec =>
  cleanSpec({
    platform: 'meta',
    name: 'Sommer-Aktion',
    goal: 'leads',
    kind: 'lead_form',
    budget: { type: 'daily', amount_cents: 2000 },
    audience: { countries: ['DE'], age_min: 25, age_max: 55, genders: ['female'], interests: [{ id: '6003107902433', name: 'Yoga' }], audience_ids: ['aud1'] },
    creative: { primary_text: 'Starte jetzt.', headline: 'Yoga für Anfänger', description: 'Probestunde', cta: 'SIGN_UP', link: { url: 'https://example.org/yoga' }, media: [{ upload_id: 'up1' }] },
    lead_form_id: 'lf1',
    ...over,
  });
const ctx = { pageId: '555', pageName: 'Yogastudio', pixelId: '999', currency: 'EUR', divisor: 100, link: 'https://example.org/yoga', imageHash: 'hash1', leadFormId: '777', audiences: ['111'], excluded: [] as string[] };

describe('Meta payloads: campaign, ad set, creative, ad – all PAUSED', () => {
  it('campaign: paused, objective from the goal, no special categories, ad-set budgets stated explicitly', () => {
    expect(campaignPayload(meta())).toEqual({ name: 'Sommer-Aktion', objective: 'OUTCOME_LEADS', status: 'PAUSED', buying_type: 'AUCTION', special_ad_categories: [], is_adset_budget_sharing_enabled: false });
    expect(campaignPayload(meta({ goal: 'traffic', kind: 'website' })).objective).toBe('OUTCOME_TRAFFIC');
    expect(campaignPayload(meta({ goal: 'conversions', kind: 'website' })).objective).toBe('OUTCOME_SALES');
    expect(campaignPayload(meta({ goal: 'reach', kind: 'website' })).objective).toBe('OUTCOME_AWARENESS');
  });

  it('ad set: optimisation per goal, budget in minor units, targeting, paused', () => {
    const p = adsetPayload(meta(), 'C1', ctx);
    expect(p).toMatchObject({
      name: 'Sommer-Aktion – Anzeigengruppe',
      campaign_id: 'C1',
      status: 'PAUSED',
      billing_event: 'IMPRESSIONS',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      optimization_goal: 'LEAD_GENERATION',
      destination_type: 'ON_AD',
      promoted_object: { page_id: '555' },
      daily_budget: 2000,
      targeting: {
        geo_locations: { countries: ['DE'] },
        age_min: 25,
        age_max: 55,
        genders: [2],
        flexible_spec: [{ interests: [{ id: '6003107902433', name: 'Yoga' }] }],
        custom_audiences: [{ id: '111' }],
        targeting_automation: { advantage_audience: 0 },
      },
    });
    expect('lifetime_budget' in p).toBe(false);
    // Germany is in the EU: Meta wants beneficiary and payer (default: the Page).
    expect(p.dsa_beneficiary).toBe('Yogastudio');
    expect(p.dsa_payor).toBe('Yogastudio');
    expect(optimisation(meta({ goal: 'traffic', kind: 'website' }), ctx)).toEqual({ optimization_goal: 'LINK_CLICKS', destination_type: 'WEBSITE' });
    expect(optimisation(meta({ goal: 'conversions', kind: 'website', conversion_event: 'lead' }), ctx)).toEqual({ optimization_goal: 'OFFSITE_CONVERSIONS', destination_type: 'WEBSITE', promoted_object: { pixel_id: '999', custom_event_type: 'LEAD' } });
    expect(optimisation(meta({ goal: 'reach', kind: 'website' }), ctx).optimization_goal).toBe('REACH');
  });

  it('ad set: lifetime budget with schedule, euro cents scaled to the currency, no DSA outside the EU', () => {
    const spec = meta({ goal: 'traffic', kind: 'website', budget: { type: 'lifetime', amount_cents: 30000 }, schedule: { start: '2026-11-01', end: '2026-11-30' }, audience: { countries: ['US'] } });
    const p = adsetPayload(spec, 'C1', { ...ctx, currency: 'JPY', divisor: 1 });
    expect(p.lifetime_budget).toBe(300);
    expect('daily_budget' in p).toBe(false);
    expect(p.start_time).toBe('2026-11-01T00:00:00+0000');
    expect(p.end_time).toBe('2026-11-30T23:59:00+0000');
    expect('dsa_beneficiary' in p).toBe(false);
    expect(targetsEu(spec)).toBe(false);
    expect(targetsEu(meta())).toBe(true);
  });

  it('targeting: cities with a radius (17–80 km), regions, zips, excluded audiences, both genders omitted', () => {
    const spec = meta({ audience: { locations: [{ type: 'city', key: '2511182', name: 'Köln', country: 'DE', radius: 5 }, { type: 'region', key: '1234', name: 'NRW' }, { type: 'zip', key: 'DE:50667', name: '50667' }, { type: 'country', key: 'AT', name: 'Österreich' }], genders: ['male', 'female'] } });
    const t = targetingOf(spec, { audiences: [], excluded: ['999'] });
    expect(t.geo_locations).toEqual({ countries: ['AT'], regions: [{ key: '1234' }], cities: [{ key: '2511182', radius: 17, distance_unit: 'kilometer' }], zips: [{ key: 'DE:50667' }] });
    expect(t.excluded_custom_audiences).toEqual([{ id: '999' }]);
    expect('genders' in t).toBe(false);
    expect('custom_audiences' in t).toBe(false);
  });

  it('creative: link ad with instant form call to action, UTM as url_tags; video uses video_data', () => {
    const spec = meta();
    const c = creativePayload(spec, { ...ctx, urlTags: tracking(spec, ctx.link).urlTags });
    expect(c).toEqual({
      name: 'Sommer-Aktion – Creative',
      object_story_spec: {
        page_id: '555',
        link_data: { message: 'Starte jetzt.', link: 'https://example.org/yoga', name: 'Yoga für Anfänger', description: 'Probestunde', image_hash: 'hash1', call_to_action: { type: 'SIGN_UP', value: { lead_gen_form_id: '777', link: 'https://example.org/yoga' } } },
      },
      url_tags: 'utm_source=facebook&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_term={{adset.name}}',
    });
    const web = meta({ goal: 'traffic', kind: 'website', creative: { primary_text: 'Text', headline: 'Titel', link: { url: 'https://example.org/yoga' }, media: [{ upload_id: 'v1' }] } });
    const v = creativePayload(web, { ...ctx, imageHash: undefined, videoId: '888', thumbnailHash: 'thumb' });
    expect(v.object_story_spec.video_data).toEqual({ video_id: '888', message: 'Text', title: 'Titel', image_hash: 'thumb', call_to_action: { type: 'LEARN_MORE', value: { link: 'https://example.org/yoga' } } });
    expect('link_data' in v.object_story_spec).toBe(false);
  });

  it('ad: paused, bound to ad set and creative', () => {
    expect(adPayload(meta(), 'AS1', 'CR1')).toEqual({ name: 'Sommer-Aktion – Anzeige', adset_id: 'AS1', creative: { creative_id: 'CR1' }, status: 'PAUSED' });
  });

  it('instant form payload: questions, privacy policy, thank-you page', () => {
    const p = leadFormPayload({ name: 'Probestunde', headline: 'Gratis testen', description: 'Trag dich ein.', questions: ['FULL_NAME', 'EMAIL', { type: 'CUSTOM', key: 'erfahrung', label: 'Deine Erfahrung?' }], privacy_url: 'https://example.org/datenschutz', thank_you: { title: 'Danke!', body: 'Wir melden uns.', url: 'https://example.org/danke' } });
    expect(p).toMatchObject({
      name: 'Probestunde',
      locale: 'DE_DE',
      questions: [{ type: 'FULL_NAME' }, { type: 'EMAIL' }, { type: 'CUSTOM', key: 'erfahrung', label: 'Deine Erfahrung?' }],
      privacy_policy: { url: 'https://example.org/datenschutz', link_text: 'Datenschutz' },
      follow_up_action_url: 'https://example.org/danke',
      context_card: { title: 'Gratis testen', content: ['Trag dich ein.'] },
      thank_you_page: { title: 'Danke!', body: 'Wir melden uns.', button_type: 'VIEW_WEBSITE', website_url: 'https://example.org/danke' },
    });
  });
});

const google = (over: any = {}): AdSpec =>
  cleanSpec({
    platform: 'google',
    name: 'Suche Yoga',
    goal: 'leads',
    kind: 'search',
    budget: { type: 'daily', amount_cents: 1500 },
    schedule: { start: '2026-11-01', end: '2026-12-31' },
    audience: { locations: [{ type: 'geo', key: '2276', name: 'Deutschland' }], languages: ['de'], keywords: [{ text: 'yoga köln', match: 'PHRASE' }, { text: 'yogakurs', match: 'EXACT' }], negative_keywords: ['kostenlos'] },
    creative: { headlines: ['Yoga in Köln', 'Probestunde gratis', 'Jetzt anmelden'], descriptions: ['Kleine Gruppen, erfahrene Lehrer.', 'Starte noch diese Woche.'], path1: 'yoga', link: { url: 'https://example.org/yoga' } },
    ...over,
  });
const gctx = { customerId: '1234567890', finalUrl: 'https://example.org/yoga', trackingTemplate: '{lpurl}?utm_source=google', userLists: ['customers/1234567890/userLists/9'], tag: 'x1' };

describe('Google Ads payloads: one atomic mutate, everything PAUSED', () => {
  it('search campaign: budget micros, paused campaign and ad group and ad, EU political declaration, RSA', () => {
    const body = searchMutate(google(), gctx);
    expect(body.partialFailure).toBe(false);
    const ops = body.mutateOperations;
    const by = (k: string) => ops.filter((o) => k in o).map((o) => (o as any)[k]);
    expect(by('campaignBudgetOperation')[0].create).toMatchObject({ resourceName: 'customers/1234567890/campaignBudgets/-1', amountMicros: '15000000', deliveryMethod: 'STANDARD', explicitlyShared: false });
    const camp = by('campaignOperation')[0].create;
    expect(camp).toMatchObject({
      resourceName: 'customers/1234567890/campaigns/-2',
      status: 'PAUSED',
      advertisingChannelType: 'SEARCH',
      campaignBudget: 'customers/1234567890/campaignBudgets/-1',
      containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      maximizeConversions: {},
      startDateTime: '2026-11-01 00:00:00',
      endDateTime: '2026-12-31 23:59:59',
      trackingUrlTemplate: '{lpurl}?utm_source=google',
      networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false },
    });
    expect(by('adGroupOperation')[0].create).toMatchObject({ status: 'PAUSED', type: 'SEARCH_STANDARD', campaign: 'customers/1234567890/campaigns/-2' });
    const ad = by('adGroupAdOperation')[0].create;
    expect(ad.status).toBe('PAUSED');
    expect(ad.ad.finalUrls).toEqual(['https://example.org/yoga']);
    expect(ad.ad.responsiveSearchAd).toEqual({ headlines: [{ text: 'Yoga in Köln' }, { text: 'Probestunde gratis' }, { text: 'Jetzt anmelden' }], descriptions: [{ text: 'Kleine Gruppen, erfahrene Lehrer.' }, { text: 'Starte noch diese Woche.' }], path1: 'yoga' });
    const crit = by('campaignCriterionOperation').map((c) => c.create);
    expect(crit).toContainEqual({ campaign: 'customers/1234567890/campaigns/-2', location: { geoTargetConstant: 'geoTargetConstants/2276' } });
    expect(crit).toContainEqual({ campaign: 'customers/1234567890/campaigns/-2', language: { languageConstant: 'languageConstants/1001' } });
    expect(crit).toContainEqual({ campaign: 'customers/1234567890/campaigns/-2', negative: true, keyword: { text: 'kostenlos', matchType: 'BROAD' } });
    const kw = by('adGroupCriterionOperation').map((c) => c.create);
    expect(kw).toContainEqual({ adGroup: 'customers/1234567890/adGroups/-3', status: 'ENABLED', keyword: { text: 'yoga köln', matchType: 'PHRASE' } });
    expect(kw).toContainEqual({ adGroup: 'customers/1234567890/adGroups/-3', status: 'ENABLED', keyword: { text: 'yogakurs', matchType: 'EXACT' } });
    // Customer Match list as audience
    expect(kw).toContainEqual({ adGroup: 'customers/1234567890/adGroups/-3', userList: { userList: 'customers/1234567890/userLists/9' } });
  });

  it('bidding follows the goal; a lifetime budget is spread over the days (Google budgets are daily)', () => {
    const traffic = searchMutate(google({ goal: 'traffic' }), gctx).mutateOperations.find((o: any) => o.campaignOperation)!.campaignOperation.create;
    expect(traffic.targetSpend).toEqual({});
    expect('maximizeConversions' in traffic).toBe(false);
    const manual = searchMutate(google({ max_cpc_cents: 80 }), gctx).mutateOperations.find((o: any) => o.campaignOperation)!.campaignOperation.create;
    expect(manual.manualCpc).toEqual({ enhancedCpcEnabled: false });
    const life = google({ budget: { type: 'lifetime', amount_cents: 61000 }, schedule: { start: '2026-11-01', end: '2026-12-30' } });
    expect(dailyCents(life)).toBe(1017);
    expect(dailyCents(google())).toBe(1500);
  });

  it('Performance Max: campaign, asset group (paused) with text and image assets', () => {
    const spec = google({
      kind: 'pmax',
      creative: { headlines: ['Yoga Köln', 'Probestunde', 'Jetzt buchen'], long_headlines: ['Yoga in Köln – kleine Gruppen, echte Betreuung'], descriptions: ['Kleine Gruppen.', 'Starte noch diese Woche mit uns.'], business_name: 'Yogastudio', link: { url: 'https://example.org/yoga' }, media: [{ upload_id: 'a', role: 'marketing' }, { upload_id: 'b', role: 'square' }, { upload_id: 'c', role: 'logo' }] },
    });
    const body = pmaxMutate(spec, { ...gctx, images: [{ role: 'marketing', data: 'AAA', name: 'm.jpg' }, { role: 'square', data: 'BBB', name: 's.jpg' }, { role: 'logo', data: 'CCC', name: 'l.png' }] });
    const ops = body.mutateOperations as any[];
    expect(ops.find((o) => o.campaignOperation).campaignOperation.create).toMatchObject({ advertisingChannelType: 'PERFORMANCE_MAX', status: 'PAUSED', maximizeConversions: {}, containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING' });
    expect(ops.find((o) => o.assetGroupOperation).assetGroupOperation.create).toMatchObject({ status: 'PAUSED', finalUrls: ['https://example.org/yoga'], campaign: 'customers/1234567890/campaigns/-2' });
    const fields = ops.filter((o) => o.assetGroupAssetOperation).map((o) => o.assetGroupAssetOperation.create.fieldType);
    expect(fields.filter((f) => f === 'HEADLINE')).toHaveLength(3);
    expect(fields).toEqual(expect.arrayContaining(['LONG_HEADLINE', 'DESCRIPTION', 'BUSINESS_NAME', 'MARKETING_IMAGE', 'SQUARE_MARKETING_IMAGE', 'LOGO']));
    expect(ops.filter((o) => o.assetOperation && o.assetOperation.create.imageAsset)).toHaveLength(3);
    // Every asset link points at a temporary asset created in the same request.
    const assets = new Set(ops.filter((o) => o.assetOperation).map((o) => o.assetOperation.create.resourceName));
    for (const o of ops.filter((x) => x.assetGroupAssetOperation)) expect(assets.has(o.assetGroupAssetOperation.create.asset)).toBe(true);
  });

  it('switching on also switches on what was created paused; pausing only needs the campaign', () => {
    const ids = { campaign: 'customers/1/campaigns/22', ad_group: 'customers/1/adGroups/33', ad_group_ad: 'customers/1/adGroupAds/33~44' };
    expect(statusMutate(ids, 'PAUSED').mutateOperations).toEqual([{ campaignOperation: { update: { resourceName: 'customers/1/campaigns/22', status: 'PAUSED' }, updateMask: 'status' } }]);
    const on = statusMutate(ids, 'ENABLED').mutateOperations.map((o: any) => Object.keys(o)[0]);
    expect(on).toEqual(['campaignOperation', 'adGroupOperation', 'adGroupAdOperation']);
  });

  it('language constants: codes, ids and resource names', () => {
    expect(languageConstant('de')).toBe('languageConstants/1001');
    expect(languageConstant('en-US')).toBe('languageConstants/1000');
    expect(languageConstant('1002')).toBe('languageConstants/1002');
    expect(languageConstant('languageConstants/1003')).toBe('languageConstants/1003');
    expect(languageConstant('xx')).toBeUndefined();
  });
});

describe('spec, review and UTM', () => {
  it('cleanSpec bounds everything and falls back to the platform default kind', () => {
    const s = cleanSpec({ platform: 'meta', name: ' x '.repeat(100), goal: 'unsinn', kind: 'search', budget: { amount_cents: -5 }, audience: { age_min: 5, age_max: 99, countries: ['de', 'xyz', 'at'] }, creative: { cta: 'learn_more', utm: false } });
    expect(s.name.length).toBeLessThanOrEqual(120);
    expect(s.goal).toBe('leads');
    expect(s.kind).toBe('lead_form');
    expect(s.budget.amount_cents).toBe(0);
    expect(s.audience.age_min).toBeUndefined();
    expect(s.audience.countries).toEqual(['DE', 'AT']);
    expect(s.creative.cta).toBe('LEARN_MORE');
    expect(s.creative.utm).toBe(false);
    expect(() => cleanSpec({ platform: 'tiktok' })).toThrow();
    expect(() => cleanSpec({ platform: 'meta', schedule: { start: 'morgen' } })).toThrow();
  });

  it('UTM parameters are added to the link without touching existing ones; macros for Meta, ValueTrack for Google', () => {
    expect(withUtm('https://example.org/p?x=1&utm_source=newsletter', { utm_source: 'facebook', utm_medium: 'paid_social' })).toBe('https://example.org/p?x=1&utm_source=newsletter&utm_medium=paid_social');
    const m = tracking(meta(), 'https://example.org/yoga');
    expect(m.urlTags).toContain('utm_campaign={{campaign.name}}');
    expect(m.example).toBe('https://example.org/yoga?utm_source=facebook&utm_medium=paid_social&utm_campaign=Sommer-Aktion&utm_content=Sommer-Aktion+%E2%80%93+Anzeige&utm_term=Sommer-Aktion+%E2%80%93+Anzeigengruppe');
    const g = tracking(google(), 'https://example.org/yoga?a=1');
    expect(g.trackingTemplate).toBe('{lpurl}&utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_term={keyword}');
    expect(tracking(google(), 'https://example.org/yoga').trackingTemplate!.startsWith('{lpurl}?')).toBe(true);
    // A link that already carries its own source stays as it is; utm switched off adds nothing.
    expect(tracking(meta(), 'https://example.org/x?utm_source=partner')).toEqual({ example: 'https://example.org/x?utm_source=partner' });
    expect(tracking(cleanSpec({ ...meta(), creative: { ...meta().creative, utm: false } }), 'https://example.org/x')).toEqual({ example: 'https://example.org/x' });
  });

  it('validation: what blocks a publish', () => {
    const ok = { maxDailyCents: 50_000, hasPixel: false, hasPage: true, hasLeadForm: true, link: 'https://example.org/yoga' };
    expect(validateSpec(meta(), ok).errors).toEqual([]);
    expect(validateSpec(meta({ budget: { type: 'daily', amount_cents: 60_000 } }), ok).errors.join()).toMatch(/Tageslimit/);
    expect(validateSpec(meta({ budget: { type: 'lifetime', amount_cents: 10000 } }), ok).errors.join()).toMatch(/Enddatum/);
    expect(validateSpec(meta(), { ...ok, hasPage: false }).errors.join()).toMatch(/Facebook-Seite/);
    expect(validateSpec(meta(), { ...ok, hasLeadForm: false }).errors.join()).toMatch(/Sofortformular/);
    expect(validateSpec(meta({ goal: 'conversions', kind: 'website' }), ok).errors.join()).toMatch(/Pixel/);
    expect(validateSpec(meta({ goal: 'reach', kind: 'lead_form' }), ok).errors.join()).toMatch(/Reichweite/);
    expect(validateSpec(meta({ audience: {} }), ok).errors.join()).toMatch(/Ort fehlt/);
    expect(validateSpec(meta({ creative: { ...meta().creative, media: [] } }), ok).errors.join()).toMatch(/Bild oder Video/);
    expect(validateSpec(meta(), { ...ok, link: '' }).errors.join()).toMatch(/Link fehlt/);
    expect(validateSpec(meta({ creative: { ...meta().creative, headline: 'x'.repeat(60) } }), ok).warnings.join()).toMatch(/Überschrift/);
    // Google
    const g = { maxDailyCents: 50_000, hasPixel: false, link: 'https://example.org/yoga' };
    expect(validateSpec(google(), g).errors).toEqual([]);
    expect(validateSpec(google({ goal: 'reach' }), g).errors.join()).toMatch(/nur bei Meta/);
    expect(validateSpec(google({ creative: { headlines: ['a', 'b'], descriptions: ['x'] } }), g).errors.join()).toMatch(/3 Überschriften/);
    expect(validateSpec(google({ creative: { headlines: ['x'.repeat(31), 'b', 'c'], descriptions: ['abc def', 'ghi jkl'] } }), g).errors.join()).toMatch(/30 Zeichen/);
    expect(validateSpec(google({ kind: 'pmax', creative: { headlines: ['a', 'b', 'c'], descriptions: ['x', 'y'] } }), g).errors.join()).toMatch(/Querformat|lange Überschrift/);
  });

  it('review: plain-language rows, the example link and "paused after publishing"', () => {
    const spec = meta();
    const problems = validateSpec(spec, { maxDailyCents: 50_000, hasPage: true, hasLeadForm: true, link: 'https://example.org/yoga' });
    const r = reviewOf(spec, { accountName: 'Testkonto', currency: 'EUR', problems, link: 'https://example.org/yoga', mediaNames: ['bild.jpg'], audienceNames: ['Kunden'], leadFormName: 'Probestunde', hash: 'h' });
    expect(r).toMatchObject({ platform: 'meta', status_after: 'paused', ready: true, hash: 'h', headline: 'Sommer-Aktion' });
    expect(r.rows.find((x) => x.label === 'Budget')!.value).toMatch(/20,00\s€ pro Tag/);
    expect(r.rows.find((x) => x.label === 'Tracking')!.value).toContain('utm_source=facebook');
    expect(r.note).toMatch(/pausiert/);
    expect(r.preview.media).toEqual(['bild.jpg']);
  });
});

describe('rules: pause when CPL > X', () => {
  const n = (o: Partial<Record<string, number>> = {}) => ({ spend_cents: 6000, impressions: 4000, clicks: 80, platform_leads: 2, crm_leads: 0, ...o });
  it('cost per lead uses CRM leads when there are any, else the platform count; no lead yet = spend so far', () => {
    expect(metricValue('cpl', n())).toBe(3000);
    expect(metricValue('cpl', n({ crm_leads: 3 }))).toBe(2000);
    expect(metricValue('cpl', n({ platform_leads: 0 }))).toBe(6000);
    expect(metricValue('cpl', n({ spend_cents: 0 }))).toBeNull();
    expect(metricValue('cpc', n({ clicks: 0 }))).toBeNull();
    expect(metricValue('ctr', n({ impressions: 100 }))).toBeNull();
    expect(metricValue('ctr', n())).toBeCloseTo(2);
  });

  it('evaluates thresholds and the minimum spend guard', () => {
    const rule = { metric: 'cpl' as const, op: '>' as const, value: 2500, min_spend_cents: 0 };
    expect(evaluate(rule, n()).hit).toBe(true);
    expect(evaluate({ ...rule, value: 3000 }, n()).hit).toBe(false);
    expect(evaluate({ ...rule, min_spend_cents: 10_000 }, n()).hit).toBe(false);
    expect(evaluate({ ...rule, op: '<' }, n({ platform_leads: 0 })).hit).toBe(false);
    expect(evaluate({ metric: 'leads', op: '<', value: 1, min_spend_cents: 5000 }, n({ platform_leads: 0 })).hit).toBe(true);
  });

  it('cleans rules and refuses nonsense', () => {
    const fail = (m: string) => new Error(m);
    expect(cleanRule({ metric: 'cpl', op: '>', value: 2500, window_days: 7, action: 'pause', min_spend_cents: 3000 }, fail)).toMatchObject({ metric: 'cpl', op: '>', value: 2500, window_days: 7, action: 'pause', platform: 'all', min_spend_cents: 3000 });
    expect(() => cleanRule({ metric: 'foo', op: '>', value: 1 }, fail)).toThrow(/Kennzahl/);
    expect(() => cleanRule({ metric: 'cpl', op: '=', value: 1 }, fail)).toThrow(/Bedingung/);
    expect(() => cleanRule({ metric: 'cpl', op: '>', value: -1 }, fail)).toThrow(/Schwellenwert/);
    expect(() => cleanRule({ metric: 'cpl', op: '>', value: 1, window_days: 90 }, fail)).toThrow(/Zeitraum/);
    // An action that would spend does not exist: unknown actions fall back to pause.
    expect(cleanRule({ metric: 'cpl', op: '>', value: 1, action: 'activate' }, fail).action).toBe('pause');
  });
});

describe('lead mapping', () => {
  it('maps instant-form answers to contact fields and custom fields', () => {
    const m = mapLead({
      id: '4444444444444',
      field_data: [
        { name: 'full_name', values: ['Anna Beispiel'] },
        { name: 'email', values: [' Anna@Example.com '] },
        { name: 'phone_number', values: ['+49 151 2345678'] },
        { name: 'city', values: ['Köln'] },
        { name: 'zip_code', values: ['50667'] },
        { name: 'wie_viel_erfahrung_hast_du?', values: ['Anfänger'] },
        { name: 'leer', values: [''] },
      ],
    });
    expect(m.input).toMatchObject({ name: 'Anna Beispiel', email: 'anna@example.com', phone: '+491512345678', city: 'Köln', postal_code: '50667' });
    expect(m.custom).toEqual({ wie_viel_erfahrung_hast_du: 'Anfänger' });
    expect(m.answers).toHaveLength(6);
  });
});
