import { useState } from 'react';
import { api, money } from '../api';
import { Badge, Check, Empty, Field, Input, Modal, Select, Spinner, act, navigate, useLoad } from '../ui';
import { ImagePicker } from './ContentKit';
import './FormsDepth.css';
import { tr, useT } from '../i18n';

/** Formulare: Optionen je Feldtyp (Sterne, Skala, Bildauswahl, Punkte, Zahlung, Rechner), Sprünge und die Vorlagen-Galerie. Server: services/form-fields.ts, form-logic.ts. */

const SCORABLE = ['select', 'radio', 'checkbox', 'picture_choice'];
const NUMERIC = ['number', 'rating', 'nps', 'scale'];
const ASKED = (t: string) => !['heading', 'page_break', 'hidden', 'calculator'].includes(t);

// German labels (message ids of the forms catalog), shown through t()
export const RULE_OPS: [string, string][] = [
  ['eq', 'ist'],
  ['neq', 'ist nicht'],
  ['contains', 'enthält'],
  ['gt', 'ist größer als'],
  ['gte', 'ist mindestens'],
  ['lt', 'ist kleiner als'],
  ['lte', 'ist höchstens'],
  ['filled', 'ist ausgefüllt'],
  ['empty', 'ist leer'],
];
const NO_VALUE = ['filled', 'empty'];

/** Options of one field that depend on its type. `setField` merges a patch into the field. */
const varName = (name: string) => {
  const v = String(name ?? '').replace(/[^A-Za-z0-9_]/g, '_');
  return /^[0-9]/.test(v) ? `_${v}` : v;
};

export function FieldOptions({ field, setField, capabilities, fields = [], variables = [] }: { field: any; setField: (p: any) => void; capabilities?: { stripe?: boolean }; fields?: any[]; variables?: { name: string }[] }) {
  const t = useT('forms');
  const products = useLoad(() => (field.type === 'payment' ? api.get<any[]>('/api/products') : Promise.resolve([])), [field.type]);
  const ty: string = field.type;
  const options: string[] = (field.options ?? []).map((o: string) => o).filter((o: string) => o.trim());
  const [open, setOpen] = useState(false);
  return (
    <div className="fd">
      {ASKED(ty) && (
        <Field label={t('Hinweis unter der Frage (optional)')}>
          <Input value={field.hint} onChange={(v) => setField({ hint: v })} maxLength={300} />
        </Field>
      )}
      {ty === 'rating' && (
        <Field label={t('Anzahl Sterne')}>
          <Select value={String(field.max ?? 5)} onChange={(v) => setField({ max: Number(v) })} options={[3, 4, 5, 6, 7, 8, 9, 10].map((n) => [String(n), t.plural(n, { other: '{n} Sterne' })] as [string, string])} />
        </Field>
      )}
      {ty === 'nps' && <p className="fd-hint">{t('Skala von 0 („überhaupt nicht wahrscheinlich“) bis 10. In der Auswertung zählen 9–10 als Promotoren, 0–6 als Kritiker.')}</p>}
      {(ty === 'scale' || ty === 'nps') && (
        <div className="grid2">
          <Field label={t('Beschriftung links')}>
            <Input value={field.labels?.[0]} onChange={(v) => setField({ labels: [v, field.labels?.[1] ?? ''] })} placeholder={ty === 'nps' ? t('Unwahrscheinlich') : t('trifft nicht zu')} maxLength={60} />
          </Field>
          <Field label={t('Beschriftung rechts')}>
            <Input value={field.labels?.[1]} onChange={(v) => setField({ labels: [field.labels?.[0] ?? '', v] })} placeholder={ty === 'nps' ? t('Sehr wahrscheinlich') : t('trifft zu')} maxLength={60} />
          </Field>
        </div>
      )}
      {ty === 'scale' && (
        <>
          <div className="grid3">
            <Field label={t('Von')}>
              <Input type="number" value={field.min ?? 1} onChange={(v) => setField({ min: Number(v) })} />
            </Field>
            <Field label={t('Bis')}>
              <Input type="number" value={field.max ?? 10} onChange={(v) => setField({ max: Number(v) })} />
            </Field>
            <Field label={t('Schrittweite')}>
              <Input type="number" min={1} value={field.step ?? 1} onChange={(v) => setField({ step: Math.max(1, Number(v) || 1) })} />
            </Field>
          </div>
          <Field label={t('Darstellung')}>
            <Select value={field.style ?? 'buttons'} onChange={(v) => setField({ style: v })} options={[['buttons', t('Zahlenreihe zum Antippen')], ['slider', t('Schieberegler')]]} />
          </Field>
        </>
      )}
      {ty === 'number' && (
        <div className="grid2">
          <Field label={t('Mindestwert (optional)')}>
            <Input type="number" value={field.min ?? ''} onChange={(v) => setField({ min: v === '' ? undefined : Number(v) })} />
          </Field>
          <Field label={t('Höchstwert (optional)')}>
            <Input type="number" value={field.max ?? ''} onChange={(v) => setField({ max: v === '' ? undefined : Number(v) })} />
          </Field>
        </div>
      )}
      {ty === 'picture_choice' && (
        <>
          <Check checked={!!field.multiple} onChange={(v) => setField({ multiple: v })} label={t('Mehrere Bilder wählbar')} />
          {options.length ? (
            <Field label={t('Bild je Option')} hint={t('Die Optionen stehen oben (eine pro Zeile). Bilder: https://-Adresse oder hochgeladen.')}>
              <div className="fd-rows">
                {options.map((o, i) => (
                  <div key={`${i}-${o}`} className="fd-row">
                    <b className="fd-opt">{o}</b>
                    <ImagePicker value={field.images?.[i] ?? ''} onChange={(v) => setField({ images: options.map((_x, k) => (k === i ? v : field.images?.[k] ?? '')) })} />
                  </div>
                ))}
              </div>
            </Field>
          ) : (
            <p className="fd-hint">{t('Trage oben die Optionen ein, danach kannst du jedem ein Bild geben.')}</p>
          )}
        </>
      )}
      {ty === 'ranking' && <p className="fd-hint">{t('Besucher ziehen die Optionen (oben, eine pro Zeile) in ihre Reihenfolge – oder verschieben sie mit den Pfeiltasten.')}</p>}
      {ty === 'signature' && <p className="fd-hint">{t('Gezeichnete Unterschrift als Bild (PNG, bis 200 KB). Du siehst sie bei der Einsendung.')}</p>}
      {ty === 'date_range' && <p className="fd-hint">{t('Zwei Daten: Von und Bis. Für Formeln zählt die Anzahl der Tage (inklusive beider Tage).')}</p>}
      {ty === 'payment' && (
        <>
          <Field label={t('Produkt, das bezahlt wird')} hint={t('Produkte legst du unter Umsatz → Produkte an. Nach dem Absenden geht es auf die Stripe-Bezahlseite.')}>
            <Select value={field.product_id} onChange={(v) => setField({ product_id: v })} placeholder={t('– Produkt wählen –')} options={(products.data ?? []).map((p) => [p.id, `${p.name} · ${money(p.price_cents, p.currency)}${p.recurring ? ' / ' + (p.recurring === 'month' ? t('Monat') : t('Jahr')) : ''}`])} />
          </Field>
          {!capabilities?.stripe && <div className="fd-note">{t('Stripe ist noch nicht verbunden (Einstellungen → Stripe). Bis dahin wird die Einsendung gespeichert, aber nichts bezahlt.')}</div>}
          {!field.product_id && <div className="fd-note">{t('Ohne Produkt weiß das Formular nicht, was bezahlt werden soll.')}</div>}
        </>
      )}
      {ty === 'calculator' && (
        <>
          <Field label={t('Formel')} hint={t('Rechnet mit den Feld-Schlüsseln der anderen Fragen (die Knöpfe unten fügen sie ein), z. B. menge * 12,5 – oder mit den Variablen unter „Punkte & Ergebnis“.')}>
            <Input value={field.formula} onChange={(v) => setField({ formula: v })} placeholder={t('menge * preis * 1.19')} maxLength={300} />
          </Field>
          <div className="fd-chips" role="group" aria-label={t('Verfügbare Werte')} style={{ marginBottom: 8 }}>
            {[
              ...fields.filter((x) => x.id !== field.id && ['number', 'rating', 'nps', 'scale', 'select', 'radio', 'checkbox', 'picture_choice', 'date_range', 'calculator'].includes(x.type)).map((x) => ({ key: varName(x.name), label: x.label || x.name })),
              { key: 'score', label: t('Punktestand') },
              ...variables.filter((v) => v.name).map((v) => ({ key: v.name, label: `Variable ${v.name}` })),
            ].map((c) => (
              <button type="button" key={c.key} className="fd-chip" title={c.label} onClick={() => setField({ formula: `${field.formula ?? ''}${field.formula && !/[\s(]$/.test(field.formula) ? ' ' : ''}${c.key}` })}>
                {c.key}
              </button>
            ))}
          </div>
          <Field label={t('Anzeige')}>
            <Select value={field.format ?? 'number'} onChange={(v) => setField({ format: v })} options={[['number', t('Zahl')], ['currency', t('Euro-Betrag')], ['percent', t('Prozent')]]} />
          </Field>
          <p className="fd-hint">
            {/* i18n-ignore – the <code> operators stay as they are */}
            {t('Rechenarten + − * / %, Klammern, Vergleiche (')}<code>==</code> <code>&lt;</code> <code>&gt;=</code> …), <code>&amp;&amp;</code> <code>||</code>, <code>{t('wenn ? dann : sonst')}</code> {t('sowie min, max, sum, avg, round, floor, ceil, abs, sqrt, pow und if(Bedingung, dann, sonst). Dezimalzahlen mit Punkt oder Komma; Argumente von Funktionen mit „, “ (Komma und Leerzeichen) trennen.')} <code>score</code> {t('ist der Punktestand. Das Ergebnis zeigt sich live unter der Frage.')}
          </p>
        </>
      )}
      {(SCORABLE.includes(ty) || NUMERIC.includes(ty)) && (
        <details className="fd-score" open={open || !!field.points || field.weight !== undefined} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
          <summary>{t('Punkte für die Auswertung')}</summary>
          {SCORABLE.includes(ty) &&
            (options.length ? (
              <div className="fd-rows">
                {options.map((o) => (
                  <div key={o} className="fd-row">
                    <span className="fd-opt">{o}</span>
                    <input
                      type="number"
                      aria-label={t('Punkte für {option}', { option: o })}
                      value={field.points?.[o] ?? ''}
                      placeholder="0"
                      onChange={(e) => {
                        const next = { ...(field.points ?? {}) };
                        if (e.target.value === '' || Number(e.target.value) === 0) delete next[o];
                        else next[o] = Number(e.target.value);
                        setField({ points: Object.keys(next).length ? next : undefined });
                      }}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <p className="fd-hint">{t('Erst Optionen eintragen.')}</p>
            ))}
          {NUMERIC.includes(ty) && (
            <Field label={t('Gewicht der Zahl im Punktestand')} hint={t('Antwort × Gewicht wird zu den Punkten addiert. Leer: zählt nicht.')}>
              <Input type="number" value={field.weight ?? ''} onChange={(v) => setField({ weight: v === '' ? undefined : Number(v) })} placeholder={t('zählt nicht')} />
            </Field>
          )}
          <p className="fd-hint">{t('Der Punktestand heißt in Formeln und Ergebnissen')} <code>score</code>.</p>
        </details>
      )}
    </div>
  );
}

// --- logic jumps ------------------------------------------------------------------------------------------------------

/** Where a jump from the field at `index` may go: later questions (one-question mode) or later pages (classic), or the end. */
function targets(fields: any[], index: number, mode: string): [string, string][] {
  const t = tr('forms');
  const out: [string, string][] = [];
  if (mode === 'typeform') {
    for (const f of fields.slice(index + 1)) if (!['heading', 'page_break', 'hidden'].includes(f.type)) out.push([f.id, f.label || f.name]);
  } else {
    // Pages as the server numbers them: the non-empty stretches between page breaks, counted from 1.
    const pages: { first: string }[][] = [[]];
    let mine = 0;
    fields.forEach((f, i) => {
      if (f.type === 'page_break') pages.push([]);
      else pages[pages.length - 1].push({ first: f.label || f.name });
      if (i === index) mine = pages.length - 1;
    });
    let n = 0;
    pages.forEach((p, k) => {
      if (!p.length) return;
      n++;
      if (k > mine) out.push([`page:${n}`, t('Seite {n}: {first}', { n, first: p[0].first })]);
    });
  }
  out.push(['end', t('Ende (Abschicken)')]);
  return out;
}

export function JumpsEditor({ field, index, fields, mode, onChange }: { field: any; index: number; fields: any[]; mode: string; onChange: (jumps: any[]) => void }) {
  const t = useT('forms');
  if (['heading', 'page_break', 'hidden', 'calculator', 'payment', 'file', 'signature'].includes(field.type)) return null;
  const jumps: any[] = field.jumps ?? [];
  const opts = targets(fields, index, mode);
  const set = (i: number, patch: any) => onChange(jumps.map((j, k) => (k === i ? { ...j, ...patch } : j)));
  const choices: string[] = (field.options ?? []).filter((o: string) => o.trim());
  return (
    <div className="fd" data-tour="form-jumps">
      <div className="fd-title">{t('Sprünge (Logik)')}</div>
      {!jumps.length && <p className="fd-hint">{t('Ohne Sprung geht es zur nächsten Frage. Mit einem Sprung führt eine Antwort direkt zu einer späteren Frage – oder ans Ende.')}</p>}
      {jumps.map((j, i) => (
        <div key={i} className="fd-jump">
          <span>{t('Wenn die Antwort')}</span>
          <Select value={j.op} onChange={(v) => set(i, { op: v })} options={RULE_OPS.map(([k, l]) => [k, t(l)] as [string, string])} />
          {!NO_VALUE.includes(j.op) && (choices.length ? <Select value={j.value} onChange={(v) => set(i, { value: v })} placeholder={t('– Wert –')} options={choices} /> : <Input value={j.value} onChange={(v) => set(i, { value: v })} placeholder={t('Wert')} />)}
          <span>{t('dann weiter zu')}</span>
          <Select value={j.goto} onChange={(v) => set(i, { goto: v })} options={opts} />
          <button type="button" className="icon-btn" aria-label={t('Sprung entfernen')} onClick={() => onChange(jumps.filter((_x, k) => k !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="btn small secondary" disabled={opts.length < 1} onClick={() => onChange([...jumps, { op: 'eq', value: choices[0] ?? '', goto: opts[0][0] }])}>
        {t('+ Sprung')}
      </button>
      {mode !== 'typeform' && <p className="fd-hint">{t('Im klassischen Layout springst du von Seite zu Seite (Seitenumbruch zwischen den Fragen). Für Sprünge von Frage zu Frage das Layout „Eine Frage nach der anderen“ wählen.')}</p>}
    </div>
  );
}

// --- template gallery -----------------------------------------------------------------------------------------------------

type Card = { id: string; name: string; category: string; description: string; kind: string; mode: string; needs_product: boolean; fields: number; features: string[] };

export function TemplateGallery({ onClose }: { onClose: () => void }) {
  const t = useT('forms');
  const list = useLoad(() => api.get<{ categories: string[]; templates: Card[] }>('/api/forms/templates'), []);
  const products = useLoad(() => api.get<any[]>('/api/products').catch(() => []), []);
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const [pick, setPick] = useState<Card | null>(null);
  const [product, setProduct] = useState('');
  const [busy, setBusy] = useState(false);
  const use = async (c: Card) => {
    setBusy(true);
    const r = await act(() => api.post<{ id: string }>(`/api/forms/templates/${c.id}/use`, c.needs_product ? { product_id: product } : {}), t('Formular aus Vorlage angelegt'));
    setBusy(false);
    if (r) (onClose(), navigate(`forms/${r.id}`));
  };
  const rows = (list.data?.templates ?? []).filter((c) => (!cat || c.category === cat) && (!q.trim() || `${c.name} ${c.description} ${c.category} ${t(c.category)}`.toLowerCase().includes(q.trim().toLowerCase())));
  return (
    <Modal title={t('Formular-Vorlagen')} onClose={onClose} wide>
      <div className="fd">
        <div className="fd-bar">
          <div className="grow" style={{ minWidth: 180 }}>
            <Input value={q} onChange={setQ} placeholder={t('Vorlage suchen …')} aria-label={t('Vorlage suchen')} autoFocus />
          </div>
        </div>
        <div className="fd-chips" role="group" aria-label={t('Kategorie')}>
          <button type="button" className={`fd-chip${!cat ? ' on' : ''}`} onClick={() => setCat('')}>
            {t('Alle')}
          </button>
          {(list.data?.categories ?? []).map((c) => (
            <button type="button" key={c} className={`fd-chip${cat === c ? ' on' : ''}`} onClick={() => setCat(c)}>
              {t(c)}
            </button>
          ))}
        </div>
        {!list.data ? (
          <Spinner />
        ) : !rows.length ? (
          <Empty>{t('Keine passende Vorlage.')}</Empty>
        ) : (
          <div className="fd-grid">
            {rows.map((c) => (
              <div key={c.id} className="fd-card">
                <div className="fd-card-head">
                  <h3>{c.name}</h3>
                  <Badge tone={c.mode === 'typeform' ? 'purple' : 'gray'}>{c.mode === 'typeform' ? t('Frage für Frage') : t('Klassisch')}</Badge>
                </div>
                <p className="muted small">{c.description}</p>
                <div className="fd-feat">
                  <Badge>{t.plural(c.fields, { other: '{n} Felder' })}</Badge>
                  {c.features.map((f) => (
                    <Badge key={f} tone="blue">
                      {t(f)}
                    </Badge>
                  ))}
                </div>
                <button className="btn small" style={{ marginTop: 'auto' }} onClick={() => (c.needs_product ? (setPick(c), setProduct('')) : void use(c))} disabled={busy}>
                  {t('Vorlage verwenden')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {pick && (
        <Modal title={t('{name}: Produkt wählen', { name: pick.name })} onClose={() => setPick(null)}>
          <p className="muted" style={{ marginTop: 0 }}>
            {t('Diese Vorlage enthält ein Zahlungsfeld. Welches Produkt soll bezahlt werden?')}
          </p>
          {products.data?.length ? (
            <Select value={product} onChange={setProduct} placeholder={t('– Produkt wählen –')} options={products.data.map((p) => [p.id, `${p.name} · ${money(p.price_cents, p.currency)}`])} />
          ) : (
            <p className="muted small">{t('Lege zuerst unter Umsatz → Produkte ein Produkt an.')}</p>
          )}
          <div className="actions" style={{ marginTop: 12 }}>
            <button className="btn" disabled={!product || busy} onClick={() => void use(pick)}>
              {t('Formular anlegen')}
            </button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}

