import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { Check, Field, Input, Select, Textarea, useFocusLayer } from '../ui';
import { widgetIcon } from './WidgetCard';
import type { FieldDef, Widget, WidgetType } from './types';

/**
 * The settings panel of one widget, drawn from the widget type's declared fields – so a module's widget gets its panel
 * without any browser code. Opens at the side, closes with ✕ or Esc, saves as one board version.
 */

type Values = Record<string, any>;
const empty = (f: FieldDef): unknown => f.default ?? (f.type === 'bool' ? false : f.type === 'multi' || f.type === 'list' ? [] : f.type === 'number' || f.type === 'json' ? null : '');
const initial = (fields: FieldDef[], config: Values): Values => Object.fromEntries(fields.map((f) => [f.key, config[f.key] === undefined ? empty(f) : config[f.key]]));
const visible = (f: FieldDef, v: Values) => !f.hidden && (!f.showIf || f.showIf.in.includes(String(v[f.showIf.key] ?? '')));

type Option = { value: string; label: string; hint?: string };

/** Choices for an id field, from the person's own data (their rights apply on the server). */
function useOptions(source: string | undefined, query: string, enabled: boolean) {
  const [state, setState] = useState<{ options: Option[]; error: string; loading: boolean }>({ options: [], error: '', loading: !!source });
  useEffect(() => {
    if (!source || !enabled) return;
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      api
        .get<{ options: Option[] }>(`/api/boards/options/${source}${query}`)
        .then((r) => live && setState({ options: r.options, error: '', loading: false }))
        .catch((e: Error) => live && setState({ options: [], error: e.message, loading: false }));
    }, query.includes('q=') ? 220 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [source, query, enabled]);
  return state;
}

function Choice({ f, value, onChange, values }: { f: FieldDef; value: string; onChange: (v: string) => void; values: Values }) {
  const [search, setSearch] = useState('');
  const dep = f.dependsOn ? `pipeline_id=${encodeURIComponent(String(values[f.dependsOn] ?? ''))}` : '';
  const searchable = f.optionsFrom === 'wiki_pages';
  const query = [dep, searchable && search ? `q=${encodeURIComponent(search)}` : ''].filter(Boolean).join('&');
  const { options, error, loading } = useOptions(f.optionsFrom, query ? `?${query}` : '', !!f.optionsFrom);
  if (!f.optionsFrom) return <Select value={value} onChange={onChange} options={f.options ?? []} />;
  const list = options.some((o) => o.value === value) || !value ? options : [{ value, label: `${value} (aktuell gewählt)` }, ...options];
  return (
    <>
      {searchable && <Input value={search} onChange={setSearch} placeholder="Seite suchen …" aria-label="Seite suchen" />}
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={!!error} aria-busy={loading}>
        <option value="">{loading ? 'Lädt …' : error ? 'Nicht verfügbar' : '– nichts gewählt –'}</option>
        {list.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
            {o.hint ? ` · ${o.hint}` : ''}
          </option>
        ))}
      </select>
      {error && <span className="bd-hint bad">{error}</span>}
    </>
  );
}

/** A labelled row. Fields made of several buttons must not sit inside a <label> (a click on the text would press the first one). */
function Row({ f, children }: { f: FieldDef; children: ReactNode }) {
  if (f.type === 'bool' || f.type === 'multi' || f.type === 'list' || f.type === 'json')
    return (
      <div className="field">
        {f.type !== 'bool' && <span>{f.label}</span>}
        {children}
        {f.hint && <small className="muted">{f.hint}</small>}
      </div>
    );
  return (
    <Field label={f.label} hint={f.hint}>
      {children}
    </Field>
  );
}

function Control({ f, values, set }: { f: FieldDef; values: Values; set: (v: unknown) => void }) {
  const value = values[f.key];
  switch (f.type) {
    case 'text':
    case 'url':
      return <Input type={f.type === 'url' ? 'url' : 'text'} value={value ?? ''} onChange={set} maxLength={f.maxLength} placeholder={f.placeholder} />;
    case 'textarea':
      return <Textarea value={value ?? ''} onChange={set} maxLength={f.maxLength} placeholder={f.placeholder} rows={8} />;
    case 'number':
      return (
        <input
          type="number"
          value={value ?? ''}
          min={f.min}
          max={f.max}
          placeholder={f.placeholder}
          onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))}
        />
      );
    case 'select':
      return <Choice f={f} value={String(value ?? '')} onChange={set} values={values} />;
    case 'bool':
      return <Check checked={!!value} onChange={set} label={f.label} />;
    case 'multi':
      return (
        <div className="chips" role="group" aria-label={f.label}>
          {(f.options ?? []).map(([v, l]) => {
            const on = ((value as string[]) ?? []).includes(v);
            return (
              <button key={v} type="button" className={`chip${on ? ' on' : ''}`} aria-pressed={on} onClick={() => set(on ? (value as string[]).filter((x) => x !== v) : [...((value as string[]) ?? []), v])}>
                {l}
              </button>
            );
          })}
        </div>
      );
    case 'list':
      return <ListControl f={f} rows={(value as Values[]) ?? []} set={set} />;
    case 'json':
      return <JsonControl value={value} set={set} />;
    default:
      return null;
  }
}

function JsonControl({ value, set }: { value: unknown; set: (v: unknown) => void }) {
  const [text, setText] = useState(value === null || value === undefined ? '' : JSON.stringify(value, null, 2));
  const [bad, setBad] = useState('');
  return (
    <>
      <textarea
        className="mono"
        rows={8}
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          if (!e.target.value.trim()) return setBad(''), set(null);
          try {
            set(JSON.parse(e.target.value));
            setBad('');
          } catch {
            setBad('Das ist kein gültiges JSON.');
          }
        }}
      />
      {bad && <span className="bd-hint bad">{bad}</span>}
    </>
  );
}

/** A list of entries (e.g. the buttons of Schnellaktionen): each entry is a small form of its own. */
function ListControl({ f, rows, set }: { f: FieldDef; rows: Values[]; set: (v: Values[]) => void }) {
  const item = f.item ?? [];
  const blank = (): Values => Object.fromEntries(item.map((i) => [i.key, empty(i)]));
  const put = (n: number, patch: Values) => set(rows.map((r, i) => (i === n ? { ...r, ...patch } : r)));
  return (
    <div className="bd-listfield">
      {rows.map((r, n) => (
        <fieldset key={n} className="bd-entry">
          <legend>
            {f.label} {n + 1}
          </legend>
          <span className="bd-entry-tools">
            <button type="button" className="bd-iconbtn" disabled={n === 0} onClick={() => set(swap(rows, n, n - 1))} aria-label={`Eintrag ${n + 1} nach oben`}>
              <Icon name="up" size={14} />
            </button>
            <button type="button" className="bd-iconbtn" disabled={n === rows.length - 1} onClick={() => set(swap(rows, n, n + 1))} aria-label={`Eintrag ${n + 1} nach unten`}>
              <Icon name="down" size={14} />
            </button>
            <button type="button" className="bd-iconbtn danger" onClick={() => set(rows.filter((_, i) => i !== n))} aria-label={`Eintrag ${n + 1} entfernen`}>
              <Icon name="trash" size={14} />
            </button>
          </span>
          {item
            .filter((i) => visible(i, r))
            .map((i) => (
              <Row key={i.key} f={i}>
                <Control f={i} values={r} set={(v) => put(n, { [i.key]: v })} />
              </Row>
            ))}
        </fieldset>
      ))}
      {rows.length < (f.maxItems ?? 20) && (
        <button type="button" className="btn secondary small" onClick={() => set([...rows, blank()])}>
          <Icon name="plus" size={14} /> {f.label} hinzufügen
        </button>
      )}
    </div>
  );
}
const swap = <T,>(a: T[], i: number, j: number) => {
  const b = [...a];
  [b[i], b[j]] = [b[j], b[i]];
  return b;
};

export function SettingsPanel({ widget, type, canEdit, onSave, onRemove, onClose }: { widget: Widget; type: WidgetType | undefined; canEdit: boolean; onSave: (patch: { config: Values; title: string }) => Promise<boolean>; onRemove: () => void; onClose: () => void }) {
  const fields = type?.fields ?? [];
  const [values, setValues] = useState<Values>(() => initial(fields, widget.config));
  const [title, setTitle] = useState(widget.title);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLElement>(null);
  const start = useMemo(() => JSON.stringify({ v: initial(fields, widget.config), t: widget.title }), [widget.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify({ v: values, t: title }) !== start;

  // Once per opening (the parent redraws often with live data): the focus moves to the first control, Tab stays in the
  // drawer, Esc closes it and the focus goes back to the widget's settings button.
  useFocusLayer(box, onClose, { first: 'input, select, textarea' });

  const save = async () => {
    // only what changed is sent; an emptied number goes back to the default (null removes it)
    const config: Values = {};
    const first = initial(fields, widget.config);
    for (const f of fields) if (!f.hidden && JSON.stringify(values[f.key]) !== JSON.stringify(first[f.key])) config[f.key] = values[f.key];
    setBusy(true);
    const ok = await onSave({ config, title: title.trim() });
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <>
      <div className="bd-scrim" onMouseDown={onClose} />
      <aside ref={box} className="bd-drawer" role="dialog" aria-modal="true" aria-label={`Einstellungen: ${type?.label ?? widget.type}`} data-tour="board-settings">
        <header>
          <span className="bd-pick-icon">
            <Icon name={widgetIcon(type)} size={18} />
          </span>
          <div>
            <h3>{type?.label ?? widget.type}</h3>
            <p className="muted small">{type?.description}</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Schließen">
            ✕
          </button>
        </header>
        <div className="bd-drawer-body">
          {!type && <p className="bd-callout">Dieses Widget ist nicht mehr verfügbar (das Modul ist nicht aktiv). Du kannst es entfernen.</p>}
          {type && (
            <>
              <Field label="Titel" hint={`Leer lassen für „${type.label}“`}>
                <Input value={title} onChange={setTitle} maxLength={80} disabled={!canEdit} />
              </Field>
              {fields
                .filter((f) => visible(f, values))
                .map((f) => (
                  <Row key={f.key} f={f}>
                    <Control f={f} values={values} set={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
                  </Row>
                ))}
              {!fields.some((f) => !f.hidden) && <p className="muted small">Dieses Widget hat keine weiteren Einstellungen.</p>}
              {type.access_label && <p className="muted small">Sichtbar nur für Personen mit dem Recht „{type.access_label}“. Jede Person sieht nur, was sie auch auf der eigenen Seite sehen dürfte.</p>}
            </>
          )}
        </div>
        <footer>
          <button type="button" className="btn ghost danger-text" onClick={onRemove} disabled={!canEdit}>
            <Icon name="trash" size={14} /> Entfernen
          </button>
          <span className="grow" />
          <button type="button" className="btn secondary bd-cancel" onClick={onClose}>
            Abbrechen
          </button>
          <button type="button" className="btn" onClick={save} disabled={!canEdit || !dirty || busy || !type}>
            Speichern
          </button>
        </footer>
      </aside>
    </>
  );
}
