import { createContext, useContext, useState } from 'react';
import { api } from '../../api';
import { Check, Input, Select, Spinner, Textarea, act } from '../../ui';
import { GenImageButton } from '../GenMediaKit';
import { coerce, imageKeys, type F } from './blocks';
import { prepareImage } from './image-prep';
import { intlLocale, useT } from '../../i18n';

/** What the fields of the editor choose from: the account's forms, calendars, products and the site's collections, components and pages. */
export interface SiteData {
  funnelId: string;
  forms: any[];
  calendars: any[];
  products: any[];
  collections: any[];
  components: any[];
  pages: { id: string; name: string; slug: string }[];
  /** Colour tokens of the site (name → hex), for the swatches. */
  colors: Record<string, string>;
}
export const SiteCtx = createContext<SiteData>({ funnelId: '', forms: [], calendars: [], products: [], collections: [], components: [], pages: [], colors: {} });
export const useSite = () => useContext(SiteCtx);

/** German names of the colour tokens (message ids of the sites catalog), shown through t(). */
export const COLOR_LABELS: Record<string, string> = { brand: 'Marke', accent: 'Akzent', text: 'Text', muted: 'Gedämpft', bg: 'Hintergrund', surface: 'Fläche', line: 'Linie', success: 'Erfolg', danger: 'Fehler' };
export const COLOR_NAMES = Object.keys(COLOR_LABELS);

/** Hex of a colour value (hex or token:<name>) for swatches and the contrast hint. */
export function resolveColor(v: string | undefined, colors: Record<string, string>): string {
  if (!v) return '';
  if (v.startsWith('token:')) return colors[v.slice(6)] ?? '';
  return /^#[0-9a-f]{3,8}$/i.test(v) ? v : '';
}

/** A colour: one of the site's colours (they follow the design) or a colour of its own. */
export function ColorField({ value, onChange, none }: { value: string | undefined; onChange: (v: string) => void; none?: string }) {
  const t = useT('sites');
  const { colors } = useSite();
  const v = value ?? '';
  const mode = !v ? '' : v.startsWith('token:') ? v : 'custom';
  const hex = resolveColor(v, colors) || '#ffffff';
  return (
    <div className="colorfield">
      <span className="swatch" style={{ background: resolveColor(v, colors) || 'transparent' }} aria-hidden="true" />
      <select value={mode} onChange={(e) => onChange(e.target.value === 'custom' ? hex.slice(0, 7) : e.target.value)} aria-label={t('Farbe')}>
        <option value="">{none ?? t('Standard')}</option>
        {COLOR_NAMES.map((n) => (
          <option key={n} value={`token:${n}`}>
            {t(COLOR_LABELS[n])}
          </option>
        ))}
        <option value="custom">{t('Eigene Farbe …')}</option>
      </select>
      {mode === 'custom' && <input type="color" value={hex.slice(0, 7)} onChange={(e) => onChange(e.target.value)} aria-label={t('Eigene Farbe wählen')} />}
    </div>
  );
}

/** A link: a page of this site (follows renames), an address, an anchor or mail/phone. */
export function LinkField({ value, onChange }: { value: string | undefined; onChange: (v: string) => void }) {
  const t = useT('sites');
  const { pages } = useSite();
  const v = value ?? '';
  const isPage = v.startsWith('page:') && pages.some((p) => `page:${p.id}` === v);
  const [custom, setCustom] = useState(!!v && !isPage);
  return (
    <div className="linkfield">
      <select
        value={custom ? 'custom' : v}
        onChange={(e) => {
          if (e.target.value === 'custom') {
            setCustom(true);
            if (isPage) onChange('');
          } else {
            setCustom(false);
            onChange(e.target.value);
          }
        }}
        aria-label={t('Linkziel')}
      >
        <option value="">{t('– kein Link –')}</option>
        {pages.map((p) => (
          <option key={p.id} value={`page:${p.id}`}>
            {t('Seite:')} {p.name}
          </option>
        ))}
        <option value="custom">{t('Adresse, Anker oder E-Mail …')}</option>
      </select>
      {custom && <Input value={v} onChange={onChange} placeholder={t('https://…, #anker, mailto:…, tel:…')} />}
    </div>
  );
}

/** Upload with scaled copies (srcset), size and a picture from the AI studio. `onChange(url, extra)`: extra = width, height, srcset. */
export function ImageField({ value, onChange }: { value: string; onChange: (v: string, size?: { w: number; h: number; srcset: string }) => void }) {
  const t = useT('sites');
  const [busy, setBusy] = useState('');
  const upload = async (file: File) => {
    setBusy(t('Bild wird vorbereitet …'));
    const r = await act(() =>
      prepareImage(
        file,
        (name, data) => api.post('/api/uploads', { name, data }),
        (d, n) => setBusy(t('Hochladen {d} von {n} …', { d, n })),
      ),
    );
    setBusy('');
    if (r) onChange(r.url, { w: r.w, h: r.h, srcset: r.srcset });
  };
  return (
    <div className="imgfield">
      <Input value={value} onChange={(v) => onChange(v, { w: 0, h: 0, srcset: '' })} placeholder={t('https://… oder hochladen')} />
      <div className="row">
        <label className="btn small secondary filebtn">
          {t('Bild hochladen')}
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} hidden />
        </label>
        <GenImageButton onPick={(u) => onChange(u.url, { w: 0, h: 0, srcset: '' })} />
        {value && (
          <button type="button" className="btn small ghost" onClick={() => onChange('', { w: 0, h: 0, srcset: '' })}>
            {t('Entfernen')}
          </button>
        )}
      </div>
      {busy && (
        <p className="muted small" role="status">
          {busy}
        </p>
      )}
      {value && /^(https?:\/\/|\/)/.test(value) && <img className="imgthumb" src={value} alt="" />}
    </div>
  );
}

const money = (c: number, cur: string) => new Intl.NumberFormat(intlLocale(), { style: 'currency', currency: cur || 'EUR' }).format(c / 100);

/** One field of a block, by its type. `set(patch)` writes one or more keys (images also write width, height and srcset). */
export function FieldInput({ f, value, set }: { f: F; value: any; set: (patch: Record<string, any>) => void }) {
  const t = useT('sites');
  const site = useSite();
  const [key, type, , opts] = f;
  const one = (v: any) => set({ [key]: v });
  if (type === 'textarea') return <Textarea value={value} onChange={one} rows={4} />;
  if (type === 'code') return <Textarea value={value} onChange={one} rows={8} className="mono" />;
  if (type === 'number') return <Input type="number" value={value ?? ''} onChange={(v) => one(v === '' ? '' : Number(v))} />;
  if (type === 'bool') return <Check checked={!!value} onChange={one} label={t('Ja')} />;
  if (type === 'link') return <LinkField value={value} onChange={one} />;
  if (type === 'image') {
    const k = imageKeys(key);
    return (
      <ImageField
        value={value ?? ''}
        onChange={(url, size) => set({ [key]: url, ...(size ? { [k.w]: size.w || undefined, [k.h]: size.h || undefined, [k.srcset]: size.srcset || undefined } : {}) })}
      />
    );
  }
  if (type === 'datetime') return <Input type="datetime-local" value={value ? String(value).slice(0, 16) : ''} onChange={(v) => one(v ? new Date(v).toISOString() : '')} />;
  if (type === 'select') return <Select value={String(value ?? '')} onChange={(v) => one(coerce(key, v))} options={(opts ?? []).map((o) => (typeof o === 'string' ? o : ([o[0], t(o[1])] as [string, string])))} />;
  if (type === 'form') return <Select value={value} onChange={one} placeholder={t('Formular wählen…')} options={site.forms.map((x) => [x.id, x.name])} />;
  if (type === 'calendar') return <Select value={value} onChange={one} placeholder={t('Kalender wählen…')} options={site.calendars.map((x) => [x.slug, x.name])} />;
  if (type === 'product')
    return <Select value={value} onChange={one} placeholder={t('Produkt wählen…')} options={site.products.filter((p) => p.active !== 0).map((p) => [p.id, `${p.name} · ${money(p.price_cents, p.currency)}`])} />;
  if (type === 'collection') return <Select value={value} onChange={one} placeholder={t('Sammlung wählen…')} options={site.collections.map((c) => [c.id, c.name])} />;
  if (type === 'component') return <Select value={value} onChange={one} placeholder={t('Komponente wählen…')} options={site.components.map((c) => [c.id, c.name])} />;
  return <Input value={value} onChange={one} />;
}

export function Loading() {
  return <Spinner />;
}
