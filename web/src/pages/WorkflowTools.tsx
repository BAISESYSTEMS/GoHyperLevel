import './workflow-tools.css';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ICONS, Icon, type IconName } from '../icons';
import { api, currentLocation } from '../api';
import { Badge, Check, Field, Input, Modal, Select, Spinner, TagInput, Textarea } from '../ui';
import { WebinarPicker } from './WebinarKit';
import { tr, useT, type TFn } from '../i18n';
import { splitCatalogFields } from '../areas/marketing-fields';

/**
 * Tools of the workflow editor that are driven by the server's catalogue (GET /api/workflow-catalog): the action picker
 * with categories, search and inline docs, a generic form for every step that has no editor of its own, trigger selection by
 * category with a form for the newer triggers, filters for every trigger, and the condition editor.
 * Docs: docs/workflow-actions.md.
 */

// --- catalogue ------------------------------------------------------------------------------------

export interface FieldDef {
  key: string;
  label: string;
  type: string;
  options?: [string, string][];
  placeholder?: string;
  help?: string;
  required?: boolean;
  default?: unknown;
  showIf?: { field: string; in: string[] };
  rows?: FieldDef[];
  addLabel?: string;
}
export interface ActionMeta {
  type: string;
  label: string;
  category: string;
  icon?: string;
  summary: string;
  doc: string;
  fields: FieldDef[];
  provides?: string[];
  pure?: boolean;
  custom?: boolean;
  keywords?: string;
  needs?: string;
  app?: string;
  sample?: Record<string, unknown>;
  container?: boolean;
}
export interface TriggerMeta {
  type: string;
  label: string;
  category: string;
  summary: string;
  doc: string;
  fields: FieldDef[];
  sample: Record<string, unknown>;
  keywords?: string;
}
export interface Catalog {
  categories: { key: string; label: string }[];
  trigger_categories: { key: string; label: string }[];
  actions: ActionMeta[];
  triggers: TriggerMeta[];
  counts: { actions: number; triggers: number };
  functions?: { name: string; sig: string; doc: string }[];
}
export type ToolStep = { id: string; type: string; [k: string]: any };
export interface ToolCtx {
  pipelines: any[];
  forms: any[];
  calendars: any[];
  workflows: any[];
  customFields: any[];
  tags: string[];
  /** Every step of the workflow, for "Springe zu" fields. */
  steps: { id: string; label: string }[];
}

const cache: { loc: string; promise?: Promise<Catalog> } = { loc: '' };
export function loadCatalog(): Promise<Catalog> {
  const loc = currentLocation();
  if (!cache.promise || cache.loc !== loc) {
    cache.loc = loc;
    cache.promise = api.get<Catalog>('/api/workflow-catalog').catch((e) => {
      cache.promise = undefined;
      throw e;
    });
  }
  return cache.promise;
}
export function useCatalog() {
  const [cat, setCat] = useState<Catalog | undefined>();
  const [error, setError] = useState('');
  useEffect(() => {
    let on = true;
    loadCatalog().then((c) => on && setCat(c), (e) => on && setError((e as Error).message));
    return () => {
      on = false;
    };
  }, []);
  return { cat, error };
}

const remote = new Map<string, Promise<any>>();
/** Lists the pickers need (team, products, groups …), loaded once per sub-account and editor visit. */
export const resetRemoteCache = () => remote.clear();
function useRemote<T = any>(key: string, path: string): T | undefined {
  const k = `${currentLocation()}:${key}`;
  const [data, setData] = useState<T | undefined>();
  useEffect(() => {
    let on = true;
    let p = remote.get(k);
    if (!p) {
      p = api.get(path).catch(() => (key === 'social' ? { channels: [] } : []));
      remote.set(k, p);
    }
    p.then((x) => on && setData(x));
    return () => {
      on = false;
    };
  }, [k, path, key]);
  return data;
}

/** An icon name the web app knows (the server may name one that was renamed). */
export const iconOf = (n?: string): IconName => (n && n in ICONS ? (n as IconName) : 'apps');
const collator = new Intl.Collator('de');

/** Label and icon of a step type: the catalogue first, then the editor's own list. */
export function stepInfo(type: string, cat: Catalog | undefined, builtin: Record<string, [IconName, string]>): [IconName, string] {
  const m = cat?.actions.find((a) => a.type === type);
  if (m) return [iconOf(m.icon ?? builtin[type]?.[0]), m.label];
  return builtin[type] ?? ['apps', type];
}

// --- containers (steps that hold steps) ------------------------------------------------------------

export const BRANCH_KEY = /^(then|else|each|b\d)$/;
export const branchKeysOf = (s: ToolStep): string[] => Object.keys(s).filter((k) => BRANCH_KEY.test(k) && Array.isArray(s[k]));
const letter = (i: number) => String.fromCharCode(65 + i);
export const variantsOf = (s: ToolStep): { name: string; weight: number }[] =>
  (Array.isArray(s.variants) ? s.variants : [])
    .slice(0, 5)
    .map((v: any, i: number) => ({ name: String(v?.name || letter(i)), weight: Number(v?.weight) || 0 }));

/** The lanes a container shows in the builder. */
export function branchesOf(s: ToolStep): { key: string; label: string; tone?: 'yes' | 'no' }[] {
  const t = tr('workflows');
  if (s.type === 'if') return [{ key: 'then', label: t('Ja'), tone: 'yes' }, { key: 'else', label: t('Nein'), tone: 'no' }];
  if (s.type === 'split_test') {
    const v = variantsOf(s);
    const total = v.reduce((a, x) => a + x.weight, 0) || 1;
    return v.map((x, i) => ({ key: `b${i}`, label: `${x.name} · ${Math.round((x.weight / total) * 100)} %` }));
  }
  if (s.type === 'loop') return [{ key: 'each', label: t('Für jedes Element') }];
  return [];
}

/** A new step with the defaults of its form (steps with their own editor keep theirs). */
export function newStepFor(type: string, meta: ActionMeta | undefined, id: string): ToolStep {
  const s: ToolStep = { id, type };
  if (meta && !meta.custom) for (const f of meta.fields) if (f.default !== undefined) s[f.key] = f.default;
  if (type === 'split_test') Object.assign(s, { variants: [{ name: 'A', weight: 50 }, { name: 'B', weight: 50 }], b0: [], b1: [], sticky: true, var_name: 'split' });
  if (type === 'loop') s.each = [];
  return s;
}

const short = (v: unknown, n = 56) => {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** One line under a step in the builder: the name, or its first filled-in settings. */
export function genericSummary(meta: ActionMeta | undefined, s: ToolStep): string {
  if (!meta || meta.custom) return '';
  const t = tr('workflows');
  const parts: string[] = [];
  for (const f of meta.fields) {
    const v = s[f.key];
    if (v === undefined || v === null || v === '' || f.type === 'bool' || f.type === 'conditions') continue;
    if (f.type === 'rows') {
      if (Array.isArray(v) && v.length) parts.push(t.plural(v.length, { one: '{n} Zeile', other: '{n} Zeilen' }));
    } else if (f.type === 'step') {
      parts.push(`→ ${short(v, 10)}`);
    } else if (['select', 'text', 'textarea', 'number', 'code', 'target', 'contact_field', 'time', 'date'].includes(f.type)) {
      const label = f.type === 'select' ? f.options?.find((o) => o[0] === String(v))?.[1] ?? String(v) : String(v);
      parts.push(f.type === 'code' || f.type === 'textarea' || f.type === 'text' ? short(label, 40) : `${f.label}: ${short(label, 24)}`);
    }
    if (parts.length >= 2) break;
  }
  return parts.join(' · ');
}

// --- action picker ---------------------------------------------------------------------------------

const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
/** Search text of an action: its German name and description, the name in the UI language, search words, type and app. */
const hay = (m: ActionMeta, t: TFn) => `${m.label} ${t(m.label)} ${m.summary} ${m.keywords ?? ''} ${m.type} ${m.app ?? ''}`.toLowerCase();

export function ActionPicker({ onPick, onClose, builtin }: { onPick: (type: string) => void; onClose: () => void; builtin: Record<string, [IconName, string]> }) {
  const t = useT('workflows');
  const { cat, error } = useCatalog();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('all');
  const [sel, setSel] = useState('');
  const results = useMemo(() => {
    if (!cat) return [];
    const w = words(q);
    const order = new Map(cat.categories.map((c, i) => [c.key, i] as const));
    return cat.actions
      .filter((m) => (category === 'all' || m.category === category) && w.every((x) => hay(m, t).includes(x)))
      .sort((a, b) => (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99) || collator.compare(t(a.label), t(b.label)));
  }, [cat, q, category, t]);
  useEffect(() => {
    if (!results.some((m) => m.type === sel)) setSel(results[0]?.type ?? '');
  }, [results, sel]);
  const pick = (type: string) => {
    if (!type) return;
    onPick(type);
    onClose();
  };
  const current = results.find((m) => m.type === sel);
  const catLabel = (key: string) => t(cat?.categories.find((c) => c.key === key)?.label ?? key);
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    const w = words(q);
    for (const m of cat?.actions ?? []) if (w.every((x) => hay(m, t).includes(x))) out[m.category] = (out[m.category] ?? 0) + 1;
    return out;
  }, [cat, q, t]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const move = (d: number) => {
    const i = results.findIndex((m) => m.type === sel);
    const next = results[Math.min(results.length - 1, Math.max(0, i + d))];
    if (next) {
      setSel(next.type);
      requestAnimationFrame(() => document.getElementById(`wt-item-${next.type}`)?.scrollIntoView({ block: 'nearest' }));
    }
  };
  return (
    <Modal title={t('Schritt hinzufügen')} onClose={onClose} wide>
      {error && <p className="muted">{t('Der Katalog konnte nicht geladen werden:')} {error}</p>}
      {!cat && !error && <Spinner />}
      {cat && (
        <div className="wt-picker">
          <nav className="wt-cats" data-tour="wf-picker-cats" aria-label={t('Kategorien')}>
            <button className={category === 'all' ? 'on' : ''} onClick={() => setCategory('all')}>
              <span>{t('Alle')}</span>
              <span className="n">{total}</span>
            </button>
            {cat.categories
              .filter((c) => counts[c.key])
              .map((c) => (
                <button key={c.key} className={category === c.key ? 'on' : ''} onClick={() => setCategory(c.key)}>
                  <span>{t(c.label)}</span>
                  <span className="n">{counts[c.key]}</span>
                </button>
              ))}
          </nav>
          <div className="wt-main">
            <div className="wt-search" data-tour="wf-picker-search">
              <input
                autoFocus
                type="search"
                value={q}
                placeholder={t.plural(cat.counts.actions, { other: '{n} Aktionen durchsuchen …' })}
                aria-label={t('Aktion suchen')}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') (e.preventDefault(), move(1));
                  else if (e.key === 'ArrowUp') (e.preventDefault(), move(-1));
                  else if (e.key === 'Enter') (e.preventDefault(), pick(sel));
                }}
              />
            </div>
            <div className="wt-list" data-tour="wf-picker-list" role="listbox" aria-label={t('Aktionen')}>
              {!results.length && <div className="wt-empty">{t('Keine Aktion gefunden. Andere Suchbegriffe oder „Alle“ probieren.')}</div>}
              {results.map((m, i) => (
                <div key={m.type}>
                  {category === 'all' && (i === 0 || results[i - 1].category !== m.category) && <div className="wt-group">{catLabel(m.category)}</div>}
                  <button id={`wt-item-${m.type}`} role="option" aria-selected={m.type === sel} className={`wt-item${m.type === sel ? ' on' : ''}`} onClick={() => setSel(m.type)} onDoubleClick={() => pick(m.type)}>
                    <Icon name={iconOf(m.icon ?? builtin[m.type]?.[0])} />
                    <span>
                      <strong>{t(m.label)}</strong>
                      <small>{m.summary}</small>
                    </span>
                  </button>
                </div>
              ))}
            </div>
          </div>
          <aside className="wt-doc" data-tour="wf-picker-doc" aria-live="polite">
            {current ? <ActionDoc meta={current} catLabel={catLabel(current.category)} onAdd={() => pick(current.type)} /> : <p className="muted">{t('Wähle links eine Aktion – hier steht, was sie tut.')}</p>}
          </aside>
        </div>
      )}
    </Modal>
  );
}

function ActionDoc({ meta, catLabel, onAdd }: { meta: ActionMeta; catLabel: string; onAdd?: () => void }) {
  const t = useT('workflows');
  return (
    <>
      <h4>{t(meta.label)}</h4>
      <div className="row" style={{ gap: 6 }}>
        <Badge>{catLabel}</Badge>
        {meta.app && <Badge tone="purple">{meta.app}</Badge>}
        {meta.pure && <Badge tone="green">{t('Testlauf rechnet echt')}</Badge>}
      </div>
      <p>{meta.summary}</p>
      {meta.doc && meta.doc !== meta.summary && <p className="muted">{meta.doc}</p>}
      {meta.needs && (
        <p>
          <b>{t('Voraussetzung:')}</b> {meta.needs}
        </p>
      )}
      {!!meta.provides?.length && (
        <div>
          <div className="muted small">{t('Danach verfügbar:')}</div>
          <div className="wt-chips">
            {meta.provides.map((p) => (
              <code key={p} className="wt-chip">{`{{${p}}}`}</code>
            ))}
          </div>
        </div>
      )}
      {onAdd && (
        <button className="btn wt-add-btn" data-tour="wf-picker-add" onClick={onAdd}>
          {t('+ Hinzufügen')}
        </button>
      )}
    </>
  );
}

/** What the selected step does – shown above its settings, for every step. */
export function StepDoc({ type, open }: { type: string; open?: boolean }) {
  const t = useT('workflows');
  const { cat } = useCatalog();
  const meta = cat?.actions.find((a) => a.type === type);
  if (!meta || (!meta.summary && !meta.doc)) return null;
  return (
    <details className="wt-form" open={open} data-tour="wf-step-doc" style={{ marginBottom: 10 }}>
      <summary className="muted small" style={{ cursor: 'pointer' }}>
        {meta.summary || t('Was macht dieser Schritt?')}
      </summary>
      <div style={{ marginTop: 6 }}>
        {meta.doc && meta.doc !== meta.summary && <p className="wt-help">{meta.doc}</p>}
        {meta.needs && <div className="wt-needs">{t('Voraussetzung:')} {meta.needs}</div>}
        {!!meta.provides?.length && (
          <div className="wt-chips" style={{ marginBottom: 8 }}>
            {meta.provides.map((p) => (
              <code key={p} className="wt-chip" title={t('Mit diesem Platzhalter in späteren Schritten verwenden')}>{`{{${p}}}`}</code>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

export function StepNameField({ step, set }: { step: ToolStep; set: (p: any) => void }) {
  const t = useT('workflows');
  return (
    <Field label={t('Name im Ablauf (optional)')} hint={t('Erscheint im Ablauf und im Protokoll – hilft bei vielen Schritten.')}>
      <Input value={step.name} onChange={(v) => set({ name: v })} placeholder={t('z. B. Budget prüfen')} maxLength={80} />
    </Field>
  );
}

// --- fields ------------------------------------------------------------------------------------------

const CONTACT_FIELD_LIST: [string, string][] = [
  ['first_name', 'Vorname'],
  ['last_name', 'Nachname'],
  ['email', 'E-Mail'],
  ['phone', 'Telefon'],
  ['company', 'Firma'],
  ['address', 'Adresse'],
  ['city', 'Ort'],
  ['postal_code', 'PLZ'],
  ['country', 'Land'],
  ['website', 'Webseite'],
  ['source', 'Quelle'],
  ['date_of_birth', 'Geburtstag'],
];
const WEEKDAY_LIST: [string, string][] = [['mon', 'Mo'], ['tue', 'Di'], ['wed', 'Mi'], ['thu', 'Do'], ['fri', 'Fr'], ['sat', 'Sa'], ['sun', 'So']];

const contactFieldOptions = (ctx: ToolCtx): [string, string][] => {
  const t = tr('workflows');
  return [...CONTACT_FIELD_LIST.map(([k, l]) => [k, t(l)] as [string, string]), ...ctx.customFields.map((f: any) => [`custom.${f.key}`, t('Feld: {name}', { name: f.label })] as [string, string])];
};

function TargetField({ value, onChange, ctx }: { value: string; onChange: (v: string) => void; ctx: ToolCtx }) {
  const t = useT('workflows');
  const v = String(value ?? '');
  const [mode, setMode] = useState<'var' | 'field'>(!v || v.startsWith('var.') ? 'var' : 'field');
  return (
    <div className="wt-target">
      <Select
        value={mode}
        onChange={(m) => {
          setMode(m as 'var' | 'field');
          onChange('');
        }}
        options={[['var', t('Variable')], ['field', t('Kontaktfeld')]]}
      />
      {mode === 'var' ? (
        <Input value={v.startsWith('var.') ? v.slice(4) : ''} onChange={(x) => onChange(x.trim() ? `var.${x.trim()}` : '')} placeholder={t('ergebnis')} aria-label={t('Name der Variable')} />
      ) : (
        <Select value={v} onChange={onChange} placeholder={t('Feld wählen…')} options={contactFieldOptions(ctx)} />
      )}
    </div>
  );
}

/** A contact field by name: free text (custom.<key> works for every custom field) with the known fields as suggestions. */
function ContactFieldInput({ value, onChange, ctx, placeholder }: { value: string; onChange: (v: string) => void; ctx: ToolCtx; placeholder?: string }) {
  const t = useT('workflows');
  const id = useRef(`wt-fields-${Math.random().toString(36).slice(2, 8)}`).current;
  return (
    <>
      <input list={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? t('Feld wählen oder custom.<schlüssel>')} />
      <datalist id={id}>
        {contactFieldOptions(ctx).map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </datalist>
    </>
  );
}

function TzField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT('workflows');
  const zones = useMemo(() => (typeof Intl !== 'undefined' && (Intl as any).supportedValuesOf ? ((Intl as any).supportedValuesOf('timeZone') as string[]) : ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'UTC']), []);
  return (
    <>
      <Input value={value} onChange={onChange} list="wt-zones" placeholder={t('leer = Zeitzone des Sub-Accounts')} />
      <datalist id="wt-zones">
        {zones.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
    </>
  );
}

/** Help for the expression language: every function with its signature. */
export function ExprHelp() {
  const t = useT('workflows');
  const { cat } = useCatalog();
  const [q, setQ] = useState('');
  const list = (cat?.functions ?? []).filter((f) => !q || `${f.name} ${f.doc}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <details className="wt-expr" data-tour="wf-expr-help">
      <summary className="small" style={{ cursor: 'pointer', color: 'var(--brand-text, var(--brand))' }}>
        {t('Ausdruckssprache: Funktionen und Beispiele')}
      </summary>
      <p className="wt-note">
        {/* i18n-ignore – the <code> examples stay as they are */}
        {t('Zugriff auf')} <code>contact</code>, <code>event</code>, <code>var</code> {t('und')} <code>location</code>. {t('Beispiele:')} <code>contact.custom.budget &gt; 1000 && 'vip' in contact.tags</code> · <code>round(var.netto * 1.19, 2)</code> · <code>`Hallo ${'${contact.first_name}'}`</code>. {t('Mehrzeilig mit')} <code>let</code>, <code>if</code>, <code>for … of</code>, <code>return</code>; <code>var.x = …</code> {t('schreibt eine Variable.')} {t('Kein')} <code>eval</code>
        {t(', keine Netzwerk- oder Dateizugriffe; höchstens 150 ms Rechenzeit.')}
      </p>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Funktion suchen …')} aria-label={t('Funktion suchen')} style={{ width: '100%', marginBottom: 6 }} />
      <div style={{ maxHeight: 180, overflowY: 'auto' }}>
        {list.slice(0, 80).map((f) => (
          <div key={f.name} className="small" style={{ padding: '2px 0' }}>
            <code>{f.sig}</code> <span className="muted">{f.doc}</span>
          </div>
        ))}
        {!list.length && <div className="muted small">{t('Keine Funktion gefunden.')}</div>}
      </div>
    </details>
  );
}

const visible = (f: FieldDef, values: Record<string, any>, all: FieldDef[]) => {
  if (!f.showIf) return true;
  const dep = all.find((x) => x.key === f.showIf!.field);
  const cur = values[f.showIf.field] ?? dep?.default;
  return f.showIf.in.includes(String(cur ?? ''));
};

type RowsHook = (key: string, kind: 'add' | 'remove', index: number, before: any[]) => Record<string, any> | undefined;

function RowsField({ f, value, set, ctx, onRows }: { f: FieldDef; value: any; set: (p: any) => void; ctx: ToolCtx; onRows?: RowsHook }) {
  const t = useT('workflows');
  const rows: any[] = Array.isArray(value) ? value : [];
  const cols = f.rows ?? [];
  const blank = Object.fromEntries(cols.filter((c) => c.default !== undefined).map((c) => [c.key, c.default]));
  return (
    <div className="field">
      <span>{f.label}</span>
      <div className="wt-rows">
        {rows.map((r, i) => (
          <div className="wt-row" key={i}>
            <div className={cols.length === 2 ? 'grid2' : undefined}>
              {cols.filter((c) => visible(c, r ?? {}, cols)).map((c) => (
                <FieldInput key={c.key} f={c} values={r ?? {}} all={cols} set={(p) => set({ [f.key]: rows.map((x, j) => (j === i ? { ...x, ...p } : x)) })} ctx={ctx} />
              ))}
            </div>
            <button type="button" className="icon-btn wt-x" aria-label={t('Zeile entfernen')} onClick={() => set({ [f.key]: rows.filter((_, j) => j !== i), ...(onRows?.(f.key, 'remove', i, rows) ?? {}) })}>
              ✕
            </button>
          </div>
        ))}
      </div>
      <div>
        <button type="button" className="btn small secondary" onClick={() => set({ [f.key]: [...rows, { ...blank }], ...(onRows?.(f.key, 'add', rows.length, rows) ?? {}) })}>
          {f.addLabel ?? t('+ Zeile')}
        </button>
      </div>
      {f.help && <small className="muted">{f.help}</small>}
    </div>
  );
}

function FieldInput({ f, values, set, ctx, all, onRows }: { f: FieldDef; values: Record<string, any>; set: (p: any) => void; ctx: ToolCtx; all: FieldDef[]; onRows?: RowsHook }) {
  const t = useT('workflows');
  const raw = values[f.key];
  const value = raw === undefined ? f.default : raw;
  const one = (v: unknown) => set({ [f.key]: v });
  const label = f.required ? `${f.label} *` : f.label;
  const users = useRemote<any[]>('users', '/api/location-users');
  const products = useRemote<any[]>('products', '/api/products');
  const templates = useRemote<any[]>('contract-templates', '/api/contracts?kind=template');
  const groups = useRemote<any[]>('groups', '/api/community/groups');
  const social = useRemote<{ channels: any[] }>('social', '/api/social');
  const wrap = (child: ReactNode) => (
    <Field label={label} hint={f.help}>
      {child}
    </Field>
  );
  switch (f.type) {
    case 'rows':
      return <RowsField f={f} value={value} set={set} ctx={ctx} onRows={onRows} />;
    case 'bool':
      return (
        <div className="field">
          <Check checked={value === true || value === 'true' || value === 1} onChange={one} label={label} />
          {f.help && <small className="muted">{f.help}</small>}
        </div>
      );
    case 'number':
      return wrap(<Input type="number" value={value as any} onChange={(v) => one(v === '' ? '' : Number(v))} placeholder={f.placeholder} />);
    case 'textarea':
      return wrap(<Textarea value={value as any} onChange={one} rows={3} placeholder={f.placeholder} />);
    case 'code':
      return (
        <>
          {wrap(<Textarea className="wt-code" spellCheck={false} value={value as any} onChange={one} rows={5} placeholder={f.placeholder} />)}
          <ExprHelp />
        </>
      );
    case 'select':
      return wrap(<Select value={value as any} onChange={one} options={f.options ?? []} placeholder={f.options?.some((o) => o[0] === '') ? undefined : '–'} />);
    case 'time':
      return wrap(<Input type="time" value={value as any} onChange={one} />);
    case 'date':
      return wrap(<Input value={value as any} onChange={one} placeholder={f.placeholder ?? t('2026-12-01  ·  {{var.datum}}')} />);
    case 'tz':
      return wrap(<TzField value={String(value ?? '')} onChange={one} />);
    case 'tags':
      return wrap(<TagInput value={Array.isArray(value) ? (value as string[]) : []} onChange={one} suggestions={ctx.tags} />);
    case 'weekdays': {
      const days: string[] = Array.isArray(value) && value.length ? (value as string[]) : ['mon', 'tue', 'wed', 'thu', 'fri'];
      return wrap(
        <div className="wt-days">
          {WEEKDAY_LIST.map(([k, l]) => (
            <Check key={k} checked={days.includes(k)} onChange={(on) => one(on ? [...days, k] : days.filter((d) => d !== k))} label={t(l)} />
          ))}
        </div>,
      );
    }
    case 'conditions':
      return <ConditionsEditor conditions={values[f.key] ?? []} match={values.match} onChange={(p) => set({ ...(p.conditions ? { [f.key]: p.conditions } : {}), ...(p.match ? { match: p.match } : {}) })} customFields={ctx.customFields} label={f.label} hint={f.help} />;
    case 'step':
      return wrap(<Select value={value as any} onChange={one} placeholder={t('Schritt wählen…')} options={ctx.steps.map((s) => [s.id, s.label] as [string, string])} />);
    case 'target':
      return wrap(<TargetField value={String(value ?? '')} onChange={one} ctx={ctx} />);
    case 'contact_field':
      return wrap(<ContactFieldInput value={String(value ?? '')} onChange={one} ctx={ctx} placeholder={f.placeholder} />);
    case 'workflow':
      return wrap(<Select value={value as any} onChange={one} placeholder={t('Workflow wählen…')} options={ctx.workflows.map((w: any) => [w.id, w.name] as [string, string])} />);
    case 'pipeline':
      return wrap(<Select value={value as any} onChange={(v) => set({ [f.key]: v, ...(all.some((x) => x.type === 'stage') ? { stage_id: '' } : {}) })} placeholder="–" options={ctx.pipelines.map((p: any) => [p.id, p.name] as [string, string])} />);
    case 'stage': {
      const pipe = ctx.pipelines.find((p: any) => p.id === values.pipeline_id);
      const stages: [string, string][] = pipe ? pipe.stages.map((s: any) => [s.id, s.name]) : ctx.pipelines.flatMap((p: any) => p.stages.map((s: any) => [s.id, `${p.name} › ${s.name}`] as [string, string]));
      return wrap(<Select value={value as any} onChange={one} placeholder="–" options={stages} />);
    }
    case 'calendar':
      return wrap(<Select value={value as any} onChange={one} placeholder={t('jeder Kalender')} options={ctx.calendars.map((c: any) => [c.id, c.name] as [string, string])} />);
    case 'form':
      return wrap(<Select value={value as any} onChange={one} placeholder={t('jedes Formular')} options={ctx.forms.map((c: any) => [c.id, c.name] as [string, string])} />);
    case 'user':
      return wrap(<Select value={value as any} onChange={one} placeholder="–" options={(users ?? []).map((u) => [u.id, u.name || u.email] as [string, string])} />);
    case 'users': {
      const ids: string[] = Array.isArray(value) ? (value as string[]) : [];
      return wrap(
        <div className="wt-days">
          {(users ?? []).map((u) => (
            <Check key={u.id} checked={ids.includes(u.id)} onChange={(on) => one(on ? [...ids, u.id] : ids.filter((x) => x !== u.id))} label={u.name || u.email} />
          ))}
          {users && !users.length && <span className="muted">{t('Keine Teammitglieder gefunden.')}</span>}
        </div>,
      );
    }
    case 'group':
      return wrap(<Select value={value as any} onChange={one} placeholder={t('Gruppe wählen…')} options={(groups ?? []).map((g) => [g.id, g.name] as [string, string])} />);
    case 'webinar':
      return wrap(<WebinarPicker value={String(value ?? '')} onChange={one} placeholder={f.required ? t('Webinar wählen…') : t('jedes Webinar')} />);
    case 'product':
      return wrap(<Select value={value as any} onChange={one} placeholder={t('Produkt wählen…')} options={(products ?? []).map((p) => [p.id, p.name] as [string, string])} />);
    case 'contract_template':
      return wrap(<Select value={value as any} onChange={one} placeholder={t('Vorlage wählen…')} options={(templates ?? []).map((x) => [x.id, x.title || x.id] as [string, string])} />);
    case 'social_channels': {
      const ids: string[] = Array.isArray(value) ? (value as string[]) : [];
      const channels = (social?.channels ?? []).filter((c: any) => c.supported !== false);
      return wrap(
        <div className="wt-days">
          {channels.map((c: any) => (
            <Check key={c.id} checked={ids.includes(c.id)} onChange={(on) => one(on ? [...ids, c.id] : ids.filter((x) => x !== c.id))} label={`${c.name} (${c.label})`} />
          ))}
          {social && !channels.length && <span className="muted">{t('Erst im Social Planner einen Kanal verbinden.')}</span>}
        </div>,
      );
    }
    default:
      return wrap(<Input value={value as any} onChange={one} placeholder={f.placeholder} />);
  }
}

/** A form for a list of fields (steps, triggers): shows a field only while its `showIf` holds. `all` = every field of the form when `fields` is a part of it. */
export function FieldsForm({ fields, values, set, ctx, onRows, all = fields }: { fields: FieldDef[]; values: Record<string, any>; set: (patch: any) => void; ctx: ToolCtx; onRows?: RowsHook; all?: FieldDef[] }) {
  return (
    <>
      {fields.filter((f) => visible(f, values, all)).map((f) => (
        <FieldInput key={f.key} f={f} values={values} all={all} set={set} ctx={ctx} onRows={onRows} />
      ))}
    </>
  );
}

/**
 * The settings form of a step that has no editor of its own: built from the catalogue. `part` (Einfach-Modus): "main" = the
 * everyday fields, "more" = the folded rest (web/src/areas/marketing-fields.ts → splitCatalogFields); "all" = everything.
 */
export function GenericStepConfig({ step, set, ctx, part = 'all' }: { step: ToolStep; set: (p: any) => void; ctx: ToolCtx; part?: 'all' | 'main' | 'more' }) {
  const t = useT('workflows');
  const { cat, error } = useCatalog();
  const meta = cat?.actions.find((a) => a.type === step.type);
  if (part === 'more') {
    const more = meta && !meta.custom ? splitCatalogFields(meta.fields).more : [];
    return more.length ? (
      <div className="wt-form">
        <FieldsForm fields={more} all={meta!.fields} values={step} set={set} ctx={ctx} />
      </div>
    ) : null;
  }
  if (error) return <p className="muted">{t('Der Katalog konnte nicht geladen werden:')} {error}</p>;
  if (!cat) return <Spinner />;
  if (!meta || meta.custom || !meta.fields.length) return <p className="muted">{t('Keine Einstellungen.')}</p>;
  const fields = part === 'main' ? splitCatalogFields(meta.fields).main : meta.fields;
  /** Split test: removing or adding a path moves the steps of the paths behind it with it. */
  const onRows: RowsHook | undefined =
    step.type === 'split_test'
      ? (key, kind, index, before) => {
          if (key !== 'variants') return undefined;
          const patch: Record<string, any> = {};
          if (kind === 'remove') {
            for (let j = index; j < before.length; j++) patch[`b${j}`] = j + 1 < before.length ? step[`b${j + 1}`] ?? [] : undefined;
          } else patch[`b${index}`] = step[`b${index}`] ?? [];
          return patch;
        }
      : undefined;
  return (
    <div className="wt-form">
      <FieldsForm fields={fields} all={meta.fields} values={step} set={set} ctx={ctx} onRows={onRows} />
      {meta.sample && (
        <div className="wt-sample">
          <button type="button" className="btn small secondary" data-tour="wf-sample" onClick={() => set(JSON.parse(JSON.stringify(meta.sample)))}>
            {t('Beispiel einfügen')}
          </button>
          <span className="muted small">{t('füllt die Felder mit einem Beispiel')}</span>
        </div>
      )}
    </div>
  );
}

// --- conditions ---------------------------------------------------------------------------------------

/** German labels (message ids of the workflows catalog); shown through t(). */
export const OPS_ALL: [string, string][] = [
  ['has', 'hat / enthält'],
  ['not_has', 'hat nicht'],
  ['equals', 'ist gleich'],
  ['not_equals', 'ist nicht'],
  ['contains', 'enthält'],
  ['starts_with', 'beginnt mit'],
  ['ends_with', 'endet mit'],
  ['in', 'ist eines von'],
  ['not_in', 'ist keines von'],
  ['empty', 'ist leer'],
  ['not_empty', 'ist nicht leer'],
  ['gt', 'größer als'],
  ['gte', 'mindestens'],
  ['lt', 'kleiner als'],
  ['lte', 'höchstens'],
  ['between', 'zwischen'],
  ['regex', 'passt auf Muster'],
  ['date_before', 'Datum vor'],
  ['date_after', 'Datum nach'],
];
const OP_HINT: Record<string, string> = { between: '10, 20', in: 'a, b, c', not_in: 'a, b, c', date_before: 'now oder 2026-12-01', date_after: 'now oder 2026-12-01', regex: '^\\d{5}$' };
const BASE_FIELDS = ['tag', 'email', 'phone', 'first_name', 'last_name', 'company', 'city', 'source', 'dnd'];

/** Conditions with all operators, a free field name (contact, custom field, `var.x`, `event.x`) and suggestions. */
export function ConditionsEditor({
  conditions,
  match,
  onChange,
  customFields,
  label,
  hint,
  suggestions = [],
}: {
  conditions: any[];
  match?: string;
  onChange: (p: { conditions?: any[]; match?: string }) => void;
  customFields: any[];
  label?: string;
  hint?: ReactNode;
  suggestions?: string[];
}) {
  const t = useT('workflows');
  const conds = Array.isArray(conditions) ? conditions : [];
  const id = useRef(`wt-cf-${Math.random().toString(36).slice(2, 8)}`).current;
  const known = [...BASE_FIELDS, ...customFields.map((f: any) => `contact.custom.${f.key}`), 'var.', 'event.', ...suggestions];
  const patch = (i: number, p: any) => onChange({ conditions: conds.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  return (
    <div data-tour="wf-conditions">
      <Field label={label ?? t('Bedingung erfüllt, wenn')} hint={hint}>
        <Select value={match ?? 'all'} onChange={(v) => onChange({ match: v })} options={[['all', t('alle zutreffen')], ['any', t('eine zutrifft')]]} />
      </Field>
      {conds.map((c, i) => {
        const noValue = ['empty', 'not_empty'].includes(c.op);
        return (
          <div key={i} className={`wt-cond${noValue ? ' no-value' : ''}`}>
            <input list={id} value={c.field ?? ''} onChange={(e) => patch(i, { field: e.target.value })} placeholder={t('Feld, z. B. tag, var.summe')} aria-label={t('Feld')} />
            <Select value={c.op} onChange={(v) => patch(i, { op: v })} options={OPS_ALL.map(([k, l]) => [k, t(l)] as [string, string])} />
            {!noValue && <Input value={c.value} onChange={(v) => patch(i, { value: v })} placeholder={OP_HINT[c.op] ? t(OP_HINT[c.op]) : t('Wert')} aria-label={t('Wert')} />}
            <button type="button" className="icon-btn" aria-label={t('Bedingung entfernen')} onClick={() => onChange({ conditions: conds.filter((_, j) => j !== i) })}>
              ✕
            </button>
          </div>
        );
      })}
      <datalist id={id}>
        {known.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
      <button type="button" className="btn small secondary" onClick={() => onChange({ conditions: [...conds, { field: 'tag', op: 'has', value: '' }] })}>
        {t('+ Bedingung')}
      </button>
    </div>
  );
}

// --- triggers -------------------------------------------------------------------------------------------

/** Trigger choice grouped by category (the catalogue has all of them; `labels` covers the time before it has loaded). */
export function TriggerSelect({ value, onChange, labels }: { value: string; onChange: (v: string) => void; labels: Record<string, string> }) {
  const t = useT('workflows');
  const { cat } = useCatalog();
  const groups = useMemo(() => {
    if (!cat) return [];
    return cat.trigger_categories
      .map((c) => ({ ...c, items: cat.triggers.filter((m) => m.category === c.key).sort((a, b) => collator.compare(t(labelOf(a, labels)), t(labelOf(b, labels)))) }))
      .filter((g) => g.items.length);
  }, [cat, labels, t]);
  if (!cat) return <Select value={value} onChange={onChange} options={Object.entries(labels).map(([k, l]) => [k, t(l)] as [string, string])} />;
  return (
    <select className="wt-trigger-select" value={value} onChange={(e) => onChange(e.target.value)} data-tour="wf-trigger-select" aria-label={t('Auslöser')}>
      {groups.map((g) => (
        <optgroup key={g.key} label={t(g.label)}>
          {g.items.map((m) => (
            <option key={m.type} value={m.type}>
              {t(labelOf(m, labels))}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
const labelOf = (m: TriggerMeta, labels: Record<string, string>) => labels[m.type] ?? m.label;

/** The label of a trigger for lists and headings (in the UI language). */
export function useTriggerLabel(labels: Record<string, string>) {
  const t = useT('workflows');
  const { cat } = useCatalog();
  return (type?: string) => (type ? t(labels[type] ?? cat?.triggers.find((m) => m.type === type)?.label ?? type) : '');
}

/** What a trigger is, what data it brings ({{event.…}}) and – for the newer triggers – its settings. */
export function TriggerDoc({ type, config, setC, ctx }: { type: string; config: Record<string, any>; setC: (p: any) => void; ctx: ToolCtx }) {
  const t = useT('workflows');
  const { cat } = useCatalog();
  const meta = cat?.triggers.find((m) => m.type === type);
  if (!meta) return null;
  const keys = Object.keys(meta.sample ?? {}).filter((k) => k !== 'contact').slice(0, 14);
  return (
    <div className="wt-form" data-tour="wf-trigger-doc">
      {/* one line in view; the full description and the data it brings behind one toggle */}
      {meta.summary && <p className="wt-help">{meta.summary}</p>}
      {(!!keys.length || (!!meta.doc && meta.doc !== meta.summary)) && (
        <details style={{ marginBottom: 10 }}>
          <summary className="muted small" style={{ cursor: 'pointer' }}>
            {t('Mehr zum Auslöser und seinen Daten')}
          </summary>
          {meta.doc && meta.doc !== meta.summary && (
            <p className="wt-help" style={{ marginTop: 6 }}>
              {meta.doc}
            </p>
          )}
          {!!keys.length && (
            <div className="wt-chips" style={{ marginTop: 6 }}>
              {keys.map((k) => (
                <code key={k} className="wt-chip" title={short(JSON.stringify(meta.sample[k]), 80)}>{`{{event.${k}}}`}</code>
              ))}
            </div>
          )}
        </details>
      )}
      {!!meta.fields.length && <FieldsForm fields={meta.fields} values={config} set={setC} ctx={ctx} />}
    </div>
  );
}

/** Extra filters every trigger accepts: field checks on the event and the contact, and an expression. */
export function TriggerFilters({ type, config, setC, customFields }: { type: string; config: Record<string, any>; setC: (p: any) => void; customFields: any[] }) {
  const t = useT('workflows');
  const { cat } = useCatalog();
  const meta = cat?.triggers.find((m) => m.type === type);
  const sample = Object.keys(meta?.sample ?? {}).filter((k) => k !== 'contact').map((k) => `event.${k}`);
  const filters: any[] = Array.isArray(config.filters) ? config.filters : [];
  const active = filters.length > 0 || !!String(config.filter_expression ?? '').trim();
  return (
    <details className="wt-filter-box" open={active} data-tour="wf-trigger-filters">
      <summary>{active ? t('Zusätzliche Filter (aktiv)') : t('Zusätzliche Filter')}</summary>
      <p className="wt-note">
        {t('Der Workflow startet nur, wenn diese Bedingungen zutreffen – zusätzlich zu den Einstellungen oben.')} {t('Felder des Ereignisses heißen')} <code>event.…</code>, {t('die des Kontakts z. B.')} <code>tag</code> {t('oder')} <code>contact.custom.budget</code>.
      </p>
      <ConditionsEditor conditions={filters} match={config.filters_match} onChange={(p) => setC({ ...(p.conditions ? { filters: p.conditions } : {}), ...(p.match ? { filters_match: p.match } : {}) })} customFields={customFields} label={t('Filter gelten, wenn')} suggestions={sample} />
      <Field label={t('Oder ein Ausdruck (optional)')} hint={t('Wahr/falsch; z. B. event.amount > 100 && contact.city == \'Köln\'')}>
        <Textarea className="wt-code" spellCheck={false} value={config.filter_expression} onChange={(v) => setC({ filter_expression: v })} rows={2} />
      </Field>
      <ExprHelp />
    </details>
  );
}
