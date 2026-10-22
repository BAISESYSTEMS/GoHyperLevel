import { useEffect, useState } from 'react';
import { api, amount, d } from '../api';
import { Badge, Check, Empty, Field, Input, Select, Spinner, Textarea, act, confirmAsk, useLoad } from '../ui';
import { ImagePicker } from './ContentKit';
import './FormsDepth.css';
import { getLocale, tr, useT } from '../i18n';
import { SOURCE_LOCALE } from '../i18n/registry';
import { SortableGrid } from '../sortable/Sortable';

/** Formulare: Layout & Ablauf, Design, Logik & Ergebnis, Spam-Schutz, Auswertung je Feld und Einsendungs-Details. Server: form-themes/-logic/-analytics/-captcha. */

type SetS = (patch: any) => void;

// --- layout & flow ------------------------------------------------------------------------------------------------------

export function FlowPanel({ s, setS }: { s: any; setS: SetS }) {
  const t = useT('forms');
  const typeform = s.mode === 'typeform';
  const w = s.welcome;
  return (
    <div className="card fd" data-tour="form-flow">
      <h2>{t('Layout & Ablauf')}</h2>
      <Field label={t('Layout')}>
        <Select value={typeform ? 'typeform' : 'classic'} onChange={(v) => setS({ mode: v })} options={[['classic', t('Klassisch – alle Fragen einer Seite untereinander')], ['typeform', t('Eine Frage nach der anderen – groß, mit Tastatur und weichen Übergängen')]]} />
      </Field>
      {typeform && <p className="fd-hint">{t('Besucher bedienen es mit Enter (weiter), den Buchstaben A–Z bei Auswahlfragen und Alt + Pfeiltasten. Sprünge („Logik“) gehen dann von Frage zu Frage.')}</p>}
      <Check checked={s.show_progress !== false} onChange={(v) => setS({ show_progress: v })} label={t('Fortschrittsbalken zeigen')} />
      {typeform && <Check checked={!!s.auto_advance} onChange={(v) => setS({ auto_advance: v })} label={t('Nach einer Auswahl automatisch zur nächsten Frage')} />}
      <Check checked={!!s.save_progress} onChange={(v) => setS({ save_progress: v })} label={t('Fortschritt speichern – Besucher können später weitermachen')} />
      <hr />
      <Check checked={!!w} onChange={(v) => setS({ welcome: v ? { title: t('Willkommen'), text: '', button: t('Los geht’s') } : null })} label={t('Startseite vor der ersten Frage')} />
      {w && (
        <>
          <Field label={t('Überschrift')}>
            <Input value={w.title} onChange={(v) => setS({ welcome: { ...w, title: v } })} maxLength={160} />
          </Field>
          <Field label={t('Text')}>
            <Textarea value={w.text} onChange={(v) => setS({ welcome: { ...w, text: v } })} rows={3} maxLength={1000} />
          </Field>
          <Field label={t('Button')}>
            <Input value={w.button} onChange={(v) => setS({ welcome: { ...w, button: v } })} maxLength={40} />
          </Field>
        </>
      )}
    </div>
  );
}

// --- scoring, variables, endings -------------------------------------------------------------------------------------------

type Ending = { var?: string; min?: number | null; max?: number | null; title: string; text: string; redirect_url?: string; tag?: string };

export function ScoringPanel({ s, setS, fields }: { s: any; setS: SetS; fields: any[] }) {
  const t = useT('forms');
  const vars: { name: string; formula: string }[] = s.variables ?? [];
  const endings: Ending[] = s.endings ?? [];
  const names = ['score', ...vars.map((v) => v.name), ...fields.filter((f) => f.type === 'calculator').map((f) => f.name)];
  const setEnd = (i: number, patch: Partial<Ending>) => setS({ endings: endings.map((e, k) => (k === i ? { ...e, ...patch } : e)) });
  const num = (v: string) => (v === '' ? null : Number(v));
  return (
    <div className="fd" data-tour="form-scoring">
      <div className="card">
        <h2>{t('Punkte & Variablen')}</h2>
        <p className="fd-hint">
          {/* i18n-ignore – the <code> examples stay as they are */}
          {t('Jede Option einer Auswahlfrage kann Punkte geben (am Feld unter „Punkte für die Auswertung“), Zahlen können mit einem Gewicht zählen. Die Summe heißt')} <code>score</code>{t('. Eigene Variablen rechnen damit weiter, z. B.')} <code>score / 40 * 100</code>.
        </p>
        {vars.map((v, i) => (
          <div key={i} className="fd-jump">
            <Input value={v.name} onChange={(n) => setS({ variables: vars.map((x, k) => (k === i ? { ...x, name: n } : x)) })} placeholder="name" aria-label={t('Variablenname')} style={{ maxWidth: 160 }} />
            <span>=</span>
            {/* i18n-ignore – a formula example */}
            <Input value={v.formula} onChange={(n) => setS({ variables: vars.map((x, k) => (k === i ? { ...x, formula: n } : x)) })} placeholder="score * 2" aria-label={t('Formel')} />
            <button type="button" className="icon-btn" aria-label={t('Variable entfernen')} onClick={() => setS({ variables: vars.filter((_x, k) => k !== i) })}>
              ✕
            </button>
          </div>
        ))}
        <button type="button" className="btn small secondary" onClick={() => setS({ variables: [...vars, { name: `${t('wert')}${vars.length + 1}`, formula: 'score' }] })}>
          {t('+ Variable')}
        </button>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h2>{t('Ergebnisse')}</h2>
        <p className="fd-hint">{t('Je nach Wert einer Variablen sehen Besucher nach dem Absenden ein anderes Ergebnis, bekommen einen Tag oder werden weitergeleitet. Die erste passende Zeile gilt. In Texten fügt')} <code>{'{{score}}'}</code> {t('den Wert ein.')}</p>
        <Check checked={!!s.show_result} onChange={(v) => setS({ show_result: v })} label={t('Berechnete Werte nach dem Absenden anzeigen (Punkte, Variablen)')} />
        {endings.map((e, i) => (
          <div key={i} className="fd-ending">
            <div className="fd-jump">
              <span>{t('Wenn')}</span>
              <Select value={e.var || 'score'} onChange={(v) => setEnd(i, { var: v })} options={names} />
              <span>{t('von')}</span>
              <Input type="number" value={e.min ?? ''} onChange={(v) => setEnd(i, { min: num(v) })} placeholder="–" aria-label={t('von')} style={{ maxWidth: 90 }} />
              <span>{t('bis')}</span>
              <Input type="number" value={e.max ?? ''} onChange={(v) => setEnd(i, { max: num(v) })} placeholder="–" aria-label={t('bis')} style={{ maxWidth: 90 }} />
              <button type="button" className="icon-btn" aria-label={t('Ergebnis entfernen')} onClick={() => setS({ endings: endings.filter((_x, k) => k !== i) })}>
                ✕
              </button>
            </div>
            <Field label={t('Überschrift')}>
              <Input value={e.title} onChange={(v) => setEnd(i, { title: v })} maxLength={160} />
            </Field>
            <Field label={t('Text')}>
              <Textarea value={e.text} onChange={(v) => setEnd(i, { text: v })} rows={3} maxLength={2000} />
            </Field>
            <div className="grid2">
              <Field label={t('Weiterleiten zu (optional)')}>
                <Input value={e.redirect_url} onChange={(v) => setEnd(i, { redirect_url: v })} placeholder="https://…" />
              </Field>
              <Field label={t('Tag für den Kontakt (optional)')}>
                <Input value={e.tag} onChange={(v) => setEnd(i, { tag: v })} placeholder={t('z. B. quiz:profi')} maxLength={80} />
              </Field>
            </div>
          </div>
        ))}
        <button type="button" className="btn small secondary" onClick={() => setS({ endings: [...endings, { var: 'score', min: null, max: null, title: '', text: '' }] })}>
          {t('+ Ergebnis')}
        </button>
        <p className="fd-hint" style={{ marginTop: 10 }}>
          {t('Workflows starten mit „Formular bewertet“ (')}<code>form.scored</code>{t(') und – bei Zahlungsfeldern – „Formular bezahlt“ (')}<code>form.paid</code>).
        </p>
      </div>
    </div>
  );
}

// --- design -------------------------------------------------------------------------------------------------------------------

const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const ch = (c: number) => ((c / 255) <= 0.03928 ? c / 255 / 12.92 : (((c / 255) + 0.055) / 1.055) ** 2.4);
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
};
const HEX = /^#[0-9a-f]{6}$/i;
const ratio = (a: string, b: string) => {
  if (!HEX.test(a) || !HEX.test(b)) return 21;
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
};
const readable = (bg: string) => (ratio(bg, '#000000') >= ratio(bg, '#ffffff') ? '#000000' : '#ffffff');
/** Decimal comma and "12 %" in German (as before), "12.5" and "12%" in English. */
const de = () => getLocale() === SOURCE_LOCALE;
const dec = (n: number) => (de() ? String(n).replace('.', ',') : String(n));
const pct = (n: number | string) => (de() ? `${n} %` : `${n}%`);

function warnings(th: any): string[] {
  const t = tr('forms');
  const out: string[] = [];
  const onCard = ratio(th.text, th.card);
  if (onCard < 4.5) out.push(t('Text auf Karte: Kontrast {ratio} : 1 – mindestens 4,5 : 1 ist gut lesbar.', { ratio: dec(onCard) }));
  if (!th.bg_image) {
    const onPage = ratio(th.text, th.background);
    if (onPage < 4.5) out.push(t('Text auf Hintergrund: Kontrast {ratio} : 1 – mindestens 4,5 : 1 ist gut lesbar.', { ratio: dec(onPage) }));
  }
  const btn = ratio(th.button_text || readable(th.color), th.color);
  if (btn < 4.5) out.push(t('Button: Kontrast {ratio} : 1 – mindestens 4,5 : 1 ist gut lesbar.', { ratio: dec(btn) }));
  const accent = ratio(th.color, th.card);
  if (accent < 3) out.push(t('Akzentfarbe auf Karte: Kontrast {ratio} : 1 – mindestens 3 : 1 für Markierungen.', { ratio: dec(accent) }));
  return out;
}

const FONT_STACK: Record<string, string> = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", "Noto Serif", serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", "Nunito", system-ui, sans-serif',
  humanist: 'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", sans-serif',
  mono: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace',
};

function ThemePreview({ t: theme }: { t: any }) {
  const t = useT('forms');
  const btn = theme.button_text || readable(theme.color);
  return (
    <div
      className="fd-theme-preview"
      style={{ background: theme.bg_image ? `linear-gradient(rgba(0,0,0,${(theme.bg_overlay || 0) / 100}),rgba(0,0,0,${(theme.bg_overlay || 0) / 100})),url("${theme.bg_image}") center/cover` : theme.background, fontFamily: FONT_STACK[theme.font] ?? FONT_STACK.system, textAlign: theme.align }}
      aria-label={t('Vorschau des Designs')}
      role="img"
    >
      <div style={{ background: theme.card, color: theme.text, borderRadius: theme.radius, padding: 18 }}>
        <div style={{ fontSize: 12, opacity: 0.7 }}>1 → 3</div>
        <div style={{ height: 6, borderRadius: 99, background: `color-mix(in srgb, ${theme.text} 15%, ${theme.card})`, margin: '6px 0 14px' }}>
          <div style={{ width: '40%', height: '100%', borderRadius: 99, background: theme.color }} />
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 10 }}>{t('Wie können wir dir helfen?')}</div>
        <div style={{ border: `2px solid ${theme.color}`, borderRadius: theme.radius, padding: '10px 12px', marginBottom: 8 }}>{t('A · Beratung')}</div>
        <div style={{ border: `1px solid color-mix(in srgb, ${theme.text} 25%, ${theme.card})`, borderRadius: theme.radius, padding: '10px 12px', marginBottom: 14 }}>{t('B · Angebot')}</div>
        <span style={{ display: 'inline-block', background: theme.color, color: btn, borderRadius: theme.radius, padding: '10px 18px', fontWeight: 600 }}>{t('Weiter')}</span>
      </div>
    </div>
  );
}

export function DesignPanel({ f, s, setS, previewKey }: { f: any; s: any; setS: SetS; previewKey: number }) {
  const t = useT('forms');
  const themes = useLoad(() => api.get<{ presets: { key: string; label: string; theme: any }[]; fonts: { key: string; label: string }[] }>('/api/forms/themes'), []);
  const th = { ...(f.theme ?? {}), ...(s.theme ?? {}) };
  const set = (patch: any) => setS({ theme: { ...th, ...patch } });
  const warn = warnings(th);
  const color = (key: string, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <input type="color" value={HEX.test(th[key]) ? th[key] : '#000000'} onChange={(e) => set({ [key]: e.target.value })} aria-label={label} className="fd-color" />
    </Field>
  );
  return (
    <div className="fd-design" data-tour="form-design">
      <div className="card fd">
        <h2>{t('Design')}</h2>
        <div className="fd-presets" role="group" aria-label={t('Design-Vorlagen')}>
          {(themes.data?.presets ?? []).map((p) => (
            <button type="button" key={p.key} className={`fd-preset${th.preset === p.key ? ' on' : ''}`} onClick={() => setS({ theme: p.theme })} title={t(p.label)} aria-pressed={th.preset === p.key}>
              <span className="sw" style={{ background: p.theme.background }}>
                <i style={{ background: p.theme.card }} />
                <i style={{ background: p.theme.color }} />
              </span>
              {t(p.label)}
            </button>
          ))}
        </div>
        <div className="grid2">
          <Field label={t('Schrift')}>
            <Select value={th.font} onChange={(v) => set({ font: v })} options={(themes.data?.fonts ?? [{ key: 'system', label: t('Systemschrift') }]).map((x) => [x.key, t(x.label)] as [string, string])} />
          </Field>
          <Field label={t('Ausrichtung')}>
            <Select value={th.align} onChange={(v) => set({ align: v })} options={[['left', t('Linksbündig')], ['center', t('Zentriert')]]} />
          </Field>
        </div>
        <div className="fd-colors">
          {color('color', t('Akzent (Buttons, Auswahl)'))}
          {color('text', t('Text'))}
          {color('card', t('Karte / Frage'))}
          {color('background', t('Hintergrund'))}
        </div>
        <div className="grid2">
          <Field label={t('Button-Text')} hint={t('Automatisch schwarz oder weiß, je nach Lesbarkeit.')}>
            <div className="row" style={{ alignItems: 'center', gap: 8 }}>
              <input type="color" value={HEX.test(th.button_text) ? th.button_text : readable(th.color)} onChange={(e) => set({ button_text: e.target.value })} aria-label={t('Button-Text')} className="fd-color" />
              {th.button_text && (
                <button type="button" className="btn small ghost" onClick={() => set({ button_text: '' })}>
                  {t('automatisch')}
                </button>
              )}
            </div>
          </Field>
          <Field label={t('Rundung: {n} px', { n: th.radius })}>
            <input type="range" min={0} max={28} value={th.radius} onChange={(e) => set({ radius: Number(e.target.value) })} aria-label={t('Rundung')} />
          </Field>
        </div>
        <Field label={t('Hintergrundbild (optional)')}>
          <ImagePicker value={th.bg_image} onChange={(v) => set({ bg_image: v })} />
        </Field>
        {th.bg_image && (
          <Field label={t('Abdunkeln: {n} %', { n: th.bg_overlay })} hint={t('Macht Text auf dem Bild besser lesbar.')}>
            <input type="range" min={0} max={80} value={th.bg_overlay} onChange={(e) => set({ bg_overlay: Number(e.target.value) })} aria-label={t('Abdunkeln')} />
          </Field>
        )}
        {warn.length > 0 && (
          <div className="fd-note" role="status">
            <b>{t('Lesbarkeit')}</b>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {warn.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div>
        <ThemePreview t={th} />
        <p className="muted small">{t('Die Vorschau zeigt Farben, Schrift und Rundung sofort. Das echte Formular (nach dem Speichern):')}</p>
        <iframe key={previewKey} className="preview-frame" src={`/f/${f.id}`} title={t('Vorschau des Formulars')} />
      </div>
    </div>
  );
}

// --- spam protection ----------------------------------------------------------------------------------------------------------

export function SecurityPanel({ s, setS, onKeys }: { s: any; setS: SetS; onKeys: () => void }) {
  const t = useT('forms');
  const st = useLoad(() => api.get<{ configured: boolean; site_key: string; secret_hint: string; forms: number }>('/api/forms/captcha'), []);
  const [site, setSite] = useState('');
  const [secret, setSecret] = useState('');
  useEffect(() => {
    if (st.data) setSite(st.data.site_key);
  }, [st.data?.site_key]);
  const c = st.data;
  const save = async () => {
    const r = await act(() => api.put('/api/forms/captcha', { site_key: site, secret_key: secret }), t('Turnstile-Schlüssel gespeichert'));
    if (r) (setSecret(''), await st.reload(), onKeys());
  };
  return (
    <div className="card fd" data-tour="form-security">
      <h2>{t('Spam-Schutz')}</h2>
      <p className="fd-hint">{t('Ein verstecktes Honeypot-Feld ist immer aktiv – es kostet Besucher nichts. Zusätzlich kannst du Cloudflare Turnstile einschalten, ein unauffälliges Captcha mit deinen eigenen Cloudflare-Schlüsseln.')}</p>
      <Check checked={!!s.captcha?.enabled} onChange={(v) => setS({ captcha: { enabled: v } })} label={t('Turnstile für dieses Formular verlangen')} />
      {s.captcha?.enabled && !c?.configured && <div className="fd-note">{t('Dafür unten erst die Schlüssel eintragen.')}</div>}
      <hr />
      <h3 style={{ margin: '0 0 6px' }}>{t('Turnstile-Schlüssel (für alle Formulare dieses Kunden)')}</h3>
      {!c ? (
        <Spinner />
      ) : (
        <>
          <div className="grid2">
            <Field label={t('Site Key')} hint={t('Steht im Cloudflare-Dashboard unter Turnstile.')}>
              {/* i18n-ignore – the shape of a key */}
              <Input value={site} onChange={setSite} placeholder="0x4AAAAAAA…" autoComplete="off" />
            </Field>
            <Field label={t('Secret Key')} hint={c.configured ? t('Gespeichert ({hint}). Leer lassen, um ihn zu behalten.', { hint: c.secret_hint }) : t('Wird verschlüsselt gespeichert und nie wieder angezeigt.')}>
              <Input type="password" value={secret} onChange={setSecret} placeholder={c.configured ? '••••••••' : ''} autoComplete="new-password" />
            </Field>
          </div>
          <div className="actions">
            <button className="btn" disabled={!site.trim() || (!c.configured && !secret.trim())} onClick={save}>
              {t('Schlüssel speichern')}
            </button>
            {c.configured && (
              <button
                className="btn ghost danger-text"
                onClick={async () => confirmAsk(t('Schlüssel entfernen? Turnstile wird dann in allen Formularen ausgeschaltet.')) && (await act(() => api.del('/api/forms/captcha'), t('Schlüssel entfernt'))) && (setSecret(''), await st.reload(), setS({ captcha: { enabled: false } }), onKeys())}
              >
                {t('Schlüssel entfernen')}
              </button>
            )}
          </div>
        </>
      )}
      <p className="fd-hint" style={{ marginTop: 12 }}>
        {t('Datenschutz: Turnstile lädt ein Skript von')} <code>challenges.cloudflare.com</code> {t('und übermittelt dabei die IP-Adresse an Cloudflare. Nimm es in deinen Cookie-/Einwilligungsbanner (Kategorie „notwendig“ bzw. Sicherheit) und in die Datenschutzerklärung auf. Ist Cloudflare nicht erreichbar, nimmt das Formular nichts an (kein stiller Durchlass).')}
      </p>
    </div>
  );
}

// --- analytics ------------------------------------------------------------------------------------------------------------------

type Report = {
  days: number;
  submissions: number;
  totals: { opened: number; started: number; submitted: number; completion_percent: number; abandon_percent: number; avg_submit_seconds: number };
  fields: { id: string; label: string; type: string; position: number; views: number; answered: number; answer_percent: number; dropoffs: number; dropoff_percent: number; avg_seconds: number }[];
  funnel: { step: string; field?: string; count: number; percent: number }[];
  worst_dropoff: { id: string; label: string; count: number } | null;
  slowest: { id: string; label: string; seconds: number } | null;
  daily: { day: string; opened: number; submitted: number }[];
};

const secs = (n: number) => {
  const t = tr('forms');
  return n >= 60 ? t('{m} Min. {s} s', { m: Math.floor(n / 60), s: Math.round(n % 60) }) : `${dec(Math.round(n * 10) / 10)} s`;
};

export function FormAnalytics({ id }: { id: string }) {
  const t = useT('forms');
  const [days, setDays] = useState('30');
  const r = useLoad(() => api.get<Report>(`/api/forms/${id}/analytics?days=${days}`), [id, days]);
  const a = r.data;
  if (!a) return r.error ? <Empty>{r.error}</Empty> : <Spinner />;
  const tot = a.totals;
  const maxDay = Math.max(1, ...a.daily.map((x) => x.opened));
  return (
    <div className="fd" data-tour="form-analytics">
      <div className="fd-bar">
        <div style={{ width: 190 }}>
          <Select value={days} onChange={setDays} options={[['7', t('Letzte 7 Tage')], ['30', t('Letzte 30 Tage')], ['90', t('Letzte 90 Tage')], ['180', t('Letzte 180 Tage')]]} />
        </div>
        <span className="grow" />
        <button className="btn ghost danger-text" onClick={async () => confirmAsk(t('Alle Aufrufdaten dieses Formulars löschen? Die Einsendungen bleiben.')) && (await act(() => api.del(`/api/forms/${id}/analytics`), t('Auswertung zurückgesetzt'))) && void r.reload()}>
          {t('Auswertung zurücksetzen')}
        </button>
      </div>
      <SortableGrid id="form.analytics" className="fd-stats">
        <div className="fd-stat"><b>{tot.opened}</b><span>{t('Aufrufe')}</span></div>
        <div className="fd-stat"><b>{tot.started}</b><span>{t('haben begonnen')}</span></div>
        <div className="fd-stat"><b>{tot.submitted}</b><span>{t('abgeschickt')}</span></div>
        <div className="fd-stat"><b>{pct(tot.completion_percent)}</b><span>{t('Abschlussquote')}</span></div>
        <div className="fd-stat"><b>{pct(tot.abandon_percent)}</b><span>{t('Abbruch')}</span></div>
        <div className="fd-stat"><b>{tot.avg_submit_seconds ? secs(tot.avg_submit_seconds) : '–'}</b><span>{t('Ø bis zum Absenden')}</span></div>
      </SortableGrid>
      {!tot.opened ? (
        <Empty>{t('Noch keine Aufrufe in diesem Zeitraum. Die Auswertung füllt sich, sobald Besucher das Formular öffnen.')}</Empty>
      ) : (
        <>
          {(a.worst_dropoff || a.slowest) && (
            <div className="fd-note ok">
              {a.worst_dropoff && <div>{t('Die meisten brechen bei „{label}“ ab ({n}×).', { label: a.worst_dropoff.label, n: a.worst_dropoff.count })}</div>}
              {a.slowest && <div>{t('Am längsten dauert „{label}“ (Ø {time}).', { label: a.slowest.label, time: secs(a.slowest.seconds) })}</div>}
            </div>
          )}
          <h3>{t('Trichter')}</h3>
          <div className="fd-funnel">
            {a.funnel.map((x, i) => (
              <div key={`${i}-${x.step}`} className="fd-frow">
                <span className="lbl" title={x.field ? x.step : t(x.step)}>{x.field ? x.step : t(x.step)}</span>
                <div className="bar"><span style={{ width: `${x.percent}%` }} /></div>
                <span className="n">{x.count} <span className="muted small">({pct(x.percent)})</span></span>
              </div>
            ))}
          </div>
          <h3>{t('Je Frage')}</h3>
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr><th>#</th><th>{t('Frage')}</th><th className="num">{t('Gesehen')}</th><th className="num">{t('Beantwortet')}</th><th className="num">{t('Abbruch hier')}</th><th className="num">{t('Ø Zeit')}</th></tr>
              </thead>
              <tbody>
                {a.fields.map((x) => (
                  <tr key={x.id}>
                    <td>{x.position}</td>
                    <td>{x.label}</td>
                    <td className="num">{x.views}</td>
                    <td className="num">{x.answered} <span className="muted small">({pct(x.answer_percent)})</span></td>
                    <td className="num">{x.dropoffs ? <Badge tone={x.dropoff_percent >= 25 ? 'red' : x.dropoff_percent >= 10 ? 'yellow' : 'gray'}>{x.dropoffs} ({pct(x.dropoff_percent)})</Badge> : '–'}</td>
                    <td className="num">{x.avg_seconds ? secs(x.avg_seconds) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {a.daily.length > 1 && (
            <>
              <h3>{t('Pro Tag')}</h3>
              <div className="fd-days" role="img" aria-label={t('Aufrufe und Einsendungen pro Tag')}>
                {a.daily.map((x) => (
                  <div key={x.day} title={t('{day}: {opened} Aufrufe, {submitted} Einsendungen', { day: d(x.day), opened: x.opened, submitted: x.submitted })}>
                    <i style={{ height: `${(x.opened / maxDay) * 100}%` }} />
                    <i className="done" style={{ height: `${(x.submitted / maxDay) * 100}%` }} />
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
      <p className="fd-hint">{t('Datenschutzfreundlich gezählt: ohne Cookies und ohne IP-Adresse, mit zufälliger Besuchs-Kennung pro Aufruf. „Do Not Track“ und „Global Privacy Control“ werden respektiert. Aufrufdaten werden nach 180 Tagen gelöscht.')}</p>
    </div>
  );
}

// --- submissions ----------------------------------------------------------------------------------------------------------------

/** Score, ending and payment of one submission, as small badges under the answers. */
export function SubmissionExtras({ meta }: { meta: any }) {
  const t = useT('forms');
  const score = meta?.score;
  const pay = meta?.payment;
  if (!score && !pay) return null;
  return (
    <div className="fd-sub-extra">
      {score?.values && Object.entries(score.values).map(([k, v]) => <Badge key={k} tone="blue">{k === 'score' ? t('Punkte') : k}: {dec(Math.round(Number(v) * 100) / 100)}</Badge>)}
      {score?.ending && <Badge tone="purple">{score.ending}</Badge>}
      {pay && (
        <Badge tone={pay.status === 'paid' ? 'green' : 'yellow'}>
          {pay.status === 'paid' ? t('Bezahlt') : t('Zahlung offen')}: {pay.product} · {amount((pay.amount_cents ?? 0) / 100, pay.currency)}
        </Badge>
      )}
      {meta?.duration_ms ? <span className="muted small">{t('{time} ausgefüllt', { time: secs(meta.duration_ms / 1000) })}</span> : null}
    </div>
  );
}

