import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../icons';
import { api } from '../../api';
import { QrButton } from '../../QrCode';
import { Check, Field, Input, Modal, Select, Tabs, Textarea, act, confirmAsk, toast, useLoad } from '../../ui';
import { DraftCheck } from './A11y';
import { BLOCKS, BLOCK_TYPES, GROUPS } from './blocks';
import { SiteCtx, type SiteData } from './Fields';
import { Inspector } from './Inspector';
import { accepts, Tree, type Drag } from './Tree';
import {
  clone,
  countNodes,
  duplicate,
  find,
  fixSpans,
  hasSections,
  insert,
  insertionPoint,
  kindOf,
  move,
  newBlock,
  newSection,
  nudge,
  remove,
  resizeCols,
  SECTION_PRESETS,
  toLayout,
  uid,
  update,
  type Block,
  type Container,
} from './model';
import './site.css';
import { tr, useT } from '../../i18n';
import { lazyPages } from '../../lazy';

// Funnel & Website AI: the builder's AI side panel is a chunk of its own (modules/site-ai.ts, docs/site-ai.md).
const { SiteAiPanel } = lazyPages(() => import('./AiPanel'), 'SiteAiPanel');

const DEVICE_WIDTH = { desktop: '100%', tablet: '820px', phone: '390px' } as const;
type Device = keyof typeof DEVICE_WIDTH;
const MAX_NODES = 400;

export interface EditorProps {
  page: any;
  funnel: any;
  onSaved: () => void;
  /** Other editors reuse this one (A/B variants, components): where to save and preview. */
  endpoints?: { save: string; preview: string; /** Name of the field the blocks are saved under (default `blocks`). */ key?: string; /** Body of the preview request. */ previewBody?: (blocks: Block[]) => Record<string, any> };
  /** Replaces the "Live" and QR buttons. */
  extra?: ReactNode;
  /** The blocks of a component: no SEO, no page layout. */
  component?: boolean;
  /** Jump to this block after load (from the accessibility check). */
  focusBlock?: string;
}

const COLS_ICON = { 1: 'column1', 2: 'columns2', 3: 'columns3', 4: 'columns3' } as const;

/** The starting values of a new block in the UI language (blocks.ts holds them in German – message ids of the sites catalog). */
function localInit<T>(v: T): T {
  const t = tr('sites');
  const walk = (x: any): any => (typeof x === 'string' ? t(x) : Array.isArray(x) ? x.map(walk) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)])) : x);
  return walk(v);
}

/** The page editor: structure tree with drag & drop, inspector (content, style, devices) and a live preview per device. */
export function SiteEditor({ page, funnel, onSaved, endpoints, extra, component, focusBlock }: EditorProps) {
  const t = useT('sites');
  const [blocks, setBlocks] = useState<Block[]>(page.blocks ?? []);
  const [seo, setSeo] = useState<any>(page.seo ?? {});
  const [layout, setLayout] = useState<any>(page.layout ?? {});
  const [selId, setSelId] = useState<string | undefined>(undefined);
  const [html, setHtml] = useState('');
  const [dirty, setDirty] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [device, setDevice] = useState<Device>('desktop');
  const [addTab, setAddTab] = useState('blocks');
  const [saveAs, setSaveAs] = useState<Block | null>(null);
  const [editComp, setEditComp] = useState<any>(null);
  const [pageTab, setPageTab] = useState('seo');
  const [ai, setAi] = useState(false);
  const past = useRef<Block[][]>([]);
  const future = useRef<Block[][]>([]);
  const last = useRef({ key: '', at: 0 });
  const [, bump] = useState(0);

  const forms = useLoad(() => api.get<any[]>('/api/forms'), []);
  const calendars = useLoad(() => api.get<any[]>('/api/calendars'), []);
  const products = useLoad(() => api.get<any[]>('/api/products'), []);
  const collections = useLoad(() => api.get<any[]>(`/api/funnels/${funnel.id}/collections`), [funnel.id]);
  const components = useLoad(() => api.get<any[]>('/api/site-components?blocks=1'), []);
  const design = useLoad(() => api.get<any>(`/api/funnels/${funnel.id}/design`), [funnel.id]);

  const site: SiteData = useMemo(
    () => ({
      funnelId: funnel.id,
      forms: forms.data ?? [],
      calendars: calendars.data ?? [],
      products: products.data ?? [],
      collections: collections.data ?? [],
      components: components.data ?? [],
      pages: (funnel.pages ?? []).map((p: any) => ({ id: p.id, name: p.name, slug: p.slug })),
      colors: design.data?.tokens?.colors ?? {},
    }),
    [funnel.id, funnel.pages, forms.data, calendars.data, products.data, collections.data, components.data, design.data],
  );

  // A different page: start over.
  useEffect(() => {
    setBlocks(page.blocks ?? []);
    setSeo(page.seo ?? {});
    setLayout(page.layout ?? {});
    setSelId(undefined);
    setDirty(false);
    past.current = [];
    future.current = [];
  }, [page.id]);

  useEffect(() => {
    if (focusBlock && find(blocks, focusBlock)) setSelId(focusBlock);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusBlock, page.id]);

  // Live preview (unsaved blocks and layout), a little after the last change.
  useEffect(() => {
    const url = endpoints?.preview ?? `/api/funnel-pages/${page.id}/preview`;
    const timer = setTimeout(() => api.text('POST', url, endpoints?.previewBody ? endpoints.previewBody(blocks) : component || endpoints ? { blocks } : { blocks, layout }).then(setHtml, () => undefined), 350);
    return () => clearTimeout(timer);
  }, [blocks, layout, page.id, endpoints?.preview]);

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => (e.preventDefault(), (e.returnValue = ''));
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const commit = useCallback(
    (next: Block[], o: { sel?: string | null; key?: string } = {}) => {
      // Typing in one field is one undo step, not one per letter.
      const now = Date.now();
      const same = o.key && last.current.key === o.key && now - last.current.at < 900;
      if (!same) {
        past.current = [...past.current.slice(-49), blocks];
        future.current = [];
      }
      last.current = { key: o.key ?? '', at: now };
      setBlocks(next);
      setDirty(true);
      if (o.sel !== undefined) setSelId(o.sel ?? undefined);
      bump((n) => n + 1);
    },
    [blocks],
  );
  const undo = () => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(blocks);
    last.current = { key: '', at: 0 };
    setBlocks(prev);
    setDirty(true);
    bump((n) => n + 1);
  };
  const redo = () => {
    const nxt = future.current.pop();
    if (!nxt) return;
    past.current.push(blocks);
    setBlocks(nxt);
    setDirty(true);
    bump((n) => n + 1);
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') (e.preventDefault(), e.shiftKey ? redo() : undo());
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') (e.preventDefault(), redo());
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const sel = selId ? find(blocks, selId) : undefined;
  const selRow = sel && kindOf(sel.node) === 'col' && sel.parent.kind === 'row' ? find(blocks, sel.parent.id)?.node : undefined;

  // --- changes -----------------------------------------------------------------------------------------------------------------
  const tooMany = (extra = 3) => countNodes(blocks) + extra > MAX_NODES && (toast(t('Die Seite hat schon sehr viele Elemente (höchstens {n}).', { n: MAX_NODES })), true);

  /** Puts a node in a container; blocks that land on the page itself get a section around them (layout first). */
  function place(node: Block, c: Container, index: number) {
    if (tooMany()) return;
    if (c.kind === 'root' && kindOf(node) === 'block' && (hasSections(blocks) || !blocks.length)) {
      const sec = newSection([12]);
      sec.rows[0].cols[0].blocks = [node];
      commit(insert(blocks, c, index, sec), { sel: node.id });
    } else commit(insert(blocks, c, index, node), { sel: node.id });
  }
  const addBlock = (type: string, at?: { container: Container; index: number }) => {
    const spec = BLOCKS[type];
    if (!spec) return;
    const pt = at ?? insertionPoint(blocks, selId, 'block');
    place(newBlock(type, localInit(spec.init)), pt.container, pt.index);
  };
  const addSection = (spans: number[], at?: { container: Container; index: number }) => {
    if (tooMany(2 + spans.length)) return;
    const pt = at ?? insertionPoint(blocks, selId, 'section');
    const s = newSection(spans);
    commit(insert(blocks, pt.container, pt.index, s), { sel: s.id });
  };
  const addComponent = (c: any, at?: { container: Container; index: number }) => {
    const inner = Array.isArray(c.blocks) ? c.blocks : [];
    const section = inner.some((b: Block) => b.type === 'section');
    const pt = at ?? insertionPoint(blocks, selId, section ? 'section' : 'block');
    const node = { id: uid(), type: 'component', component_id: c.id };
    if (section && pt.container.kind !== 'root') return toast(t('Diese Komponente enthält Abschnitte – sie passt nur auf die Seite, nicht in eine Spalte.'));
    if (tooMany()) return;
    commit(insert(blocks, pt.container, pt.index, node), { sel: node.id });
  };

  const onDrop = (c: Container, index: number) => {
    const d = drag;
    setDrag(null);
    if (!d) return;
    if (d.what === 'node') {
      const next = move(blocks, d.id, c, index);
      if (next !== blocks) commit(next, { sel: d.id });
    } else if (d.what === 'block') addBlock(d.type, { container: c, index });
    else if (d.what === 'section') addSection(d.spans, { container: c, index });
    else {
      const comp = site.components.find((x) => x.id === d.id);
      if (comp) addComponent(comp, { container: c, index });
    }
  };

  const del = (id: string) => {
    const hit = find(blocks, id);
    if (!hit) return;
    const k = kindOf(hit.node);
    const filled = JSON.stringify(hit.node).includes('"type"');
    if (k !== 'block' && filled && !confirmAsk(k === 'section' ? t('Abschnitt mit allem darin entfernen?') : k === 'row' ? t('Zeile mit allem darin entfernen?') : t('Spalte mit allem darin entfernen?'))) return;
    let { tree } = remove(blocks, id);
    if (k === 'col' && hit.parent.kind === 'row') tree = fixSpans(tree, hit.parent);
    commit(tree, { sel: hit.parent.kind === 'root' ? null : (hit.parent as any).id });
  };
  const dup = (id: string) => {
    if (tooMany(5)) return;
    const r = duplicate(blocks, id);
    commit(r.tree, { sel: r.id });
  };
  const patchSel = (patch: Record<string, any>) => {
    if (!selId) return;
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const cleared = Object.keys(patch).filter((k) => patch[k] === undefined);
    commit(
      update(blocks, selId, (n) => {
        const out = { ...n, ...clean };
        for (const k of cleared) delete out[k];
        return out;
      }),
      { key: `${selId}:${Object.keys(patch).join(',')}` },
    );
  };
  const setCols = (rowId: string, spans: number[]) => commit(update(blocks, rowId, (r) => resizeCols(r, spans)), { key: `${rowId}:cols` });

  // --- components ---------------------------------------------------------------------------------------------------------------
  async function saveComponent(name: string) {
    if (!saveAs || !name.trim()) return;
    const made = await act(() => api.post('/api/site-components', { name: name.trim(), blocks: [saveAs] }), t('Komponente gespeichert'));
    if (!made) return;
    // The place on the page becomes the component (all other uses will follow its changes).
    commit(update(blocks, saveAs.id, () => ({ id: uid(), type: 'component', component_id: made.id })), { sel: undefined });
    setSaveAs(null);
    components.reload();
  }
  function detach(node: Block) {
    const c = site.components.find((x) => x.id === node.component_id);
    const hit = find(blocks, node.id);
    if (!c || !hit) return;
    let tree = remove(blocks, node.id).tree;
    clone(c.blocks as Block[]).forEach((b, i) => (tree = insert(tree, hit.parent, hit.index + i, b)));
    commit(tree, { sel: null });
  }
  /** The component was deleted: every place on this page becomes plain blocks, as the server did for the saved pages. */
  function detachAll(compId: string, comp: any) {
    let tree = blocks;
    for (let guard = 0; guard < 200; guard++) {
      let hit: ReturnType<typeof find>;
      const all: Block[] = [];
      const collect = (list: Block[]) => list.forEach((n) => (all.push(n), collect(n.rows ?? []), collect(n.cols ?? []), collect(n.blocks ?? [])));
      collect(tree);
      const id = all.find((n) => n.type === 'component' && n.component_id === compId)?.id ?? '';
      if (!id) break;
      hit = find(tree, id);
      if (!hit) break;
      let next = remove(tree, id).tree;
      clone((comp.blocks ?? []) as Block[]).forEach((b, i) => (next = insert(next, hit!.parent, hit!.index + i, b)));
      tree = next;
    }
    if (tree !== blocks) commit(tree, { sel: null });
  }
  const openComponent = (node: Block) => {
    const c = site.components.find((x) => x.id === node.component_id);
    if (c) setEditComp(c);
  };

  // --- saving ---------------------------------------------------------------------------------------------------------------------
  const save = async () => {
    const body = endpoints || component ? { [endpoints?.key ?? 'blocks']: blocks, ...(component || endpoints?.key ? {} : { seo }) } : { blocks, seo, layout };
    const r = await act(() => api.patch(endpoints?.save ?? `/api/funnel-pages/${page.id}`, body), endpoints ? t('Gespeichert') : t('Seite gespeichert'));
    if (r) {
      setDirty(false);
      onSaved();
    }
  };

  const selNode = sel?.node;
  const flat = !hasSections(blocks) && blocks.length > 0;

  return (
    <SiteCtx.Provider value={site}>
      <div className="site-editor" data-tour="page-builder">
        <div className="se-left">
          <div className="se-bar">
            <button className="btn" data-tour="page-save" onClick={save} disabled={!dirty}>
              {dirty ? t('Speichern') : t('Gespeichert ✓')}
            </button>
            <button className="icon-btn" onClick={undo} disabled={!past.current.length} aria-label={t('Rückgängig (Strg+Z)')} title={t('Rückgängig (Strg+Z)')}>
              <Icon name="undo" />
            </button>
            <button className="icon-btn" onClick={redo} disabled={!future.current.length} aria-label={t('Wiederholen (Strg+Y)')} title={t('Wiederholen (Strg+Y)')}>
              <Icon name="redo" />
            </button>
            {!component && (
              <button className="btn ai" onClick={() => setAi(true)}>
                <Icon name="ai" size={15} /> {t('KI-Assistent')}
              </button>
            )}
            {extra ??
              (!component && (
                <>
                  <a className="btn secondary" href={page.url} target="_blank" rel="noreferrer">
                    {t('Live ↗')}
                  </a>
                  <QrButton url={page.url} title={t('Seite {name}', { name: page.name ?? page.title ?? '' }).trim()} />
                </>
              ))}
          </div>

          <div className="card se-add" data-tour="site-palette">
            <Tabs tabs={[['blocks', t('Blöcke')], ['sections', t('Abschnitte')], ['comps', site.components.length ? t('Komponenten ({n})', { n: site.components.length }) : t('Komponenten')]]} value={addTab} onChange={setAddTab} />
            {addTab === 'sections' && (
              <div className="pal-grid">
                {SECTION_PRESETS.map((p) => (
                  <button key={p.key} className="pal" draggable onDragStart={(e) => (e.dataTransfer.setData('text/plain', p.key), (e.dataTransfer.effectAllowed = 'copy'), setDrag({ what: 'section', spans: p.spans }))} onDragEnd={() => setDrag(null)} onClick={() => addSection(p.spans)} title={t('Anklicken oder in die Struktur ziehen')}>
                    <Icon name={COLS_ICON[p.spans.length as 1 | 2 | 3 | 4]} />
                    <span>{t(p.label)}</span>
                  </button>
                ))}
              </div>
            )}
            {addTab === 'blocks' &&
              GROUPS.map((g) => (
                <div key={g}>
                  <p className="pal-group small">{t(g)}</p>
                  <div className="pal-grid">
                    {BLOCK_TYPES.filter((type) => BLOCKS[type].group === g)
                      .filter((type) => type !== 'component' || site.components.length)
                      .map((type) => (
                        <button key={type} className="pal" draggable onDragStart={(e) => (e.dataTransfer.setData('text/plain', type), (e.dataTransfer.effectAllowed = 'copy'), setDrag({ what: 'block', type }))} onDragEnd={() => setDrag(null)} onClick={() => addBlock(type)} title={t('Anklicken oder in die Struktur ziehen')}>
                          <Icon name={BLOCKS[type].icon} />
                          <span>{t(BLOCKS[type].label)}</span>
                        </button>
                      ))}
                  </div>
                </div>
              ))}
            {addTab === 'comps' &&
              (site.components.length ? (
                <div className="pal-list">
                  {site.components.map((c) => {
                    const section = (c.blocks ?? []).some((b: Block) => b.type === 'section');
                    return (
                      <div key={c.id} className="pal row-pal" draggable onDragStart={(e) => (e.dataTransfer.setData('text/plain', c.id), (e.dataTransfer.effectAllowed = 'copy'), setDrag({ what: 'component', id: c.id, name: c.name, section }))} onDragEnd={() => setDrag(null)}>
                        <Icon name="puzzle" />
                        <span className="grow">
                          {c.name} <span className="muted small">· {t('{n}× genutzt', { n: c.uses })}</span>
                        </span>
                        <button className="btn small secondary" onClick={() => addComponent(c)}>
                          {t('Einfügen')}
                        </button>
                        <button className="btn small ghost" onClick={() => setEditComp(c)}>
                          {t('Bearbeiten')}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="muted small">{t('Noch keine Komponenten. Wähle einen Block oder Abschnitt aus und klicke „Als Komponente speichern“ – danach kannst du ihn auf allen Seiten einsetzen; eine Änderung wirkt überall.')}</p>
              ))}
          </div>

          <div className="card se-tree">
            <div className="row" style={{ alignItems: 'center', marginBottom: 6 }}>
              <h3 style={{ margin: 0 }}>{t('Struktur')}</h3>
              <span className="grow" />
              <span className="muted small">{t.plural(countNodes(blocks), { other: '{n} Elemente' })}</span>
            </div>
            {flat && (
              <p className="notice small">
                {t('Diese Seite ist eine einfache Liste von Blöcken.')}{' '}
                <button className="btn small secondary" onClick={() => commit(toLayout(blocks), { sel: null })}>
                  {t('In Abschnitte umwandeln')}
                </button>{' '}
                {t('– dann kannst du Spalten und Abstände nutzen; das Aussehen bleibt gleich.')}
              </p>
            )}
            <Tree blocks={blocks} selId={selId} drag={drag} setDrag={setDrag} onSelect={setSelId} onDrop={onDrop} onNudge={(id, dir) => commit(nudge(blocks, id, dir), { sel: id })} onDuplicate={dup} onDelete={del} />
            {!blocks.length && (
              <p className="muted small">
                {t('Die Seite ist leer. Wähle oben einen')} <b>{t('Abschnitt')}</b> {t('oder einen')} <b>{t('Block')}</b> {t('– oder ziehe ihn hierher.')}
              </p>
            )}
            {drag && !blocks.length && (
              <div
                className={`dz live big${accepts(blocks, drag, { kind: 'root' }) ? ' over' : ''}`}
                onDragOver={(e) => (e.preventDefault(), (e.dataTransfer.dropEffect = 'copy'))}
                onDrop={(e) => (e.preventDefault(), onDrop({ kind: 'root' }, 0))}
              >
                {t('Hier ablegen')}
              </div>
            )}
          </div>

          {selNode && (
            <Inspector
              key={selNode.id}
              node={selNode}
              row={selRow}
              patch={patchSel}
              setCols={setCols}
              onSaveComponent={() => setSaveAs(selNode)}
              onDetach={() => detach(selNode)}
              onEditComponent={() => openComponent(selNode)}
            />
          )}

          {!component && (
            <div className="card" data-tour="page-seo">
              <Tabs tabs={[['seo', 'SEO'], ['layout', t('Seiten-Layout')], ['a11y', t('Prüfen')]]} value={pageTab} onChange={setPageTab} />
              {pageTab === 'seo' && (
                <>
                  <Field label={t('Seitentitel')}>
                    <Input value={seo.title} onChange={(v) => (setSeo({ ...seo, title: v }), setDirty(true))} />
                  </Field>
                  <Field label={t('Beschreibung')}>
                    <Textarea value={seo.description} onChange={(v) => (setSeo({ ...seo, description: v }), setDirty(true))} rows={3} />
                  </Field>
                  <Field label={t('Vorschaubild für Social Media (optional)')}>
                    <Input value={seo.og_image} onChange={(v) => (setSeo({ ...seo, og_image: v }), setDirty(true))} placeholder={t('https://… (sonst erstes Bild der Seite)')} />
                  </Field>
                  <Check checked={!!seo.noindex} onChange={(v) => (setSeo({ ...seo, noindex: v }), setDirty(true))} label={t('Nicht in Google anzeigen (noindex)')} />
                </>
              )}
              {pageTab === 'layout' && !endpoints && (
                <PageLayoutCard layout={layout} setLayout={(l) => (setLayout(l), setDirty(true))} page={page} funnel={funnel} languages={design.data?.languages} onTranslated={onSaved} />
              )}
              {pageTab === 'layout' && endpoints && <p className="muted small">{t('Die Variante übernimmt das Seiten-Layout der Originalseite.')}</p>}
              {pageTab === 'a11y' &&
                (endpoints ? (
                  <p className="muted small">{t('Prüfe die Originalseite oder den ganzen Auftritt unter „Barrierefreiheit“.')}</p>
                ) : (
                  <DraftCheck pageId={page.id} body={() => ({ blocks, layout, seo })} onPick={(id) => setSelId(id)} />
                ))}
            </div>
          )}
        </div>

        <div className="se-right">
          <div className="se-pvbar" data-tour="site-device">
            <span className="muted small grow">
              {t('Live-Vorschau')} · {funnel.name} / {page.name}
            </span>
            {([['desktop', t('Desktop'), 'monitor'], ['tablet', t('Tablet'), 'columns2'], ['phone', t('Handy'), 'mobile']] as const).map(([k, l, ic]) => (
              <button key={k} className={`btn small ${device === k ? '' : 'secondary'}`} onClick={() => setDevice(k)} aria-pressed={device === k}>
                <Icon name={ic} /> {l}
              </button>
            ))}
          </div>
          <div className="se-frame-wrap">
            <iframe className={`preview-frame se-frame ${device}`} style={{ width: DEVICE_WIDTH[device] }} data-tour="page-preview" srcDoc={html} title={t('Vorschau')} sandbox="allow-scripts allow-forms" />
          </div>
        </div>

        {saveAs && <SaveComponent node={saveAs} onSave={saveComponent} onClose={() => setSaveAs(null)} />}
        {ai && (
          <Suspense fallback={null}>
            <SiteAiPanel page={page} funnel={funnel} blocks={blocks} selId={selId} onApply={(next) => commit(next, { sel: null })} onClose={() => setAi(false)} />
          </Suspense>
        )}
        {editComp && (
          <Modal title={t('Komponente „{name}“', { name: editComp.name })} wide onClose={() => (setEditComp(null), components.reload())}>
            <ComponentEditor comp={editComp} funnel={funnel} onSaved={() => components.reload()} onDeleted={() => (detachAll(editComp.id, editComp), setEditComp(null), components.reload())} />
          </Modal>
        )}
      </div>
    </SiteCtx.Provider>
  );
}

function SaveComponent({ node, onSave, onClose }: { node: Block; onSave(name: string): void; onClose(): void }) {
  const t = useT('sites');
  const [name, setName] = useState(String(node.name || node.heading || node.text || (BLOCKS[node.type] ? t(BLOCKS[node.type].label) : '') || t('Komponente')).slice(0, 60));
  return (
    <Modal
      title={t('Als Komponente speichern')}
      onClose={onClose}
      footer={
        <button className="btn" disabled={!name.trim()} onClick={() => onSave(name)}>
          {t('Speichern')}
        </button>
      }
    >
      <p className="muted small">{t('Eine Komponente ist ein Baustein, den du auf allen Seiten einsetzen kannst – z. B. ein Kontakt-Abschnitt. Änderst du sie, ändert sie sich überall. Hier auf der Seite wird der Block durch die Komponente ersetzt.')}</p>
      <Field label="Name">
        <Input value={name} onChange={setName} autoFocus />
      </Field>
    </Modal>
  );
}

/** Edits the blocks of a component with the same editor (previewed within the design of the site). */
function ComponentEditor({ comp, funnel, onSaved, onDeleted }: { comp: any; funnel: any; onSaved(): void; onDeleted(): void }) {
  const t = useT('sites');
  const first = funnel.pages?.[0];
  const [name, setName] = useState(comp.name);
  const uses = useLoad(() => api.get<any>(`/api/site-components/${comp.id}`), [comp.id]);
  if (!first) return <p className="muted">{t('Die Website hat noch keine Seite für die Vorschau.')}</p>;
  return (
    <>
      <div className="row" style={{ marginBottom: 10, alignItems: 'end' }}>
        <div style={{ width: 300 }}>
          <Field label="Name">
            <Input value={name} onChange={setName} onBlur={() => name.trim() && name !== comp.name && act(() => api.patch(`/api/site-components/${comp.id}`, { name: name.trim() }), t('Umbenannt')).then(onSaved)} />
          </Field>
        </div>
        <span className="muted small">
          {uses.data?.used_on ? t.plural(uses.data.used_on.length, { other: 'Genutzt auf {n} Seite(n)' }) : t('Genutzt auf {n} Seite(n)', { n: '…' })}
          {(uses.data?.used_on ?? []).length ? `: ${(uses.data.used_on as any[]).slice(0, 4).map((u) => u.name).join(', ')}` : ''}
        </span>
        <span className="grow" />
        <button
          className="btn small danger"
          onClick={async () => {
            if (!confirmAsk(t('Komponente „{name}“ löschen? Auf den Seiten bleibt sie als normale Blöcke bestehen.', { name: comp.name }))) return;
            if (await act(() => api.del(`/api/site-components/${comp.id}`), t('Komponente gelöscht'))) onDeleted();
          }}
        >
          {t('Löschen')}
        </button>
      </div>
      <SiteEditor page={{ id: comp.id, name: comp.name, blocks: comp.blocks ?? [] }} funnel={funnel} component endpoints={{ save: `/api/site-components/${comp.id}`, preview: `/api/funnel-pages/${first.id}/preview` }} onSaved={onSaved} extra={<span className="muted small">{t('Änderungen wirken nach dem Speichern auf allen Seiten.')}</span>} />
    </>
  );
}

function PageLayoutCard({ layout, setLayout, page, funnel, languages, onTranslated }: { layout: any; setLayout(l: any): void; page: any; funnel: any; languages?: { default: string; list: { code: string; label: string }[] } | null; onTranslated(): void }) {
  const t = useT('sites');
  const list = languages?.list ?? [];
  const [lang, setLang] = useState('');
  const siblings = (funnel.pages ?? []).filter((p: any) => layout.group && p.layout?.group === layout.group && p.id !== page.id);
  return (
    <>
      <Check checked={layout.header === false} onChange={(v) => setLayout({ ...layout, header: v ? false : undefined })} label={t('Kopfzeile auf dieser Seite ausblenden (z. B. Landingpage)')} />
      <Check checked={layout.footer === false} onChange={(v) => setLayout({ ...layout, footer: v ? false : undefined })} label={t('Fußzeile auf dieser Seite ausblenden')} />
      <Field label={t('Sprache dieser Seite')} hint={t('Wird im Quelltext (lang) und in hreflang für Google verwendet.')}>
        <Select value={layout.lang ?? ''} onChange={(v) => setLayout({ ...layout, lang: v || undefined })} options={list.length ? list.map((l) => [l.code, l.label]) : [['de', t('Deutsch')], ['en', t('English')]]} placeholder={t('Standard ({lang})', { lang: languages?.default ?? 'de' })} />
      </Field>
      <div className="row" style={{ alignItems: 'end' }}>
        <div style={{ width: 120 }}>
          <Field label={t('Übersetzung anlegen')}>
            <Input value={lang} onChange={(v) => setLang(v.toLowerCase().replace(/[^a-z-]/g, ''))} placeholder="en" maxLength={8} />
          </Field>
        </div>
        <button
          className="btn small secondary"
          disabled={!lang}
          onClick={async () => {
            const r = await act(() => api.post(`/api/funnel-pages/${page.id}/translation`, { lang }), t('Übersetzung angelegt – du findest sie bei den Seiten'));
            if (r) (setLang(''), onTranslated());
          }}
        >
          {t('Kopie anlegen')}
        </button>
      </div>
      {siblings.length > 0 && <p className="muted small">{t('Übersetzungen:')} {siblings.map((p: any) => `${p.name} (${p.layout?.lang})`).join(', ')}</p>}
    </>
  );
}
