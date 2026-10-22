import { useState, type ReactNode } from 'react';
import { Check, Field, Input, Select, Tabs } from '../../ui';
import { BLOCKS, type BlockSpec } from './blocks';
import { ColorField, FieldInput, ImageField, resolveColor, useSite } from './Fields';
import { contrast } from './contrast';
import { evenCols, kindOf, type Block } from './model';
import { SECTION_PRESETS } from './model';
import { useT } from '../../i18n';

type Patch = Record<string, any>;
/** German labels (message ids of the sites catalog), shown through t(). */
const DEVICES: [string, string][] = [['desktop', 'Desktop'], ['tablet', 'Tablet'], ['phone', 'Handy']];

/** A number that may be empty (= not set). */
function Num({ value, onChange, min, max, placeholder, label }: { value: unknown; onChange: (v: number | undefined) => void; min?: number; max?: number; placeholder?: string; label?: string }) {
  return <input type="number" inputMode="numeric" min={min} max={max} placeholder={placeholder} aria-label={label} value={value === undefined || value === null || value === '' ? '' : Number(value)} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />;
}

const clean = (o: Record<string, any>) => {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(o)) {
    const inner = v && typeof v === 'object' ? clean(v) : v;
    if (inner !== undefined && inner !== '' && !(typeof inner === 'object' && !Object.keys(inner).length)) out[k] = inner;
  }
  return out;
};

/** Hide on devices: checkboxes for desktop, tablet and phone. */
function HideField({ node, patch }: { node: Block; patch: (p: Patch) => void }) {
  const t = useT('sites');
  const h = node.hide ?? {};
  return (
    <Field label={t('Ausblenden auf')}>
      <div className="checks">
        {DEVICES.map(([k, l]) => (
          <Check key={k} checked={!!h[k]} onChange={(v) => patch({ hide: clean({ ...h, [k]: v || undefined }) })} label={t(l)} />
        ))}
      </div>
    </Field>
  );
}

/** Font size per device in percent of the normal size. */
function FsField({ node, patch }: { node: Block; patch: (p: Patch) => void }) {
  const t = useT('sites');
  const f = node.fs ?? {};
  return (
    <Field label={t('Schriftgröße in % (100 = normal)')}>
      <div className="grid3">
        {DEVICES.map(([k, l]) => (
          <label key={k} className="mini">
            <span>{t(l)}</span>
            <Num value={f[k]} min={50} max={220} placeholder="100" label={t('Schriftgröße {device}', { device: t(l) })} onChange={(v) => patch({ fs: clean({ ...f, [k]: v }) })} />
          </label>
        ))}
      </div>
    </Field>
  );
}

function BorderField({ node, patch }: { node: Block; patch: (p: Patch) => void }) {
  const t = useT('sites');
  const b = node.border ?? {};
  const set = (k: string, v: any) => {
    const next = { w: b.w ?? 0, style: b.style ?? 'solid', color: b.color ?? 'token:line', ...b, [k]: v };
    patch({ border: next.w ? next : undefined });
  };
  return (
    <Field label={t('Rahmen')}>
      <div className="grid3">
        <label className="mini">
          <span>{t('Stärke px')}</span>
          <Num value={b.w} min={0} max={12} placeholder="0" label={t('Rahmenstärke')} onChange={(v) => set('w', v ?? 0)} />
        </label>
        <label className="mini">
          <span>{t('Linie')}</span>
          <Select value={b.style ?? 'solid'} onChange={(v) => set('style', v)} options={[['solid', t('Durchgezogen')], ['dashed', t('Gestrichelt')], ['dotted', t('Gepunktet')]]} />
        </label>
        <label className="mini">
          <span>{t('Farbe')}</span>
          <ColorField value={b.color ?? 'token:line'} onChange={(v) => set('color', v || 'token:line')} none={t('Linie')} />
        </label>
      </div>
    </Field>
  );
}

function ContrastHint({ fg, bg }: { fg?: string; bg?: string }) {
  const t = useT('sites');
  const { colors } = useSite();
  const f = resolveColor(fg, colors);
  const b = resolveColor(bg, colors) || colors.bg;
  if (!f || !b) return null;
  const r = contrast(f, b);
  if (r >= 4.5) return null;
  return (
    <p className="warn small" role="status">
      {t('Kontrast {ratio} : 1 – für gut lesbaren Text sind mindestens 4,5 : 1 nötig (BFSG/WCAG). Wähle eine hellere oder dunklere Farbe.', { ratio: r.toFixed(1) })}
    </p>
  );
}

function ItemsEditor({ spec, node, set }: { spec: BlockSpec; node: Block; set: (p: Patch) => void }) {
  const t = useT('sites');
  const it = spec.items!;
  const label = t(it.label);
  const list: Block[] = node[it.key] ?? [];
  const upd = (next: Block[]) => set({ [it.key]: next });
  const mv = (i: number, d: number) => {
    const a = [...list];
    [a[i], a[i + d]] = [a[i + d], a[i]];
    upd(a);
  };
  return (
    <>
      {list.map((x, i) => (
        <div key={i} className="card item">
          <div className="itemhead">
            <b className="small">
              {label} {i + 1}
            </b>
            <span>
              <button className="icon-btn" disabled={!i} onClick={() => mv(i, -1)} aria-label={t('{item} {n} nach oben', { item: label, n: i + 1 })}>
                ↑
              </button>
              <button className="icon-btn" disabled={i === list.length - 1} onClick={() => mv(i, 1)} aria-label={t('{item} {n} nach unten', { item: label, n: i + 1 })}>
                ↓
              </button>
              <button className="icon-btn" onClick={() => upd(list.filter((_, j) => j !== i))} aria-label={t('{item} {n} entfernen', { item: label, n: i + 1 })}>
                ✕
              </button>
            </span>
          </div>
          {it.fields.map((f) => (
            <Field key={f[0]} label={t(f[2])}>
              <FieldInput f={f} value={x[f[0]]} set={(p) => upd(list.map((y, j) => (j === i ? { ...y, ...p } : y)))} />
            </Field>
          ))}
        </div>
      ))}
      <button className="btn small secondary" onClick={() => upd([...list, {}])}>
        + {label}
      </button>
    </>
  );
}

export interface InspectorProps {
  node: Block;
  /** The row a column belongs to (for the column widths). */
  row?: Block;
  patch(p: Patch): void;
  /** Replaces the columns of a row (count and widths). */
  setCols(rowId: string, spans: number[]): void;
  onSaveComponent(): void;
  onDetach(): void;
  onEditComponent(): void;
}

export function Inspector(p: InspectorProps) {
  const t = useT('sites');
  const [tab, setTab] = useState('content');
  const { node } = p;
  const kind = kindOf(node);
  const spec = kind === 'block' ? BLOCKS[node.type] : undefined;
  const site = useSite();
  const set = p.patch;
  const setR = (bp: 'tablet' | 'phone', key: string, v: number | undefined) => set({ r: clean({ ...(node.r ?? {}), [bp]: { ...(node.r?.[bp] ?? {}), [key]: v } }) });
  const title = kind === 'block' ? (spec ? t(spec.label) : undefined) : kind === 'section' ? t('Abschnitt') : kind === 'row' ? t('Zeile') : t('Spalte');

  const content: ReactNode = (() => {
    if (kind === 'section')
      return (
        <>
          <Field label={t('Name (nur für dich in der Struktur)')}>
            <Input value={node.name} onChange={(v) => set({ name: v })} placeholder={t('z. B. Hero, Kontakt …')} />
          </Field>
          <div className="grid2">
            <Field label={t('Inhaltsbreite')}>
              <Select value={node.width ?? 'normal'} onChange={(v) => set({ width: v })} options={[['narrow', t('Schmal (760 px)')], ['normal', t('Normal (1100 px)')], ['wide', t('Breit (1320 px)')], ['full', t('Volle Breite')]]} />
            </Field>
            <Field label={t('Ausrichtung')}>
              <Select value={node.align ?? ''} onChange={(v) => set({ align: v || undefined })} options={[['', t('Wie Design')], ['left', t('Links')], ['center', t('Mitte')], ['right', t('Rechts')]]} />
            </Field>
          </div>
          <Field label={t('Anker (für Links wie #kontakt)')}>
            <Input value={node.anchor} onChange={(v) => set({ anchor: v })} placeholder={t('kontakt')} />
          </Field>
        </>
      );
    if (kind === 'row') {
      const cols: Block[] = node.cols ?? [];
      const total = cols.reduce((s, c) => s + (Number(c.span) || 0), 0);
      return (
        <>
          <Field label={t('Spalten')}>
            <div className="presets">
              {SECTION_PRESETS.map((pr) => (
                <button key={pr.key} className={`btn small ${cols.length === pr.spans.length && cols.every((c, i) => c.span === pr.spans[i]) ? '' : 'secondary'}`} onClick={() => p.setCols(node.id, pr.spans)}>
                  {t(pr.label)}
                </button>
              ))}
            </div>
          </Field>
          <Field label={t('Breite je Spalte (von 12)')} hint={total === 12 ? undefined : total < 12 ? t('Zusammen {n} von 12 – die Zeile ist nicht ganz gefüllt.', { n: total }) : t('Zusammen {n} von 12 – die Zeile ist zu breit und bricht um.', { n: total })}>
            <div className="spans">
              {cols.map((c, i) => (
                <Num key={c.id} value={c.span} min={1} max={12} label={t('Breite Spalte {n}', { n: i + 1 })} onChange={(v) => p.setCols(node.id, cols.map((x, j) => (j === i ? Math.min(12, Math.max(1, v ?? 1)) : Number(x.span) || 1)))} />
              ))}
              <button className="btn small ghost" onClick={() => p.setCols(node.id, evenCols(cols.map((c) => ({ ...c, span: 0 }))).map((c) => c.span))}>
                {t('Gleich breit')}
              </button>
            </div>
          </Field>
        </>
      );
    }
    if (kind === 'col')
      return (
        <div className="grid3">
          <Field label={t('Breite (von 12)')}>
            <Num value={node.span} min={1} max={12} label={t('Breite')} onChange={(v) => set({ span: v ?? 6 })} />
          </Field>
          <Field label={t('Ausrichtung')}>
            <Select value={node.align ?? ''} onChange={(v) => set({ align: v || undefined })} options={[['', t('Wie Abschnitt')], ['left', t('Links')], ['center', t('Mitte')], ['right', t('Rechts')]]} />
          </Field>
          <Field label={t('Senkrecht')}>
            <Select value={node.valign ?? ''} onChange={(v) => set({ valign: v || undefined })} options={[['', t('Oben')], ['center', t('Mitte')], ['bottom', t('Unten')]]} />
          </Field>
        </div>
      );
    if (!spec) return <p className="muted">{t('Unbekannter Blocktyp „{type}“ – er bleibt unverändert.', { type: node.type })}</p>;
    return (
      <>
        {spec.hint && <p className="muted small">{t(spec.hint)}</p>}
        {node.type === 'component' && node.component_id && (
          <div className="row">
            <button className="btn small secondary" onClick={p.onEditComponent}>
              {t('Komponente bearbeiten')}
            </button>
            <button className="btn small ghost" onClick={p.onDetach}>
              {t('Von Komponente lösen')}
            </button>
          </div>
        )}
        {spec.fields.map((f) => (
          <Field key={f[0]} label={t(f[2])}>
            <FieldInput f={f} value={node[f[0]]} set={set} />
          </Field>
        ))}
        {node.type === 'product' && node.product_id && site.products.length > 0 && !site.products.some((x) => x.id === node.product_id) && <p className="warn small">{t('Dieses Produkt gibt es in diesem Projekt nicht (mehr).')}</p>}
        {spec.items && <ItemsEditor spec={spec} node={node} set={set} />}
      </>
    );
  })();

  const style: ReactNode = (() => {
    if (kind === 'section')
      return (
        <>
          <div className="grid2">
            <Field label={t('Hintergrund')}>
              <ColorField value={node.bg} onChange={(v) => set({ bg: v })} none={t('Transparent')} />
            </Field>
            <Field label={t('Textfarbe (leer = automatisch lesbar)')}>
              <ColorField value={node.color} onChange={(v) => set({ color: v })} none={t('Automatisch')} />
            </Field>
          </div>
          <ContrastHint fg={node.color} bg={node.bg} />
          <Field label={t('Hintergrundbild')}>
            <ImageField value={node.bg_image ?? ''} onChange={(url) => set({ bg_image: url || undefined })} />
          </Field>
          {node.bg_image && (
            <Field label={t('Abdunkeln: {n} %', { n: node.bg_overlay ?? 0 })}>
              <input type="range" min={0} max={90} step={5} value={node.bg_overlay ?? 0} onChange={(e) => set({ bg_overlay: Number(e.target.value) })} />
            </Field>
          )}
          <div className="grid3">
            <Field label={t('Abstand oben/unten (px)')}>
              <Num value={node.pad_y} min={0} max={240} label={t('Abstand oben und unten')} onChange={(v) => set({ pad_y: v ?? 0 })} />
            </Field>
            <Field label={t('Abstand links/rechts (px)')}>
              <Num value={node.pad_x} min={0} max={120} label={t('Abstand links und rechts')} onChange={(v) => set({ pad_x: v ?? 0 })} />
            </Field>
            <Field label={t('Ecken (px)')}>
              <Num value={node.radius} min={0} max={64} label={t('Eckenradius')} onChange={(v) => set({ radius: v })} />
            </Field>
          </div>
          <BorderField node={node} patch={set} />
        </>
      );
    if (kind === 'row')
      return (
        <>
          <div className="grid3">
            <Field label={t('Abstand zwischen Spalten (px)')}>
              <Num value={node.gap} min={0} max={80} label={t('Spaltenabstand')} onChange={(v) => set({ gap: v ?? 0 })} />
            </Field>
            <Field label={t('Senkrecht')}>
              <Select value={node.valign ?? ''} onChange={(v) => set({ valign: v || undefined })} options={[['', t('Oben')], ['center', t('Mitte')], ['bottom', t('Unten')], ['stretch', t('Gleich hoch')]]} />
            </Field>
          </div>
          <Check checked={!!node.rev} onChange={(v) => set({ rev: v || undefined })} label={t('Reihenfolge der Spalten umdrehen (auf dem Handy zuerst die rechte)')} />
        </>
      );
    if (kind === 'col')
      return (
        <>
          <div className="grid2">
            <Field label={t('Hintergrund')}>
              <ColorField value={node.bg} onChange={(v) => set({ bg: v })} none={t('Transparent')} />
            </Field>
            <Field label={t('Innenabstand (px)')}>
              <Num value={node.pad} min={0} max={80} label={t('Innenabstand')} onChange={(v) => set({ pad: v })} />
            </Field>
            <Field label={t('Ecken (px)')}>
              <Num value={node.radius} min={0} max={64} label={t('Eckenradius')} onChange={(v) => set({ radius: v })} />
            </Field>
            <Field label={t('Schatten')}>
              <Select value={node.shadow ?? ''} onChange={(v) => set({ shadow: v || undefined })} options={[['', t('Keiner')], ['sm', t('Dezent')], ['md', t('Mittel')], ['lg', t('Stark')]]} />
            </Field>
          </div>
          <BorderField node={node} patch={set} />
          <Check checked={!!node.sticky} onChange={(v) => set({ sticky: v || undefined })} label={t('Beim Scrollen mitlaufen (nur Desktop)')} />
        </>
      );
    if (spec?.plain) return <p className="muted small">{t('Dieser Block hat keine Farb- und Abstandsoptionen.')}</p>;
    return (
      <>
        <div className="grid2">
          <Field label={t('Hintergrund')}>
            <ColorField value={node.bg} onChange={(v) => set({ bg: v })} none={t('Transparent')} />
          </Field>
          <Field label={t('Textfarbe')}>
            <ColorField value={node.color} onChange={(v) => set({ color: v })} none={t('Automatisch')} />
          </Field>
        </div>
        <ContrastHint fg={node.color} bg={node.bg} />
        <div className="grid3">
          <Field label={t('Ausrichtung')}>
            <Select value={node.align ?? ''} onChange={(v) => set({ align: v || undefined })} options={[['', t('Standard')], ['left', t('Links')], ['center', t('Mitte')], ['right', t('Rechts')]]} />
          </Field>
          <Field label={t('Innenabstand (px)')}>
            <Num value={node.padding} min={0} max={240} placeholder="48" label={t('Innenabstand')} onChange={(v) => set({ padding: v })} />
          </Field>
          <Field label={t('Schatten')}>
            <Select value={node.shadow ?? ''} onChange={(v) => set({ shadow: v || undefined })} options={[['', t('Keiner')], ['sm', t('Dezent')], ['md', t('Mittel')], ['lg', t('Stark')]]} />
          </Field>
        </div>
      </>
    );
  })();

  const responsive: ReactNode = (
    <>
      <HideField node={node} patch={set} />
      {kind === 'row' && (
        <Field label={t('Spalten untereinander ab')} hint={t('Darunter stehen die Spalten übereinander.')}>
          <Select value={node.stack ?? 'phone'} onChange={(v) => set({ stack: v })} options={[['phone', t('Handy (bis 640 px)')], ['tablet', t('Tablet (bis 1024 px)')], ['never', t('Nie – immer nebeneinander')]]} />
        </Field>
      )}
      {kind === 'col' && (
        <Field label={t('Breite auf kleineren Geräten (von 12, leer = wie Desktop)')}>
          <div className="grid2">
            <label className="mini">
              <span>{t('Tablet')}</span>
              <Num value={node.r?.tablet?.span} min={1} max={12} label={t('Breite Tablet')} onChange={(v) => setR('tablet', 'span', v)} />
            </label>
            <label className="mini">
              <span>{t('Handy')}</span>
              <Num value={node.r?.phone?.span} min={1} max={12} label={t('Breite Handy')} onChange={(v) => setR('phone', 'span', v)} />
            </label>
          </div>
        </Field>
      )}
      {kind === 'section' && (
        <Field label={t('Abstand oben/unten auf kleineren Geräten (px)')}>
          <div className="grid2">
            <label className="mini">
              <span>{t('Tablet')}</span>
              <Num value={node.r?.tablet?.pad_y} min={0} max={240} label={t('Abstand Tablet')} onChange={(v) => setR('tablet', 'pad_y', v)} />
            </label>
            <label className="mini">
              <span>{t('Handy')}</span>
              <Num value={node.r?.phone?.pad_y} min={0} max={240} label={t('Abstand Handy')} onChange={(v) => setR('phone', 'pad_y', v)} />
            </label>
          </div>
        </Field>
      )}
      {kind !== 'row' && <FsField node={node} patch={set} />}
      {kind === 'block' && !spec?.plain && (
        <Field label={t('Anker (für Links wie #preise)')}>
          <Input value={node.anchor} onChange={(v) => set({ anchor: v })} placeholder={t('preise')} />
        </Field>
      )}
    </>
  );

  return (
    <div className="inspector card" data-tour="site-inspector">
      <div className="insp-head">
        <h3>{title}</h3>
        {(kind === 'section' || kind === 'block') && node.type !== 'component' && (
          <button className="btn small ghost" onClick={p.onSaveComponent} data-tour="site-save-component">
            {t('Als Komponente speichern')}
          </button>
        )}
      </div>
      <Tabs tabs={[['content', t('Inhalt')], ...(kind === 'block' && spec?.plain && node.type !== 'spacer' ? [] : [['style', t('Stil')] as [string, string]]), ['responsive', t('Geräte')]]} value={tab} onChange={setTab} />
      <div className="insp-body">{tab === 'content' ? content : tab === 'style' ? style : responsive}</div>
    </div>
  );
}
