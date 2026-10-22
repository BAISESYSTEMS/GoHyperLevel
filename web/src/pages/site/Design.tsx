import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../../api';
import { Check, Empty, Field, Input, Select, Spinner, Textarea, act, confirmAsk, useLoad } from '../../ui';
import { COLOR_LABELS, COLOR_NAMES, ImageField, LinkField, SiteCtx, type SiteData } from './Fields';
import { contrast } from './contrast';
import './site.css';
import { useT } from '../../i18n';

type Item = { label: string; url: string; children?: Item[] };

// German labels (message ids of the sites catalog), shown through t()
const SHADOW_PRESETS: [string, string, string][] = [
  ['none', 'Keiner', 'none'],
  ['soft', 'Dezent', '0 1px 2px rgba(17,24,39,.08)'],
  ['mid', 'Mittel', '0 6px 18px rgba(17,24,39,.10)'],
  ['strong', 'Stark', '0 18px 44px rgba(17,24,39,.16)'],
];
const RATIOS: [string, string][] = [['1.125', 'Klein (1,125)'], ['1.2', 'Ruhig (1,2)'], ['1.25', 'Standard (1,25)'], ['1.333', 'Deutlich (1,333)'], ['1.5', 'Groß (1,5)']];

const Section = ({ title, hint, children, open }: { title: string; hint?: string; children: ReactNode; open?: boolean }) => (
  <details className="card ds-sec" open={open}>
    <summary>
      <b>{title}</b>
      {hint && <span className="muted small"> · {hint}</span>}
    </summary>
    <div className="ds-body">{children}</div>
  </details>
);

/** A menu: items with a link, one level of sub-items, and order. */
function MenuItems({ items, onChange, depth = 0, label: labelProp }: { items: Item[]; onChange: (v: Item[]) => void; depth?: number; label?: string }) {
  const t = useT('sites');
  const label = labelProp ?? t('Eintrag');
  const set = (i: number, patch: Partial<Item>) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const mv = (i: number, d: number) => {
    const a = [...items];
    [a[i], a[i + d]] = [a[i + d], a[i]];
    onChange(a);
  };
  return (
    <div className={depth ? 'mi-sub' : ''}>
      {items.map((it, i) => (
        <div key={i} className="mi">
          <div className="mi-row">
            <Input value={it.label} onChange={(v) => set(i, { label: v })} placeholder={t('Beschriftung')} aria-label={t('{item} {n}: Beschriftung', { item: label, n: i + 1 })} />
            <LinkField value={it.url} onChange={(v) => set(i, { url: v })} />
            <span className="mi-act">
              <button className="icon-btn" disabled={!i} onClick={() => mv(i, -1)} aria-label={t('{item} {n} nach oben', { item: label, n: i + 1 })}>
                ↑
              </button>
              <button className="icon-btn" disabled={i === items.length - 1} onClick={() => mv(i, 1)} aria-label={t('{item} {n} nach unten', { item: label, n: i + 1 })}>
                ↓
              </button>
              <button className="icon-btn" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label={t('{item} {n} entfernen', { item: label, n: i + 1 })}>
                ✕
              </button>
            </span>
          </div>
          {depth < 1 && (
            <>
              <MenuItems items={it.children ?? []} onChange={(c) => set(i, { children: c.length ? c : undefined })} depth={1} label={t('Unterpunkt')} />
              {(it.children ?? []).length < 12 && (
                <button className="btn small ghost" onClick={() => set(i, { children: [...(it.children ?? []), { label: '', url: '' }] })}>
                  {t('+ Unterpunkt')}
                </button>
              )}
            </>
          )}
        </div>
      ))}
      {depth === 0 && items.length < 12 && (
        <button className="btn small secondary" onClick={() => onChange([...items, { label: '', url: '' }])}>
          + {label}
        </button>
      )}
    </div>
  );
}

/** Design tokens, header, footer, menus, languages, search, 404 and statistics of a website – with a live preview. */
export function DesignTab({ funnel, onSaved }: { funnel: any; onSaved: () => void }) {
  const t = useT('sites');
  const d = useLoad(() => api.get<any>(`/api/funnels/${funnel.id}/design`), [funnel.id]);
  const [draft, setDraft] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  const [html, setHtml] = useState('');
  const [previewPage, setPreviewPage] = useState('');
  const [newMenu, setNewMenu] = useState('');
  const first = d.data?.pages?.[0]?.id;

  useEffect(() => {
    if (!d.data) return;
    const s = funnel.settings ?? {};
    setDraft({
      tokens: d.data.tokens,
      header: { enabled: false, brand: '', logo: '', menu: 'main', cta_text: '', cta_url: '', sticky: false, search: true, lang_switch: false, ...(d.data.header ?? {}) },
      footer: { enabled: false, text: '', columns: [], ...(d.data.footer ?? {}) },
      menus: d.data.menus ?? {},
      languages: d.data.languages ?? { default: 'de', list: [{ code: 'de', label: 'Deutsch' }] },
      not_found: { page_id: '', heading: '', text: '', ...(d.data.not_found ?? {}) },
      search: d.data.search ?? { enabled: false },
      analytics: { enabled: true, respect_dnt: true, retention_days: 180, ...(s.analytics ?? {}) },
    });
    setDirty(false);
  }, [d.data]);

  const set = (patch: Record<string, any>) => {
    setDraft((x: any) => ({ ...x, ...patch }));
    setDirty(true);
  };

  useEffect(() => {
    const pid = previewPage || first;
    if (!draft || !pid) return;
    const timer = setTimeout(() => api.text('POST', `/api/funnel-pages/${pid}/preview`, { settings: draft }).then(setHtml, () => undefined), 450);
    return () => clearTimeout(timer);
  }, [draft, previewPage, first]);

  const site: SiteData = useMemo(() => ({ funnelId: funnel.id, forms: [], calendars: [], products: [], collections: [], components: [], pages: d.data?.pages ?? [], colors: draft?.tokens?.colors ?? {} }), [funnel.id, d.data, draft?.tokens?.colors]);

  if (!draft) return d.error ? <Empty>{d.error}</Empty> : <Spinner />;
  const tok = draft.tokens;
  const setTok = (path: [string, string?], v: any) => set({ tokens: path[1] ? { ...tok, [path[0]]: { ...tok[path[0]], [path[1]]: v } } : { ...tok, [path[0]]: v } });
  const pairs: [string, string, string][] = [
    [t('Text auf Hintergrund'), tok.colors.text, tok.colors.bg],
    [t('Grauer Text auf Hintergrund'), tok.colors.muted, tok.colors.bg],
    [t('Grauer Text auf Fläche'), tok.colors.muted, tok.colors.surface],
    [t('Markenfarbe auf Hintergrund'), tok.colors.brand, tok.colors.bg],
    [t('Weißer Text auf Marke (Buttons)'), '#ffffff', tok.colors.brand],
  ];
  const menuNames = Object.keys(draft.menus);
  const header = draft.header;
  const footer = draft.footer;
  const langs = draft.languages;

  const save = async () => {
    const r = await act(() => api.patch(`/api/funnels/${funnel.id}`, { settings: draft }), t('Design gespeichert'));
    if (r) {
      setDirty(false);
      onSaved();
      d.reload();
    }
  };

  return (
    <SiteCtx.Provider value={site}>
      <div className="site-editor design-tab" data-tour="site-design">
        <div className="se-left">
          <div className="se-bar">
            <button className="btn" onClick={save} disabled={!dirty}>
              {dirty ? t('Design speichern') : t('Gespeichert ✓')}
            </button>
            <button
              className="btn secondary"
              onClick={() => confirmAsk(t('Farben, Schriften und Formen auf die Standardwerte zurücksetzen?')) && set({ tokens: d.data.defaults })}
            >
              {t('Standard-Design')}
            </button>
          </div>

          <Section title={t('Farben')} hint={t('gelten überall – Blöcke verweisen darauf')} open>
            <div className="ds-colors">
              {COLOR_NAMES.map((n) => (
                <label key={n} className="ds-color">
                  <span>{t(COLOR_LABELS[n])}</span>
                  <span className="ds-colorin">
                    <input type="color" value={tok.colors[n]?.slice(0, 7) ?? '#000000'} onChange={(e) => setTok(['colors'], { ...tok.colors, [n]: e.target.value })} aria-label={t('{color} wählen', { color: t(COLOR_LABELS[n]) })} />
                    <Input value={tok.colors[n]} onChange={(v) => /^#[0-9a-f]{0,8}$/i.test(v) && setTok(['colors'], { ...tok.colors, [n]: v })} aria-label={t('{color} als Hex-Wert', { color: t(COLOR_LABELS[n]) })} />
                  </span>
                </label>
              ))}
            </div>
            <ul className="ds-contrast">
              {pairs.map(([label, fg, bg]) => {
                const r = contrast(fg, bg);
                return (
                  <li key={label} className={r >= 4.5 ? 'ok' : 'low'}>
                    <span className="ds-chip" style={{ color: fg, background: bg }} aria-hidden="true">
                      {/* i18n-ignore – a type sample */}
                      Aa
                    </span>
                    {/* i18n-ignore – WCAG levels */}
                    {label}: <b>{r.toFixed(1)} : 1</b> · {r >= 7 ? 'AAA' : r >= 4.5 ? 'AA ✓' : t('zu niedrig (mind. 4,5 : 1 für BFSG)')}
                  </li>
                );
              })}
            </ul>
          </Section>

          <Section title={t('Schrift & Größen')} hint={t('Systemschriften – nichts wird nachgeladen')}>
            <div className="grid2">
              <Field label={t('Fließtext')}>
                <Select value={tok.fonts.body} onChange={(v) => setTok(['fonts'], { ...tok.fonts, body: v })} options={d.data.fonts.map((f: any) => [f.key, f.label])} />
              </Field>
              <Field label={t('Überschriften')}>
                <Select value={tok.fonts.heading} onChange={(v) => setTok(['fonts'], { ...tok.fonts, heading: v })} options={d.data.fonts.map((f: any) => [f.key, f.label])} />
              </Field>
              <Field label={t('Grundgröße: {n} px', { n: tok.scale.base })}>
                <input type="range" min={14} max={22} value={tok.scale.base} onChange={(e) => setTok(['scale'], { ...tok.scale, base: Number(e.target.value) })} />
              </Field>
              <Field label={t('Größenverhältnis der Überschriften')}>
                <Select value={String(tok.scale.ratio)} onChange={(v) => setTok(['scale'], { ...tok.scale, ratio: Number(v) })} options={RATIOS.map(([k, l]) => [k, t(l)] as [string, string])} />
              </Field>
              <Field label={t('Abstandseinheit: {n} px', { n: tok.space })}>
                <input type="range" min={4} max={12} value={tok.space} onChange={(e) => setTok(['space'], Number(e.target.value))} />
              </Field>
            </div>
          </Section>

          <Section title={t('Ecken & Schatten')}>
            <div className="grid3">
              {(['sm', 'md', 'lg'] as const).map((k) => (
                <Field key={k} label={{ sm: t('Ecken klein (px)'), md: t('Ecken mittel (px)'), lg: t('Ecken groß (px)') }[k]}>
                  <Input type="number" value={tok.radius[k]} onChange={(v) => setTok(['radius'], { ...tok.radius, [k]: Number(v) })} />
                </Field>
              ))}
              {(['sm', 'md', 'lg'] as const).map((k) => (
                <Field key={k} label={{ sm: t('Schatten klein'), md: t('Schatten mittel'), lg: t('Schatten groß') }[k]}>
                  <Select value={SHADOW_PRESETS.find((p) => p[2] === tok.shadow[k])?.[0] ?? 'custom'} onChange={(v) => v !== 'custom' && setTok(['shadow'], { ...tok.shadow, [k]: SHADOW_PRESETS.find((p) => p[0] === v)![2] })} options={[...SHADOW_PRESETS.map((p) => [p[0], t(p[1])] as [string, string]), ['custom', t('Eigener')]]} />
                </Field>
              ))}
            </div>
          </Section>

          <Section title={t('Kopfzeile')} hint={t('Logo, Menü, Button – auf jeder Seite')}>
            <Check checked={header.enabled} onChange={(v) => set({ header: { ...header, enabled: v } })} label={t('Kopfzeile anzeigen')} />
            {header.enabled && (
              <>
                <div className="grid2">
                  <Field label={t('Name / Marke')}>
                    <Input value={header.brand} onChange={(v) => set({ header: { ...header, brand: v } })} />
                  </Field>
                  <Field label={t('Menü')}>
                    <Select value={header.menu} onChange={(v) => set({ header: { ...header, menu: v } })} options={menuNames.length ? menuNames : ['main']} />
                  </Field>
                  <Field label={t('Button-Text (optional)')}>
                    <Input value={header.cta_text} onChange={(v) => set({ header: { ...header, cta_text: v } })} />
                  </Field>
                  <Field label={t('Button-Link')}>
                    <LinkField value={header.cta_url} onChange={(v) => set({ header: { ...header, cta_url: v } })} />
                  </Field>
                </div>
                <Field label={t('Logo (optional)')}>
                  <ImageField value={header.logo} onChange={(url) => set({ header: { ...header, logo: url } })} />
                </Field>
                <div className="checks">
                  <Check checked={header.sticky} onChange={(v) => set({ header: { ...header, sticky: v } })} label={t('Beim Scrollen oben bleiben')} />
                  <Check checked={header.search !== false} onChange={(v) => set({ header: { ...header, search: v } })} label={t('Suchfeld anzeigen (wenn Suche an ist)')} />
                  <Check checked={!!header.lang_switch} onChange={(v) => set({ header: { ...header, lang_switch: v } })} label={t('Sprachwechsler anzeigen')} />
                </div>
              </>
            )}
          </Section>

          <Section title={t('Menüs')} hint={t('Navigation für Kopf- und Fußzeile')}>
            {menuNames.map((name) => (
              <div key={name} className="card ds-menu">
                <div className="row" style={{ alignItems: 'center' }}>
                  <b>{t('Menü „{name}“', { name })}</b>
                  <span className="grow" />
                  <button className="btn small ghost" onClick={() => confirmAsk(t('Menü „{name}“ löschen?', { name })) && set({ menus: Object.fromEntries(Object.entries(draft.menus).filter(([k]) => k !== name)) })}>
                    {t('Menü löschen')}
                  </button>
                </div>
                <MenuItems items={draft.menus[name]} onChange={(v) => set({ menus: { ...draft.menus, [name]: v } })} />
              </div>
            ))}
            <div className="row" style={{ alignItems: 'end' }}>
              <div style={{ width: 200 }}>
                <Field label={t('Neues Menü (Name)')}>
                  <Input value={newMenu} onChange={(v) => setNewMenu(v.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20))} placeholder={t('main, footer …')} />
                </Field>
              </div>
              <button className="btn small secondary" disabled={!/^[a-z][a-z0-9_-]*$/.test(newMenu) || newMenu in draft.menus} onClick={() => (set({ menus: { ...draft.menus, [newMenu]: [] } }), setNewMenu(''))}>
                {t('Menü anlegen')}
              </button>
            </div>
          </Section>

          <Section title={t('Fußzeile')} hint={t('Spalten mit Menüs oder Links, Rechtliches')}>
            <Check checked={footer.enabled} onChange={(v) => set({ footer: { ...footer, enabled: v } })} label={t('Fußzeile anzeigen (mit Links zu Impressum, Datenschutz und Cookie-Einstellungen)')} />
            {footer.enabled && (
              <>
                <Field label={t('Text (z. B. © 2026 Firma)')}>
                  <Textarea value={footer.text} onChange={(v) => set({ footer: { ...footer, text: v } })} rows={2} />
                </Field>
                {footer.columns.map((c: any, i: number) => (
                  <div key={i} className="card">
                    <div className="grid2">
                      <Field label={t('Spalte {n}: Titel', { n: i + 1 })}>
                        <Input value={c.title} onChange={(v) => set({ footer: { ...footer, columns: footer.columns.map((x: any, j: number) => (j === i ? { ...x, title: v } : x)) } })} />
                      </Field>
                      <Field label={t('Inhalt')}>
                        <Select
                          value={c.menu ?? ''}
                          onChange={(v) => set({ footer: { ...footer, columns: footer.columns.map((x: any, j: number) => (j === i ? (v ? { title: x.title, menu: v } : { title: x.title, links: x.links ?? [] }) : x)) } })}
                          options={[['', t('Eigene Links')], ...menuNames.map((m) => [m, t('Menü „{name}“', { name: m })] as [string, string])]}
                        />
                      </Field>
                    </div>
                    {!c.menu && <MenuItems items={c.links ?? []} onChange={(v) => set({ footer: { ...footer, columns: footer.columns.map((x: any, j: number) => (j === i ? { ...x, links: v } : x)) } })} label={t('Link')} />}
                    <button className="btn small ghost" onClick={() => set({ footer: { ...footer, columns: footer.columns.filter((_: any, j: number) => j !== i) } })}>
                      {t('Spalte entfernen')}
                    </button>
                  </div>
                ))}
                {footer.columns.length < 4 && (
                  <button className="btn small secondary" onClick={() => set({ footer: { ...footer, columns: [...footer.columns, { title: '', links: [] }] } })}>
                    {t('+ Spalte')}
                  </button>
                )}
              </>
            )}
          </Section>

          <Section title={t('Sprachen')} hint={t('Seiten in mehreren Sprachen, hreflang für Google')}>
            <div className="grid2">
              <Field label={t('Standardsprache (Kürzel)')}>
                <Input value={langs.default} onChange={(v) => set({ languages: { ...langs, default: v.toLowerCase().slice(0, 5) } })} />
              </Field>
            </div>
            {langs.list.map((l: any, i: number) => (
              <div key={i} className="row" style={{ alignItems: 'end' }}>
                <div style={{ width: 90 }}>
                  <Input value={l.code} onChange={(v) => set({ languages: { ...langs, list: langs.list.map((x: any, j: number) => (j === i ? { ...x, code: v.toLowerCase().slice(0, 5) } : x)) } })} aria-label={t('Sprache {n}: Kürzel', { n: i + 1 })} />
                </div>
                <div style={{ width: 200 }}>
                  <Input value={l.label} onChange={(v) => set({ languages: { ...langs, list: langs.list.map((x: any, j: number) => (j === i ? { ...x, label: v } : x)) } })} aria-label={t('Sprache {n}: Name', { n: i + 1 })} />
                </div>
                <button className="icon-btn" onClick={() => set({ languages: { ...langs, list: langs.list.filter((_: any, j: number) => j !== i) } })} aria-label={t('Sprache {n} entfernen', { n: i + 1 })}>
                  ✕
                </button>
              </div>
            ))}
            <button className="btn small secondary" onClick={() => set({ languages: { ...langs, list: [...langs.list, { code: '', label: '' }] } })}>
              {t('+ Sprache')}
            </button>
            <p className="muted small">{t('Eine Übersetzung einer Seite legst du im Editor unter „Seiten-Layout“ an; sie bekommt denselben Gruppenschlüssel und wird per hreflang verknüpft.')}</p>
          </Section>

          <Section title={t('Suche & Fehlerseite')}>
            <Check checked={!!draft.search.enabled} onChange={(v) => set({ search: { enabled: v } })} label={t('Websuche einschalten (Seite /search, Suchfeld in der Kopfzeile)')} />
            <Field label={t('Eigene 404-Seite')} hint={t('Eine Seite dieser Website, die gezeigt wird, wenn ein Pfad nicht existiert. Ohne Auswahl erscheint ein schlichter Hinweis im Design der Seite.')}>
              <Select value={draft.not_found.page_id} onChange={(v) => set({ not_found: { ...draft.not_found, page_id: v } })} placeholder={t('Standard-Hinweis')} options={(d.data.pages ?? []).map((p: any) => [p.id, p.name])} />
            </Field>
            {!draft.not_found.page_id && (
              <div className="grid2">
                <Field label={t('Überschrift')}>
                  <Input value={draft.not_found.heading} onChange={(v) => set({ not_found: { ...draft.not_found, heading: v } })} placeholder={t('Seite nicht gefunden')} />
                </Field>
                <Field label={t('Text')}>
                  <Input value={draft.not_found.text} onChange={(v) => set({ not_found: { ...draft.not_found, text: v } })} />
                </Field>
              </div>
            )}
          </Section>

          <Section title={t('Statistik')} hint={t('ohne Cookies, ohne Einwilligung')}>
            <Check checked={draft.analytics.enabled} onChange={(v) => set({ analytics: { ...draft.analytics, enabled: v } })} label={t('Seitenaufrufe, Verweildauer und Conversions je Schritt zählen')} />
            <Check checked={draft.analytics.respect_dnt} onChange={(v) => set({ analytics: { ...draft.analytics, respect_dnt: v } })} label={t('„Do Not Track“ und Global Privacy Control respektieren')} />
            <Field label={t('Aufbewahrung in Tagen (30–730)')}>
              <Input type="number" value={draft.analytics.retention_days} onChange={(v) => set({ analytics: { ...draft.analytics, retention_days: Number(v) } })} />
            </Field>
            <p className="muted small">{t('Besucher werden nur über einen täglich wechselnden Hash gezählt (keine Cookies, keine IP-Speicherung). Erwähne die Reichweitenmessung trotzdem in der Datenschutzerklärung.')}</p>
          </Section>
        </div>

        <div className="se-right">
          <div className="se-pvbar">
            <span className="muted small grow">{t('Vorschau mit deinen Änderungen')}</span>
            <div style={{ width: 200 }}>
              <Select value={previewPage || first} onChange={setPreviewPage} options={(d.data.pages ?? []).map((p: any) => [p.id, p.name])} />
            </div>
          </div>
          <iframe className="preview-frame" srcDoc={html} title={t('Vorschau des Designs')} sandbox="allow-scripts allow-forms" />
        </div>
      </div>
    </SiteCtx.Provider>
  );
}
