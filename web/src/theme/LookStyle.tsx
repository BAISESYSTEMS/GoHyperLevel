import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { BACKDROPS, BORDERS, HEADER_STYLES, RADII, SHADOWS, SIDE_STYLES, STYLE_KEYS, SURFACES, TYPEFACES, type Prefs } from '../../../server/services/appearance-model';
import { api } from '../api';
import { useT, type TFn } from '../i18n';
import { act, toastError } from '../ui';
import { Icon } from '../icons';
import { sideTokens } from './css';
import { TYPEFACE_STACKS, styleOf, styleVars, type StyleInput } from './look';
import { BACKDROP_LABEL, BORDER_LABEL, HEADER_LABEL, LOOK_PRESETS, RADIUS_LABEL, SHADOW_LABEL, SIDE_STYLE_LABEL, SURFACE_LABEL, TYPEFACE_LABEL, presetOf } from './look-presets';
import { resolveDark, update } from './store';
import './look-editor.css';

/**
 * Einstellungen → Darstellung → Stil & Fenster: presets with a mini window each (one click sets every style key),
 * then the fine-tuning – window style, corners, shadow, border, typeface, sidebar, top bar, background. Every choice
 * applies to the whole app at once (store.update), so the app itself is the live preview. Colours stay with the theme.
 * An own background picture is re-encoded in the browser (JPEG, ≤ 2400 px, no photo metadata) and uploaded once.
 */

/** A picture file → a JPEG data: URL of at most 2400 px on the long side (smaller upload, EXIF and GPS data gone). */
export async function pictureToJpeg(file: File, max = 2400): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * scale));
  c.height = Math.max(1, Math.round(bmp.height * scale));
  const g = c.getContext('2d');
  if (!g) throw new Error('canvas');
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c.toDataURL('image/jpeg', 0.85);
}

/** Uploads an own background picture; resolves to its path for `backdrop_image` (undefined when it failed – a toast said why). */
export async function uploadBackdrop(file: File, t: TFn): Promise<string | undefined> {
  let data: string;
  try {
    data = await pictureToJpeg(file);
  } catch {
    toastError(new Error(t('Dieses Bild kann der Browser nicht lesen – bitte JPG, PNG oder WebP.')));
    return undefined;
  }
  const r = await act(() => api.post<{ url: string }>('/api/appearance/backdrop', { name: file.name.slice(0, 200), data }));
  return r?.url;
}

/** A tiny app window in a style – its look comes only from the inline variables, whatever the page has. */
export function LookMini({ s, p }: { s: StyleInput; p: Prefs }) {
  const dark = resolveDark(p.mode);
  const side = sideTokens({ theme: p.theme, style: s }, dark);
  const vars = { ...styleVars(s, dark), '--lk-side': side.side, '--lk-side-text': side.sideText } as CSSProperties;
  return (
    <div className="lk-mini" style={vars} data-surface={s.surface} data-side={s.side_style} data-head={s.header} aria-hidden="true">
      <div className="lk-side">
        <i />
        <i className="on" />
        <i />
        <i />
      </div>
      <div className="lk-main">
        <div className="lk-head">
          <i />
          <span>Aa</span>{/* i18n-ignore: a type sample, the same in every language */}
        </div>
        <div className="lk-cards">
          <div className="lk-card">
            <b />
            <u />
            <u style={{ width: '60%' }} />
          </div>
          <div className="lk-card">
            <b />
            <u />
          </div>
        </div>
        <div className="lk-btn" />
      </div>
    </div>
  );
}

/** A labelled row of the fine-tuning. */
function Tune({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="small muted">{title}</div>
      {children}
      {hint && <div className="muted small" style={{ marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

/** Seg with translated labels. */
function Choice<T extends string>({ t, value, options, labels, onChange, disabled, label, font }: { t: TFn; value: T; options: readonly T[]; labels: Record<T, string | [string, string]>; onChange: (v: T) => void; disabled?: boolean; label: string; font?: (v: T) => string | undefined }) {
  const text = (v: T) => {
    const l = labels[v];
    return t(Array.isArray(l) ? l[0] : l);
  };
  return (
    <div className="ap-seg" role="radiogroup" aria-label={label}>
      {options.map((v) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)} disabled={disabled} style={font ? { fontFamily: font(v) } : undefined}>
          {text(v)}
        </button>
      ))}
    </div>
  );
}

export function LookStyle({ p, lock }: { p: Prefs; lock: boolean }) {
  const t = useT('look');
  const s = styleOf(p);
  const active = presetOf(s);
  const dark = resolveDark(p.mode);
  const set = (patch: Partial<StyleInput>) => void update(patch);
  return (
    <>
      <div className="lk-presets" role="radiogroup" aria-label={t('Voreinstellungen')} data-tour="appearance-style-presets">
        {LOOK_PRESETS.map((pr) => (
          <button key={pr.id} type="button" className={`lk-preset${active === pr.id ? ' on' : ''}`} onClick={() => set(pr.style)} disabled={lock} role="radio" aria-checked={active === pr.id} data-tour={`look-preset-${pr.id}`}>
            <LookMini s={pr.style} p={p} />
            <span className="lk-preset-head">
              <b>{t(pr.name)}</b>
              {active === pr.id && <Icon name="ok" size={15} />}
            </span>
            <span className="muted small">{t(pr.blurb)}</span>
          </button>
        ))}
      </div>
      {!active && <p className="muted small" style={{ margin: '8px 0 0' }}>{t('Eigene Mischung – wähle oben eine Voreinstellung oder stimme unten fein ab.')}</p>}

      <div className="lk-tune" data-tour="appearance-style-tune">
        <h3 style={{ margin: '6px 0 0' }}>{t('Feineinstellung')}</h3>
        <Tune title={t('Fensterstil')}>
          <div className="lk-surfaces" role="radiogroup" aria-label={t('Fensterstil')}>
            {SURFACES.map((id) => (
              <button key={id} type="button" className={`lk-surface${s.surface === id ? ' on' : ''}`} onClick={() => set({ surface: id })} disabled={lock} role="radio" aria-checked={s.surface === id}>
                <span className="lk-sample" style={styleVars({ ...s, surface: id, radius: 'auto', shadow: 'auto', border: 'auto' }, dark) as CSSProperties} aria-hidden="true" />
                <b>{t(SURFACE_LABEL[id][0])}</b>
                <span className="muted small">{t(SURFACE_LABEL[id][1])}</span>
              </button>
            ))}
          </div>
        </Tune>
        <Tune title={t('Ecken')}>
          <Choice t={t} label={t('Ecken')} value={s.radius} options={RADII} labels={RADIUS_LABEL} onChange={(v) => set({ radius: v })} disabled={lock} />
        </Tune>
        <Tune title={t('Schatten')}>
          <Choice t={t} label={t('Schatten')} value={s.shadow} options={SHADOWS} labels={SHADOW_LABEL} onChange={(v) => set({ shadow: v })} disabled={lock} />
        </Tune>
        <Tune title={t('Rahmen')}>
          <Choice t={t} label={t('Rahmen')} value={s.border} options={BORDERS} labels={BORDER_LABEL} onChange={(v) => set({ border: v })} disabled={lock} />
        </Tune>
        <Tune title={t('Schriftart')} hint={t('Schriften, die dein Gerät schon hat – nichts wird nachgeladen. Fehlt eine, springt die nächste ähnliche ein.')}>
          <Choice t={t} label={t('Schriftart')} value={s.typeface} options={TYPEFACES} labels={TYPEFACE_LABEL} onChange={(v) => set({ typeface: v })} disabled={lock} font={(v) => TYPEFACE_STACKS[v]} />
        </Tune>
        <Tune title={t('Seitenleiste')} hint={t(SIDE_STYLE_LABEL[s.side_style][1])}>
          <Choice t={t} label={t('Stil der Seitenleiste')} value={s.side_style} options={SIDE_STYLES} labels={SIDE_STYLE_LABEL} onChange={(v) => set({ side_style: v })} disabled={lock} />
        </Tune>
        <Tune title={t('Kopfzeile')} hint={t(HEADER_LABEL[s.header][1])}>
          <Choice t={t} label={t('Kopfzeile')} value={s.header} options={HEADER_STYLES} labels={HEADER_LABEL} onChange={(v) => set({ header: v })} disabled={lock} />
        </Tune>
        <Tune title={t('Hintergrund')} hint={t('Hinter den Seiten – am schönsten mit „Glas“ oder einer schwebenden Seitenleiste.')}>
          <Backdrops t={t} s={s} dark={dark} lock={lock} />
        </Tune>
        <div className="actions">
          <button type="button" className="btn secondary small" disabled={lock} onClick={() => void update(Object.fromEntries([...STYLE_KEYS, 'backdrop_image'].map((k) => [k, null])) as { [K in keyof Prefs]?: null })} data-tour="appearance-style-reset">
            <Icon name="reset" size={14} /> {t('Stil zurücksetzen')}
          </button>
          <span className="muted small">{t('Farben, Dichte und Schriftgröße bleiben, wie sie sind.')}</span>
        </div>
      </div>
    </>
  );
}

/** The background tiles, the last one the own picture (upload, replace, remove). */
function Backdrops({ t, s, dark, lock }: { t: TFn; s: StyleInput; dark: boolean; lock: boolean }) {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    const url = await uploadBackdrop(f, t);
    setBusy(false);
    if (url) void update({ backdrop: 'image', backdrop_image: url });
  };
  return (
    <>
      <div className="lk-backdrops" role="radiogroup" aria-label={t('Hintergrund')}>
        {BACKDROPS.map((id) => {
          const empty = id === 'image' && !s.backdrop_image;
          return (
            <button
              key={id}
              type="button"
              className={`lk-backdrop${s.backdrop === id ? ' on' : ''}`}
              style={styleVars({ ...s, backdrop: id }, dark) as CSSProperties}
              onClick={() => (empty ? file.current?.click() : update({ backdrop: id }))}
              disabled={lock || busy}
              role="radio"
              aria-checked={s.backdrop === id}
              data-tour={`look-backdrop-${id}`}
            >
              {empty && <Icon name="image" size={18} />}
              {t(BACKDROP_LABEL[id])}
            </button>
          );
        })}
      </div>
      <div className="lk-upload">
        <label className={`btn secondary small${lock || busy ? ' disabled' : ''}`} aria-disabled={lock || busy}>
          <Icon name="upload" size={14} /> {busy ? t('Wird hochgeladen …') : s.backdrop_image ? t('Anderes Bild hochladen') : t('Eigenes Bild hochladen')}
          <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" disabled={lock || busy} onChange={(e) => (void pick(e.target.files?.[0]), (e.target.value = ''))} />
        </label>
        {s.backdrop_image && (
          <button type="button" className="btn ghost small" disabled={lock || busy} onClick={() => void update({ backdrop_image: null, ...(s.backdrop === 'image' ? { backdrop: null } : {}) })}>
            <Icon name="trash" size={14} /> {t('Bild entfernen')}
          </button>
        )}
        <span className="muted small">{t('Das Foto wird so abgeschwächt, dass Schrift darauf immer lesbar bleibt.')}</span>
      </div>
    </>
  );
}
