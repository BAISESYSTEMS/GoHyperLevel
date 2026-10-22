import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import { AtSign, Bold, CheckSquare, Code, FileUp, Heading2, Heading3, Italic, Link as LinkIcon, List, ListOrdered, Minus, Quote, SquareCode, Strikethrough, Table, Sparkles, Blocks, Info } from 'lucide-react';
import { api } from '../api';
import { toast, toastError } from '../ui';
import { AutoTextarea, CARET, Menu, Prose, RecordPicker, readAsDataUrl, refMarkdown, useDebounced, type CardStore, type Person, type SlashItem } from './CollabKit';
import { useT } from '../i18n';

/**
 * The wiki's editor: Markdown in a text area with a toolbar, a "/" menu for blocks, @mentions, list continuation,
 * file and image upload (button, paste, drop – same checks as the server's) and a live preview that is rendered
 * by the server, so what you see is exactly what the page will show.
 */

const UPLOAD = /^(image\/(png|jpeg|gif|webp)|application\/(pdf|zip)|text\/(plain|csv)|application\/vnd\.(openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|oasis\.opendocument\.(text|spreadsheet|presentation)))$/;
const MAX_UPLOAD = 8 * 1024 * 1024;

// German labels (message ids of the collab catalog), shown and inserted through t()
const CALLOUTS: [string, string][] = [
  ['INFO', 'Info'],
  ['TIP', 'Tipp'],
  ['WARNING', 'Warnung'],
  ['DANGER', 'Achtung'],
  ['SUCCESS', 'Erfolg'],
];
// German (a message id of the collab catalog); block(t(TABLE), 2, 8) selects the first heading
const TABLE = '| Spalte 1 | Spalte 2 | Spalte 3 |\n| --- | --- | --- |\n| | | |\n| | | |';

export function WikiEditor({ value, onChange, store, people, onAi, readOnly }: { value: string; onChange: (v: string) => void; store: CardStore; people: Person[]; onAi?: (selection: string) => void; readOnly?: boolean }) {
  const t = useT('collab');
  const ta = useRef<HTMLTextAreaElement | null>(null);
  const [view, setView] = useState<'split' | 'write' | 'preview'>(() => (window.innerWidth >= 1100 ? 'split' : 'write'));
  const [picker, setPicker] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [drop, setDrop] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  // --- preview, rendered by the server ---
  const [html, setHtml] = useState('');
  const [prevErr, setPrevErr] = useState('');
  const dv = useDebounced(value, 350);
  useEffect(() => {
    if (view === 'write') return;
    let live = true;
    api
      .post('/api/wiki/render', { body: dv })
      .then((r) => live && (setHtml(r.html), setPrevErr('')))
      .catch((e) => live && setPrevErr((e as Error).message));
    return () => {
      live = false;
    };
  }, [dv, view]);

  // --- text operations ---
  const edit = useCallback(
    (fn: (v: string, s: number, e: number) => { v: string; s: number; e: number }) => {
      const el = ta.current;
      if (!el) return;
      const r = fn(el.value, el.selectionStart, el.selectionEnd);
      // text and selection are set together, then React is told (it finds the value in place and keeps the selection)
      el.value = r.v;
      el.setSelectionRange(r.s, r.e);
      onChange(r.v);
      el.focus();
    },
    [onChange],
  );
  const wrap = (a: string, b = a, ph = 'Text') =>
    edit((v, s, e) => {
      const sel = v.slice(s, e) || ph;
      return { v: v.slice(0, s) + a + sel + b + v.slice(e), s: s + a.length, e: s + a.length + sel.length };
    });
  const prefixLines = (p: string | ((i: number) => string)) =>
    edit((v, s, e) => {
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      let le = v.indexOf('\n', e);
      if (le < 0) le = v.length;
      const block = v
        .slice(ls, le)
        .split('\n')
        .map((l, i) => (typeof p === 'function' ? p(i) : p) + l.replace(/^(#{1,6} |[-*+] (\[[ xX]\] )?|\d+[.)] |> )/, ''))
        .join('\n');
      return { v: v.slice(0, ls) + block + v.slice(le), s: ls, e: ls + block.length };
    });
  /** A block on its own, with a blank line around it; `cursor` is where the cursor lands inside it. */
  const block = (text: string, cursor?: number, select = 0) =>
    edit((v, s, e) => {
      const before = v.slice(0, s);
      const after = v.slice(e);
      const pre = before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
      const post = after && !after.startsWith('\n\n') ? (after.startsWith('\n') ? '\n' : '\n\n') : '';
      const at = before.length + pre.length + (cursor ?? text.length);
      return { v: before + pre + text + post + after, s: at, e: at + select };
    });
  const insertInline = (text: string) =>
    edit((v, s, e) => ({ v: v.slice(0, s) + text + v.slice(e), s: s + text.length, e: s + text.length }));
  const link = () =>
    edit((v, s, e) => {
      const sel = v.slice(s, e) || t('Linktext');
      const text = `[${sel}](https://)`;
      const urlAt = s + sel.length + 3;
      return { v: v.slice(0, s) + text + v.slice(e), s: urlAt, e: urlAt + 8 };
    });
  const callout = (kind: string, label: string) => block(`> [!${kind}] ${label}\n> Text`, `> [!${kind}] ${label}\n> `.length, 4);

  // --- uploads ---
  const upload = async (files: File[]) => {
    for (const f of files) {
      if (!UPLOAD.test(f.type)) {
        toastError(new Error(t('„{name}“: Erlaubt sind Bilder (PNG, JPG, GIF, WebP), PDF, Text/CSV, Office-Dokumente und ZIP.', { name: f.name })));
        continue;
      }
      if (f.size > MAX_UPLOAD) {
        toastError(new Error(t('„{name}“ ist größer als 8 MB.', { name: f.name })));
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const r = await api.post('/api/wiki/media', { name: f.name || t('Datei'), data: await readAsDataUrl(f) });
        insertInline(`${r.markdown}\n`);
      } catch (e) {
        toastError(e);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  // --- keys: shortcuts and list continuation ---
  const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      // the editor owns these keys while it has the focus: the menu (Strg B) and the jump palette (Strg K) must not react too
      const own = (fn: () => void) => (e.preventDefault(), e.stopPropagation(), fn(), true);
      if (e.key === 'b') return own(() => wrap('**'));
      if (e.key === 'i') return own(() => wrap('*'));
      if (e.key === 'k') return own(link);
    }
    if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing || el.selectionStart !== el.selectionEnd) return false;
    const pos = el.selectionStart;
    const v = el.value;
    // inside a code fence Enter is just Enter
    if ((v.slice(0, pos).match(/^ {0,3}(```|~~~)/gm)?.length ?? 0) % 2 === 1) return false;
    const ls = v.lastIndexOf('\n', pos - 1) + 1;
    const m = /^(\s*)(- \[[ xX]\] |[-*+] |\d+[.)] |> )(.*)$/.exec(v.slice(ls, pos));
    if (!m) return false;
    e.preventDefault();
    if (!m[3].trim()) {
      // an empty item ends the list
      const cut = v.slice(0, ls) + v.slice(pos);
      el.value = cut;
      el.setSelectionRange(ls, ls);
      onChange(cut);
      return true;
    }
    const marker = /^\d/.test(m[2]) ? `${parseInt(m[2], 10) + 1}${m[2].replace(/^\d+/, '')}` : m[2].replace(/\[[xX]\]/, '[ ]');
    const ins = `\n${m[1]}${marker}`;
    const next = v.slice(0, pos) + ins + v.slice(pos);
    el.value = next;
    el.setSelectionRange(pos + ins.length, pos + ins.length);
    onChange(next);
    return true;
  };

  const slash: SlashItem[] = [
    { key: 'h2', label: t('Überschrift 2'), insert: '## ' },
    { key: 'h3', label: t('Überschrift 3'), insert: '### ' },
    { key: 'liste', label: t('Aufzählung'), insert: '- ' },
    { key: 'nummern', label: t('Nummerierte Liste'), insert: '1. ' },
    { key: 'checkliste', label: t('Checkliste'), insert: '- [ ] ' },
    { key: 'zitat', label: t('Zitat'), insert: '> ' },
    ...CALLOUTS.map(([k, de]) => [k, t(de)]).map(([k, l]) => ({ key: `hinweis-${k.toLowerCase()}`, label: t('Hinweis: {kind}', { kind: l }), insert: `> [!${k}] ${l}\n> ${CARET}` })),
    { key: 'code', label: t('Codeblock'), insert: `\`\`\`\n${CARET}\n\`\`\`` },
    { key: 'tabelle', label: t('Tabelle'), insert: t(TABLE) },
    { key: 'trenner', label: t('Trennlinie'), insert: '---\n' },
    { key: 'karte', label: t('Datensatz oder Seite einbetten …'), sub: t('Karte'), insert: '', run: () => setPicker(true) },
    { key: 'bild', label: t('Bild oder Datei hochladen …'), sub: t('Datei'), insert: '', run: () => file.current?.click() },
    ...(onAi ? [{ key: 'ki', label: t('KI-Schreibhilfe …'), sub: t('KI'), insert: '', run: () => onAi(selectionText()) }] : []),
  ];
  const selectionText = () => {
    const el = ta.current;
    return el && el.selectionEnd > el.selectionStart ? el.value.slice(el.selectionStart, el.selectionEnd) : '';
  };

  const words = value.trim() ? value.trim().split(/\s+/).length : 0;
  const tb = (title: string, icon: ReactElement, run: () => void, on?: boolean) => (
    <button type="button" title={title} aria-label={title} className={on ? 'on' : ''} onClick={run} disabled={readOnly}>
      {icon}
    </button>
  );

  return (
    <div className="wke" data-tour="wiki-editor">
      <div className="wke-tools" role="toolbar" aria-label={t('Formatierung')} data-tour="wiki-toolbar">
        {tb(t('Überschrift 2'), <Heading2 size={16} />, () => prefixLines('## '))}
        {tb(t('Überschrift 3'), <Heading3 size={16} />, () => prefixLines('### '))}
        <span className="sep" />
        {tb(t('Fett (Strg+B)'), <Bold size={16} />, () => wrap('**'))}
        {tb(t('Kursiv (Strg+I)'), <Italic size={16} />, () => wrap('*'))}
        {tb(t('Durchgestrichen'), <Strikethrough size={16} />, () => wrap('~~'))}
        {tb(t('Code'), <Code size={16} />, () => wrap('`', '`', 'code'))}
        {tb(t('Link (Strg+K)'), <LinkIcon size={16} />, link)}
        <span className="sep" />
        {tb(t('Aufzählung'), <List size={16} />, () => prefixLines('- '))}
        {tb(t('Nummerierte Liste'), <ListOrdered size={16} />, () => prefixLines((i) => `${i + 1}. `))}
        {tb(t('Checkliste'), <CheckSquare size={16} />, () => prefixLines('- [ ] '))}
        {tb(t('Zitat'), <Quote size={16} />, () => prefixLines('> '))}
        <Menu
          title={t('Hinweis einfügen')}
          className=""
          trigger={<Info size={16} />}
          left
          items={CALLOUTS.map(([k, de]) => [k, t(de)]).map(([k, l]) => ({ label: l, onClick: () => callout(k, l) }))}
        />
        {tb(t('Codeblock'), <SquareCode size={16} />, () => block('```\n\n```', 4))}
        {tb(t('Tabelle'), <Table size={16} />, () => block(t(TABLE), 2, 8))}
        {tb(t('Trennlinie'), <Minus size={16} />, () => block('---'))}
        <span className="sep" />
        {tb(t('Bild oder Datei hochladen'), <FileUp size={16} />, () => file.current?.click())}
        <button type="button" title={t('Datensatz, Canvas-Board oder Seite einbetten')} aria-label={t('Datensatz einbetten')} onClick={() => setPicker(true)} disabled={readOnly} data-tour="wiki-embed">
          <Blocks size={16} /> <span className="small">{t('Karte')}</span>
        </button>
        {tb(t('Person erwähnen'), <AtSign size={16} />, () => insertInline('@'))}
        {onAi && (
          <button type="button" title={t('KI-Schreibhilfe')} onClick={() => onAi(selectionText())} disabled={readOnly} data-tour="wiki-ai">
            <Sparkles size={16} /> <span className="small">{t('KI')}</span>
          </button>
        )}
        <span className="views" role="group" aria-label={t('Ansicht')}>
          <button type="button" className={view === 'write' ? 'on' : ''} onClick={() => setView('write')} aria-pressed={view === 'write'}>
            {t('Schreiben')}
          </button>
          <button type="button" className={view === 'split' ? 'on' : ''} onClick={() => setView('split')} aria-pressed={view === 'split'}>
            {t('Geteilt')}
          </button>
          <button type="button" className={view === 'preview' ? 'on' : ''} onClick={() => setView('preview')} aria-pressed={view === 'preview'}>
            {t('Vorschau')}
          </button>
        </span>
      </div>
      <input
        ref={file}
        type="file"
        className="ck-sr"
        tabIndex={-1}
        aria-label={t('Dateien einfügen')}
        multiple
        accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,application/zip,text/plain,text/csv,.docx,.xlsx,.pptx,.odt,.ods,.odp"
        onChange={(e) => {
          const fs = [...(e.target.files ?? [])];
          e.target.value = '';
          void upload(fs);
        }}
      />
      <div
        className={`wke-panes${view === 'split' ? ' split' : ''}${drop ? ' ck-dropzone' : ''}`}
        onDragOver={(e) => {
          if ([...e.dataTransfer.types].includes('Files')) {
            e.preventDefault();
            setDrop(true);
          }
        }}
        onDragLeave={() => setDrop(false)}
        onDrop={(e) => {
          setDrop(false);
          if (e.dataTransfer.files.length) {
            e.preventDefault();
            void upload([...e.dataTransfer.files]);
          }
        }}
      >
        {view !== 'preview' && (
          <div className="wke-write">
            <AutoTextarea
              ref={ta}
              className="wke-src"
              value={value}
              onChange={onChange}
              people={people}
              slash={slash}
              onKey={onKey}
              onPasteFiles={(fs) => void upload(fs)}
              placeholder={t('Schreibe los … „/“ öffnet das Blockmenü, „@“ erwähnt eine Person, Dateien lassen sich hineinziehen.')}
              ariaLabel={t('Seiteninhalt (Markdown)')}
              readOnly={readOnly}
              tour="wiki-source"
            />
          </div>
        )}
        {view !== 'write' && (
          <div className="wke-prev" aria-label={t('Vorschau')}>
            {prevErr ? <p className="muted">{prevErr}</p> : value.trim() ? <Prose html={html} store={store} /> : <p className="muted">{t('Die Vorschau erscheint hier.')}</p>}
          </div>
        )}
      </div>
      <div className="wke-foot">
        <span>{words} {t('Wörter')}</span>
        {uploading > 0 && <span>{t('Lädt hoch …')}</span>}
        <span className="grow" />
        <details>
          <summary>{t('Syntax-Hilfe')}</summary>
          <p className="small" style={{ margin: '6px 0 0', maxWidth: 520 }}>
            <code>{t('# Überschrift')}</code> · <code>{t('**fett**')}</code> · <code>{t('*kursiv*')}</code> · <code>{t('- Liste')}</code> · <code>{t('- [ ] Aufgabe')}</code> · <code>{t('> Zitat')}</code> · <code>{t('> [!TIP] Hinweis')}</code> · <code>{t('[Text](https://…)')}</code> · <code>{t('[Name](card:contact:ID)')}</code> · <code>{t('[Seite](page:ID)')}</code> · <code>{t('```Code```')}</code>
          </p>
        </details>
      </div>
      {picker && (
        <RecordPicker
          onClose={() => setPicker(false)}
          onPick={(p) => {
            setPicker(false);
            // pages are a link in the text, everything else a card of its own
            if (p.kind === 'wiki') insertInline(refMarkdown(p));
            else block(refMarkdown(p));
            toast(t('Eingefügt – die Karte zeigt immer den aktuellen Stand.'));
          }}
        />
      )}
    </div>
  );
}
