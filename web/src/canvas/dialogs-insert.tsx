import { useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Check, Field, Input, Modal, Tabs, toastError, useLoad } from '../ui';
import { Icon } from '../icons';
import { GenImageModal } from '../pages/GenMediaKit';
import { type CanvasElement, type ChartData, type ChartKind, createElement } from '../../../server/services/canvas-model';
import { elementSvg, renderSvg } from '../../../server/services/canvas-render';
import { CANVAS_ICONS } from '../../../server/services/canvas-icons';
import { TEMPLATES, buildTemplate } from '../../../server/services/canvas-templates';
import { MermaidError, mermaidToElements } from '../../../server/services/canvas-mermaid';
import { newId } from './store';
import { imageElement, imageSize, uploadImage, IMAGE_TYPES } from './media';
import type { DialogProps } from './dialogs';

/** Dialogs that put things on the board: templates, images, icons, tables, charts and Mermaid text. */

const LIGHT_BG = '#ffffff';

/** Inline SVG preview of some elements (all markup comes from the escaping renderer). */
export function Preview({ els, max = 360, prefix = 'pv' }: { els: CanvasElement[]; max?: number; prefix?: string }) {
  const svg = useMemo(() => {
    try {
      return renderSvg(els, { background: LIGHT_BG, maxSize: max, padding: 12, idPrefix: prefix }).svg;
    } catch {
      return '';
    }
  }, [els, max, prefix]);
  return svg ? <div className="cv-preview" dangerouslySetInnerHTML={{ __html: svg }} /> : <div className="cv-preview empty">Keine Vorschau</div>;
}

// --- templates ----------------------------------------------------------------------------------------

/** The elements of every template (for the gallery previews), built once. */
export function useTemplatePreviews() {
  return useMemo(() => {
    let n = 0;
    const out: Record<string, CanvasElement[]> = {};
    for (const t of TEMPLATES) out[t.key] = buildTemplate(t.key, () => `p${n++}`, { x: 0, y: 0 }) ?? [];
    return out;
  }, []);
}

export function TemplatesDialog({ api: ed, onClose }: DialogProps) {
  const cats = ['Alle', ...new Set(TEMPLATES.map((t) => t.category))];
  const [cat, setCat] = useState('Alle');
  const previews = useTemplatePreviews();
  const use = (key: string) => {
    const els = buildTemplate(key, newId, { x: 0, y: 0 });
    if (!els) return;
    const [cx, cy] = ed.center();
    const ids = ed.insert(els, { at: [cx, cy] });
    onClose();
    setTimeout(() => ed.zoomTo(ids), 40);
  };
  return (
    <Modal title="Vorlagen" onClose={onClose} wide>
      <div className="cv-cats" role="tablist">
        {cats.map((c) => (
          <button key={c} className={`cv-chip${cat === c ? ' on' : ''}`} onClick={() => setCat(c)}>
            {c}
          </button>
        ))}
      </div>
      <div className="cv-tpl-grid" data-tour="canvas-templates">
        {TEMPLATES.filter((t) => cat === 'Alle' || t.category === cat).map((t) => (
          <button key={t.key} className="cv-tpl" onClick={() => use(t.key)} disabled={ed.readOnly}>
            <Preview els={previews[t.key]} max={340} prefix={`t${t.key}`} />
            <b>{t.name}</b>
            <span className="muted small">{t.description}</span>
          </button>
        ))}
      </div>
      <p className="muted small">Die Vorlage landet in der Mitte deiner Ansicht und lässt sich danach wie alles andere ändern (Strg Z nimmt sie zurück).</p>
    </Modal>
  );
}

// --- images -------------------------------------------------------------------------------------------

interface MediaItem {
  id: string;
  name: string;
  src: string;
  mime: string;
}

export function MediaDialog({ api: ed, onClose }: DialogProps) {
  const [tab, setTab] = useState('upload');
  const [busy, setBusy] = useState(false);
  const [gen, setGen] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const lib = useLoad(() => api.get<MediaItem[]>('/api/canvas/media'), []);
  const place = async (src: string, name: string, size?: { w: number; h: number }, offset = 0) => {
    const s = size ?? (await imageSize(src));
    const [cx, cy] = ed.center();
    ed.insert([imageElement({ src, w: s.w, h: s.h, name }, cx + offset, cy + offset)]);
  };
  const upload = async (files: File[]) => {
    const ok = files.filter((f) => IMAGE_TYPES.test(f.type));
    if (!ok.length) return toastError('Nur PNG, JPG, GIF oder WebP');
    setBusy(true);
    try {
      for (const [i, f] of ok.slice(0, 10).entries()) {
        const img = await uploadImage(ed.board.id, f);
        await place(img.src, img.name, img, i * 30);
      }
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  // KI-Studio: the generated image lands in the media library and then on the board
  if (gen)
    return (
      <GenImageModal
        aspect="1:1"
        onClose={() => setGen(false)}
        onPick={async (u) => {
          const src = new URL(u.url, window.location.href).pathname;
          await place(src, u.name || 'KI-Bild', undefined);
          onClose();
        }}
      />
    );
  return (
    <Modal title="Bild einfügen" onClose={onClose} wide>
      <Tabs
        tabs={[
          ['upload', 'Hochladen'],
          ['library', 'Mediathek'],
          ['ai', 'KI-Bild'],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'upload' ? (
        <div
          className="cv-drop"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void upload([...e.dataTransfer.files]);
          }}
        >
          <Icon name="imageUp" size={30} />
          <p>
            Bilder hierher ziehen oder <button className="btn small" onClick={() => file.current?.click()} disabled={busy}>Dateien wählen</button>
          </p>
          <p className="muted small">PNG, JPG, GIF oder WebP bis 8 MB. Du kannst Bilder auch direkt auf das Board ziehen oder mit Strg V einfügen. Sie landen in der Mediathek.</p>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => void upload([...(e.target.files ?? [])])} />
        </div>
      ) : tab === 'ai' ? (
        <div className="cv-drop">
          <Icon name="sparkles" size={30} />
          <p>Beschreibe das Bild – es wird mit deinem KI-Anbieter (KI-Studio) erzeugt, in der Mediathek gespeichert und aufs Board gelegt.</p>
          <button className="btn" onClick={() => setGen(true)} data-tour="canvas-media-ai">
            <Icon name="sparkles" size={14} /> KI-Bild generieren
          </button>
        </div>
      ) : (
        <div className="cv-media-grid">
          {lib.loading && <p className="muted">Lädt …</p>}
          {!lib.loading && !lib.data?.length && <p className="muted">Noch keine Bilder in der Mediathek.</p>}
          {(lib.data ?? []).map((m) => (
            <button
              key={m.id}
              className="cv-media"
              title={m.name}
              onClick={async () => {
                await place(m.src, m.name);
                onClose();
              }}
            >
              <img src={m.src} alt={m.name} loading="lazy" />
              <span>{m.name}</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

// --- icons --------------------------------------------------------------------------------------------

export function IconGlyph({ name, size = 24 }: { name: string; size?: number }) {
  const def = CANVAS_ICONS[name];
  if (!def) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {def[2].map(([tag, attrs], i) => {
        const Tag = tag as 'path';
        return <Tag key={i} {...(attrs as Record<string, string>)} />;
      })}
    </svg>
  );
}

export function IconsDialog({ api: ed, data, onClose }: DialogProps) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return Object.entries(CANVAS_ICONS).filter(([k, [label, more]]) => !words.length || words.every((w) => `${k} ${label} ${more}`.toLowerCase().includes(w)));
  }, [q]);
  const pick = (name: string) => {
    if (data?.id) ed.patch([data.id], { icon: name });
    else {
      const [cx, cy] = ed.center();
      ed.insert([createElement({ type: 'icon', icon: name, x: cx - 32, y: cy - 32, w: 64, h: 64, ...(ed.defaults.stroke ? { stroke: ed.defaults.stroke } : {}) }, newId)]);
    }
    onClose();
  };
  return (
    <Modal title={data?.id ? 'Icon wechseln' : 'Icon einfügen'} onClose={onClose} wide>
      <Input value={q} onChange={setQ} placeholder="Suchen: Person, Kalender, Euro …" autoFocus aria-label="Icons suchen" />
      <div className="cv-icon-grid">
        {list.map(([k, [label]]) => (
          <button key={k} className="cv-icon-pick" onClick={() => pick(k)} title={label}>
            <IconGlyph name={k} size={26} />
            <span>{label}</span>
          </button>
        ))}
        {!list.length && <p className="muted">Kein Icon gefunden.</p>}
      </div>
    </Modal>
  );
}

// --- tables -------------------------------------------------------------------------------------------

/** Cells from pasted spreadsheet text (tabs, or semicolons/commas when there are no tabs). */
export function parseGrid(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  const sep = text.includes('\t') ? '\t' : text.includes(';') ? ';' : ',';
  return lines.map((l) => l.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, '$1')));
}

export function TableDialog({ api: ed, data, onClose }: DialogProps) {
  const el = ed.store.els.get(data?.id);
  const [cells, setCells] = useState<string[][]>(() => (el?.cells?.length ? el.cells.map((r) => [...r]) : [['', ''], ['', '']]));
  const [header, setHeader] = useState(!!el?.header);
  if (!el) return null;
  const cols = Math.max(1, ...cells.map((r) => r.length));
  const grid = cells.map((r) => Array.from({ length: cols }, (_, i) => r[i] ?? ''));
  const set = (r: number, c: number, v: string) => setCells(grid.map((row, i) => (i === r ? row.map((x, j) => (j === c ? v : x)) : row)));
  const paste = (r: number, c: number, text: string) => {
    if (!/[\t\n]/.test(text.trim())) return false;
    const rows = parseGrid(text);
    const next = grid.map((row) => [...row]);
    rows.forEach((vals, i) => {
      while (next.length <= r + i && next.length < 40) next.push(Array(cols).fill(''));
      vals.forEach((v, j) => {
        if (c + j >= 20) return;
        for (const row of next) while (row.length <= c + j) row.push('');
        if (next[r + i]) next[r + i][c + j] = v;
      });
    });
    setCells(next);
    return true;
  };
  const apply = () => {
    const rowH = Math.max(28, el.h / Math.max(1, el.cells?.length ?? 1));
    ed.patch([el.id], { cells: grid, header: header || undefined, h: Math.round(rowH * grid.length), w: Math.max(el.w, cols * 90) });
    onClose();
  };
  return (
    <Modal
      title="Tabelle bearbeiten"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" onClick={apply}>
            Übernehmen
          </button>
        </>
      }
    >
      <div className="cv-grid-edit" style={{ gridTemplateColumns: `repeat(${cols}, minmax(90px, 1fr)) 28px` }}>
        {grid.map((row, r) => (
          <FragmentRow key={r}>
            {row.map((v, c) => (
              <input key={c} value={v} className={header && r === 0 ? 'head' : ''} onChange={(e) => set(r, c, e.target.value)} onPaste={(e) => paste(r, c, e.clipboardData.getData('text')) && e.preventDefault()} aria-label={`Zeile ${r + 1}, Spalte ${c + 1}`} />
            ))}
            <button className="icon-btn" title="Zeile löschen" disabled={grid.length < 2} onClick={() => setCells(grid.filter((_, i) => i !== r))}>
              ✕
            </button>
          </FragmentRow>
        ))}
        {cols > 1 &&
          Array.from({ length: cols }, (_, c) => (
            <button key={`d${c}`} className="icon-btn" title="Spalte löschen" onClick={() => setCells(grid.map((row) => row.filter((_, j) => j !== c)))}>
              ✕
            </button>
          ))}
      </div>
      <div className="cv-actions" style={{ marginTop: 10 }}>
        <button className="btn small secondary" onClick={() => setCells([...grid, Array(cols).fill('')])} disabled={grid.length >= 40}>
          + Zeile
        </button>
        <button className="btn small secondary" onClick={() => setCells(grid.map((row) => [...row, '']))} disabled={cols >= 20}>
          + Spalte
        </button>
        <Check checked={header} onChange={setHeader} label="Erste Zeile ist Kopfzeile" />
      </div>
      <p className="muted small">Tipp: Zellen aus Excel oder Google Sheets kopieren und in eine Zelle einfügen.</p>
    </Modal>
  );
}

const FragmentRow = ({ children }: { children: ReactNode }) => <>{children}</>;

// --- charts -------------------------------------------------------------------------------------------

const CHART_KINDS: [ChartKind, string][] = [
  ['bar', 'Balken'],
  ['line', 'Linie'],
  ['area', 'Fläche'],
  ['pie', 'Kuchen'],
  ['donut', 'Ring'],
];

export function ChartDialog({ api: ed, data, onClose }: DialogProps) {
  const el = ed.store.els.get(data?.id);
  const start: ChartData = el?.chart ?? { kind: 'bar', labels: ['A', 'B', 'C'], series: [{ name: 'Werte', values: [3, 5, 2] }] };
  const [kind, setKind] = useState<ChartKind>(start.kind);
  const [title, setTitle] = useState(start.title ?? '');
  const [labels, setLabels] = useState<string[]>(start.labels);
  const [series, setSeries] = useState<{ name: string; values: string[] }[]>(start.series.map((s) => ({ name: s.name, values: s.values.map(String) })));
  const chart = useMemo<ChartData>(
    () => ({ kind, ...(title.trim() ? { title: title.trim() } : {}), labels, series: series.map((s) => ({ name: s.name, values: labels.map((_, i) => Number(String(s.values[i] ?? '').replace(',', '.')) || 0) })) }),
    [kind, title, labels, series],
  );
  const prev = useMemo(() => {
    if (!el) return '';
    const e = { ...el, chart, x: 0, y: 0 };
    try {
      return elementSvg(e, { byId: new Map([[e.id, e]]) }, {});
    } catch {
      return '';
    }
  }, [el, chart]);
  if (!el) return null;
  const addRow = () => {
    setLabels([...labels, `Wert ${labels.length + 1}`]);
    setSeries(series.map((s) => ({ ...s, values: [...s.values, '0'] })));
  };
  const paste = (text: string) => {
    if (!/[\t\n]/.test(text.trim())) return false;
    const rows = parseGrid(text).filter((r) => r.some(Boolean));
    if (rows.length < 2 || rows[0].length < 2) return false;
    const head = rows[0];
    const body = rows.slice(1, 201);
    setLabels(body.map((r) => r[0] ?? ''));
    setSeries(head.slice(1, 9).map((name, j) => ({ name, values: body.map((r) => r[j + 1] ?? '0') })));
    return true;
  };
  return (
    <Modal
      title="Diagramm bearbeiten"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="btn"
            onClick={() => {
              ed.patch([el.id], { chart });
              onClose();
            }}
          >
            Übernehmen
          </button>
        </>
      }
    >
      <div className="cv-two">
        <div>
          <div className="cv-chips">
            {CHART_KINDS.map(([k, l]) => (
              <button key={k} className={`cv-chip${kind === k ? ' on' : ''}`} onClick={() => setKind(k)}>
                {l}
              </button>
            ))}
          </div>
          <Field label="Titel">
            <Input value={title} onChange={setTitle} placeholder="z. B. Umsatz pro Monat" />
          </Field>
          <div className="cv-table-wrap" onPaste={(e) => paste(e.clipboardData.getData('text')) && e.preventDefault()}>
            <table className="cv-data">
              <thead>
                <tr>
                  <th>Beschriftung</th>
                  {series.map((s, j) => (
                    <th key={j}>
                      <input value={s.name} onChange={(e) => setSeries(series.map((x, i) => (i === j ? { ...x, name: e.target.value } : x)))} aria-label={`Reihe ${j + 1}`} />
                    </th>
                  ))}
                  <th>
                    <button className="icon-btn" title="Reihe hinzufügen" disabled={series.length >= 8 || kind === 'pie' || kind === 'donut'} onClick={() => setSeries([...series, { name: `Reihe ${series.length + 1}`, values: labels.map(() => '0') }])}>
                      +
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {labels.map((l, i) => (
                  <tr key={i}>
                    <td>
                      <input value={l} onChange={(e) => setLabels(labels.map((x, k) => (k === i ? e.target.value : x)))} aria-label={`Beschriftung ${i + 1}`} />
                    </td>
                    {series.map((s, j) => (
                      <td key={j}>
                        <input inputMode="decimal" value={s.values[i] ?? ''} onChange={(e) => setSeries(series.map((x, k) => (k === j ? { ...x, values: labels.map((_, n) => (n === i ? e.target.value : (x.values[n] ?? '0'))) } : x)))} aria-label={`${s.name} ${l}`} />
                      </td>
                    ))}
                    <td>
                      <button
                        className="icon-btn"
                        title="Zeile löschen"
                        disabled={labels.length < 2}
                        onClick={() => {
                          setLabels(labels.filter((_, k) => k !== i));
                          setSeries(series.map((s) => ({ ...s, values: s.values.filter((_, k) => k !== i) })));
                        }}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn small secondary" onClick={addRow} disabled={labels.length >= 60}>
            + Zeile
          </button>
          <p className="muted small">Tipp: Eine Tabelle aus Excel oder Sheets (erste Zeile = Reihen-Namen) kopieren und hier einfügen.</p>
        </div>
        <div className="cv-preview wide" dangerouslySetInnerHTML={{ __html: `<svg viewBox="-6 -6 ${el.w + 12} ${el.h + 12}" width="100%" style="background:#fff;border-radius:8px">${prev}</svg>` }} />
      </div>
    </Modal>
  );
}

// --- Mermaid ------------------------------------------------------------------------------------------

const MERMAID_EXAMPLES: [string, string][] = [
  ['Flussdiagramm', 'flowchart TD\n  A([Anfrage]) --> B{Passt?}\n  B -->|Ja| C[Angebot senden]\n  B -->|Nein| D[Absage]\n  C --> E([Abschluss])'],
  ['Mindmap', 'mindmap\n  root((Herbst-Kampagne))\n    Kanäle\n      E-Mail\n      Social\n    Inhalte\n      Blog\n      Video'],
  ['Ablauf (Sequenz)', 'sequenceDiagram\n  Kunde->>Formular: Anfrage\n  Formular->>CRM: Kontakt anlegen\n  CRM-->>Kunde: Bestätigung'],
];

export function MermaidDialog({ api: ed, onClose }: DialogProps) {
  const [src, setSrc] = useState(MERMAID_EXAMPLES[0][1]);
  const [sketch, setSketch] = useState(!!ed.defaults.sketch);
  const built = useMemo(() => {
    if (!src.trim()) return { els: [] as CanvasElement[], error: '' };
    try {
      let n = 0;
      const r = mermaidToElements(src, () => `m${n++}`, { x: 0, y: 0 }, { sketch });
      return { els: r.elements, error: '' };
    } catch (e) {
      return { els: [] as CanvasElement[], error: e instanceof MermaidError ? e.message : 'Konnte nicht gelesen werden' };
    }
  }, [src, sketch]);
  const insert = () => {
    try {
      const r = mermaidToElements(src, newId, { x: 0, y: 0 }, { sketch });
      const ids = ed.insert(r.elements, { at: ed.center() });
      onClose();
      setTimeout(() => ed.zoomTo(ids), 40);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Modal
      title="Mermaid-Diagramm einfügen"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" onClick={insert} disabled={!built.els.length}>
            Einfügen
          </button>
        </>
      }
    >
      <div className="cv-two">
        <div>
          <div className="cv-chips">
            {MERMAID_EXAMPLES.map(([l, s]) => (
              <button key={l} className="cv-chip" onClick={() => setSrc(s)}>
                {l}
              </button>
            ))}
          </div>
          <textarea className="cv-code" rows={14} value={src} onChange={(e) => setSrc(e.target.value)} spellCheck={false} aria-label="Mermaid-Text" />
          <Check checked={sketch} onChange={setSketch} label="Handgezeichnet" />
          <p className="muted small">Unterstützt: flowchart/graph, mindmap und sequenceDiagram. Pfeile bleiben an den Formen haften.</p>
        </div>
        <div>{built.error ? <p className="cv-error">{built.error}</p> : <Preview els={built.els} max={460} prefix="mm" />}</div>
      </div>
    </Modal>
  );
}
