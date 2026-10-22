import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../icons';
import { navigate, pressable, toast } from '../ui';
import { type CanvasElement, type FontKey, CARD_LABELS, FILL_COLORS, FRAME_PRESETS, STICKY_COLORS, STROKE_COLORS, createElement, elementBox, typeLabel } from '../../../server/services/canvas-model';
import { cardKey } from '../../../server/services/canvas-render';
import { newId } from './store';
import { align, distribute, duplicate, group, reorder, ungroup } from './actions';
import { selectionBox, toWorld } from './geometry';
import type { EditorApi } from './Editor';

export type Tool = 'select' | 'hand' | 'lasso' | 'rect' | 'ellipse' | 'diamond' | 'line' | 'arrow' | 'draw' | 'text' | 'sticky' | 'frame' | 'image' | 'comment' | 'eraser';

function Pop({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', on, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', on, true);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="cv-pop">
      {children}
    </div>
  );
}

// --- toolbar --------------------------------------------------------------------------------------------

export function Toolbar({ api }: { api: EditorApi }) {
  const [fly, setFly] = useState<'' | 'shapes' | 'frames' | 'more'>('');
  const [shape, setShape] = useState<'rect' | 'ellipse' | 'diamond'>('rect');
  const T = (t: Tool, icon: IconName | ReactNode, label: string, key?: string, tour?: string) => (
    <button key={t} className={`cv-tool${api.tool === t ? ' on' : ''}`} onClick={() => api.setTool(t)} title={key ? `${label} (${key})` : label} aria-label={label} data-tour={tour}>
      {typeof icon === 'string' ? <Icon name={icon as IconName} size={18} /> : icon}
    </button>
  );
  const at = () => api.center();
  const shapeIcon = (s: string) => (s === 'ellipse' ? <span className="cv-glyph">◯</span> : s === 'diamond' ? <span className="cv-glyph">◇</span> : <span className="cv-glyph">▭</span>);
  return (
    <nav className="cv-toolbar cv-panel" aria-label="Werkzeuge" data-tour="canvas-tools">
      {T('select', <span className="cv-glyph">➚</span>, 'Auswählen', 'V', 'canvas-tool-select')}
      {T('hand', <span className="cv-glyph">✋</span>, 'Verschieben', 'H / Leertaste')}
      {T('lasso', <span className="cv-glyph">➰</span>, 'Lasso', 'Q / Strg + Ziehen')}
      <span className="cv-sep" />
      <div className="cv-fly">
        <button className={`cv-tool${['rect', 'ellipse', 'diamond'].includes(api.tool) ? ' on' : ''}`} onClick={() => api.setTool(shape)} onContextMenu={(e) => (e.preventDefault(), setFly('shapes'))} title="Formen (R, O, D) – rechts/lang drücken für mehr" aria-label="Formen" data-tour="canvas-tool-shapes">
          {shapeIcon(shape)}
        </button>
        <button className="cv-fly-more" onClick={() => setFly(fly === 'shapes' ? '' : 'shapes')} aria-label="Weitere Formen">
          ▾
        </button>
        {fly === 'shapes' && (
          <Pop onClose={() => setFly('')}>
            {(['rect', 'ellipse', 'diamond'] as const).map((s) => (
              <button
                key={s}
                className="cv-tool"
                onClick={() => {
                  setShape(s);
                  api.setTool(s);
                  setFly('');
                }}
                title={{ rect: 'Rechteck (R)', ellipse: 'Ellipse (O)', diamond: 'Raute (D)' }[s]}
              >
                {shapeIcon(s)}
              </button>
            ))}
          </Pop>
        )}
      </div>
      {T('arrow', 'move', 'Pfeil', 'A', 'canvas-tool-arrow')}
      {T('line', <span className="cv-glyph">╱</span>, 'Linie', 'L')}
      {T('draw', 'edit', 'Stift', 'P', 'canvas-tool-pen')}
      {T('text', <span className="cv-glyph" style={{ fontWeight: 700 }}>T</span>, 'Text', 'T')}
      {T('sticky', 'note', 'Notiz', 'S', 'canvas-tool-sticky')}
      <div className="cv-fly">
        {T('frame', 'monitor', 'Rahmen / Artboard', 'F', 'canvas-tool-frame')}
        <button className="cv-fly-more" onClick={() => setFly(fly === 'frames' ? '' : 'frames')} aria-label="Rahmen-Größen">
          ▾
        </button>
        {fly === 'frames' && (
          <Pop onClose={() => setFly('')}>
            <div className="cv-pop-list">
              {FRAME_PRESETS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => {
                    const [cx, cy] = at();
                    api.insert([createElement({ type: 'frame', x: cx - p.w / 2, y: cy - p.h / 2, w: p.w, h: p.h, name: p.label, preset: p.key }, newId)]);
                    setTimeout(() => api.zoomTo(api.store.ordered.slice(-1).map((e) => e.id)), 30);
                    setFly('');
                  }}
                >
                  <span>{p.label}</span>
                  <small>{p.group}</small>
                </button>
              ))}
            </div>
          </Pop>
        )}
      </div>
      <button className="cv-tool" onClick={() => api.open('media')} title="Bild (I) – hochladen, einfügen, Mediathek" aria-label="Bild" data-tour="canvas-tool-image">
        <Icon name="image" size={18} />
      </button>
      <button className="cv-tool" onClick={() => api.open('icons')} title="Icon" aria-label="Icon">
        <Icon name="star" size={18} />
      </button>
      <button
        className="cv-tool"
        onClick={() => {
          const [cx, cy] = at();
          api.insert([createElement({ type: 'table', x: cx - 240, y: cy - 80 }, newId)]);
        }}
        title="Tabelle"
        aria-label="Tabelle"
      >
        <Icon name="vizTable" size={18} />
      </button>
      <button
        className="cv-tool"
        onClick={() => {
          const [cx, cy] = at();
          const ids = api.insert([createElement({ type: 'chart', x: cx - 210, y: cy - 130 }, newId)]);
          if (ids[0]) api.open('chart', { id: ids[0] });
        }}
        title="Diagramm"
        aria-label="Diagramm"
      >
        <Icon name="vizBar" size={18} />
      </button>
      <span className="cv-sep" />
      <button className="cv-tool accent" onClick={() => api.open('crm')} title="Live-CRM-Karte: Kontakt, Firma, Deal, Aufgabe, Ticket, Termin, Projekt, Bericht, Pipeline" aria-label="CRM-Karte" data-tour="canvas-tool-crm">
        <Icon name="contacts" size={18} />
      </button>
      <button className="cv-tool" onClick={() => api.open('templates')} title="Vorlagen" aria-label="Vorlagen" data-tour="canvas-tool-templates">
        <Icon name="template" size={18} />
      </button>
      {T('comment', 'chat', 'Kommentar', 'C')}
      {T('eraser', <span className="cv-glyph">⌫</span>, 'Radierer', 'X')}
      <div className="cv-fly">
        <button className="cv-tool" onClick={() => setFly(fly === 'more' ? '' : 'more')} title="Mehr: Mermaid, Workflow, Funnel" aria-label="Mehr" data-tour="canvas-tool-more">
          <span className="cv-glyph">⋯</span>
        </button>
        {fly === 'more' && (
          <Pop onClose={() => setFly('')}>
            <div className="cv-pop-list">
              <button onClick={() => (api.open('mermaid'), setFly(''))}>Mermaid-Diagramm einfügen</button>
              <button onClick={() => (api.open('workflow'), setFly(''))}>Workflow als Diagramm</button>
              <button onClick={() => (api.open('workflowDraft'), setFly(''))}>Flussdiagramm → Workflow-Entwurf</button>
              <button onClick={() => (api.open('funnel'), setFly(''))}>Rahmen → Funnel-Seiten</button>
              <button onClick={() => (api.open('settings'), setFly(''))}>Board-Einstellungen</button>
              <button onClick={() => (api.open('shortcuts'), setFly(''))}>
                Tastenkürzel <small>?</small>
              </button>
            </div>
          </Pop>
        )}
      </div>
    </nav>
  );
}

// --- inspector (styles) ---------------------------------------------------------------------------------------

const has = (els: CanvasElement[], ...types: string[]) => els.some((e) => types.includes(e.type));
const common = <K extends keyof CanvasElement>(els: CanvasElement[], k: K, fallback: CanvasElement[K]): CanvasElement[K] => {
  const v = els[0]?.[k] ?? fallback;
  return els.every((e) => (e[k] ?? fallback) === v) ? v : (undefined as any);
};

function Swatches({ colors, value, onPick, label }: { colors: string[]; value: string | undefined; onPick: (c: string) => void; label: string }) {
  return (
    <div className="cv-swatches" role="group" aria-label={label}>
      {colors.map((c) => (
        <button key={c} className={`cv-swatch${value === c ? ' on' : ''}${c === 'transparent' ? ' none' : ''}`} style={{ background: c === 'transparent' ? undefined : c }} onClick={() => onPick(c)} title={c === 'transparent' ? 'Keine' : c} aria-label={c === 'transparent' ? 'Keine Füllung' : c} />
      ))}
      <label className="cv-swatch custom" title="Eigene Farbe">
        <input type="color" value={value && /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'} onChange={(e) => onPick(e.target.value)} aria-label={`${label}: eigene Farbe`} />
      </label>
    </div>
  );
}

function Seg<T extends string | number>({ value, options, onPick, label }: { value: T | undefined; options: [T, ReactNode, string?][]; onPick: (v: T) => void; label: string }) {
  return (
    <div className="cv-seg" role="group" aria-label={label}>
      {options.map(([v, l, title]) => (
        <button key={String(v)} className={value === v ? 'on' : ''} onClick={() => onPick(v)} title={title}>
          {l}
        </button>
      ))}
    </div>
  );
}

const Row = ({ label, children, stack }: { label: string; children: ReactNode; stack?: boolean }) => (
  <div className={`cv-row${stack ? ' stack' : ''}`}>
    <span className="cv-row-label">{label}</span>
    <div className="cv-row-body">{children}</div>
  </div>
);

export function Inspector({ api }: { api: EditorApi }) {
  const els = api.selected;
  const ids = api.selection;
  const [collapsed, setCollapsed] = useState(window.innerWidth <= 900);
  if (!els.length) {
    if (api.readOnly) return null;
    // defaults for new elements
    return (
      <aside className="cv-inspector cv-panel" data-tour="canvas-inspector">
        <div className="cv-insp-head">
          <b>Stil für neue Elemente</b>
        </div>
        <Row label="Stil">
          <Seg value={api.defaults.sketch ? 'sketch' : 'clean'} options={[['clean', 'Sauber'], ['sketch', 'Handgezeichnet']]} onPick={(v) => api.setDefaults({ sketch: v === 'sketch' || undefined })} label="Stil" />
        </Row>
        <Row label="Linie" stack>
          <Swatches colors={STROKE_COLORS} value={api.defaults.stroke} onPick={(c) => api.setDefaults({ stroke: c })} label="Linienfarbe" />
        </Row>
        <Row label="Füllung" stack>
          <Swatches colors={FILL_COLORS} value={api.defaults.fill} onPick={(c) => api.setDefaults({ fill: c })} label="Füllung" />
        </Row>
        <p className="muted small">Tipp: Doppelklick schreibt Text, Strg + Rad zoomt, Leertaste + Ziehen verschiebt.</p>
      </aside>
    );
  }
  const set = (p: Partial<CanvasElement>) => api.patch(ids, p);
  const shapes = els.filter((e) => ['rect', 'ellipse', 'diamond', 'sticky', 'frame', 'table', 'chart', 'image'].includes(e.type));
  const lines = els.filter((e) => e.type === 'line' || e.type === 'arrow');
  const texty = has(els, 'text', 'rect', 'ellipse', 'diamond', 'sticky', 'arrow', 'line', 'table');
  const one = els.length === 1 ? els[0] : null;
  const locked = els.some((e) => e.locked);
  const title = one ? (one.type === 'card' ? `${CARD_LABELS[one.card!.kind]}-Karte` : typeLabel(one.type)) : `${els.length} Elemente`;
  return (
    <aside className={`cv-inspector cv-panel${collapsed ? ' collapsed' : ''}`} data-tour="canvas-inspector">
      <div className="cv-insp-head">
        <b>{title}</b>
        <button className="icon-btn" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Stil zeigen' : 'Stil einklappen'}>
          {collapsed ? '▴' : '▾'}
        </button>
      </div>
      {!collapsed && (
        <div className="cv-insp-body">
          {api.readOnly ? (
            <p className="muted small">Nur Lesezugriff – Kommentare sind möglich.</p>
          ) : locked ? (
            <button className="btn small secondary" onClick={() => set({ locked: undefined })}>
              <Icon name="lock" /> Entsperren
            </button>
          ) : (
            <>
              {one?.type === 'card' && <CardSection api={api} el={one} />}
              {one?.type === 'frame' && (
                <Row label="Größe">
                  <select value={one.preset ?? ''} onChange={(e) => {
                    const p = FRAME_PRESETS.find((x) => x.key === e.target.value);
                    if (p) set({ preset: p.key, w: p.w, h: p.h });
                  }}>
                    <option value="">Eigene ({Math.round(one.w)}×{Math.round(one.h)})</option>
                    {FRAME_PRESETS.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </Row>
              )}
              {has(els, 'rect', 'ellipse', 'diamond', 'line', 'arrow', 'draw', 'icon', 'table', 'chart', 'image') && (
                <Row label="Linie" stack>
                  <Swatches colors={STROKE_COLORS} value={common(els, 'stroke', undefined)} onPick={(c) => set({ stroke: c })} label="Linienfarbe" />
                </Row>
              )}
              {has(els, 'rect', 'ellipse', 'diamond', 'frame', 'table', 'chart') && (
                <Row label="Füllung" stack>
                  <Swatches colors={FILL_COLORS} value={common(shapes, 'fill', undefined)} onPick={(c) => set({ fill: c })} label="Füllung" />
                </Row>
              )}
              {has(els, 'sticky') && (
                <Row label="Farbe" stack>
                  <Swatches colors={Object.values(STICKY_COLORS)} value={common(els, 'fill', undefined)} onPick={(c) => set({ fill: c })} label="Notizfarbe" />
                </Row>
              )}
              {has(els, 'rect', 'ellipse', 'diamond', 'line', 'arrow') && (
                <Row label="Stil">
                  <Seg value={common(els, 'sketch', undefined) ? 'sketch' : 'clean'} options={[['clean', 'Sauber'], ['sketch', 'Handgezeichnet']]} onPick={(v) => set({ sketch: v === 'sketch' || undefined })} label="Stil" />
                </Row>
              )}
              {has(els, 'rect', 'ellipse', 'diamond') && common(els, 'sketch', undefined) && (
                <Row label="Füllart">
                  <Seg value={common(els, 'fillStyle', 'hachure')} options={[['hachure', '▤', 'Schraffur'], ['cross', '▦', 'Kreuz'], ['solid', '■', 'Voll']]} onPick={(v) => set({ fillStyle: v })} label="Füllart" />
                </Row>
              )}
              {has(els, 'rect', 'ellipse', 'diamond', 'line', 'arrow', 'draw', 'icon', 'image') && (
                <Row label="Stärke">
                  <Seg value={common(els, 'strokeWidth', 2)} options={[[1, '1'], [2, '2'], [4, '4'], [6, '6']]} onPick={(v) => set({ strokeWidth: v })} label="Linienstärke" />
                </Row>
              )}
              {has(els, 'rect', 'ellipse', 'diamond', 'line', 'arrow') && (
                <Row label="Strich">
                  <Seg value={common(els, 'strokeStyle', 'solid')} options={[['solid', '—', 'Durchgezogen'], ['dashed', '– –', 'Gestrichelt'], ['dotted', '···', 'Gepunktet']]} onPick={(v) => set({ strokeStyle: v === 'solid' ? undefined : v })} label="Strichart" />
                </Row>
              )}
              {lines.length > 0 && (
                <>
                  <Row label="Verlauf">
                    <Seg value={common(lines, 'route', 'straight')} options={[['straight', '╱', 'Gerade'], ['elbow', '┐', 'Rechtwinklig'], ['curved', '∿', 'Kurve']]} onPick={(v) => set({ route: v })} label="Verlauf" />
                  </Row>
                  <Row label="Spitzen">
                    <Seg value={common(lines, 'startHead', 'none')} options={[['none', '—'], ['arrow', '←'], ['triangle', '◀'], ['dot', '●']]} onPick={(v) => set({ startHead: v === 'none' ? undefined : v })} label="Anfang" />
                    <Seg value={common(lines, 'endHead', lines[0].type === 'arrow' ? 'arrow' : 'none')} options={[['none', '—'], ['arrow', '→'], ['triangle', '▶'], ['dot', '●']]} onPick={(v) => set({ endHead: v })} label="Ende" />
                  </Row>
                </>
              )}
              {has(els, 'rect', 'frame', 'image', 'sticky', 'table', 'chart') && (
                <Row label="Ecken">
                  <Seg value={common(els, 'radius', 0)} options={[[0, '┌', 'Eckig'], [8, '╭', 'Leicht rund'], [24, '◜', 'Rund']]} onPick={(v) => set({ radius: v || undefined })} label="Ecken" />
                </Row>
              )}
              {texty && (
                <>
                  <Row label="Schrift">
                    <Seg value={common(els, 'font', 'sans')} options={[['sans', 'Aa', 'Sans'], ['serif', <span key="s" style={{ fontFamily: 'Georgia, serif' }}>Aa</span>, 'Serif'], ['mono', <span key="m" style={{ fontFamily: 'monospace' }}>Aa</span>, 'Mono'], ['hand', <span key="h" style={{ fontFamily: "'Segoe Print','Comic Sans MS',cursive" }}>Aa</span>, 'Handschrift']]} onPick={(v) => set({ font: v as FontKey })} label="Schriftart" />
                  </Row>
                  <Row label="Größe">
                    <Seg value={common(els, 'fontSize', 20)} options={[[14, 'S'], [20, 'M'], [28, 'L'], [40, 'XL'], [64, 'XXL']]} onPick={(v) => set({ fontSize: v })} label="Schriftgröße" />
                  </Row>
                  <Row label="Text">
                    <Seg value={common(els, 'bold', undefined) ? 'b' : ''} options={[['b', <b key="b">B</b>, 'Fett']]} onPick={() => set({ bold: !common(els, 'bold', undefined) || undefined })} label="Fett" />
                    <Seg value={common(els, 'italic', undefined) ? 'i' : ''} options={[['i', <i key="i">I</i>, 'Kursiv']]} onPick={() => set({ italic: !common(els, 'italic', undefined) || undefined })} label="Kursiv" />
                    <Seg value={common(els, 'align', undefined)} options={[['left', '⇤', 'Links'], ['center', '⇔', 'Mitte'], ['right', '⇥', 'Rechts']]} onPick={(v) => set({ align: v })} label="Ausrichtung" />
                  </Row>
                  {has(els, 'text', 'rect', 'ellipse', 'diamond', 'sticky') && (
                    <Row label="Farbe" stack>
                      <Swatches colors={STROKE_COLORS} value={common(els, 'color', undefined)} onPick={(c) => set({ color: c })} label="Textfarbe" />
                    </Row>
                  )}
                </>
              )}
              {one?.type === 'image' && (
                <Row label="Bild">
                  <Seg value={one.fit ?? 'cover'} options={[['cover', 'Füllen'], ['contain', 'Ganz']]} onPick={(v) => set({ fit: v })} label="Bild anpassen" />
                </Row>
              )}
              {one?.type === 'icon' && (
                <button className="btn small secondary" onClick={() => api.open('icons', { id: one.id })}>
                  Icon wechseln
                </button>
              )}
              {one?.type === 'table' && (
                <button className="btn small secondary" onClick={() => api.open('table', { id: one.id })}>
                  Tabelle bearbeiten
                </button>
              )}
              {one?.type === 'chart' && (
                <button className="btn small secondary" onClick={() => api.open('chart', { id: one.id })}>
                  Daten bearbeiten
                </button>
              )}
              <Row label="Deckkraft">
                <input type="range" min={10} max={100} step={5} value={Math.round((common(els, 'opacity', 1) ?? 1) * 100)} onChange={(e) => set({ opacity: Number(e.target.value) >= 100 ? undefined : Number(e.target.value) / 100 })} aria-label="Deckkraft" />
              </Row>
              {one && one.type !== 'line' && one.type !== 'arrow' && (
                <Row label="Link">
                  <input className="cv-input" placeholder="https://… oder /app/…" defaultValue={one.link ?? ''} key={one.id} onBlur={(e) => set({ link: e.target.value.trim() || undefined })} />
                </Row>
              )}
              <div className="cv-actions">
                <IconBtn title="Nach vorne" onClick={() => reorder(api.store, ids, 'front')}>⤒</IconBtn>
                <IconBtn title="Nach hinten" onClick={() => reorder(api.store, ids, 'back')}>⤓</IconBtn>
                <IconBtn title="Duplizieren (Strg D)" onClick={() => api.select(duplicate(api.store, ids))}>⧉</IconBtn>
                {els.length > 1 && <IconBtn title="Gruppieren (Strg G)" onClick={() => group(api.store, ids)}>⊞</IconBtn>}
                {els.some((e) => e.groupIds?.length) && <IconBtn title="Gruppierung aufheben" onClick={() => ungroup(api.store, ids)}>⊟</IconBtn>}
                <IconBtn title="Sperren (Strg L)" onClick={() => set({ locked: true })}>
                  <Icon name="lock" />
                </IconBtn>
                <IconBtn title="Kommentieren" onClick={() => api.comments.toggle()}>
                  <Icon name="chat" />
                </IconBtn>
                <IconBtn title="Löschen (Entf)" onClick={() => api.store.remove(ids)}>
                  <Icon name="trash" />
                </IconBtn>
              </div>
              {els.length > 1 && (
                <div className="cv-actions">
                  <IconBtn title="Links ausrichten" onClick={() => align(api.store, ids, 'left')}>⫷</IconBtn>
                  <IconBtn title="Horizontal zentrieren" onClick={() => align(api.store, ids, 'hcenter')}>⫼</IconBtn>
                  <IconBtn title="Rechts ausrichten" onClick={() => align(api.store, ids, 'right')}>⫸</IconBtn>
                  <IconBtn title="Oben ausrichten" onClick={() => align(api.store, ids, 'top')}>⊤</IconBtn>
                  <IconBtn title="Vertikal zentrieren" onClick={() => align(api.store, ids, 'vcenter')}>⊝</IconBtn>
                  <IconBtn title="Unten ausrichten" onClick={() => align(api.store, ids, 'bottom')}>⊥</IconBtn>
                  {els.length > 2 && <IconBtn title="Horizontal verteilen" onClick={() => distribute(api.store, ids, 'h')}>↔</IconBtn>}
                  {els.length > 2 && <IconBtn title="Vertikal verteilen" onClick={() => distribute(api.store, ids, 'v')}>↕</IconBtn>}
                </div>
              )}
              {els.some((e) => (e.text ?? '').trim() && e.type !== 'card') && (
                <div className="cv-crm-actions" data-tour="canvas-convert">
                  <span className="muted small">In das CRM übernehmen</span>
                  <button className="btn small secondary" onClick={() => api.open('convertTask', { ids })}>
                    <Icon name="tasks" /> Als Aufgabe
                  </button>
                  <button className="btn small secondary" onClick={() => api.open('deal', { ids })}>
                    <Icon name="deal" /> Als Deal
                  </button>
                </div>
              )}
              {els.some((e) => e.type === 'frame') && (
                <div className="cv-crm-actions">
                  <button className="btn small secondary" onClick={() => api.open('export', { scope: 'frame', frameId: els.find((e) => e.type === 'frame')!.id })}>
                    <Icon name="download" /> Rahmen exportieren
                  </button>
                  <button className="btn small secondary" onClick={() => api.open('funnel', { frameIds: els.filter((e) => e.type === 'frame').map((e) => e.id) })}>
                    <Icon name="funnels" /> Als Funnel-Seiten
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
}

const IconBtn = ({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) => (
  <button className="icon-btn" title={title} aria-label={title} onClick={onClick}>
    {children}
  </button>
);

function CardSection({ api, el }: { api: EditorApi; el: CanvasElement }) {
  const data = api.store.cards[cardKey(el.card!.kind, el.card!.id)];
  return (
    <div className="cv-card-info">
      <div className="muted small">{data?.ok ? 'Live-Daten aus dem CRM' : (data?.error ?? 'Lädt …')}</div>
      <div className="cv-actions">
        {data?.url && (
          <button className="btn small" onClick={() => navigate(data.url!)}>
            Öffnen
          </button>
        )}
        <button className="btn small secondary" onClick={() => void api.refreshCards().then(() => toast('Aktualisiert'))}>
          <Icon name="refresh" /> Aktualisieren
        </button>
      </div>
    </div>
  );
}

// --- layers ------------------------------------------------------------------------------------------------------

export function LayersPanel({ api, onClose }: { api: EditorApi; onClose: () => void }) {
  const els = [...api.store.ordered].reverse();
  const top = els.filter((e) => !e.frameId || !api.store.els.has(e.frameId));
  const label = (e: CanvasElement) => (e.type === 'frame' ? e.name : e.type === 'card' ? `${CARD_LABELS[e.card!.kind]} · ${api.store.cards[cardKey(e.card!.kind, e.card!.id)]?.title ?? ''}` : e.name || e.text?.split('\n')[0] || (e.type === 'icon' ? e.icon : '')) || typeLabel(e.type);
  const row = (e: CanvasElement, depth: number): ReactNode => (
    <div key={e.id}>
      <div className={`cv-layer${api.selection.includes(e.id) ? ' on' : ''}${e.hidden ? ' hidden' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} {...pressable((ev) => api.select(ev.shiftKey ? [...api.selection, e.id] : [e.id]))} onDoubleClick={() => api.zoomTo([e.id])}>
        <span className="cv-layer-type">{typeLabel(e.type)}</span>
        <span className="cv-layer-name">{label(e)}</span>
        {!api.readOnly && (
          <>
            <button className="icon-btn" title={e.hidden ? 'Einblenden' : 'Ausblenden'} onClick={(ev) => (ev.stopPropagation(), api.store.update({ [e.id]: { hidden: e.hidden ? undefined : true } }))}>
              {e.hidden ? '◌' : '◉'}
            </button>
            <button className="icon-btn" title={e.locked ? 'Entsperren' : 'Sperren'} onClick={(ev) => (ev.stopPropagation(), api.store.update({ [e.id]: { locked: e.locked ? undefined : true } }))}>
              {e.locked ? <Icon name="lock" size={13} /> : <span className="muted">○</span>}
            </button>
          </>
        )}
      </div>
      {e.type === 'frame' && els.filter((c) => c.frameId === e.id).map((c) => row(c, depth + 1))}
    </div>
  );
  return (
    <aside className="cv-layers cv-panel" data-tour="canvas-layers-panel">
      <div className="cv-insp-head">
        <b>Ebenen</b> <span className="muted small">{els.length}</span>
        <button className="icon-btn" onClick={onClose} aria-label="Schließen">
          ✕
        </button>
      </div>
      <div className="cv-layers-list">{top.length ? top.map((e) => row(e, 0)) : <p className="muted small">Noch nichts auf dem Board.</p>}</div>
    </aside>
  );
}

// --- minimap -------------------------------------------------------------------------------------------------------

export function Minimap({ api }: { api: EditorApi }) {
  const W = 200;
  const H = 130;
  const els = api.store.ordered.filter((e) => !e.hidden);
  const vw = { x: -api.view.tx / api.view.z, y: -api.view.ty / api.view.z, w: api.size.w / api.view.z, h: api.size.h / api.view.z };
  const box = selectionBox(els, api.store.els);
  const b = box ? { x: Math.min(box.x, vw.x), y: Math.min(box.y, vw.y), w: Math.max(box.x + box.w, vw.x + vw.w) - Math.min(box.x, vw.x), h: Math.max(box.y + box.h, vw.y + vw.h) - Math.min(box.y, vw.y) } : vw;
  const k = Math.min(W / Math.max(1, b.w), H / Math.max(1, b.h)) * 0.92;
  const ox = (W - b.w * k) / 2 - b.x * k;
  const oy = (H - b.h * k) / 2 - b.y * k;
  const move = (e: React.PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const wx = (e.clientX - r.left - ox) / k;
    const wy = (e.clientY - r.top - oy) / k;
    api.setView((v) => ({ ...v, tx: api.size.w / 2 - wx * v.z, ty: api.size.h / 2 - wy * v.z }));
  };
  const color = (e: CanvasElement) => (e.type === 'frame' ? 'var(--cv-mm-frame)' : e.type === 'sticky' ? (e.fill ?? '#fff3a3') : e.type === 'card' ? '#4c6ef5' : e.fill && e.fill !== 'transparent' ? e.fill : 'var(--cv-mm-ink)');
  return (
    <div className="cv-minimap cv-panel" data-tour="canvas-minimap">
      <svg
        width={W}
        height={H}
        onPointerDown={(e) => {
          (e.currentTarget as SVGElement).setPointerCapture(e.pointerId);
          move(e);
        }}
        onPointerMove={(e) => e.buttons && move(e)}
      >
        {els.slice(-1500).map((e) => {
          const eb = elementBox(e);
          return <rect key={e.id} x={ox + eb.x * k} y={oy + eb.y * k} width={Math.max(1, eb.w * k)} height={Math.max(1, eb.h * k)} fill={color(e)} opacity={e.type === 'frame' ? 0.5 : 0.85} />;
        })}
        <rect x={ox + vw.x * k} y={oy + vw.y * k} width={vw.w * k} height={vw.h * k} className="cv-mm-view" />
      </svg>
    </div>
  );
}

export { toWorld };
