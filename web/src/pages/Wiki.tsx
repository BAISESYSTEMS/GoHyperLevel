import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactElement } from 'react';
import { BookText, ChevronDown, ChevronRight, Copy as CopyIcon, FilePlus2, FileText, FileUp, FolderInput, Globe, History, Lock, MessageSquare, MoreHorizontal, PanelLeft, Pencil, Plus, Search, Settings2, Share2, Sparkles, Star, Trash2, Upload } from 'lucide-react';
import './collab.css';
import { ApiError, ago, api, dt } from '../api';
import { Empty, Link, Spinner, act, confirmAsk, navigate, toast, toastError, useLoad } from '../ui';
import { useSession } from '../session';
import { Avatar, Menu, Prose, Snippet, useCardStore, useDebounced, withLocation, type CardStore, type Person } from './CollabKit';
import { WikiEditor } from './WikiEditor';
import { AiDialog, CommentsPanel, IconDialog, ImportDialog, MoveDialog, ShareDialog, SpaceDialog, TemplatesDialog, TrashDialog, VersionsDialog, type Space, type TreePage } from './WikiDialogs';
import { useT } from '../i18n';

/**
 * Wiki: spaces with a nested page tree (drag & drop), pages in Markdown with live cards, history, comments,
 * sharing, templates and import/export. Server contract: docs/wiki.md.
 */

type Modal = null | { kind: 'templates' | 'import' | 'trash' | 'space'; space?: Space; parent?: string | null; spaceId?: string };

const storeKey = 'pghl.wiki.tree';
function loadFolds(): { open: Set<string>; closed: Set<string> } {
  try {
    const j = JSON.parse(localStorage.getItem(storeKey) ?? '{}');
    return { open: new Set(Array.isArray(j.open) ? j.open : []), closed: new Set(Array.isArray(j.closed) ? j.closed : []) };
  } catch {
    return { open: new Set(), closed: new Set() };
  }
}

export function Wiki({ id }: { id?: string }) {
  const t = useT('collab');
  const session = useSession();
  const tree = useLoad<{ spaces: Space[]; pages: TreePage[] }>(() => api.get('/api/wiki/tree'), []);
  const favs = useLoad<{ id: string; title: string; icon: string; space_id: string }[]>(() => api.get('/api/wiki/favorites'), []);
  const people = useLoad<Person[]>(() => api.get('/api/wiki/people'), []);
  const store = useCardStore('/api/wiki/cards');
  const [drawer, setDrawer] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [folds, setFolds] = useState(loadFolds);
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const [hits, setHits] = useState<any[] | null>(null);
  const spaces = tree.data?.spaces ?? [];
  const pages = tree.data?.pages ?? [];
  const cur = id ? pages.find((p) => p.id === id) : undefined;

  const refresh = useCallback(() => {
    void tree.reload();
    void favs.reload();
  }, []);
  useEffect(() => setDrawer(false), [id]);
  useEffect(() => {
    if (dq.length < 2) return setHits(null);
    let live = true;
    api
      .get(`/api/wiki/search?q=${encodeURIComponent(dq)}&limit=25`)
      .then((r) => live && setHits(r))
      .catch(() => live && setHits([]));
    return () => {
      live = false;
    };
  }, [dq]);

  const saveFolds = (f: { open: Set<string>; closed: Set<string> }) => {
    setFolds(f);
    try {
      localStorage.setItem(storeKey, JSON.stringify({ open: [...f.open].slice(-500), closed: [...f.closed].slice(-100) }));
    } catch {
      /* private mode */
    }
  };
  const setOpen = (pid: string, on: boolean) => {
    const open = new Set(folds.open);
    if (on) open.add(pid);
    else open.delete(pid);
    saveFolds({ ...folds, open });
  };
  const setSpaceOpen = (sid: string, on: boolean) => {
    const closed = new Set(folds.closed);
    if (on) closed.delete(sid);
    else closed.add(sid);
    saveFolds({ ...folds, closed });
  };
  // the open page's ancestors unfold, so the tree always shows where you are
  useEffect(() => {
    if (!cur) return;
    const open = new Set(folds.open);
    let changed = false;
    for (let p = pages.find((x) => x.id === cur.parent_id), n = 0; p && n < 20; p = pages.find((x) => x.id === p!.parent_id), n++) if (!open.has(p.id)) (open.add(p.id), (changed = true));
    if (changed) saveFolds({ ...folds, open });
  }, [cur?.id, pages.length]);

  const kids = useMemo(() => {
    const m = new Map<string, TreePage[]>();
    for (const p of pages) {
      const k = p.parent_id ?? `s:${p.space_id}`;
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return m;
  }, [pages]);

  const editableSpace = (prefer?: string) => spaces.find((s) => s.id === prefer && s.access !== 'view') ?? spaces.find((s) => s.access !== 'view');
  const newPage = async (spaceId?: string, parentId: string | null = null) => {
    let space = editableSpace(spaceId ?? cur?.space_id);
    if (!space) {
      if (spaces.length) return toastError(new Error(t('In keinem deiner Bereiche darfst du schreiben.')));
      const made = await act(() => api.post('/api/wiki/spaces', { name: t('Team-Wiki'), icon: '📚' }));
      if (!made) return;
      space = made;
    }
    const r = await act(() => api.post('/api/wiki/pages', { space_id: space!.id, parent_id: parentId ?? undefined, title: t('Neue Seite') }));
    if (!r) return;
    if (parentId) setOpen(parentId, true);
    refresh();
    navigate(`wiki/${r.id}?edit=1`);
  };

  // --- drag & drop ---
  const drag = useRef<string | null>(null);
  const [over, setOver] = useState<{ key: string; pos: 'before' | 'into' | 'after' } | null>(null);
  const descendants = (pid: string) => {
    const out = new Set<string>([pid]);
    const walk = (x: string) => {
      for (const c of kids.get(x) ?? []) if (!out.has(c.id)) (out.add(c.id), walk(c.id));
    };
    walk(pid);
    return out;
  };
  const canDrag = (p: TreePage) => spaces.find((s) => s.id === p.space_id)?.access !== 'view';
  const move = async (pageId: string, body: { space_id: string; parent_id: string | null; before_id: string | null }) => {
    const r = await act(() => api.post(`/api/wiki/pages/${pageId}/move`, body));
    if (r) {
      if (body.parent_id) setOpen(body.parent_id, true);
      refresh();
    }
  };
  const onDropPage = (e: DragEvent, target: TreePage) => {
    e.preventDefault();
    const dragged = drag.current;
    // read from the drop itself – the highlight state may not have caught up with a fast drop
    const pos = posOf(e, e.currentTarget as HTMLElement);
    drag.current = null;
    setOver(null);
    if (!dragged || descendants(dragged).has(target.id)) return;
    if (pos === 'before') return void move(dragged, { space_id: target.space_id, parent_id: target.parent_id, before_id: target.id });
    if (pos === 'after') {
      const sibs = kids.get(target.parent_id ?? `s:${target.space_id}`) ?? [];
      const i = sibs.findIndex((s) => s.id === target.id);
      const next = sibs.slice(i + 1).find((s) => s.id !== dragged);
      return void move(dragged, { space_id: target.space_id, parent_id: target.parent_id, before_id: next?.id ?? null });
    }
    void move(dragged, { space_id: target.space_id, parent_id: target.id, before_id: null });
  };
  const posOf = (e: DragEvent, el: HTMLElement): 'before' | 'into' | 'after' => {
    const r = el.getBoundingClientRect();
    const y = (e.clientY - r.top) / Math.max(1, r.height);
    return y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'into';
  };

  const row = (p: TreePage, depth: number): ReactElement => {
    const children = kids.get(p.id) ?? [];
    const isOpen = folds.open.has(p.id);
    const on = p.id === id;
    const mayEdit = canDrag(p);
    const o = over?.key === p.id ? over.pos : null;
    return (
      <div key={p.id} role="treeitem" aria-expanded={children.length ? isOpen : undefined} aria-selected={on}>
        <div
          className={`wkp-row${on ? ' on' : ''}${o ? ` over-${o}` : ''}${drag.current === p.id ? ' dragging' : ''}`}
          style={{ ['--d' as string]: depth }}
          tabIndex={0}
          draggable={mayEdit}
          onDragStart={(e) => {
            drag.current = p.id;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', p.title);
          }}
          onDragEnd={() => {
            drag.current = null;
            setOver(null);
          }}
          onDragOver={(e) => {
            if (!drag.current || !mayEdit) return;
            if (descendants(drag.current).has(p.id)) return setOver(null);
            e.preventDefault();
            const pos = posOf(e, e.currentTarget);
            if (over?.key !== p.id || over.pos !== pos) setOver({ key: p.id, pos });
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((cur) => (cur?.key === p.id ? null : cur));
          }}
          onDrop={(e) => onDropPage(e, p)}
          onClick={() => navigate(`wiki/${p.id}`)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), navigate(`wiki/${p.id}`));
            else if (e.key === 'ArrowRight' && children.length) (e.preventDefault(), setOpen(p.id, true));
            else if (e.key === 'ArrowLeft' && children.length) (e.preventDefault(), setOpen(p.id, false));
          }}
        >
          <button
            className={`wkp-twist${children.length ? '' : ' none'}`}
            tabIndex={-1}
            aria-label={isOpen ? t('Zuklappen') : t('Aufklappen')}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(p.id, !isOpen);
            }}
          >
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <span className="wkp-ico">{p.icon || <FileText size={15} />}</span>
          <span className="wkp-name" title={p.title}>
            {p.title}
          </span>
          {p.published && <Globe size={12} className="wkp-pub" aria-label={t('Im Help Center veröffentlicht')} />}
          {mayEdit && (
            <button
              className="icon-btn wkp-add"
              title={t('Unterseite anlegen')}
              aria-label={t('Unterseite von „{title}“ anlegen', { title: p.title })}
              onClick={(e) => {
                e.stopPropagation();
                void newPage(p.space_id, p.id);
              }}
            >
              <Plus size={14} />
            </button>
          )}
        </div>
        {isOpen && children.length > 0 && <div role="group">{children.map((c) => row(c, depth + 1))}</div>}
      </div>
    );
  };

  const searching = dq.length >= 2;
  const anyEditable = spaces.some((s) => s.access !== 'view');
  const side = (
    <aside className="wkp-side" aria-label={t('Wiki-Navigation')} data-tour="wiki-tree">
      <div className="wkp-side-head">
        <div className="ck-row">
          <button className="btn" onClick={() => (anyEditable || !spaces.length ? void newPage() : setModal({ kind: 'templates' }))} data-tour="wiki-new">
            <FilePlus2 size={16} /> {t('Neue Seite')}
          </button>
          <Menu
            title={t('Weitere Aktionen')}
            trigger={<MoreHorizontal size={16} />}
            left
            items={[
              { label: t('Aus Vorlage …'), icon: <BookText size={15} />, onClick: () => setModal({ kind: 'templates', spaceId: cur?.space_id }), hidden: !anyEditable },
              { label: t('Markdown importieren …'), icon: <Upload size={15} />, onClick: () => setModal({ kind: 'import', spaceId: cur?.space_id }), hidden: !anyEditable },
              { label: t('Neuer Bereich …'), icon: <Plus size={15} />, onClick: () => setModal({ kind: 'space' }) },
              { sep: true, label: '' },
              { label: t('Papierkorb'), icon: <Trash2 size={15} />, onClick: () => setModal({ kind: 'trash' }) },
            ]}
          />
        </div>
        <div className="wkp-search" data-tour="wiki-search">
          <Search size={15} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && q && (e.stopPropagation(), setQ(''))}
            placeholder={t('Im Wiki suchen …')}
            aria-label={t('Im Wiki suchen')}
          />
        </div>
      </div>
      <div className="wkp-scroll">
        {tree.loading && !tree.data && <Spinner />}
        {tree.error && <p className="muted" style={{ padding: 10 }}>{tree.error}</p>}
        {searching ? (
          hits === null ? (
            <Spinner />
          ) : hits.length ? (
            hits.map((h) => (
              <a key={h.id} className="wkp-hit" href={`/app/wiki/${h.id}`} onClick={(e) => (e.preventDefault(), setQ(''), navigate(`wiki/${h.id}`))}>
                <b>
                  {h.icon} <Snippet text={h.title} />
                </b>
                <span className="ck-snip">
                  <Snippet text={h.snippet} />
                </span>
                <span className="muted small">{h.space_name}</span>
              </a>
            ))
          ) : (
            <p className="muted" style={{ padding: 10 }}>{t('Nichts gefunden.')}</p>
          )
        ) : (
          <>
            {!!favs.data?.length && (
              <>
                <div className="wkp-sec">
                  <span>{t('Favoriten')}</span>
                </div>
                {favs.data.map((f) => (
                  <div key={f.id} className={`wkp-row${f.id === id ? ' on' : ''}`} tabIndex={0} onClick={() => navigate(`wiki/${f.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`wiki/${f.id}`)} style={{ ['--d' as string]: 0 }}>
                    <span className="wkp-twist none" />
                    <span className="wkp-ico">{f.icon || <Star size={14} />}</span>
                    <span className="wkp-name">{f.title}</span>
                  </div>
                ))}
              </>
            )}
            {spaces.map((s) => {
              const open = !folds.closed.has(s.id);
              const roots = kids.get(`s:${s.id}`) ?? [];
              const mayEdit = s.access !== 'view';
              const o = over?.key === `s:${s.id}`;
              return (
                <div key={s.id}>
                  <div className="wkp-sec">
                    <span className="ck-row" style={{ gap: 4 }}>
                      <button className="wkp-twist" onClick={() => setSpaceOpen(s.id, !open)} aria-label={open ? t('{name} zuklappen', { name: s.name }) : t('{name} aufklappen', { name: s.name })} aria-expanded={open}>
                        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                      <span title={s.description || undefined}>
                        {s.icon} {s.name}
                      </span>
                      {s.team_access === 'none' && <Lock size={11} aria-label={t('Privat')} />}
                    </span>
                    <Menu
                      title={t('Aktionen für {name}', { name: s.name })}
                      className="icon-btn"
                      trigger={<MoreHorizontal size={15} />}
                      items={[
                        { label: t('Neue Seite'), icon: <FilePlus2 size={15} />, onClick: () => void newPage(s.id), hidden: !mayEdit },
                        { label: t('Aus Vorlage …'), icon: <BookText size={15} />, onClick: () => setModal({ kind: 'templates', spaceId: s.id }), hidden: !mayEdit },
                        { label: t('Markdown importieren …'), icon: <Upload size={15} />, onClick: () => setModal({ kind: 'import', spaceId: s.id }), hidden: !mayEdit },
                        { label: t('Bereich bearbeiten …'), icon: <Settings2 size={15} />, onClick: () => setModal({ kind: 'space', space: s }), hidden: s.access !== 'owner' },
                      ]}
                    />
                  </div>
                  <div
                    onDragOver={(e) => {
                      if (!drag.current || !mayEdit) return;
                      e.preventDefault();
                      if (over?.key !== `s:${s.id}`) setOver({ key: `s:${s.id}`, pos: 'into' });
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((c) => (c?.key === `s:${s.id}` ? null : c));
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const dragged = drag.current;
                      drag.current = null;
                      setOver(null);
                      if (dragged) void move(dragged, { space_id: s.id, parent_id: null, before_id: null });
                    }}
                    className={o ? 'wkp-row over-into' : undefined}
                    style={o ? { display: 'block' } : undefined}
                    // the pages of a space: a tree (its items are the pages; the space header above stays outside)
                    role={open && roots.length ? 'tree' : undefined}
                    aria-label={open && roots.length ? s.name : undefined}
                  >
                    {open && roots.map((p) => row(p, 0))}
                    {open && !roots.length && (
                      <p className="muted small" style={{ padding: '2px 12px 6px' }}>
                        {t('Noch keine Seiten.')}{' '}
                        {mayEdit && (
                          <a href="#" onClick={(e) => (e.preventDefault(), void newPage(s.id))}>
                            {t('Erste Seite anlegen')}
                          </a>
                        )}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
            {!spaces.length && !tree.loading && (
              <p className="muted small" style={{ padding: 10 }}>
                {t('Noch kein Bereich. Lege mit „Neue Seite“ dein Team-Wiki an.')}
              </p>
            )}
          </>
        )}
      </div>
    </aside>
  );

  const parentOfModal = modal?.parent ?? null;
  return (
    <div className={`wkp${drawer ? ' drawer' : ''}`} data-tour="wiki-page">
      {side}
      <div className="wkp-scrim" onClick={() => setDrawer(false)} aria-hidden="true" />
      <main className="wkp-main">
        {id ? (
          <PageView key={id} id={id} spaces={spaces} pages={pages} people={people.data ?? []} store={store} refresh={refresh} newChild={(pid, sid) => void newPage(sid, pid)} openDrawer={() => setDrawer(true)} me={session.user.id} />
        ) : (
          <Start spaces={spaces} pages={pages} loading={tree.loading && !tree.data} openDrawer={() => setDrawer(true)} onTemplates={() => setModal({ kind: 'templates' })} onImport={() => setModal({ kind: 'import' })} onSpace={() => setModal({ kind: 'space' })} onNew={() => void newPage()} />
        )}
      </main>
      {modal?.kind === 'templates' && (
        <TemplatesDialog
          spaces={spaces}
          spaceId={modal.spaceId}
          parentId={parentOfModal}
          onClose={() => setModal(null)}
          onCreated={(p) => {
            setModal(null);
            refresh();
            navigate(`wiki/${p.id}`);
          }}
        />
      )}
      {modal?.kind === 'import' && (
        <ImportDialog
          spaces={spaces}
          spaceId={modal.spaceId}
          parentId={parentOfModal}
          onClose={() => setModal(null)}
          onDone={(r) => {
            setModal(null);
            refresh();
            if (r.pages[0]) navigate(`wiki/${r.pages[0].id}`);
          }}
        />
      )}
      {modal?.kind === 'trash' && <TrashDialog onClose={() => setModal(null)} onChanged={refresh} />}
      {modal?.kind === 'space' && (
        <SpaceDialog
          space={modal.space}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            refresh();
          }}
          onDeleted={() => {
            setModal(null);
            refresh();
            if (cur && modal.space?.id === cur.space_id) navigate('wiki');
          }}
        />
      )}
    </div>
  );
}

// --- start page ---------------------------------------------------------------------------------------------------------------------

function Start({ spaces, pages, loading, openDrawer, onTemplates, onImport, onSpace, onNew }: { spaces: Space[]; pages: TreePage[]; loading: boolean; openDrawer: () => void; onTemplates: () => void; onImport: () => void; onSpace: () => void; onNew: () => void }) {
  const t = useT('collab');
  const recent = useLoad<any[]>(() => api.get('/api/wiki/search?q=&limit=8'), []);
  const editable = spaces.some((s) => s.access !== 'view');
  return (
    <div className="wkp-start">
      <div className="wkp-toolbar">
        <button className="btn secondary small wkp-drawer-btn" onClick={openDrawer}>
          <PanelLeft size={15} /> {t('Seiten')}
        </button>
      </div>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <BookText size={26} /> Wiki
      </h1>
      <p className="muted" style={{ maxWidth: 640 }}>
        {t('Das Wissen deines Teams an einem Ort: Prozesse, Checklisten, Projektnotizen und Einarbeitung – mit Live-Karten aus dem CRM, Kommentaren und Versionsverlauf.')}
      </p>
      {loading ? (
        <Spinner />
      ) : (
        <>
          <div className="ck-row wrap" style={{ margin: '14px 0' }}>
            <button className="btn" onClick={onNew}>
              <FilePlus2 size={16} /> {spaces.length ? t('Neue Seite') : t('Team-Wiki anlegen')}
            </button>
            {editable && (
              <>
                <button className="btn secondary" onClick={onTemplates}>
                  <BookText size={16} /> {t('Aus Vorlage')}
                </button>
                <button className="btn secondary" onClick={onImport}>
                  <FileUp size={16} /> {t('Markdown importieren')}
                </button>
              </>
            )}
            <button className="btn secondary" onClick={onSpace}>
              <Plus size={16} /> {t('Neuer Bereich')}
            </button>
          </div>
          {!!spaces.length && (
            <>
              <h2>{t('Bereiche')}</h2>
              <div className="wkp-grid">
                {spaces.map((s) => (
                  <button
                    key={s.id}
                    className="wkp-tile"
                    onClick={() => {
                      const first = pages.filter((p) => p.space_id === s.id && !p.parent_id).sort((a, b) => a.position - b.position)[0];
                      if (first) navigate(`wiki/${first.id}`);
                      else if (s.access !== 'view') onNew();
                    }}
                  >
                    <span className="big">{s.icon || '📚'}</span>
                    <b>{s.name}</b>
                    <span className="muted small">{s.description || `${s.page_count} ${s.page_count === 1 ? t('Seite') : t('Seiten')}`}</span>
                    <span className="muted small">
                      {s.access === 'view' ? t('Nur lesen') : s.team_access === 'none' ? t('Privat') : s.team_access === 'view' ? t('Team liest') : t('Team bearbeitet')}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
          {!!recent.data?.length && (
            <>
              <h2 style={{ marginTop: 22 }}>{t('Zuletzt bearbeitet')}</h2>
              <div className="ck-list">
                {recent.data.map((h) => (
                  <div key={h.id}>
                    <span>{h.icon || '📄'}</span>
                    <div className="ck-grow">
                      <Link to={`wiki/${h.id}`}>
                        <b>{h.title}</b>
                      </Link>
                      <div className="ck-snip">{h.snippet}</div>
                    </div>
                    <span className="muted small">
                      {h.space_name} · {ago(h.updated_at)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// --- one page -------------------------------------------------------------------------------------------------------------------------

type SaveState = 'saved' | 'dirty' | 'saving' | 'err' | 'conflict';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function PageView({ id, spaces, pages, people, store, refresh, newChild, openDrawer, me }: { id: string; spaces: Space[]; pages: TreePage[]; people: Person[]; store: CardStore; refresh: () => void; newChild: (parent: string, space: string) => void; openDrawer: () => void; me: string }) {
  const t = useT('collab');
  const [page, setPage] = useState<any>();
  const [err, setErr] = useState('');
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [draft, setDraft] = useState({ title: '', body: '', icon: '' });
  const [save, setSave] = useState<SaveState>('saved');
  const [saveErr, setSaveErr] = useState('');
  const [remote, setRemote] = useState<{ by: string } | null>(null);
  const [panel, setPanel] = useState(() => new URLSearchParams(location.search).has('comment'));
  const [dlg, setDlg] = useState<null | 'share' | 'versions' | 'move' | 'icon' | 'ai'>(null);
  const [aiSel, setAiSel] = useState('');
  const [counts, setCounts] = useState<{ open: number; total: number } | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [focusTitle, setFocusTitle] = useState(false);
  const pageRef = useRef<any>(undefined);
  pageRef.current = page;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const saved = useRef({ title: '', body: '', icon: '' });
  const flight = useRef(false);
  const again = useRef(false);
  const saveRef = useRef<SaveState>('saved');
  saveRef.current = save;

  const load = useCallback(
    async (silent = false) => {
      try {
        const p = await api.get(`/api/wiki/pages/${id}`);
        setPage(p);
        setErr('');
        store.invalidate();
        return p;
      } catch (e) {
        if (!silent) setErr((e as Error).message);
        return undefined;
      }
    },
    [id, store],
  );
  const startEdit = (p: any) => {
    saved.current = { title: p.title, body: p.body, icon: p.icon };
    setDraft({ title: p.title, body: p.body, icon: p.icon });
    setSave('saved');
    setSaveErr('');
    setRemote(null);
    setMode('edit');
  };
  useEffect(() => {
    void load().then((p) => {
      if (p && new URLSearchParams(location.search).get('edit') === '1' && p.access !== 'view') {
        history.replaceState(null, '', location.pathname);
        startEdit(p);
        setFocusTitle(true);
      }
    });
  }, [id]);
  useEffect(() => {
    if (focusTitle && mode === 'edit' && titleRef.current) {
      titleRef.current.focus();
      titleRef.current.select();
      setFocusTitle(false);
    }
  }, [focusTitle, mode, page]);

  const changed = () => {
    const d = draftRef.current;
    const s = saved.current;
    return d.title !== s.title || d.body !== s.body || d.icon !== s.icon;
  };
  const saveNow = useCallback(
    async (force = false): Promise<void> => {
      const pg = pageRef.current;
      if (!pg) return;
      if (flight.current) {
        again.current = true;
        return;
      }
      flight.current = true;
      again.current = false;
      setSave('saving');
      const sent = draftRef.current;
      try {
        const r = await api.patch(`/api/wiki/pages/${pg.id}`, { title: sent.title, body: sent.body, icon: sent.icon, base_version: pg.version, ...(force ? { force: true } : {}) });
        const next = { ...pg, version: r.version, updated_at: r.updated_at, updated_by_name: r.updated_by_name, words: r.words, title: r.title, icon: r.icon };
        pageRef.current = next;
        setPage(next);
        saved.current = sent;
        setSaveErr('');
        setRemote(null);
        if (sent.title !== pg.title || sent.icon !== pg.icon) refresh();
        setSave(changed() ? 'dirty' : 'saved');
      } catch (e) {
        flight.current = false;
        if (e instanceof ApiError && e.status === 409) setSave('conflict');
        else setSave('err');
        setSaveErr((e as Error).message);
        return;
      }
      flight.current = false;
      if (again.current || changed()) await saveNow();
    },
    [refresh],
  );
  useEffect(() => {
    if (mode !== 'edit' || !pageRef.current || !changed()) return;
    if (saveRef.current === 'conflict') return;
    setSave((s) => (s === 'saving' ? s : 'dirty'));
    const timer = setTimeout(() => void saveNow(), 1200);
    return () => clearTimeout(timer);
  }, [draft, mode]);
  // leaving the page saves what is left; closing the tab asks first
  useEffect(
    () => () => {
      if (changed() && saveRef.current !== 'conflict' && pageRef.current) void saveNow();
    },
    [],
  );
  useEffect(() => {
    if (save !== 'dirty' && save !== 'saving') return;
    const warn = (e: BeforeUnloadEvent) => (e.preventDefault(), (e.returnValue = ''));
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [save]);

  // somebody else saved?
  useEffect(() => {
    const timer = setInterval(async () => {
      if (document.visibilityState !== 'visible' || flight.current || saveRef.current === 'conflict') return;
      try {
        const v = await api.get(`/api/wiki/pages/${id}/version`);
        const cur = pageRef.current;
        if (!cur || v.version <= cur.version) return;
        if (mode === 'view') {
          const p = await load(true);
          if (p) toast(t('„{title}“ wurde von {name} aktualisiert', { title: p.title, name: v.updated_by_name || t('jemandem') }));
        } else setRemote({ by: v.updated_by_name || t('Jemand') });
      } catch {
        /* offline or gone: the next round tries again */
      }
    }, 15_000);
    return () => clearInterval(timer);
  }, [id, mode]);

  const finish = async () => {
    while (flight.current) await sleep(60);
    if (changed() && saveRef.current !== 'conflict') await saveNow();
    while (flight.current) await sleep(60);
    if (saveRef.current === 'conflict' || saveRef.current === 'err') return;
    const p = await load();
    setMode('view');
    if (p) refresh();
  };

  const toggle = async (line: number, checked: boolean) => {
    try {
      const r = await api.post(`/api/wiki/pages/${id}/toggle`, { line, checked, base_version: pageRef.current.version });
      setPage(r);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        await load(true);
        toast(t('Die Seite wurde inzwischen geändert – bitte noch einmal abhaken.'));
      } else toastError(e);
      throw e;
    }
  };

  if (err) return <Empty action={<Link to="wiki" className="btn secondary">{t('Zur Wiki-Übersicht')}</Link>}>{err}</Empty>;
  if (!page) return <Spinner />;
  const edit = mode === 'edit';
  const canEdit = page.access !== 'view';
  const space = spaces.find((s) => s.id === page.space_id);
  const aiOn = true;
  const exportUrl = (format: string, children = false) => withLocation(`/api/wiki/pages/${page.id}/export?format=${format}${children ? '&children=1' : ''}`);
  const statusText: Record<SaveState, string> = { saved: t('Gespeichert'), dirty: t('Ungespeichert …'), saving: t('Speichert …'), err: t('Speichern fehlgeschlagen'), conflict: t('Konflikt') };

  const remove = async () => {
    if (!confirmAsk(t('„{title}“ in den Papierkorb legen?{children} Du kannst sie 30 Tage lang wiederherstellen.', { title: page.title, children: page.children?.length ? t.plural(page.children.length, { other: ' Die {n} Unterseiten kommen mit.' }) : '' }))) return;
    if (edit && changed()) setSave('saved');
    saved.current = draftRef.current;
    const r = await act(() => api.del(`/api/wiki/pages/${page.id}`), t('In den Papierkorb gelegt'));
    if (r) {
      refresh();
      navigate(page.parent_id ? `wiki/${page.parent_id}` : 'wiki');
    }
  };
  const duplicate = async (children: boolean) => {
    const r = await act(() => api.post(`/api/wiki/pages/${page.id}/duplicate`, { children }), t('Kopie angelegt'));
    if (r) {
      refresh();
      navigate(`wiki/${r.id}`);
    }
  };
  const fav = async () => {
    const r = await act(() => (page.favorite ? api.del(`/api/wiki/pages/${page.id}/favorite`) : api.post(`/api/wiki/pages/${page.id}/favorite`, {})));
    if (r) {
      setPage({ ...page, favorite: !page.favorite });
      refresh();
    }
  };

  const insertAi = (text: string) => {
    setDraft((d) => ({ ...d, body: `${d.body.replace(/\s+$/, '')}\n\n${text}`.trim() }));
    setDlg(null);
    toast(t('Eingefügt – die Seite wird gespeichert.'));
  };
  const replaceAi = (text: string, selection: boolean) => {
    setDraft((d) => ({ ...d, body: selection && aiSel && d.body.includes(aiSel) ? d.body.replace(aiSel, () => text) : text }));
    setDlg(null);
    toast(t('Ersetzt – die alte Fassung bleibt im Verlauf.'));
  };
  const openAi = (sel: string) => {
    if (!edit) startEdit(page);
    setAiSel(sel);
    setDlg('ai');
  };

  return (
    <div className={`wkp-doc${edit ? ' wide' : ''}`}>
      <div className="wkp-toolbar">
        <button className="btn secondary small wkp-drawer-btn" onClick={openDrawer} aria-label={t('Seitenbaum öffnen')}>
          <PanelLeft size={15} /> {t('Seiten')}
        </button>
        <nav className="wkp-crumbs" aria-label={t('Pfad')}>
          <Link to="wiki">{space ? `${space.icon} ${space.name}`.trim() : 'Wiki'}</Link>
          {page.path.map((p: any) => (
            <span key={p.id} className="ck-row" style={{ gap: 4 }}>
              <ChevronRight size={12} />
              <Link to={`wiki/${p.id}`}>{`${p.icon} ${p.title}`.trim()}</Link>
            </span>
          ))}
        </nav>
        {edit && (
          <span className={`wkp-status ${save === 'saving' || save === 'dirty' ? 'saving' : save === 'saved' ? '' : 'err'}`} role="status">
            {statusText[save]}
          </span>
        )}
        <button className="btn secondary small" onClick={fav} aria-pressed={page.favorite} title={page.favorite ? t('Aus Favoriten entfernen') : t('Zu Favoriten')} aria-label={t('Favorit')}>
          <Star size={15} fill={page.favorite ? 'currentColor' : 'none'} />
        </button>
        <button className="btn secondary small" onClick={() => setPanel(!panel)} data-tour="wiki-comments-btn">
          <MessageSquare size={15} /> {t('Kommentare')}{(counts?.total ?? page.comments.total) > 0 ? ` (${counts?.total ?? page.comments.total})` : ''}
        </button>
        <button className="btn secondary small" onClick={() => setDlg('share')} data-tour="wiki-share" disabled={!canEdit && !page.shares}>
          <Share2 size={15} /> {t('Teilen')}
        </button>
        {canEdit && (edit ? (
          <button className="btn small" onClick={finish} data-tour="wiki-done">
            {t('Fertig')}
          </button>
        ) : (
          <button className="btn small" onClick={() => startEdit(page)} data-tour="wiki-edit">
            <Pencil size={14} /> {t('Bearbeiten')}
          </button>
        ))}
        <Menu
          title={t('Mehr')}
          tour="wiki-more"
          trigger={<MoreHorizontal size={16} />}
          items={[
            { label: t('Verlauf'), icon: <History size={15} />, onClick: () => setDlg('versions') },
            { label: t('Unterseite anlegen'), icon: <FilePlus2 size={15} />, onClick: () => newChild(page.id, page.space_id), hidden: !canEdit },
            { label: t('KI-Schreibhilfe …'), icon: <Sparkles size={15} />, onClick: () => openAi(''), hidden: !canEdit || !aiOn },
            { label: t('Duplizieren'), icon: <CopyIcon size={15} />, onClick: () => void duplicate(false), hidden: !canEdit },
            { label: t('Mit Unterseiten duplizieren'), icon: <CopyIcon size={15} />, onClick: () => void duplicate(true), hidden: !canEdit || !page.children?.length },
            { label: t('Verschieben …'), icon: <FolderInput size={15} />, onClick: () => setDlg('move'), hidden: !canEdit },
            { sep: true, label: '' },
            { label: t('Als Markdown laden'), href: exportUrl('md') },
            { label: t('Als PDF laden'), href: exportUrl('pdf') },
            { label: t('Mit Unterseiten als Markdown'), href: exportUrl('md', true), hidden: !page.children?.length },
            { label: t('Mit Unterseiten als PDF'), href: exportUrl('pdf', true), hidden: !page.children?.length },
            { sep: true, label: '' },
            { label: t('In den Papierkorb'), icon: <Trash2 size={15} />, danger: true, onClick: () => void remove(), hidden: !canEdit },
          ]}
        />
      </div>

      {(save === 'conflict' || remote) && edit && (
        <div className="ck-banner err" role="alert">
          <span className="grow">
            {save === 'conflict' ? saveErr || t('Die Seite wurde inzwischen geändert.') : t('{name} hat diese Seite gerade geändert. Wenn du weiterschreibst, kann es zu einem Konflikt kommen.', { name: remote!.by })}
          </span>
          <button
            className="btn small secondary"
            onClick={async () => {
              const p = await load();
              if (p) startEdit(p);
            }}
          >
            {t('Neu laden (meine Änderungen verwerfen)')}
          </button>
          {save === 'conflict' && (
            <>
              <button className="btn small secondary" onClick={() => void navigator.clipboard?.writeText(draft.body).then(() => toast(t('Text kopiert')))}>
                {t('Meinen Text kopieren')}
              </button>
              <button className="btn small" onClick={() => void saveNow(true)}>
                {t('Meine Fassung behalten')}
              </button>
            </>
          )}
        </div>
      )}
      {save === 'err' && edit && (
        <div className="ck-banner err" role="alert">
          <span className="grow">{saveErr}</span>
          <button className="btn small" onClick={() => void saveNow()}>
            {t('Erneut versuchen')}
          </button>
        </div>
      )}
      {!edit && page.published?.outdated && canEdit && (
        <div className="ck-banner">
          <span className="grow">{t('Im Help Center steht noch eine ältere Fassung dieser Seite.')}</span>
          <button className="btn small" onClick={() => setDlg('share')}>
            {t('Aktualisieren')}
          </button>
        </div>
      )}

      <div className="wkp-head">
        <button className={`wkp-icon-btn${page.icon || draft.icon ? '' : ' empty'}`} disabled={!edit} onClick={() => setDlg('icon')} aria-label={t('Symbol ändern')} title={edit ? t('Symbol ändern') : undefined}>
          {(edit ? draft.icon : page.icon) || (edit ? '＋' : '')}
        </button>
        <input
          ref={titleRef}
          className="wkp-title"
          value={edit ? draft.title : page.title}
          readOnly={!edit}
          maxLength={200}
          aria-label={t('Titel der Seite')}
          placeholder={t('Titel')}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          data-tour="wiki-title"
        />
      </div>
      <div className="wkp-meta">
        <span className="ck-row" style={{ gap: 6 }}>
          <Avatar name={page.updated_by_name || page.created_by_name || '?'} size={20} />
          {page.updated_by_name || page.created_by_name || t('Unbekannt')} · {ago(page.updated_at)}
        </span>
        <span title={dt(page.created_at)}>{t('Version')} {page.version}</span>
        <span>{page.words} {t('Wörter')}</span>
        {page.tasks.total > 0 && (
          <span>
            ✅ {page.tasks.done}/{page.tasks.total}
          </span>
        )}
        {page.published && <span className="badge green">{t('Im Help Center')}</span>}
        {page.shares > 0 && <span className="badge blue">{page.shares} {t('Link')}{page.shares > 1 ? 's' : ''}</span>}
        {!canEdit && <span className="badge gray">{t('Nur lesen')}</span>}
      </div>

      {edit ? (
        <WikiEditor value={draft.body} onChange={(body) => setDraft((d) => ({ ...d, body }))} store={store} people={people} onAi={aiOn ? openAi : undefined} />
      ) : (
        <div className="wkp-body">
          <div data-tour="wiki-content">
            {page.body.trim() ? (
              <Prose html={page.html} store={store} onToggle={canEdit ? toggle : undefined} />
            ) : (
              <p className="muted">
                {t('Diese Seite ist noch leer.')}{' '}
                {canEdit && (
                  <a href="#" onClick={(e) => (e.preventDefault(), startEdit(page))}>
                    {t('Jetzt schreiben')}
                  </a>
                )}
              </p>
            )}
          </div>
          {page.toc.length > 1 && (
            <nav className="wkp-toc" aria-label={t('Inhalt')} data-tour="wiki-toc">
              <b>{t('Auf dieser Seite')}</b>
              {page.toc.map((entry: any) => (
                <a key={entry.id} href={`#${entry.id}`} style={{ paddingLeft: Math.max(0, entry.level - 2) * 12 }} onClick={(e) => (e.preventDefault(), document.getElementById(entry.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))}>
                  {entry.text}
                </a>
              ))}
            </nav>
          )}
        </div>
      )}

      {!edit && (page.children.length > 0 || page.backlinks.length > 0) && (
        <div className="wkp-sub">
          {page.children.length > 0 && (
            <>
              <h4>{t('Unterseiten')}</h4>
              {page.children.map((c: any) => (
                <Link key={c.id} to={`wiki/${c.id}`}>
                  {c.icon || <FileText size={14} />} {c.title}
                </Link>
              ))}
            </>
          )}
          {page.backlinks.length > 0 && (
            <>
              <h4 style={{ marginTop: 8 }}>{t('Verlinkt von')}</h4>
              {page.backlinks.map((c: any) => (
                <Link key={c.id} to={`wiki/${c.id}`}>
                  {c.icon || <FileText size={14} />} {c.title}
                </Link>
              ))}
            </>
          )}
        </div>
      )}

      {panel && <CommentsPanel pageId={page.id} me={me} owner={page.access === 'owner'} canResolve={canEdit} people={people} store={store} focus={new URLSearchParams(location.search).get('comment') ?? undefined} onCount={(open, total) => setCounts({ open, total })} onClose={() => setPanel(false)} />}
      {dlg === 'share' && <ShareDialog page={page} onChanged={() => void load(true)} onClose={() => setDlg(null)} />}
      {dlg === 'versions' && (
        <VersionsDialog
          page={page}
          store={store}
          canEdit={canEdit}
          onClose={() => setDlg(null)}
          onRestored={(p) => {
            setDlg(null);
            setPage(p);
            if (edit) startEdit(p);
            refresh();
          }}
        />
      )}
      {dlg === 'move' && (
        <MoveDialog
          page={page}
          spaces={spaces}
          pages={pages}
          onClose={() => setDlg(null)}
          onMoved={() => {
            setDlg(null);
            refresh();
            void load(true);
          }}
        />
      )}
      {dlg === 'icon' && (
        <IconDialog
          value={draft.icon}
          onClose={() => setDlg(null)}
          onPick={(v) => {
            setDraft({ ...draft, icon: v });
            setDlg(null);
          }}
        />
      )}
      {dlg === 'ai' && <AiDialog pageId={page.id} selection={aiSel} onClose={() => setDlg(null)} onInsert={insertAi} onReplace={replaceAi} />}
    </div>
  );
}
