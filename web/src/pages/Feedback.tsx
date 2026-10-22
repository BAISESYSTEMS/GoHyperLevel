import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ago, currentLocation, dt } from '../api';
import { Icon, type IconName } from '../icons';
import { useSession } from '../session';
import { Badge, Check, Empty, Field, Input, Link, Modal, PageHead, Select, Spinner, Textarea, act, navigate, toastError, useLoad, useRoute } from '../ui';
import { BuildHint } from '../werkstatt/Build';
import { collectDiagnostics, installDiagnostics, setAutoCapture, type DiagnosticsBlock } from '../feedback/diagnostics';
import { useT } from '../i18n';

/**
 * „Fehler & Wünsche“ for every login: the button in the top bar (menu with badge, Strg+Umschalt+F),
 * the report modal (screenshot from clipboard, file or screen capture, viewable/removable
 * diagnostics) and „Meine Meldungen“. Wish list: Wishes.tsx, agency triage: FeedbackAdmin.tsx.
 */

type Tone = 'gray' | 'green' | 'red' | 'blue' | 'yellow' | 'purple';
export interface FeedbackMe {
  prefs: { auto_capture: boolean; email: boolean };
  auto_capture_default: boolean;
  capture_client: boolean;
  unread: number;
  changelog_new: number;
  reports_open: number;
  severities: [string, string][];
  categories: [string, string][];
  areas: string[];
  board: [string, string][];
  screenshot_max: number;
}

// --- shared state: /api/feedback/me (badge, prefs) ---------------------------------------------------
let meCache: FeedbackMe | undefined;
const listeners = new Set<(m: FeedbackMe) => void>();
export async function refreshFeedback(): Promise<FeedbackMe | undefined> {
  try {
    meCache = await api.get<FeedbackMe>('/api/feedback/me');
    setAutoCapture(meCache.prefs.auto_capture && meCache.capture_client);
    listeners.forEach((fn) => fn(meCache!));
  } catch {
    /* signed out */
  }
  return meCache;
}
export function useFeedbackMe(): FeedbackMe | undefined {
  const [m, setM] = useState(meCache);
  useEffect(() => {
    listeners.add(setM);
    if (!meCache) void refreshFeedback();
    return () => void listeners.delete(setM);
  }, []);
  return m;
}

export const KIND: Record<string, [string, IconName]> = { bug: ['Fehler', 'bug'], question: ['Frage', 'faq'], wish: ['Wunsch', 'idea'], auto: ['Automatisch erfasst', 'activity'] };
export function StatusPill({ s }: { s: { label: string; tone: string } }) {
  return <Badge tone={(s.tone as Tone) ?? 'gray'}>{s.label}</Badge>;
}

/** Opens the report modal from anywhere (menu, shortcut, Meine Meldungen, Android deep link). */
export const openReport = (category: 'bug' | 'wish' | 'question' = 'bug') => window.dispatchEvent(new CustomEvent('pghl:report', { detail: { category } }));

// --- screenshots -----------------------------------------------------------------------------------
async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Bild konnte nicht gelesen werden'));
    img.src = src;
  });
}
const fileToDataUrl = (f: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Datei konnte nicht gelesen werden'));
    r.readAsDataURL(f);
  });
const sizeOf = (dataUrl: string) => Math.floor(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4);

/** Downscales big images so they fit the server limit (3 MB) and stay readable. */
export async function shrink(dataUrl: string, max = 3 * 1024 * 1024): Promise<string> {
  if (!/^data:image\/(png|jpe?g|webp);/.test(dataUrl)) {
    // e.g. a GIF or HEIC from the clipboard: draw it as JPEG
    const img = await loadImage(dataUrl);
    return drawScaled(img, 1920, 0.85);
  }
  const img = await loadImage(dataUrl);
  if (sizeOf(dataUrl) <= max * 0.8 && img.naturalWidth <= 2560) return dataUrl;
  for (const [w, q] of [
    [1920, 0.85],
    [1600, 0.75],
    [1280, 0.7],
    [1024, 0.6],
  ] as const) {
    const out = drawScaled(img, w, q);
    if (sizeOf(out) <= max) return out;
  }
  throw new Error('Das Bild ist zu groß');
}
function drawScaled(img: CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; videoWidth?: number; videoHeight?: number }, maxW: number, q: number) {
  const w0 = img.naturalWidth || img.videoWidth || 1;
  const h0 = img.naturalHeight || img.videoHeight || 1;
  const scale = Math.min(1, maxW / w0);
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * scale);
  c.height = Math.round(h0 * scale);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', q);
}
export const canCaptureScreen = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices && typeof (navigator.mediaDevices as any).getDisplayMedia === 'function';

/** One frame of the screen (or this tab) via getDisplayMedia; the modal hides itself meanwhile. */
export async function captureScreen(): Promise<string> {
  document.body.classList.add('fb-capturing');
  let stream: MediaStream | undefined;
  try {
    stream = await (navigator.mediaDevices as any).getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' });
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream!;
    await video.play();
    await new Promise((r) => setTimeout(r, 400));
    return drawScaled(video, 1920, 0.85);
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
    document.body.classList.remove('fb-capturing');
  }
}

/** Paste (Strg+V), file or screen capture → preview with ✕. */
export function ScreenshotPicker({ value, onChange, compact }: { value: string; onChange: (v: string) => void; compact?: boolean }) {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const take = async (src: Promise<string>) => {
    setBusy(true);
    try {
      onChange(await shrink(await src));
    } catch (e) {
      if ((e as Error).name !== 'NotAllowedError' && (e as Error).name !== 'AbortError') toastError(e);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
      const blob = item?.getAsFile();
      if (!blob) return;
      e.preventDefault();
      void take(fileToDataUrl(blob));
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);
  if (value)
    return (
      <div className="fb-shot">
        <img src={value} alt="Screenshot" />
        <button type="button" className="icon-btn fb-shot-x" onClick={() => onChange('')} aria-label="Screenshot entfernen">
          ✕
        </button>
      </div>
    );
  return (
    <div className={`fb-drop${compact ? ' compact' : ''}`} data-tour="fb-screenshot">
      {!compact && (
        <span className="muted small">
          <Icon name="image" size={14} /> Screenshot einfügen (<kbd>Strg</kbd>+<kbd>V</kbd>), Datei wählen{canCaptureScreen() ? ' oder Bildschirm aufnehmen' : ''} – optional
        </span>
      )}
      <span className="actions">
        <button type="button" className="btn small secondary" disabled={busy} onClick={() => file.current?.click()}>
          <Icon name="imageUp" size={13} /> Datei wählen
        </button>
        {canCaptureScreen() && (
          <button type="button" className="btn small secondary" disabled={busy} onClick={() => take(captureScreen())}>
            <Icon name="screenCapture" size={13} /> Bildschirm aufnehmen
          </button>
        )}
        {busy && <span className="muted small">Bild wird vorbereitet…</span>}
      </span>
      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void take(fileToDataUrl(f));
        }}
      />
    </div>
  );
}

// --- diagnostics block -----------------------------------------------------------------------------
type DiagKey = 'page' | 'account' | 'version' | 'browser' | 'window' | 'errors' | 'api';
const DIAG_LABEL: Record<DiagKey, string> = {
  page: 'Seite',
  account: 'Sub-Account & Rolle',
  version: 'App-Version',
  browser: 'Browser & System',
  window: 'Fenster',
  errors: 'Letzte Fehler',
  api: 'Fehlgeschlagene Anfragen',
};

function diagPayload(d: DiagnosticsBlock, removed: Set<DiagKey>) {
  const out: Record<string, unknown> = {};
  if (!removed.has('page')) Object.assign(out, { url: d.url, route: d.route });
  if (!removed.has('account')) Object.assign(out, { location_id: d.location_id });
  if (!removed.has('version')) Object.assign(out, { build: d.build });
  if (!removed.has('browser')) Object.assign(out, { user_agent: d.user_agent, browser: d.browser, os: d.os, language: d.language, timezone: d.timezone, online: d.online });
  if (!removed.has('window')) Object.assign(out, { viewport: d.viewport, screen: d.screen });
  if (!removed.has('errors')) out.errors = d.errors;
  if (!removed.has('api')) out.api_errors = d.api_errors;
  return out;
}

function DiagnosticsView({ d, removed, setRemoved, accountName, role }: { d: DiagnosticsBlock; removed: Set<DiagKey>; setRemoved: (s: Set<DiagKey>) => void; accountName: string; role: string }) {
  const [open, setOpen] = useState(false);
  const value: Record<DiagKey, string> = {
    page: d.route,
    account: `${accountName || '–'} · ${role}`,
    version: `Build ${d.build}`,
    browser: `${d.browser} · ${d.os}`,
    window: d.viewport,
    errors: d.errors.length ? `${d.errors.length}` : 'keine',
    api: d.api_errors.length ? `${d.api_errors.length}` : 'keine',
  };
  const keys = (Object.keys(DIAG_LABEL) as DiagKey[]).filter((k) => !removed.has(k));
  return (
    <div className="fb-diag" data-tour="fb-diagnostics">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <strong className="small">
          <Icon name="shield" size={13} /> Diagnosedaten {keys.length ? 'werden mitgeschickt' : '– alle entfernt'}
        </strong>
        <span className="actions">
          {keys.length > 0 && (
            <button type="button" className="btn small ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? 'Ausblenden' : 'Ansehen'}
            </button>
          )}
          {removed.size > 0 ? (
            <button type="button" className="btn small ghost" onClick={() => setRemoved(new Set())}>
              Wiederherstellen
            </button>
          ) : (
            <button type="button" className="btn small ghost" onClick={() => setRemoved(new Set(Object.keys(DIAG_LABEL) as DiagKey[]))}>
              Alle entfernen
            </button>
          )}
        </span>
      </div>
      {keys.length > 0 && (
        <div className="fb-diag-chips">
          {keys.map((k) => (
            <span key={k} className="fb-chip">
              <span className="muted">{DIAG_LABEL[k]}:</span> {value[k]}
              <button type="button" onClick={() => setRemoved(new Set([...removed, k]))} aria-label={`${DIAG_LABEL[k]} entfernen`}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      {open && keys.length > 0 && <pre className="fb-pre">{JSON.stringify(diagPayload(d, removed), null, 2)}</pre>}
      <p className="muted small" style={{ margin: '6px 0 0' }}>
        Nur technische Angaben – keine Formularinhalte, Passwörter oder Schlüssel. Hilft uns, den Fehler schnell zu finden.
      </p>
    </div>
  );
}

// --- the report modal --------------------------------------------------------------------------------
export function ReportModal({ initial = 'bug', onClose }: { initial?: 'bug' | 'wish' | 'question'; onClose: () => void }) {
  const session = useSession();
  const me = useFeedbackMe();
  const [category, setCategory] = useState<'bug' | 'wish' | 'question'>(initial);
  const [f, setF] = useState({ what: '', expected: '', steps: '', severity: 'mittel', title: '', area: 'Sonstiges' });
  const [shot, setShot] = useState('');
  const [diag] = useState(() => collectDiagnostics());
  const [removed, setRemoved] = useState<Set<DiagKey>>(new Set());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<any>(null);
  const loc = session.locations.find((l) => l.id === currentLocation());
  const role = session.user.role === 'admin' ? 'Agentur-Admin' : 'Kunden-Login';
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  const send = async () => {
    if (category === 'wish' ? !f.title.trim() : !f.what.trim())
      return toastError(new Error(category === 'wish' ? 'Bitte gib dem Wunsch einen Titel' : category === 'question' ? 'Bitte schreib deine Frage' : 'Bitte beschreibe kurz, was passiert ist'));
    setBusy(true);
    try {
      const body: Record<string, unknown> = { category, location_id: currentLocation(), screenshot: shot || undefined };
      if (category === 'wish') Object.assign(body, { title: f.title, what: f.what, area: f.area });
      else
        Object.assign(body, {
          what: f.what,
          expected: category === 'bug' ? f.expected : '',
          steps: category === 'bug' ? f.steps : '',
          severity: f.severity,
          diagnostics: removed.size === Object.keys(DIAG_LABEL).length ? false : diagPayload(diag, removed),
        });
      const r = await api.post('/api/feedback/reports', body);
      setDone(r);
      void refreshFeedback();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  if (done)
    return (
      <Modal title="Danke!" onClose={onClose}>
        <div className="fb-done" data-tour="fb-done">
          <Icon name="ok" size={36} />
          <h2>{done.kind === 'wish' ? 'Dein Wunsch steht in der Wunschliste' : `Deine ${done.kind === 'question' ? 'Frage' : 'Meldung'} ist angekommen`}</h2>
          <p>
            {done.kind === 'wish' ? 'Andere können jetzt dafür stimmen.' : 'Ticketnummer'} <strong>#{done.number}</strong>
            {done.kind !== 'wish' && <> – du bekommst Bescheid, sobald das Team antwortet oder sich der Status ändert.</>}
          </p>
          <div className="actions" style={{ justifyContent: 'center' }}>
            <button
              className="btn"
              onClick={() => {
                onClose();
                navigate(done.kind === 'wish' ? `wishes/${done.id}` : `feedback/${done.id}`);
              }}
            >
              {done.kind === 'wish' ? 'Wunsch ansehen' : 'In „Meine Meldungen“ ansehen'}
            </button>
            {done.kind === 'wish' && <BuildHint wishId={done.id} onBefore={onClose} />}
            <button className="btn secondary" onClick={onClose}>
              Schließen
            </button>
          </div>
        </div>
      </Modal>
    );

  return (
    <Modal
      title={category === 'wish' ? 'Wunsch einreichen' : category === 'question' ? 'Frage stellen' : 'Fehler melden'}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" data-tour="fb-send" disabled={busy} onClick={send}>
            <Icon name="send" size={14} /> {busy ? 'Wird gesendet…' : 'Senden'}
          </button>
        </>
      }
    >
      <div className="fb-seg" role="radiogroup" aria-label="Art" data-tour="fb-category">
        {(
          me?.categories ?? [
            ['bug', 'Fehler'],
            ['wish', 'Verbesserungswunsch'],
            ['question', 'Frage'],
          ]
        ).map(([k, l]) => (
          <button key={k} type="button" role="radio" aria-checked={category === k} className={category === k ? 'on' : ''} onClick={() => setCategory(k as any)}>
            <Icon name={KIND[k]?.[1] ?? 'bug'} size={14} /> {l}
          </button>
        ))}
      </div>
      {category === 'wish' ? (
        <>
          <Field label="Titel" tour="fb-title">
            <Input value={f.title} onChange={set('title')} placeholder="z. B. Termine direkt aus der Rechnung buchen" maxLength={200} autoFocus />
          </Field>
          <Field label="Beschreibung" hint="Was möchtest du erreichen? Wie oft brauchst du das?">
            <Textarea value={f.what} onChange={set('what')} rows={4} />
          </Field>
          <Field label="Bereich">
            <Select value={f.area} onChange={set('area')} options={me?.areas ?? ['Sonstiges']} />
          </Field>
          <p className="muted small fb-hint">
            <Icon name="community" size={13} /> Wünsche sind für alle Nutzer sichtbar – ohne deinen Namen und ohne Sub-Account. Andere können dafür stimmen.
          </p>
        </>
      ) : (
        <>
          <Field label={category === 'question' ? 'Deine Frage' : 'Was ist passiert?'} tour="fb-what">
            <Textarea
              value={f.what}
              onChange={set('what')}
              rows={3}
              autoFocus
              placeholder={category === 'question' ? 'Wie kann ich …' : 'z. B. Beim Speichern eines Kontakts dreht sich der Kreis endlos.'}
            />
          </Field>
          {category === 'bug' && (
            <>
              <div className="grid2">
                <Field label="Was hast du erwartet?">
                  <Textarea value={f.expected} onChange={set('expected')} rows={2} />
                </Field>
                <Field label="Schritte zum Nachstellen">
                  <Textarea value={f.steps} onChange={set('steps')} rows={2} placeholder={'1. …\n2. …'} />
                </Field>
              </div>
              <Field label="Wie schlimm ist es?" tour="fb-severity">
                <Select value={f.severity} onChange={set('severity')} options={me?.severities ?? [['mittel', 'Stört bei der Arbeit']]} />
              </Field>
            </>
          )}
        </>
      )}
      <Field label="Screenshot">
        <ScreenshotPicker value={shot} onChange={setShot} />
      </Field>
      {category !== 'wish' && <DiagnosticsView d={diag} removed={removed} setRemoved={setRemoved} accountName={loc?.name ?? ''} role={role} />}
    </Modal>
  );
}

// --- top bar button + menu ------------------------------------------------------------------------------
function MenuRow({ icon, label, sub, onClick, extra, tour }: { icon: IconName; label: ReactNode; sub: ReactNode; onClick: () => void; extra?: ReactNode; tour?: string }) {
  return (
    <button className="help-row" onClick={onClick} data-tour={tour}>
      <Icon name={icon} size={15} />
      <span className="grow">
        {label}
        <small>{sub}</small>
      </span>
      {extra}
    </button>
  );
}

export function FeedbackButton() {
  // The top-bar button and its menu are translated (shell catalog); the report forms and pages are German in phase 1.
  const t = useT('shell');
  const me = useFeedbackMe();
  const route = useRoute();
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<null | 'bug' | 'wish' | 'question'>(null);
  const ref = useRef<HTMLDivElement>(null);
  // Another page (menu, tour step, link) closes the form.
  useEffect(() => setModal(null), [route.join('/')]);

  useEffect(() => {
    installDiagnostics();
    const onOpen = (e: Event) => setModal(((e as CustomEvent).detail?.category as any) ?? 'bug');
    // Strg/⌘ + Umschalt + F: „Fehler melden“ from anywhere.
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setOpen(false);
        setModal('bug');
      }
    };
    const onFocus = () => void refreshFeedback();
    window.addEventListener('pghl:report', onOpen);
    window.addEventListener('keydown', onKey);
    window.addEventListener('focus', onFocus);
    const timer = setInterval(() => document.visibilityState === 'visible' && void refreshFeedback(), 120_000);
    // Android app shortcut / deep link: /app/...?report=bug
    const q = new URLSearchParams(location.search).get('report');
    if (q === 'bug' || q === 'wish' || q === 'question') setModal(q);
    return () => {
      window.removeEventListener('pghl:report', onOpen);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('focus', onFocus);
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', off);
    window.addEventListener('keydown', esc);
    return () => (document.removeEventListener('mousedown', off), window.removeEventListener('keydown', esc));
  }, [open]);

  const badge = (me?.unread ?? 0) + (me?.changelog_new ?? 0);
  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };
  return (
    <div className="fb-wrap" ref={ref}>
      <button
        className="btn secondary small fb-btn"
        data-tour="feedback-button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={`${t('Feedback: Fehler melden, Wünsche, Was ist neu')}${badge ? ` (${t('{n} neu', { n: badge })})` : ''}`}
        title={t('Fehler melden, Wunschliste, Was ist neu (Strg+Umschalt+F)')}
      >
        <Icon name="bug" size={16} />
        <span className="fb-btn-label">{t('Feedback')}</span>
        {badge > 0 && <span className="fb-badge">{badge > 9 ? '9+' : badge}</span>}
      </button>
      {open && (
        <div className="help-pop fb-pop" role="dialog" aria-label={t('Feedback')}>
          <div className="help-head">
            <strong>{t('Feedback')}</strong>
            <button className="icon-btn" onClick={() => setOpen(false)} aria-label={t('Schließen')}>
              ✕
            </button>
          </div>
          <MenuRow
            tour="fb-menu-report"
            icon="bug"
            label={t('Fehler melden')}
            sub={
              <>
                {t('Etwas klappt nicht?')} <kbd>{t('Strg')}</kbd> <kbd>⇧</kbd> <kbd>F</kbd>
              </>
            }
            onClick={() => (setOpen(false), setModal('bug'))}
          />
          <MenuRow tour="fb-menu-wish" icon="idea" label={t('Wunsch einreichen')} sub={t('Idee für eine neue Funktion')} onClick={() => (setOpen(false), setModal('wish'))} />
          <MenuRow tour="fb-menu-question" icon="faq" label={t('Frage stellen')} sub={t('Das Team antwortet dir')} onClick={() => (setOpen(false), setModal('question'))} />
          <div className="fb-sep" />
          <MenuRow
            tour="fb-menu-mine"
            icon="inbox"
            label={t('Meine Meldungen')}
            sub={me?.reports_open ? t('{n} offen', { n: me.reports_open }) : t('Status und Antworten')}
            onClick={() => go('feedback')}
            extra={me?.unread ? <span className="fb-badge inline">{me.unread}</span> : null}
          />
          <MenuRow tour="fb-menu-wishes" icon="vote" label={t('Wunschliste')} sub={t('Abstimmen, was als Nächstes kommt')} onClick={() => go('wishes')} />
          <MenuRow
            tour="fb-menu-news"
            icon="sparkles"
            label={t('Was ist neu')}
            sub={t('Neue Funktionen und Fehlerbehebungen')}
            onClick={() => go('wishes/changelog')}
            extra={me?.changelog_new ? <span className="fb-badge inline">{t('neu')}</span> : null}
          />
        </div>
      )}
      {modal && <ReportModal key={modal} initial={modal} onClose={() => setModal(null)} />}
    </div>
  );
}

// --- „Meine Meldungen“ ------------------------------------------------------------------------------------
function Prefs() {
  const me = useFeedbackMe();
  if (!me) return null;
  const save = async (p: Record<string, unknown>) => {
    if (await act(() => api.put('/api/feedback/prefs', p), 'Gespeichert')) void refreshFeedback();
  };
  return (
    <div className="card" data-tour="fb-prefs">
      <h2>Einstellungen</h2>
      <Check
        checked={me.prefs.auto_capture}
        onChange={(v) => save({ auto_capture: v })}
        label={
          <span>
            Fehler automatisch melden <span className="muted small">– technische Fehler im Browser gehen ohne Inhalte ans Team{me.auto_capture_default ? ' (für Admins Standard)' : ''}</span>
          </span>
        }
      />
      <Check checked={me.prefs.email} onChange={(v) => save({ email: v })} label="E-Mail, wenn das Team antwortet oder sich der Status ändert" />
      <p className="muted small" style={{ margin: '6px 0 0' }}>
        Push-Benachrichtigungen stellst du unter Einstellungen → Mein Konto ein.
      </p>
    </div>
  );
}

export function MyReports() {
  const { data, loading } = useLoad(() => api.get<any[]>('/api/feedback/reports'), []);
  const [filter, setFilter] = useState<'open' | 'done' | 'all'>('all');
  const list = (data ?? []).filter((r) => (filter === 'all' ? true : filter === 'open' ? !r.status.done : r.status.done));
  return (
    <>
      <PageHead title="Meine Meldungen" sub="Deine Fehlermeldungen, Fragen und Wünsche – mit Status und Antworten des Teams.">
        <button className="btn secondary" onClick={() => navigate('wishes')}>
          <Icon name="vote" size={14} /> Wunschliste
        </button>
        <button className="btn" data-tour="fb-new" onClick={() => openReport('bug')}>
          <Icon name="bug" size={14} /> Fehler melden
        </button>
      </PageHead>
      <div className="chips" style={{ marginBottom: 12 }} data-tour="fb-filter">
        {(
          [
            ['all', 'Alle'],
            ['open', 'Offen'],
            ['done', 'Erledigt'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} className={`chip${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>
            {l}
          </button>
        ))}
      </div>
      {loading && !data ? (
        <Spinner />
      ) : list.length ? (
        <div className="fb-list card" data-tour="fb-list">
          {list.map((r) => (
            <a key={r.id} className={`fb-item${r.unread ? ' unread' : ''}`} href={r.url} onClick={(e) => (e.preventDefault(), navigate(r.url))}>
              <span className={`fb-kind k-${r.kind}`}>
                <Icon name={KIND[r.kind]?.[1] ?? 'bug'} size={16} />
              </span>
              <span className="grow">
                <strong>
                  {r.number ? <span className="muted">#{r.number} </span> : null}
                  {r.title}
                </strong>
                <small className="muted">
                  {KIND[r.kind]?.[0]} · aktualisiert {ago(r.updated_at)}
                  {r.version ? ` · Version ${r.version}` : ''}
                  {r.duplicate_of ? ` · zusammengeführt mit #${r.duplicate_of.number}` : ''}
                </small>
              </span>
              {r.unread && <span className="fb-dot" aria-label="Neu" />}
              <StatusPill s={r.status} />
            </a>
          ))}
        </div>
      ) : (
        <Empty
          tour="fb-list"
          action={
            <button className="btn" onClick={() => openReport('bug')}>
              Fehler melden
            </button>
          }
        >
          {filter === 'all' ? 'Noch keine Meldungen. Fällt dir etwas auf, das nicht klappt? Melde es mit einem Klick – mit Screenshot.' : 'Hier ist gerade nichts.'}
        </Empty>
      )}
      <Prefs />
    </>
  );
}

/** Thread of team replies, own messages and status changes (never internal notes). */
export function Thread({ items }: { items: any[] }) {
  if (!items.length) return <p className="muted small">Noch keine Antworten – du bekommst Bescheid.</p>;
  return (
    <div className="fb-thread">
      {items.map((e) =>
        e.type === 'status' ? (
          <div key={e.id} className="tl-sys">
            <Icon name="flag" size={13} /> Status: {e.label} · {dt(e.at)}
          </div>
        ) : (
          <div key={e.id} className={`fb-msg ${e.type === 'team' ? 'team' : e.mine ? 'mine' : 'other'}`}>
            <div className="fb-msg-body">{e.body}</div>
            <div className="muted small">
              {e.type === 'team' ? <Icon name="service" size={12} /> : null} {e.author} · {dt(e.at)}
            </div>
          </div>
        ),
      )}
    </div>
  );
}

export function Shots({ files }: { files: { id: string; url: string }[] }) {
  if (!files.length) return null;
  return (
    <div className="fb-shots">
      {files.map((f) => (
        <a key={f.id} href={f.url} target="_blank" rel="noreferrer" title="Screenshot öffnen">
          <img src={f.url} alt="Screenshot" loading="lazy" />
        </a>
      ))}
    </div>
  );
}

function ReplyBox({ id, onDone, placeholder = 'Weitere Infos für das Team…' }: { id: string; onDone: (d: any) => void; placeholder?: string }) {
  const [text, setText] = useState('');
  const [shot, setShot] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="card" data-tour="fb-reply">
      <Textarea value={text} onChange={setText} rows={3} placeholder={placeholder} />
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
        <ScreenshotPicker value={shot} onChange={setShot} compact />
        <button
          className="btn"
          disabled={busy || (!text.trim() && !shot)}
          onClick={async () => {
            setBusy(true);
            const r = await act(() => api.post(`/api/feedback/reports/${id}/messages`, { body: text, screenshot: shot || undefined }), 'Gesendet');
            setBusy(false);
            if (r) (setText(''), setShot(''), onDone(r));
          }}
        >
          <Icon name="send" size={14} /> Senden
        </button>
      </div>
    </div>
  );
}

function DiagnosticsDetails({ d }: { d: any }) {
  if (!d || !Object.keys(d).length) return null;
  return (
    <details className="card fb-details">
      <summary>Mitgeschickte Diagnosedaten</summary>
      <pre className="fb-pre">{JSON.stringify(d, null, 2)}</pre>
    </details>
  );
}

export function ReportDetail({ id }: { id: string }) {
  const { data, error, setData } = useLoad(() => api.get(`/api/feedback/reports/${id}`), [id]);
  const [reopen, setReopen] = useState(false);
  const [reason, setReason] = useState('');
  useEffect(() => void (data && refreshFeedback()), [data?.report.id]);
  if (error) return <Empty action={<Link to="feedback">Zu „Meine Meldungen“</Link>}>{error}</Empty>;
  if (!data) return <Spinner />;
  const r = data.report;
  return (
    <>
      <div className="crumb-line">
        <Link to="feedback">← Meine Meldungen</Link>
      </div>
      <PageHead
        title={`${r.number ? `#${r.number} ` : ''}${r.title}`}
        sub={
          <span className="row" style={{ gap: 8, alignItems: 'center' }}>
            <StatusPill s={r.status} />{' '}
            <span className="muted small">
              {KIND[r.kind]?.[0]} · gemeldet {dt(r.created_at)}
              {r.platform === 'android' ? ' · Android-App' : ''}
            </span>
          </span>
        }
      >
        {data.can_reopen && (
          <button className="btn secondary" data-tour="fb-reopen" onClick={() => setReopen(true)}>
            <Icon name="refresh" size={14} /> Wieder öffnen
          </button>
        )}
      </PageHead>
      {r.duplicate_of && (
        <div className="card notice-card">
          Diese Meldung wurde mit{' '}
          <Link to={r.duplicate_of.url.replace('/app/', '')}>
            #{r.duplicate_of.number} {r.duplicate_of.title}
          </Link>{' '}
          zusammengeführt – du wirst dort informiert.
        </div>
      )}
      {r.version && (
        <div className="card notice-card ok">
          <Icon name="ok" size={15} /> {r.kind === 'wish' ? 'Umgesetzt' : 'Behoben'} in Version <strong>{r.version}</strong>
          {r.note ? ` – ${r.note}` : ''}
        </div>
      )}
      {r.reason && <div className="card notice-card">Begründung des Teams: {r.reason}</div>}
      <div className="fb-detail">
        <div>
          <div className="card">
            <h2>{r.kind === 'question' ? 'Deine Frage' : r.kind === 'auto' ? 'Fehler' : 'Deine Meldung'}</h2>
            {data.body ? <p className="fb-text">{data.body}</p> : <p className="muted">Automatisch erfasst – Details sieht das Team.</p>}
            {data.expected && (
              <>
                <h3>Erwartet</h3>
                <p className="fb-text">{data.expected}</p>
              </>
            )}
            {data.steps && (
              <>
                <h3>Schritte</h3>
                <p className="fb-text">{data.steps}</p>
              </>
            )}
            <Shots files={data.files} />
          </div>
          <div className="card" data-tour="fb-thread">
            <h2>Verlauf</h2>
            <Thread items={data.thread} />
          </div>
          {data.can_reply && <ReplyBox id={id} onDone={setData} />}
        </div>
        <aside>
          <DiagnosticsDetails d={data.diagnostics} />
        </aside>
      </div>
      {reopen && (
        <Modal
          title="Meldung wieder öffnen"
          onClose={() => setReopen(false)}
          footer={
            <button
              className="btn"
              onClick={async () => {
                const d = await act(() => api.post(`/api/feedback/reports/${id}/reopen`, { reason }), 'Wieder geöffnet');
                if (d) (setData(d), setReopen(false));
              }}
            >
              Wieder öffnen
            </button>
          }
        >
          <Field label="Was klappt noch nicht?">
            <Textarea value={reason} onChange={setReason} rows={3} autoFocus />
          </Field>
        </Modal>
      )}
    </>
  );
}

/** Route `feedback` and `feedback/<id>`. */
export function FeedbackPage() {
  const route = useRoute();
  return route[1] ? <ReportDetail id={route[1]} /> : <MyReports />;
}
