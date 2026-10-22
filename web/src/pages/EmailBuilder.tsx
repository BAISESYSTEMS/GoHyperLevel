import { Fragment, Suspense, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { Icon, type IconName } from '../icons';
import { useSession } from '../session';
import { act, confirmAsk, Modal, pressable, toast, useLoad } from '../ui';
import {
  DEFAULT_SETTINGS,
  FONTS,
  LAYOUTS,
  SOCIAL_NETWORKS,
  UNSUBSCRIBE_TOKEN,
  blockDefaults,
  cloneSection,
  designIssues,
  emptyDesign,
  escapeHtml,
  htmlToText,
  isFullHtmlDocument,
  newBlock,
  newSection,
  normalizeDesign,
  renderBlockHtml,
  renderEmailHtml,
  renderEmailText,
  type Align,
  type Block,
  type BlockStyle,
  type BlockType,
  type EmailDesign,
  type EmailSettings,
  type Section,
} from '../../../server/services/email-render';
import { STARTERS } from '../../../server/services/email-starters';
import { MoreFields, useSimple } from '../areas/fields';
import { changedAgainst } from '../areas/marketing-fields';
import { GenImageButton } from './GenMediaKit';
import { tr, useT } from '../i18n';
import { lazyPages } from '../lazy';

// The AI writer of the Funnel & Website AI for text blocks (docs/site-ai.md#ai-writer).
const { AiWriteButton } = lazyPages(() => import('./site/AiWriter'), 'AiWriteButton');

/**
 * Drag-and-drop email designer (like GHL's): palette left, canvas middle, settings right.
 * The canvas draws every block with the same renderer the server uses, so what you see is what
 * goes out. Used by campaigns, templates and the workflow step "E-Mail senden".
 */

export type BuilderMode = 'campaign' | 'template' | 'workflow';
export interface BuilderResult {
  design: EmailDesign;
  subject: string;
  html: string;
  text: string;
}

/** Icon and German name of each block type (the names are message ids of the email catalog). */
const BLOCK_META: Record<BlockType, [IconName, string]> = {
  heading: ['heading', 'Überschrift'],
  text: ['text', 'Text'],
  image: ['image', 'Bild'],
  button: ['button', 'Button'],
  divider: ['divider', 'Trennlinie'],
  spacer: ['spacer', 'Abstand'],
  social: ['social', 'Social Media'],
  video: ['video', 'Video'],
  html: ['code', 'HTML'],
  footer: ['footer', 'Footer'],
};
const PALETTE: BlockType[] = ['heading', 'text', 'image', 'button', 'divider', 'spacer', 'social', 'video', 'html', 'footer'];

/** Placeholder menu – German labels, shown through t(). */
const MERGE_FIELDS: [string, [string, string][]][] = [
  [
    'Kontakt',
    [
      ['{{contact.first_name|du}}', 'Vorname (sonst „du“)'],
      ['{{contact.first_name}}', 'Vorname'],
      ['{{contact.last_name}}', 'Nachname'],
      ['{{contact.name}}', 'Name'],
      ['{{contact.email}}', 'E-Mail'],
      ['{{contact.phone}}', 'Telefon'],
      ['{{contact.company}}', 'Firma'],
      ['{{contact.address}}', 'Adresse'],
      ['{{contact.city}}', 'Ort'],
      ['{{contact.website}}', 'Website'],
    ],
  ],
  [
    'Eigene Firma',
    [
      ['{{location.name}}', 'Firmenname'],
      ['{{location.address}}', 'Adresse'],
      ['{{location.phone}}', 'Telefon'],
      ['{{location.email}}', 'E-Mail'],
      ['{{location.website}}', 'Website'],
    ],
  ],
  ['Sonstiges', [['{{unsubscribe_url}}', 'Abmeldelink (Adresse)']]],
];

// i18n-ignore – sample person for previews (company and city are translated in fillSample)
const SAMPLE_CONTACT = { first_name: 'Max', last_name: 'Mustermann', name: 'Max Mustermann', full_name: 'Max Mustermann', email: 'max@example.com', phone: '+49 151 23456789', company: 'Musterfirma', city: 'Musterstadt', custom: {} };

/** Fills merge fields with sample data for the preview (the real values come at send time). */
function fillSample(html: string, location: Record<string, any> | undefined, escape = true): string {
  const t = tr('email');
  const data: Record<string, any> = { contact: { ...SAMPLE_CONTACT, company: t('Musterfirma'), city: t('Musterstadt') }, location: { name: t('Deine Firma'), address: t('Musterstraße 1, 12345 Musterstadt'), ...(location ?? {}) } };
  return html.replace(/\{\{\s*([\w.]+)\s*(?:\|([^}]*))?\}\}/g, (_m, path: string, fallback?: string) => {
    let cur: any = data;
    for (const k of path.split('.')) cur = cur == null ? undefined : cur[k];
    const v = cur === undefined || cur === null || cur === '' ? (fallback ?? '').trim() : String(cur);
    return escape ? escapeHtml(v) : v;
  });
}

/** A message body for the conversation view: builder emails as readable text, other HTML without tags. */
export const messageText = (body: string) => (isFullHtmlDocument(body) ? htmlToText(body.split(UNSUBSCRIBE_TOKEN).join('#')) : body.replace(/<[^>]+>/g, ' '));

/** The text version of a design as a starting point for a plain email (without the generated footer). */
export const designPlainText = (text: string | undefined) =>
  String(text ?? '')
    .replace(/(^|\n\n)--\n[\s\S]*$/, '')
    .split(UNSUBSCRIBE_TOKEN)
    .join('')
    .trim();

/**
 * A new block with its default texts in the UI language: the defaults come from the shared renderer
 * (server/services/email-render.ts) in German and are message ids of the email catalog.
 */
function localBlock(type: BlockType): Block {
  const t = tr('email');
  const b = newBlock(type);
  for (const k of ['text', 'label', 'alt', 'caption', 'html', 'unsubscribeLabel']) if (typeof b.props[k] === 'string' && b.props[k]) b.props[k] = t(b.props[k]);
  return b;
}

/** A finding of the design check (designIssues) in the UI language. */
function issueText(text: string): string {
  const t = tr('email');
  const button = /^Button „(.*)“: Link fehlt oder ist ungültig \(https:\/\/, mailto: oder tel:\)$/s.exec(text);
  if (button) return t('Button „{label}“: Link fehlt oder ist ungültig (https://, mailto: oder tel:)', { label: button[1] });
  return t(text);
}

/** Previews never get scripts; links open in a new tab. */
const previewDoc = (html: string) => html.replace('<head>', '<head><base target="_blank">');

// --- history (undo/redo) -----------------------------------------------------------------------

interface History {
  past: EmailDesign[];
  present: EmailDesign;
  future: EmailDesign[];
}

function useDesignHistory(initial: EmailDesign) {
  const [h, setH] = useState<History>({ past: [], present: initial, future: [] });
  const last = useRef<{ key: string; at: number } | null>(null);
  /** Applies a change to a copy of the current design; typing in one field (same key) is one undo step. */
  const edit = useCallback((fn: (d: EmailDesign) => void, key?: string) => {
    const t = Date.now();
    const coalesce = !!key && last.current?.key === key && t - last.current.at < 1200;
    last.current = key ? { key, at: t } : null;
    setH((st) => {
      const next = structuredClone(st.present);
      fn(next);
      return { past: coalesce ? st.past : [...st.past, st.present].slice(-100), present: next, future: [] };
    });
  }, []);
  const undo = useCallback(() => {
    last.current = null;
    setH((st) => (st.past.length ? { past: st.past.slice(0, -1), present: st.past[st.past.length - 1], future: [st.present, ...st.future] } : st));
  }, []);
  const redo = useCallback(() => {
    last.current = null;
    setH((st) => (st.future.length ? { past: [...st.past, st.present], present: st.future[0], future: st.future.slice(1) } : st));
  }, []);
  return { design: h.present, canUndo: h.past.length > 0, canRedo: h.future.length > 0, edit, undo, redo };
}

// --- tree helpers ----------------------------------------------------------------------------------

type Pos = { s: number; c: number; i: number };

function findBlock(d: EmailDesign, id: string): (Pos & { block: Block }) | null {
  for (let s = 0; s < d.sections.length; s++)
    for (let c = 0; c < d.sections[s].columns.length; c++) {
      const i = d.sections[s].columns[c].blocks.findIndex((b) => b.id === id);
      if (i >= 0) return { s, c, i, block: d.sections[s].columns[c].blocks[i] };
    }
  return null;
}

const freshBlock = (b: Block): Block => ({ ...structuredClone(b), id: newBlock(b.type).id });

// --- placeholder insertion ---------------------------------------------------------------------

type InsertTarget = { el: HTMLInputElement | HTMLTextAreaElement; set: (v: string) => void };
const InsertCtx = createContext<{ current: InsertTarget | null }>({ current: null });

function insertAt(t: InsertTarget, token: string) {
  const v = t.el.value;
  const a = t.el.selectionStart ?? v.length;
  const b = t.el.selectionEnd ?? a;
  t.set(v.slice(0, a) + token + v.slice(b));
  requestAnimationFrame(() => {
    t.el.focus();
    t.el.setSelectionRange(a + token.length, a + token.length);
  });
}

function PInput({ value, onChange, placeholder, inputRef }: { value: string; onChange: (v: string) => void; placeholder?: string; inputRef?: React.Ref<HTMLInputElement> }) {
  const target = useContext(InsertCtx);
  return <input ref={inputRef} value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onFocus={(e) => (target.current = { el: e.currentTarget, set: onChange })} />;
}

function PTextarea({ value, onChange, rows = 4, mono, inputRef }: { value: string; onChange: (v: string) => void; rows?: number; mono?: boolean; inputRef?: React.Ref<HTMLTextAreaElement> }) {
  const target = useContext(InsertCtx);
  return (
    <textarea
      ref={inputRef}
      className={mono ? 'mono' : undefined}
      rows={rows}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => (target.current = { el: e.currentTarget, set: onChange })}
    />
  );
}

function MergeSelect({ customFields, onPick }: { customFields: any[]; onPick: (token: string) => void }) {
  const t = useT('email');
  return (
    <select className="eb-merge" value="" onChange={(e) => e.target.value && onPick(e.target.value)} aria-label={t('Platzhalter einfügen')}>
      <option value="">{t('Platzhalter einfügen…')}</option>
      {MERGE_FIELDS.map(([group, list]) => (
        <optgroup key={group} label={t(group)}>
          {list.map(([v, l]) => (
            <option key={v} value={v}>
              {t(l)}
            </option>
          ))}
        </optgroup>
      ))}
      {customFields.length > 0 && (
        <optgroup label={t('Eigene Felder')}>
          {customFields.map((f) => (
            <option key={f.key} value={`{{contact.custom.${f.key}}}`}>
              {f.label}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

// --- small settings inputs -----------------------------------------------------------------------

function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="field">
      <span>{label}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </div>
  );
}

function ColorInput({ label, value, onChange, allowEmpty, fallback = '#ffffff' }: { label: string; value: string | undefined; onChange: (v: string) => void; allowEmpty?: boolean; fallback?: string }) {
  const t = useT('email');
  const [txt, setTxt] = useState(value ?? '');
  useEffect(() => setTxt(value ?? ''), [value]);
  const full = (v: string) => (/^#[0-9a-f]{3}$/i.test(v) ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}` : /^#[0-9a-f]{6}$/i.test(v) ? v : '');
  return (
    <Row label={label}>
      <div className="eb-color">
        <input type="color" value={full(value ?? '') || fallback} onChange={(e) => onChange(e.target.value)} aria-label={label} />
        <input
          value={txt}
          placeholder={allowEmpty ? t('Standard') : '#000000'}
          onChange={(e) => {
            const v = e.target.value.trim();
            setTxt(e.target.value);
            if (!v && allowEmpty) onChange('');
            else if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v)) onChange(v.toLowerCase());
          }}
          onBlur={() => setTxt(value ?? '')}
        />
        {allowEmpty && value && (
          <button type="button" className="icon-btn" title={t('Standard verwenden')} onClick={() => onChange('')}>
            ✕
          </button>
        )}
      </div>
    </Row>
  );
}

function NumInput({ label, value, onChange, min, max, suffix = 'px', placeholder }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void; min: number; max: number; suffix?: string; placeholder?: string }) {
  const [txt, setTxt] = useState(value === undefined ? '' : String(value));
  useEffect(() => setTxt(value === undefined ? '' : String(value)), [value]);
  const commit = (raw: string, final: boolean) => {
    if (raw.trim() === '') return final && placeholder !== undefined ? onChange(undefined) : undefined;
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return;
    if (n >= min && n <= max) onChange(n);
    else if (final) onChange(Math.min(max, Math.max(min, n)));
  };
  return (
    <Row label={label}>
      <div className="eb-num">
        <input
          type="number"
          min={min}
          max={max}
          value={txt}
          placeholder={placeholder}
          onChange={(e) => (setTxt(e.target.value), commit(e.target.value, false))}
          onBlur={(e) => (commit(e.target.value, true), setTxt(value === undefined ? '' : String(value)))}
        />
        <span className="muted small">{suffix}</span>
      </div>
    </Row>
  );
}

function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: [T, ReactNode, string?][]; onChange: (v: T) => void }) {
  return (
    <div className="eb-seg" role="group">
      {options.map(([v, l, title]) => (
        <button type="button" key={String(v)} className={v === value ? 'on' : ''} title={title} aria-pressed={v === value} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

function RichText({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT('email');
  const ref = useRef<HTMLTextAreaElement>(null);
  const [link, setLink] = useState<{ url: string; a: number; b: number } | null>(null);
  const wrap = (before: string, after = before, placeholder = 'Text', range?: { a: number; b: number }) => {
    const el = ref.current;
    if (!el) return;
    const v = el.value;
    const a = range?.a ?? el.selectionStart;
    const b = range?.b ?? el.selectionEnd;
    const sel = v.slice(a, b) || placeholder;
    onChange(v.slice(0, a) + before + sel + after + v.slice(b));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + before.length, a + before.length + sel.length);
    });
  };
  const list = (ordered: boolean) => {
    const el = ref.current;
    if (!el) return;
    const v = el.value;
    const a = v.lastIndexOf('\n', el.selectionStart - 1) + 1;
    const endNl = v.indexOf('\n', el.selectionEnd);
    const b = endNl < 0 ? v.length : endNl;
    const lines = v.slice(a, b).split('\n').map((l, i) => (ordered ? `${i + 1}. ` : '- ') + l.replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
    onChange(v.slice(0, a) + lines.join('\n') + v.slice(b));
  };
  return (
    <>
      <div className="eb-rt-bar">
        <button type="button" title={t('Fett')} onClick={() => wrap('**')}>
          <b>B</b>
        </button>
        <button type="button" title={t('Kursiv')} onClick={() => wrap('*')}>
          <i>I</i>
        </button>
        <button type="button" title={t('Link')} onClick={() => ref.current && setLink({ url: 'https://', a: ref.current.selectionStart, b: ref.current.selectionEnd })}>
          <Icon name="link" size={14} />
        </button>
        <button type="button" title={t('Aufzählung')} onClick={() => list(false)}>
          {t('• Liste')}
        </button>
        <button type="button" title={t('Nummerierte Liste')} onClick={() => list(true)}>
          {t('1. Liste')}
        </button>
      </div>
      {link && (
        <div className="eb-link-row">
          <input value={link.url} autoFocus onChange={(e) => setLink({ ...link, url: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && (wrap('[', `](${link.url.trim()})`, t('Linktext'), link), setLink(null))} aria-label={t('Link-Adresse')} />
          <button type="button" className="btn small" onClick={() => (wrap('[', `](${link.url.trim()})`, t('Linktext'), link), setLink(null))}>
            {t('Einfügen')}
          </button>
          <button type="button" className="icon-btn" aria-label={t('Abbrechen')} onClick={() => setLink(null)}>
            ✕
          </button>
        </div>
      )}
      <PTextarea value={value} onChange={onChange} rows={9} inputRef={ref} />
      <small className="muted">{t('**fett**, *kursiv*, [Text](https://…); Zeilen mit „- “ oder „1. “ werden zur Liste.')}</small>
    </>
  );
}

// --- modals ---------------------------------------------------------------------------------------

function ImagePicker({ onPick, onClose }: { onPick: (url: string) => void; onClose: () => void }) {
  const t = useT('email');
  const list = useLoad(() => api.get<any[]>('/api/uploads'), []);
  const [busy, setBusy] = useState(false);
  const upload = (file: File) => {
    if (file.size > 8 * 1024 * 1024) return toast(t('Datei größer als 8 MB'));
    const r = new FileReader();
    r.onload = async () => {
      setBusy(true);
      const u = await act(() => api.post('/api/uploads', { name: file.name, data: r.result }));
      setBusy(false);
      if (u) onPick(u.url);
    };
    r.readAsDataURL(file);
  };
  const images = (list.data ?? []).filter((u) => String(u.mime).startsWith('image/'));
  return (
    <Modal title={t('Bild wählen')} onClose={onClose} wide>
      <div className="actions" style={{ marginBottom: 12 }}>
        <label className="btn secondary">
          {busy ? t('Lädt hoch…') : t('Bild hochladen')}
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
        <GenImageButton small={false} onPick={(u) => onPick(u.url)} />
      </div>
      {list.error && <p className="muted">{t('Uploads nicht verfügbar ({error}) – trage die Bild-Adresse direkt ein.', { error: list.error })}</p>}
      <div className="eb-uploads">
        {images.map((u) => (
          <button type="button" key={u.id} onClick={() => onPick(u.url)} title={u.name}>
            <img src={u.url} alt={u.name} loading="lazy" />
          </button>
        ))}
      </div>
      {!list.loading && !images.length && !list.error && <p className="muted">{t('Noch keine Bilder hochgeladen.')}</p>}
    </Modal>
  );
}

function StarterPicker({ onPick, onClose, location }: { onPick: (d: EmailDesign, subject: string) => void; onClose: () => void; location?: Record<string, any> }) {
  const t = useT('email');
  const starters = useMemo(() => STARTERS.map((s) => ({ ...s, design: s.build() })), []);
  return (
    <Modal title={t('Vorlage wählen')} onClose={onClose} wide>
      <div className="eb-starters">
        <button type="button" className="eb-starter" onClick={() => onPick(emptyDesign(), '')}>
          <div className="eb-thumb empty">
            <Icon name="column1" size={28} />
          </div>
          <strong>{t('Leer beginnen')}</strong>
          <span className="muted small">{t('Eigene Blöcke zusammenstellen')}</span>
        </button>
        {starters.map((s) => (
          <button type="button" key={s.key} className="eb-starter" onClick={() => onPick(s.design, s.subject)}>
            <div className="eb-thumb">
              <iframe title={t(s.name)} srcDoc={fillSample(renderEmailHtml(s.design), location)} sandbox="" tabIndex={-1} />
            </div>
            <strong>{t(s.name)}</strong>
            <span className="muted small">{t(s.description)}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function TestSend({ design, subject, onClose }: { design: EmailDesign; subject: string; onClose: () => void }) {
  const t = useT('email');
  const session = useSession();
  const [to, setTo] = useState(session?.user.email ?? '');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    const r = await act(() => api.post('/api/email-builder/test', { design: normalizeDesign(design), subject, to }));
    setBusy(false);
    if (r) {
      toast(r.status === 'logged' ? t('Gespeichert – es ist noch kein Versand (SMTP) eingerichtet') : t('Testmail an {to} gesendet', { to: r.to }));
      onClose();
    }
  };
  return (
    <Modal
      title={t('Testmail senden')}
      onClose={onClose}
      footer={
        <button className="btn" disabled={!to || busy} onClick={send}>
          <Icon name="send" /> {t('Senden')}
        </button>
      }
    >
      <Row label={t('An')} hint={t('Platzhalter werden mit Beispieldaten (Max Mustermann) gefüllt; der Betreff bekommt [TEST].')}>
        <input type="email" value={to} autoFocus onChange={(e) => setTo(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && to && send()} />
      </Row>
    </Modal>
  );
}

function SaveSection({ onSave, onClose }: { onSave: (name: string) => void; onClose: () => void }) {
  const t = useT('email');
  const [name, setName] = useState('');
  return (
    <Modal
      title={t('Abschnitt speichern')}
      onClose={onClose}
      footer={
        <button className="btn" disabled={!name.trim()} onClick={() => onSave(name.trim())}>
          {t('Speichern')}
        </button>
      }
    >
      <Row label="Name" hint={t('Gespeicherte Abschnitte (z. B. Kopfzeile mit Logo) findest du links unter „Meine Abschnitte“ – in allen E-Mails dieses Sub-Accounts.')}>
        <input value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && onSave(name.trim())} />
      </Row>
    </Modal>
  );
}

/** HTML blocks render in a sandboxed frame on the canvas (never in the app itself). */
function HtmlBlockPreview({ html }: { html: string }) {
  const t = useT('email');
  const ref = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(40);
  const fit = () => {
    const doc = ref.current?.contentDocument;
    if (doc?.body) setH(Math.max(24, Math.min(1200, doc.documentElement.scrollHeight)));
  };
  return (
    <div className="eb-html-wrap">
      <iframe ref={ref} title={t('HTML-Block')} sandbox="allow-same-origin" srcDoc={`<!doctype html><html><head><style>body{margin:0}</style></head><body>${html}</body></html>`} style={{ height: h }} onLoad={fit} tabIndex={-1} />
    </div>
  );
}

// --- the editor ------------------------------------------------------------------------------------

type Sel = { kind: 'block' | 'section'; id: string } | null;
type Drag = { kind: 'new-block'; type: BlockType } | { kind: 'new-section'; cols: number } | { kind: 'saved'; section: Section } | { kind: 'block'; id: string } | { kind: 'section'; id: string };
type Drop = { kind: 'section'; index: number } | { kind: 'block'; s: number; c: number; i: number } | null;

export function EmailBuilder({ initial, subject: initialSubject, mode, onSave, onClose, title: titleProp }: { initial?: EmailDesign | null; subject?: string; mode: BuilderMode; onSave: (r: BuilderResult) => unknown | Promise<unknown>; onClose: () => void; title?: string }) {
  const t = useT('email');
  const simple = useSimple();
  const title = titleProp ?? t('E-Mail-Designer');
  const start = useMemo(() => {
    try {
      return initial ? normalizeDesign(initial) : emptyDesign();
    } catch {
      return emptyDesign();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const { design, canUndo, canRedo, edit, undo, redo } = useDesignHistory(start);
  const [subject, setSubject] = useState(initialSubject ?? '');
  const [saved, setSaved] = useState<{ design: EmailDesign; subject: string }>({ design: start, subject: initialSubject ?? '' });
  const [sel, setSel] = useState<Sel>(null);
  const [device, setDevice] = useState<'desktop' | 'mobile'>(() => (window.innerWidth < 700 ? 'mobile' : 'desktop'));
  const [view, setView] = useState<'edit' | 'preview' | 'text'>('edit');
  const [modal, setModal] = useState<null | 'starters' | 'test' | 'image' | 'save-section'>(initial ? null : 'starters');
  const [imageTarget, setImageTarget] = useState<((url: string) => void) | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const sections = useLoad(() => api.get<any[]>('/api/email-builder/sections').catch(() => []), []);
  const customFields = useLoad(() => api.get<any[]>('/api/custom-fields').catch(() => []), []).data ?? [];
  const location = useLoad(() => api.get<any>('/api/location').catch(() => undefined), []).data;
  const insertTarget = useRef<InsertTarget | null>(null);
  const modalRef = useRef(modal);
  modalRef.current = modal;
  const s = design.settings;
  const dirty = design !== saved.design || subject !== saved.subject;
  const issues = useMemo(() => designIssues(design, { campaign: mode === 'campaign' }), [design, mode]);
  const errors = issues.filter((i) => i.level === 'error');

  // The page behind the full-screen editor is inert (no focus, no screen reader) while it is open.
  useEffect(() => {
    const root = document.getElementById('root');
    if (!root) return;
    root.inert = true;
    return () => {
      root.inert = false;
    };
  }, []);

  const requestClose = useCallback(() => {
    if (dirty && !confirmAsk(t('Ungespeicherte Änderungen verwerfen?'))) return;
    onClose();
  }, [dirty, onClose]);

  // --- mutations ---
  const select = (next: Sel) => {
    setSel(next);
    setPanelOpen(!!next);
  };
  const updateSettings = (patch: Partial<EmailSettings>, key?: string) => edit((d) => void Object.assign(d.settings, patch), key && `settings:${key}`);
  const updateBlock = (id: string, patch: { props?: Record<string, any>; style?: Partial<BlockStyle> }, key?: string) =>
    edit((d) => {
      const f = findBlock(d, id);
      if (!f) return;
      if (patch.props) Object.assign(f.block.props, patch.props);
      if (patch.style) Object.assign(f.block.style, patch.style);
    }, key && `${id}:${key}`);
  const updateSection = (id: string, style: Partial<Section['style']>, key?: string) =>
    edit((d) => {
      const sec = d.sections.find((x) => x.id === id);
      if (sec) Object.assign(sec.style, style);
    }, key && `${id}:${key}`);
  const setLayout = (id: string, widths: number[]) =>
    edit((d) => {
      const sec = d.sections.find((x) => x.id === id);
      if (!sec) return;
      const n = widths.length;
      if (sec.columns.length > n) {
        const extra = sec.columns.splice(n).flatMap((c) => c.blocks);
        sec.columns[n - 1].blocks.push(...extra);
      }
      while (sec.columns.length < n) sec.columns.push({ id: newSection(1).columns[0].id, blocks: [] });
      sec.widths = widths;
    });
  const addSection = (index: number, sec: Section) => {
    edit((d) => void d.sections.splice(index, 0, sec));
    select({ kind: 'section', id: sec.id });
  };
  const addBlock = (pos: Pos, b: Block) => {
    edit((d) => void d.sections[pos.s]?.columns[pos.c]?.blocks.splice(pos.i, 0, b));
    select({ kind: 'block', id: b.id });
  };
  const moveBlock = (id: string, to: Pos | { newSection: number }) =>
    edit((d) => {
      const f = findBlock(d, id);
      if (!f) return;
      const [b] = d.sections[f.s].columns[f.c].blocks.splice(f.i, 1);
      if ('newSection' in to) return void d.sections.splice(to.newSection, 0, newSection(1, [[b]]));
      const i = to.s === f.s && to.c === f.c && f.i < to.i ? to.i - 1 : to.i;
      d.sections[to.s].columns[to.c].blocks.splice(i, 0, b);
    });
  const moveSection = (id: string, index: number) =>
    edit((d) => {
      const from = d.sections.findIndex((x) => x.id === id);
      if (from < 0) return;
      const [sec] = d.sections.splice(from, 1);
      d.sections.splice(index > from ? index - 1 : index, 0, sec);
    });
  const removeBlock = (id: string) => {
    edit((d) => {
      const f = findBlock(d, id);
      if (f) d.sections[f.s].columns[f.c].blocks.splice(f.i, 1);
    });
    select(null);
  };
  const duplicateBlock = (id: string) =>
    edit((d) => {
      const f = findBlock(d, id);
      if (f) d.sections[f.s].columns[f.c].blocks.splice(f.i + 1, 0, freshBlock(f.block));
    });
  const nudgeBlock = (id: string, dir: -1 | 1) =>
    edit((d) => {
      const f = findBlock(d, id);
      if (!f) return;
      const list = d.sections[f.s].columns[f.c].blocks;
      const j = f.i + dir;
      if (j >= 0 && j < list.length) [list[f.i], list[j]] = [list[j], list[f.i]];
      else if (d.sections[f.s + dir]) {
        // At the edge of its section the block hops into the neighbouring section.
        list.splice(f.i, 1);
        const target = d.sections[f.s + dir].columns[Math.min(f.c, d.sections[f.s + dir].columns.length - 1)].blocks;
        if (dir < 0) target.push(f.block);
        else target.unshift(f.block);
      }
    });
  const removeSection = (id: string) => {
    edit((d) => void (d.sections = d.sections.filter((x) => x.id !== id)));
    select(null);
  };
  const duplicateSection = (id: string) =>
    edit((d) => {
      const i = d.sections.findIndex((x) => x.id === id);
      if (i >= 0) d.sections.splice(i + 1, 0, cloneSection(d.sections[i]));
    });
  const nudgeSection = (id: string, dir: -1 | 1) =>
    edit((d) => {
      const i = d.sections.findIndex((x) => x.id === id);
      const j = i + dir;
      if (i >= 0 && j >= 0 && j < d.sections.length) [d.sections[i], d.sections[j]] = [d.sections[j], d.sections[i]];
    });

  /** Click (or tap) in the palette: add next to the selection, otherwise at the end. */
  const quickAddBlock = (type: BlockType) => {
    const b = localBlock(type);
    if (sel?.kind === 'block') {
      const f = findBlock(design, sel.id);
      if (f) return addBlock({ s: f.s, c: f.c, i: f.i + 1 }, b);
    }
    if (sel?.kind === 'section') {
      const si = design.sections.findIndex((x) => x.id === sel.id);
      if (si >= 0) return addBlock({ s: si, c: 0, i: design.sections[si].columns[0].blocks.length }, b);
    }
    const footerAt = design.sections.findIndex((x) => x.columns.some((c) => c.blocks.some((bl) => bl.type === 'footer')));
    const sec = newSection(1, [[b]]);
    edit((d) => void d.sections.splice(type !== 'footer' && footerAt >= 0 ? footerAt : d.sections.length, 0, sec));
    select({ kind: 'block', id: b.id });
  };
  const quickAddSection = (sec: Section) => {
    const si = sel?.kind === 'section' ? design.sections.findIndex((x) => x.id === sel.id) : sel?.kind === 'block' ? findBlock(design, sel.id)?.s ?? -1 : -1;
    addSection(si >= 0 ? si + 1 : design.sections.length, sec);
  };

  // --- drag and drop (native HTML5) ---
  const drag = useRef<Drag | null>(null);
  const [drop, setDropState] = useState<Drop>(null);
  const dropRef = useRef<Drop>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const setDrop = (d: Drop) => {
    if (JSON.stringify(d) === JSON.stringify(dropRef.current)) return;
    dropRef.current = d;
    setDropState(d);
  };
  const isBlockDrag = () => drag.current?.kind === 'new-block' || drag.current?.kind === 'block';
  const startDrag = (e: React.DragEvent, d: Drag) => {
    e.stopPropagation();
    drag.current = d;
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', d.kind);
  };
  const endDrag = () => {
    drag.current = null;
    setDrop(null);
  };
  useEffect(() => {
    window.addEventListener('dragend', endDrag);
    return () => window.removeEventListener('dragend', endDrag);
  }, []);
  const overBlock = (e: React.DragEvent, s: number, c: number, i: number) => {
    if (!isBlockDrag()) return;
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    setDrop({ kind: 'block', s, c, i: e.clientY > r.top + r.height / 2 ? i + 1 : i });
  };
  const overColumn = (e: React.DragEvent, s: number, c: number, n: number) => {
    if (!isBlockDrag()) return;
    e.preventDefault();
    e.stopPropagation();
    setDrop({ kind: 'block', s, c, i: n });
  };
  const overPaper = (e: React.DragEvent) => {
    if (!drag.current) return;
    e.preventDefault();
    const els = Array.from(paperRef.current?.querySelectorAll<HTMLElement>(':scope > .eb-section') ?? []);
    let index = els.length;
    for (let k = 0; k < els.length; k++) {
      const r = els[k].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        index = k;
        break;
      }
    }
    setDrop({ kind: 'section', index });
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const d = drag.current;
    const target = dropRef.current;
    endDrag();
    if (!d || !target) return;
    if (target.kind === 'section') {
      if (d.kind === 'new-section') addSection(target.index, newSection(d.cols, [], LAYOUTS[d.cols][0]));
      else if (d.kind === 'saved') addSection(target.index, cloneSection(d.section));
      else if (d.kind === 'section') moveSection(d.id, target.index);
      else if (d.kind === 'new-block') {
        const b = localBlock(d.type);
        addSection(target.index, newSection(1, [[b]]));
        select({ kind: 'block', id: b.id });
      } else if (d.kind === 'block') moveBlock(d.id, { newSection: target.index });
    } else if (d.kind === 'new-block') addBlock(target, localBlock(d.type));
    else if (d.kind === 'block') moveBlock(d.id, target);
  };

  // --- keyboard: Esc closes, Ctrl+Z / Ctrl+Y, Entf löscht die Auswahl ---
  // Capture phase + stopPropagation: a dialog behind the builder (e.g. the template form) must not
  // close on the same Esc; an open dialog inside the builder closes first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (modalRef.current) return setModal(null);
        return requestClose();
      }
      const el = e.target as HTMLElement | null;
      if (el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable)) return;
      if (modalRef.current) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        e.preventDefault();
        if (sel.kind === 'block') removeBlock(sel.id);
        else removeSection(sel.id);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const save = async () => {
    setSaving(true);
    try {
      const clean = normalizeDesign(design);
      await onSave({ design: clean, subject, html: renderEmailHtml(clean), text: renderEmailText(clean) });
      setSaved({ design, subject });
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const insertMerge = (token: string) => {
    const target = insertTarget.current;
    if (target && document.body.contains(target.el)) return insertAt(target, token);
    if (sel?.kind === 'block') {
      const f = findBlock(design, sel.id);
      if (f?.block.type === 'text') return updateBlock(sel.id, { props: { text: `${f.block.props.text}${token}` } });
      if (f?.block.type === 'heading') return updateBlock(sel.id, { props: { text: `${f.block.props.text} ${token}` } });
    }
    toast(t('Erst in ein Textfeld klicken, dann den Platzhalter wählen'));
  };

  const pickImage = (apply: (url: string) => void) => {
    setImageTarget(() => apply);
    setModal('image');
  };

  const saveSection = async (name: string) => {
    if (sel?.kind !== 'section') return;
    const sec = design.sections.find((x) => x.id === sel.id);
    if (!sec) return;
    const r = await act(() => api.post('/api/email-builder/sections', { name, section: sec }), t('Abschnitt gespeichert'));
    if (r) {
      setModal(null);
      sections.reload();
    }
  };

  const selBlock = sel?.kind === 'block' ? findBlock(design, sel.id) : null;
  const selSection = sel?.kind === 'section' ? design.sections.find((x) => x.id === sel.id) : undefined;
  const previewHtml = useMemo(() => (view === 'edit' ? '' : previewDoc(fillSample(renderEmailHtml(normalizeDesign(design), { title: subject }), location))), [view, design, subject, location]);
  const previewText = useMemo(() => (view === 'text' ? fillSample(renderEmailText(normalizeDesign(design)), location, false) : ''), [view, design, location]);
  const paperWidth = device === 'mobile' ? 375 : s.width;

  // --- panels ---
  const palette = (
    <aside className="eb-palette" aria-label={t('Blöcke')} data-tour="eb-palette">
      <div className="eb-pal-group">{t('Layout')}</div>
      <div className="eb-pal-grid">
        {([1, 2, 3] as const).map((n) => (
          <div
            key={n}
            className="eb-pal-item"
            role="button"
            tabIndex={0}
            draggable
            onDragStart={(e) => startDrag(e, { kind: 'new-section', cols: n })}
            onClick={() => quickAddSection(newSection(n, [], LAYOUTS[n][0]))}
            onKeyDown={(e) => e.key === 'Enter' && quickAddSection(newSection(n, [], LAYOUTS[n][0]))}
          >
            <Icon name={n === 1 ? 'column1' : n === 2 ? 'columns2' : 'columns3'} />
            <span>{t.plural(n, { one: '1 Spalte', other: '{n} Spalten' })}</span>
          </div>
        ))}
      </div>
      <div className="eb-pal-group">{t('Inhalt')}</div>
      <div className="eb-pal-grid">
        {PALETTE.map((type) => (
          <div key={type} className="eb-pal-item" role="button" tabIndex={0} draggable onDragStart={(e) => startDrag(e, { kind: 'new-block', type })} onClick={() => quickAddBlock(type)} onKeyDown={(e) => e.key === 'Enter' && quickAddBlock(type)}>
            <Icon name={BLOCK_META[type][0]} />
            <span>{t(BLOCK_META[type][1])}</span>
          </div>
        ))}
      </div>
      <div className="eb-pal-group">{t('Meine Abschnitte')}</div>
      {(sections.data ?? []).map((r) => (
        <div key={r.id} className="eb-saved" draggable onDragStart={(e) => startDrag(e, { kind: 'saved', section: r.section })} onClick={() => quickAddSection(cloneSection(r.section))} role="button" tabIndex={0} title={t('Ziehen oder klicken zum Einfügen')}>
          <Icon name="bookmark" size={14} />
          <span className="grow">{r.name}</span>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('{name} löschen', { name: r.name })}
            onClick={(e) => {
              e.stopPropagation();
              if (confirmAsk(t('Abschnitt „{name}“ löschen?', { name: r.name }))) void act(() => api.del(`/api/email-builder/sections/${r.id}`)).then(sections.reload);
            }}
          >
            ✕
          </button>
        </div>
      ))}
      {!sections.data?.length && <p className="muted small eb-pal-hint">{t('Abschnitt anklicken → „Speichern“, um ihn wiederzuverwenden.')}</p>}
      <button type="button" className="btn secondary small eb-pal-starters" onClick={() => setModal('starters')}>
        <Icon name="template" size={14} /> {t('Vorlagen')}
      </button>
    </aside>
  );

  /** Look of a block (Einfach-Modus: behind a "Darstellung" toggle that opens when something differs from the block's defaults). */
  const styleFields = (b: Block, opts: { color?: boolean; font?: boolean; align?: boolean } = {}, extra?: { node: ReactNode; values: unknown[] }) => {
    const st = b.style;
    return (
      <MoreFields key={b.id} id="eb-style" label={t('Darstellung')} values={[...changedAgainst(st as Record<string, unknown>, blockDefaults(b.type).style as Record<string, unknown>), ...(extra?.values ?? [])]}>
        {!simple && <div className="eb-sub">{t('Darstellung')}</div>}
        {extra?.node}
        {opts.align !== false && (
          <Row label={t('Ausrichtung')}>
            <Segmented<Align>
              value={st.align ?? 'left'}
              options={[
                ['left', t('Links')],
                ['center', t('Mitte')],
                ['right', t('Rechts')],
              ]}
              onChange={(v) => updateBlock(b.id, { style: { align: v } })}
            />
          </Row>
        )}
        <div className="grid2">
          <NumInput label={t('Abstand oben/unten')} value={st.paddingY} min={0} max={120} onChange={(v) => updateBlock(b.id, { style: { paddingY: v ?? 0 } }, 'py')} />
          <NumInput label={t('Abstand seitlich')} value={st.paddingX} min={0} max={120} onChange={(v) => updateBlock(b.id, { style: { paddingX: v ?? 0 } }, 'px')} />
        </div>
        {opts.font && <NumInput label={t('Schriftgröße')} value={st.fontSize} min={8} max={72} placeholder={t('Standard')} onChange={(v) => updateBlock(b.id, { style: { fontSize: v } }, 'fs')} />}
        {opts.color !== false && <ColorInput label={t('Textfarbe')} value={st.color} allowEmpty fallback={s.textColor} onChange={(v) => updateBlock(b.id, { style: { color: v } }, 'color')} />}
        <ColorInput label={t('Hintergrund')} value={st.background} allowEmpty onChange={(v) => updateBlock(b.id, { style: { background: v } }, 'bg')} />
      </MoreFields>
    );
  };

  const blockPanel = (b: Block) => {
    const p = b.props;
    const set = (props: Record<string, any>, key?: string) => updateBlock(b.id, { props }, key);
    switch (b.type) {
      case 'heading':
        return (
          <>
            <Row label={t('Text')}>
              <PInput value={p.text} onChange={(v) => set({ text: v }, 'text')} />
            </Row>
            <Row label={t('Größe')}>
              <Segmented<number>
                value={p.level}
                options={[
                  [1, 'H1', t('Groß')],
                  [2, 'H2', t('Mittel')],
                  [3, 'H3', t('Klein')],
                ]}
                onChange={(v) => set({ level: v })}
              />
            </Row>
            {styleFields(b, { font: true })}
          </>
        );
      case 'text':
        return (
          <>
            <Row label={t('Text')}>
              <RichText value={p.text} onChange={(v) => set({ text: v }, 'text')} />
              <Suspense fallback={null}>
                <AiWriteButton kind="email" current={p.text} onText={(r) => set({ text: r.text }, 'text')} />
              </Suspense>
            </Row>
            {styleFields(b, { font: true })}
          </>
        );
      case 'image':
        return (
          <>
            <Row label={t('Bild-Adresse')}>
              <div className="eb-inline">
                <PInput value={p.src} placeholder="https://…" onChange={(v) => set({ src: v }, 'src')} />
                <button type="button" className="btn secondary small" onClick={() => pickImage((url) => set({ src: url }))}>
                  {t('Uploads')}
                </button>
              </div>
            </Row>
            <Row label={t('Alternativtext')} hint={t('Wird angezeigt, wenn Bilder blockiert sind, und vorgelesen.')}>
              <PInput value={p.alt} onChange={(v) => set({ alt: v }, 'alt')} />
            </Row>
            <Row label={t('Link (optional)')}>
              <PInput value={p.href} placeholder="https://…" onChange={(v) => set({ href: v }, 'href')} />
            </Row>
            {styleFields(b, { color: false }, { node: <NumInput label={t('Breite (leer = volle Breite)')} value={p.width || undefined} min={20} max={1200} placeholder={t('voll')} onChange={(v) => set({ width: v ?? 0 }, 'width')} />, values: [Number(p.width) > 0] })}
          </>
        );
      case 'button':
        return (
          <>
            <Row label={t('Beschriftung')}>
              <PInput value={p.label} onChange={(v) => set({ label: v }, 'label')} />
            </Row>
            <Row label={t('Link')} hint={t('https://…, mailto:… oder tel:…')}>
              <PInput value={p.href} onChange={(v) => set({ href: v }, 'href')} />
            </Row>
            {styleFields(
              b,
              { color: false, font: true },
              {
                node: (
                  <>
                    <div className="grid2">
                      <ColorInput label={t('Button-Farbe')} value={p.background} onChange={(v) => set({ background: v || '#2563eb' }, 'btnbg')} />
                      <ColorInput label={t('Schriftfarbe')} value={p.textColor} onChange={(v) => set({ textColor: v || '#ffffff' }, 'btnfg')} />
                    </div>
                    <NumInput label={t('Ecken-Rundung')} value={p.radius} min={0} max={40} onChange={(v) => set({ radius: v ?? 0 }, 'radius')} />
                    <label className="check">
                      <input type="checkbox" checked={!!p.fullWidth} onChange={(e) => set({ fullWidth: e.target.checked })} /> {t('Volle Breite')}
                    </label>
                  </>
                ),
                values: changedAgainst(p, blockDefaults('button').props, ['background', 'textColor', 'radius', 'fullWidth']),
              },
            )}
          </>
        );
      case 'divider':
        return (
          <>
            <ColorInput label={t('Farbe')} value={p.color} onChange={(v) => set({ color: v || '#e5e7eb' }, 'color')} />
            <div className="grid2">
              <NumInput label={t('Stärke')} value={p.thickness} min={1} max={10} onChange={(v) => set({ thickness: v ?? 1 }, 'th')} />
              <NumInput label={t('Breite')} value={p.width} min={10} max={100} suffix="%" onChange={(v) => set({ width: v ?? 100 }, 'w')} />
            </div>
            {styleFields(b, { color: false })}
          </>
        );
      case 'spacer':
        return <NumInput label={t('Höhe')} value={p.height} min={4} max={200} onChange={(v) => set({ height: v ?? 24 }, 'h')} />;
      case 'social':
        return (
          <>
            <Row label={t('Darstellung')}>
              <Segmented
                value={p.variant}
                options={[
                  ['icons', t('Symbole')],
                  ['text', t('Text-Links')],
                ]}
                onChange={(v) => set({ variant: v })}
              />
            </Row>
            {(p.items as { network: string; url: string }[]).map((it, i) => (
              <div key={i} className="eb-social-row">
                <select value={it.network} onChange={(e) => set({ items: p.items.map((x: any, j: number) => (j === i ? { ...x, network: e.target.value } : x)) })} aria-label={t('Netzwerk')}>
                  {Object.entries(SOCIAL_NETWORKS).map(([k, n]) => (
                    <option key={k} value={k}>
                      {t(n.label)}
                    </option>
                  ))}
                </select>
                <input value={it.url} placeholder="https://…" onChange={(e) => set({ items: p.items.map((x: any, j: number) => (j === i ? { ...x, url: e.target.value } : x)) }, `url${i}`)} aria-label={t('Adresse')} />
                <button type="button" className="icon-btn" aria-label={t('Entfernen')} onClick={() => set({ items: p.items.filter((_: any, j: number) => j !== i) })}>
                  ✕
                </button>
              </div>
            ))}
            <button type="button" className="btn secondary small" disabled={p.items.length >= 12} onClick={() => set({ items: [...p.items, { network: 'website', url: 'https://' }] })}>
              {t('+ Link')}
            </button>
            {styleFields(b, { color: false })}
          </>
        );
      case 'video':
        return (
          <>
            <Row label={t('Video-Link')} hint={t('YouTube-Links bekommen das Vorschaubild automatisch.')}>
              <PInput value={p.url} placeholder="https://youtube.com/watch?v=…" onChange={(v) => set({ url: v }, 'url')} />
            </Row>
            <Row label={t('Vorschaubild (optional)')}>
              <div className="eb-inline">
                <PInput value={p.thumbnail} placeholder="https://…" onChange={(v) => set({ thumbnail: v }, 'thumb')} />
                <button type="button" className="btn secondary small" onClick={() => pickImage((url) => set({ thumbnail: url }))}>
                  {t('Uploads')}
                </button>
              </div>
            </Row>
            <Row label={t('Bildunterschrift')}>
              <PInput value={p.caption} onChange={(v) => set({ caption: v }, 'caption')} />
            </Row>
            <Row label={t('Alternativtext')}>
              <PInput value={p.alt} onChange={(v) => set({ alt: v }, 'alt')} />
            </Row>
            {styleFields(b, { color: false })}
          </>
        );
      case 'html':
        return (
          <>
            <Row label="HTML" hint={t('Eigenes HTML mit Inline-Styles. Skripte, Formulare und iframes werden entfernt.')}>
              <PTextarea value={p.html} onChange={(v) => set({ html: v }, 'html')} rows={12} mono />
            </Row>
            {styleFields(b, { align: false })}
          </>
        );
      case 'footer':
        return (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              {t('Pflicht in Kampagnen: Firmenname, Adresse und Abmeldelink. Der persönliche Abmeldelink wird beim Versand eingesetzt.')}
            </p>
            <Row label={t('Firma')}>
              <PInput value={p.company} onChange={(v) => set({ company: v }, 'company')} />
            </Row>
            <Row label={t('Adresse')}>
              <PTextarea value={p.address} onChange={(v) => set({ address: v }, 'address')} rows={2} />
            </Row>
            <Row label={t('Hinweistext')}>
              <PTextarea value={p.text} onChange={(v) => set({ text: v }, 'ftext')} rows={2} />
            </Row>
            <Row label={t('Text des Abmeldelinks')}>
              <PInput value={p.unsubscribeLabel} onChange={(v) => set({ unsubscribeLabel: v }, 'unsub')} />
            </Row>
            <Row label={t('Einstellungs-Link (optional)')} hint={t('Leer = „Einstellungen“, wenn das Einstellungs-Center aktiv ist.')}>
              <PInput value={p.preferencesLabel} onChange={(v) => set({ preferencesLabel: v }, 'preflabel')} />
            </Row>
            {styleFields(b, { font: true })}
          </>
        );
    }
  };

  const sectionPanel = (sec: Section) => (
    <>
      <Row label={t('Spalten')}>
        <div className="eb-layouts">
          {Object.values(LAYOUTS)
            .flat()
            .map((w) => (
              <button type="button" key={w.join('-')} className={w.join('-') === sec.widths.join('-') ? 'on' : ''} title={w.map((x) => `${x} %`).join(' / ')} onClick={() => setLayout(sec.id, w)}>
                {w.map((x, i) => (
                  <span key={i} style={{ flex: x }} />
                ))}
              </button>
            ))}
        </div>
      </Row>
      <p className="muted small">{t('Auf dem Handy stehen die Spalten untereinander.')}</p>
      <MoreFields key={sec.id} id="eb-section" label={t('Darstellung')} values={changedAgainst(sec.style as Record<string, unknown>, { background: '', paddingY: 0, paddingX: 0 })}>
        <ColorInput label={t('Hintergrund')} value={sec.style.background} allowEmpty onChange={(v) => updateSection(sec.id, { background: v }, 'bg')} />
        <div className="grid2">
          <NumInput label={t('Innenabstand oben/unten')} value={sec.style.paddingY} min={0} max={120} onChange={(v) => updateSection(sec.id, { paddingY: v ?? 0 }, 'py')} />
          <NumInput label={t('Innenabstand seitlich')} value={sec.style.paddingX} min={0} max={120} onChange={(v) => updateSection(sec.id, { paddingX: v ?? 0 }, 'px')} />
        </div>
      </MoreFields>
      <div className="eb-panel-actions">
        <button type="button" className="btn secondary small" onClick={() => setModal('save-section')}>
          <Icon name="bookmark" size={14} /> {t('Als Abschnitt speichern')}
        </button>
        <button type="button" className="btn secondary small" onClick={() => duplicateSection(sec.id)}>
          <Icon name="copy" size={14} /> {t('Duplizieren')}
        </button>
        <button type="button" className="btn danger small" onClick={() => removeSection(sec.id)}>
          <Icon name="trash" size={14} /> {t('Löschen')}
        </button>
      </div>
    </>
  );

  const settingsPanel = (
    <>
      <Row label={t('Vorschautext (Preheader)')} hint={t('Steht im Posteingang neben dem Betreff.')}>
        <PInput value={s.preheader} onChange={(v) => updateSettings({ preheader: v }, 'pre')} placeholder={t('z. B. Nur diese Woche: 20 % Rabatt')} />
      </Row>
      <MoreFields id="eb-settings" label={t('Darstellung')} values={changedAgainst(s as unknown as Record<string, unknown>, DEFAULT_SETTINGS as unknown as Record<string, unknown>, ['width', 'background', 'contentBackground', 'textColor', 'linkColor', 'fontFamily', 'fontSize'])}>
        <NumInput label={t('Breite')} value={s.width} min={320} max={900} onChange={(v) => updateSettings({ width: v ?? 600 }, 'width')} />
        <div className="grid2">
          <ColorInput label={t('Hintergrund')} value={s.background} onChange={(v) => updateSettings({ background: v || '#f3f4f6' }, 'bg')} />
          <ColorInput label={t('Inhalt')} value={s.contentBackground} onChange={(v) => updateSettings({ contentBackground: v || '#ffffff' }, 'cbg')} />
          <ColorInput label={t('Text')} value={s.textColor} onChange={(v) => updateSettings({ textColor: v || '#1f2937' }, 'tc')} />
          <ColorInput label={t('Links')} value={s.linkColor} onChange={(v) => updateSettings({ linkColor: v || '#2563eb' }, 'lc')} />
        </div>
        <Row label={t('Schrift')}>
          <select value={s.fontFamily} onChange={(e) => updateSettings({ fontFamily: e.target.value })}>
            {FONTS.map(([f, l]) => (
              <option key={f} value={f}>
                {l}
              </option>
            ))}
          </select>
        </Row>
        <NumInput label={t('Schriftgröße')} value={s.fontSize} min={10} max={24} onChange={(v) => updateSettings({ fontSize: v ?? 16 }, 'fs')} />
      </MoreFields>
      {issues.length > 0 && (
        <div className="eb-issues">
          <div className="eb-sub">{t('Prüfung')}</div>
          {issues.map((i, k) => (
            <p key={k} className={i.level}>
              {i.level === 'error' ? '⚠ ' : 'ℹ '}
              {issueText(i.text)}
            </p>
          ))}
        </div>
      )}
    </>
  );

  const panelTitle = selBlock ? t(BLOCK_META[selBlock.block.type][1]) : selSection ? t('Abschnitt') : t('E-Mail-Einstellungen');

  return (
    <InsertCtx.Provider value={insertTarget}>
      <div className="eb" role="dialog" aria-label={title}>
        <header className="eb-top">
          <strong className="eb-title">
            <Icon name="email" /> <span className="eb-title-text">{title}</span>
          </strong>
          {initialSubject !== undefined && (
            <div className="eb-subject">
              <PInput value={subject} onChange={setSubject} placeholder={t('Betreff')} />
            </div>
          )}
          <div className="eb-tools" data-tour="eb-tools">
            <button type="button" className="icon-btn" title={t('Rückgängig (Strg+Z)')} aria-label={t('Rückgängig')} disabled={!canUndo} onClick={undo}>
              <Icon name="undo" />
            </button>
            <button type="button" className="icon-btn" title={t('Wiederholen (Strg+Y)')} aria-label={t('Wiederholen')} disabled={!canRedo} onClick={redo}>
              <Icon name="redo" />
            </button>
            <Segmented
              value={device}
              options={[
                ['desktop', <Icon key="d" name="monitor" />, t('Desktop')],
                ['mobile', <Icon key="m" name="sms" />, t('Handy')],
              ]}
              onChange={setDevice}
            />
            <Segmented
              value={view}
              options={[
                ['edit', t('Bearbeiten')],
                ['preview', t('Vorschau')],
                ['text', t('Text')],
              ]}
              onChange={setView}
            />
            {view === 'edit' && (
              <button type="button" className="icon-btn eb-only-narrow" title={t('E-Mail-Einstellungen')} aria-label={t('E-Mail-Einstellungen')} onClick={() => (setSel(null), setPanelOpen((o) => !o || !!sel))}>
                <Icon name="settings" />
              </button>
            )}
            <button type="button" className="btn secondary small" data-tour="eb-test" onClick={() => setModal('test')}>
              <Icon name="send" size={14} /> {t('Test')}
            </button>
            <button type="button" className="btn small" data-tour="eb-save" disabled={saving} onClick={save} title={errors.length ? errors.map((e) => issueText(e.text)).join('\n') : undefined}>
              {saving ? t('Speichert…') : dirty ? t('Speichern') : t('Gespeichert ✓')}
              {errors.length > 0 && <span className="eb-err-dot">{errors.length}</span>}
            </button>
          </div>
          <button type="button" className="icon-btn eb-close" data-tour="eb-close" onClick={requestClose} aria-label={t('Schließen')} title={t('Schließen (Esc)')}>
            ✕
          </button>
        </header>
        <div className={`eb-body${view !== 'edit' ? ' previewing' : ''}`}>
          {view === 'edit' && palette}
          <main data-tour="eb-canvas" className={`eb-canvas${device === 'mobile' ? ' mobile' : ''}`} style={{ background: s.background }} onClick={() => select(null)}>
            {view === 'preview' ? (
              <iframe className="eb-preview" title={t('Vorschau')} sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={previewHtml} style={{ width: device === 'mobile' ? 375 : '100%' }} />
            ) : view === 'text' ? (
              <pre className="eb-text-preview" style={{ maxWidth: paperWidth }}>
                {previewText}
              </pre>
            ) : (
              <div
                ref={paperRef}
                className="eb-paper"
                style={{ width: paperWidth, background: s.contentBackground, color: s.textColor, fontFamily: s.fontFamily }}
                onDragOver={overPaper}
                onDrop={onDrop}
                onClickCapture={(e) => (e.target as HTMLElement).closest('a') && e.preventDefault()}
              >
                {design.sections.map((sec, si) => (
                  <Fragment key={sec.id}>
                    {drop?.kind === 'section' && drop.index === si && <div className="eb-ind" />}
                    <div
                      className={`eb-section${sel?.id === sec.id ? ' sel' : ''}`}
                      style={{ background: sec.style.background || undefined, padding: `${sec.style.paddingY ?? 0}px ${sec.style.paddingX ?? 0}px` }}
                      {...pressable((e) => (e.stopPropagation(), select({ kind: 'section', id: sec.id })))}
                    >
                      <div className="eb-sec-tools" onClick={(e) => e.stopPropagation()}>
                        <span className="eb-grip" draggable onDragStart={(e) => startDrag(e, { kind: 'section', id: sec.id })} title={t('Abschnitt verschieben (ziehen)')}>
                          <Icon name="grip" size={14} />
                        </span>
                        <button type="button" title={t('Nach oben')} aria-label={t('Abschnitt nach oben')} onClick={() => nudgeSection(sec.id, -1)}>
                          <Icon name="up" size={13} />
                        </button>
                        <button type="button" title={t('Nach unten')} aria-label={t('Abschnitt nach unten')} onClick={() => nudgeSection(sec.id, 1)}>
                          <Icon name="down" size={13} />
                        </button>
                        <button type="button" title={t('Duplizieren')} aria-label={t('Abschnitt duplizieren')} onClick={() => duplicateSection(sec.id)}>
                          <Icon name="copy" size={13} />
                        </button>
                        <button type="button" title={t('Löschen')} aria-label={t('Abschnitt löschen')} onClick={() => removeSection(sec.id)}>
                          <Icon name="trash" size={13} />
                        </button>
                      </div>
                      <div className="eb-cols">
                        {sec.columns.map((col, ci) => (
                          <div key={col.id} className="eb-col" style={{ width: `${sec.widths[ci]}%` }} onDragOver={(e) => overColumn(e, si, ci, col.blocks.length)}>
                            {col.blocks.map((b, bi) => (
                              <Fragment key={b.id}>
                                {drop?.kind === 'block' && drop.s === si && drop.c === ci && drop.i === bi && <div className="eb-ind" />}
                                <div
                                  className={`eb-block${sel?.id === b.id ? ' sel' : ''}`}
                                  draggable
                                  onDragStart={(e) => startDrag(e, { kind: 'block', id: b.id })}
                                  onDragOver={(e) => overBlock(e, si, ci, bi)}
                                  {...pressable((e) => (e.stopPropagation(), select({ kind: 'block', id: b.id })))}
                                >
                                  <span className="eb-blk-label">{t(BLOCK_META[b.type][1])}</span>
                                  {b.type === 'html' ? <HtmlBlockPreview html={renderBlockHtml(design, sec, ci, b)} /> : <div dangerouslySetInnerHTML={{ __html: renderBlockHtml(design, sec, ci, b) }} />}
                                  {sel?.id === b.id && (
                                    <div className="eb-blk-tools" onClick={(e) => e.stopPropagation()}>
                                      <button type="button" title={t('Nach oben')} aria-label={t('Nach oben')} onClick={() => nudgeBlock(b.id, -1)}>
                                        <Icon name="up" size={13} />
                                      </button>
                                      <button type="button" title={t('Nach unten')} aria-label={t('Nach unten')} onClick={() => nudgeBlock(b.id, 1)}>
                                        <Icon name="down" size={13} />
                                      </button>
                                      <button type="button" title={t('Duplizieren')} aria-label={t('Duplizieren')} onClick={() => duplicateBlock(b.id)}>
                                        <Icon name="copy" size={13} />
                                      </button>
                                      <button type="button" title={t('Löschen (Entf)')} aria-label={t('Löschen')} onClick={() => removeBlock(b.id)}>
                                        <Icon name="trash" size={13} />
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </Fragment>
                            ))}
                            {drop?.kind === 'block' && drop.s === si && drop.c === ci && drop.i === col.blocks.length && <div className="eb-ind" />}
                            {!col.blocks.length && <div className="eb-col-empty">{t('Block hierher ziehen')}</div>}
                          </div>
                        ))}
                      </div>
                    </div>
                  </Fragment>
                ))}
                {drop?.kind === 'section' && drop.index === design.sections.length && <div className="eb-ind" />}
                {!design.sections.length && (
                  <div className="eb-empty">
                    <p>{t('Ziehe Blöcke von links hierher – oder tippe sie an.')}</p>
                    <button type="button" className="btn secondary small" data-tour="eb-starters" onClick={(e) => (e.stopPropagation(), setModal('starters'))}>
                      {t('Mit einer Vorlage beginnen')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </main>
          {view === 'edit' && (
            <aside className={`eb-panel${panelOpen ? ' open' : ''}`} aria-label={t('Einstellungen')} data-tour="eb-panel">
              <div className="eb-panel-head">
                <strong>{panelTitle}</strong>
                <MergeSelect customFields={customFields} onPick={insertMerge} />
                <button type="button" className="icon-btn" aria-label={t('Schließen')} title={sel ? t('Auswahl aufheben') : t('Schließen')} onClick={() => (sel ? select(null) : setPanelOpen(false))}>
                  ✕
                </button>
              </div>
              <div className="eb-panel-body" key={sel?.id ?? 'settings'}>
                {selBlock ? blockPanel(selBlock.block) : selSection ? sectionPanel(selSection) : settingsPanel}
              </div>
            </aside>
          )}
        </div>
        {modal === 'starters' && (
          <StarterPicker
            location={location}
            onClose={() => setModal(null)}
            onPick={(d, subj) => {
              if (design.sections.length && !confirmAsk(t('Aktuelles Design durch die Vorlage ersetzen?'))) return;
              edit((cur) => {
                cur.settings = d.settings;
                cur.sections = d.sections;
              });
              if (subj && !subject && initialSubject !== undefined) setSubject(subj);
              select(null);
              setModal(null);
            }}
          />
        )}
        {modal === 'test' && <TestSend design={design} subject={subject} onClose={() => setModal(null)} />}
        {modal === 'image' && (
          <ImagePicker
            onClose={() => setModal(null)}
            onPick={(url) => {
              imageTarget?.(url);
              setModal(null);
            }}
          />
        )}
        {modal === 'save-section' && <SaveSection onSave={saveSection} onClose={() => setModal(null)} />}
      </div>
    </InsertCtx.Provider>
  );
}

// --- embedding: thumbnail + buttons for campaigns, templates and workflow steps ----------------------

/**
 * The designed email inside another editor: a small preview with "bearbeiten", or a button to
 * start designing. Opens the builder full-screen; `onChange` gets design, HTML, text and subject.
 */
export function EmailDesignField({ design, subject, mode, disabled, onChange, onRemove }: { design?: EmailDesign | null; subject?: string; mode: BuilderMode; disabled?: boolean; onChange: (r: BuilderResult) => unknown | Promise<unknown>; onRemove?: () => void }) {
  const t = useT('email');
  const [open, setOpen] = useState(false);
  const thumb = useMemo(() => {
    if (!design) return '';
    try {
      return fillSample(renderEmailHtml(normalizeDesign(design)), undefined);
    } catch {
      return '';
    }
  }, [design]);
  return (
    <>
      {design ? (
        <div className="eb-field">
          <div className="eb-field-thumb" onClick={() => !disabled && setOpen(true)} onKeyDown={(e) => e.key === 'Enter' && !disabled && setOpen(true)} role="button" tabIndex={0} aria-label={t('Vorschau – öffnet den Designer')}>
            <iframe title={t('Vorschau')} srcDoc={thumb} sandbox="" tabIndex={-1} />
          </div>
          <div className="eb-field-actions">
            <button type="button" className="btn" data-tour="eb-open" disabled={disabled} onClick={() => setOpen(true)}>
              <Icon name="edit" size={14} /> {t('Design bearbeiten')}
            </button>
            {onRemove && (
              <button type="button" className="btn ghost small" disabled={disabled} onClick={() => confirmAsk(t('Design entfernen und wieder als Text schreiben?')) && onRemove()}>
                {t('Als Text schreiben')}
              </button>
            )}
            <small className="muted">{t('Gestaltet mit dem E-Mail-Designer. Platzhalter wie')} {'{{contact.first_name}}'} {t('werden beim Versand ersetzt.')}</small>
          </div>
        </div>
      ) : (
        <button type="button" className="btn secondary" data-tour="eb-open" disabled={disabled} onClick={() => setOpen(true)}>
          <Icon name="template" size={14} /> {t('Mit E-Mail-Designer gestalten')}
        </button>
      )}
      {open &&
        createPortal(
          <EmailBuilder
            initial={design}
            subject={subject}
            mode={mode}
            onClose={() => setOpen(false)}
            onSave={async (r) => {
              await onChange(r);
            }}
          />,
          document.body,
        )}
    </>
  );
}
