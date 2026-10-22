import { useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, Globe, Link2, Trash2 } from 'lucide-react';
import { ago, api, d, dt } from '../api';
import { Check as CheckBox, Copy, Empty, Field, Input, Select, Spinner, Textarea, act, confirmAsk, toast, toastError, useLoad } from '../ui';
import { Avatar, AutoTextarea, Dialog, Prose, readAsText, sizeLabel, useEscape, useFocusReturn, type CardStore, type Person } from './CollabKit';
import { useT } from '../i18n';

/** The wiki's dialogs and the comment panel. Every dialog is a `Dialog`: ✕ top right, Esc, focus back to where it was opened. */

export interface Space {
  id: string;
  name: string;
  icon: string;
  description: string;
  team_access: 'edit' | 'view' | 'none';
  owner_id: string | null;
  owner_name: string;
  access: 'owner' | 'edit' | 'view';
  page_count: number;
}
export interface TreePage {
  id: string;
  space_id: string;
  parent_id: string | null;
  position: number;
  title: string;
  icon: string;
  updated_at: string;
  updated_by_name: string;
  favorite: boolean;
  published: boolean;
}

const ICON_CHOICES = ['📘', '📄', '📝', '📚', '🗂️', '📋', '✅', '🎯', '🚀', '💡', '🛠️', '📞', '🤝', '👥', '🏠', '📅', '💶', '📊', '🔒', '❓', '⭐', '🧭', '🎓', '🧾'];

// --- space ----------------------------------------------------------------------------------------------------------------------

export function SpaceDialog({ space, onSaved, onDeleted, onClose }: { space?: Space; onSaved: (s: Space) => void; onDeleted?: () => void; onClose: () => void }) {
  const t = useT('collab');
  const [name, setName] = useState(space?.name ?? '');
  const [icon, setIcon] = useState(space?.icon ?? '📚');
  const [description, setDescription] = useState(space?.description ?? '');
  const [access, setAccess] = useState<string>(space?.team_access ?? 'edit');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const body = { name, icon, description, team_access: access };
    const r = await act(() => (space ? api.patch(`/api/wiki/spaces/${space.id}`, body) : api.post('/api/wiki/spaces', body)), space ? t('Gespeichert') : t('Bereich angelegt'));
    setBusy(false);
    if (r) onSaved(r);
  };
  return (
    <Dialog
      title={space ? t('Bereich bearbeiten') : t('Neuer Bereich')}
      onClose={onClose}
      footer={
        <>
          {space && onDeleted && space.access === 'owner' && (
            <button
              className="btn danger small"
              style={{ marginRight: 'auto' }}
              onClick={async () => {
                if (!confirmAsk(t.plural(space.page_count, { other: 'Bereich „{name}“ mit allen {n} Seiten endgültig löschen? Das lässt sich nicht rückgängig machen.' }, { name: space.name }))) return;
                if (await act(() => api.del(`/api/wiki/spaces/${space.id}`), t('Bereich gelöscht'))) onDeleted();
              }}
            >
              {t('Bereich löschen')}
            </button>
          )}
          <button className="btn secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
          <button className="btn" disabled={busy || !name.trim()} onClick={save}>
            {t('Speichern')}
          </button>
        </>
      }
    >
      <Field label="Name">
        <Input value={name} onChange={setName} maxLength={80} placeholder={t('z. B. Team-Wiki, Onboarding, Prozesse')} />
      </Field>
      <Field label={t('Symbol')}>
        <Input value={icon} onChange={setIcon} maxLength={8} placeholder={t('Emoji')} style={{ width: 110 }} />
        <div className="wkp-emoji-row">
          {ICON_CHOICES.slice(0, 12).map((e) => (
            <button key={e} type="button" onClick={() => setIcon(e)} aria-label={t('Symbol {icon}', { icon: e })}>
              {e}
            </button>
          ))}
        </div>
      </Field>
      <Field label={t('Beschreibung')}>
        <Input value={description} onChange={setDescription} maxLength={300} placeholder={t('Wofür ist dieser Bereich?')} />
      </Field>
      <Field label={t('Wer darf was?')} hint={t('Die Agentur und du als Besitzer:in dürfen immer alles. Die Einstellung gilt für die übrigen Teammitglieder dieses Sub-Accounts.')}>
        <Select
          value={access}
          onChange={setAccess}
          options={[
            ['edit', t('Das Team darf lesen und bearbeiten')],
            ['view', t('Das Team darf nur lesen')],
            ['none', t('Privat: nur Besitzer:in und Agentur')],
          ]}
        />
      </Field>
    </Dialog>
  );
}

// --- templates, AI create -----------------------------------------------------------------------------------------------------

export function TemplatesDialog({ spaces, spaceId, parentId, onCreated, onClose }: { spaces: Space[]; spaceId?: string; parentId?: string | null; onCreated: (p: { id: string }) => void; onClose: () => void }) {
  const t = useT('collab');
  const tpls = useLoad<any[]>(() => api.get('/api/wiki/templates'));
  const editable = spaces.filter((s) => s.access !== 'view');
  const [space, setSpace] = useState(spaceId && editable.some((s) => s.id === spaceId) ? spaceId : (editable[0]?.id ?? ''));
  const [tab, setTab] = useState<'tpl' | 'ai'>('tpl');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const parent = space === spaceId ? (parentId ?? undefined) : undefined;
  const make = async (fn: () => Promise<any>) => {
    setBusy(true);
    const r = await act(fn);
    setBusy(false);
    if (r) onCreated(r);
  };
  return (
    <Dialog title={t('Neue Seite')} onClose={onClose} wide>
      {!editable.length ? (
        <Empty>{t('Du hast noch keinen Bereich, in dem du schreiben darfst. Lege zuerst einen Bereich an.')}</Empty>
      ) : (
        <>
          <div className="ck-row wrap" style={{ marginBottom: 12 }}>
            <div className="tabs" style={{ margin: 0, flex: 1, minWidth: 220 }}>
              <button className={tab === 'tpl' ? 'on' : ''} onClick={() => setTab('tpl')}>
                {t('Aus Vorlage')}
              </button>
              <button className={tab === 'ai' ? 'on' : ''} onClick={() => setTab('ai')} data-tour="wiki-ai-create">
                {t('✨ Mit KI schreiben')}
              </button>
            </div>
            {editable.length > 1 && (
              <label className="ck-row small">
                <span className="muted">{t('Bereich')}</span>
                <Select value={space} onChange={setSpace} options={editable.map((s) => [s.id, `${s.icon} ${s.name}`.trim()] as [string, string])} />
              </label>
            )}
          </div>
          {tab === 'tpl' ? (
            tpls.loading ? (
              <Spinner />
            ) : (
              <div className="wkp-grid" data-tour="wiki-templates">
                {tpls.data?.map((tpl) => (
                  <button key={tpl.key} className="wkp-tile" disabled={busy} onClick={() => make(() => api.post('/api/wiki/pages', { space_id: space, parent_id: parent, template: tpl.key }))}>
                    <span className="big">{tpl.icon || '📄'}</span>
                    <b>{tpl.name}</b>
                    <span className="muted small">{tpl.description}</span>
                    {tpl.pages > 1 && <span className="muted small">{tpl.pages} {t('Seiten')}</span>}
                  </button>
                ))}
              </div>
            )
          ) : (
            <>
              <Field label={t('Worum soll es gehen?')} hint={t('Die KI schreibt einen Entwurf, den du danach wie jede Seite bearbeitest. Sie erfindet keine Fakten – prüfe den Text.')}>
                <Textarea value={prompt} onChange={setPrompt} rows={4} maxLength={2000} placeholder={t('z. B. Checkliste für das Onboarding neuer Kunden mit Zugängen, Kickoff-Termin und Erstberatung')} />
              </Field>
              <button className="btn" disabled={busy || prompt.trim().length < 5} onClick={() => make(() => api.post('/api/wiki/ai/create', { prompt, space_id: space, parent_id: parent }))}>
                {busy ? t('Schreibt …') : t('Seite erstellen')}
              </button>
            </>
          )}
        </>
      )}
    </Dialog>
  );
}

// --- import -----------------------------------------------------------------------------------------------------------------------

export function ImportDialog({ spaces, spaceId, parentId, onDone, onClose }: { spaces: Space[]; spaceId?: string; parentId?: string | null; onDone: (r: { imported: number; pages: { id: string }[] }) => void; onClose: () => void }) {
  const t = useT('collab');
  const editable = spaces.filter((s) => s.access !== 'view');
  const [space, setSpace] = useState(spaceId && editable.some((s) => s.id === spaceId) ? spaceId : (editable[0]?.id ?? ''));
  const [files, setFiles] = useState<{ name: string; content: string }[]>([]);
  const [paste, setPaste] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const total = files.reduce((n, f) => n + f.content.length, 0);
  const pick = async (list: FileList | null) => {
    const out: { name: string; content: string }[] = [];
    for (const f of [...(list ?? [])].slice(0, 50)) {
      if (!/\.(md|markdown|txt|html?)$/i.test(f.name)) {
        toastError(new Error(t('„{name}“: Erlaubt sind .md, .markdown, .txt und .html.', { name: f.name })));
        continue;
      }
      if (f.size > 1_000_000) {
        toastError(new Error(t('„{name}“ ist größer als 1 MB.', { name: f.name })));
        continue;
      }
      out.push({ name: f.name, content: await readAsText(f) });
    }
    setFiles((cur) => [...cur, ...out].slice(0, 50));
  };
  const run = async () => {
    setBusy(true);
    const payload = [...files, ...(paste.trim() ? [{ name: title.trim() || t('Import'), content: paste }] : [])];
    const r = await act(() => api.post('/api/wiki/import', { space_id: space, parent_id: space === spaceId ? (parentId ?? undefined) : undefined, files: payload }));
    setBusy(false);
    if (r) {
      toast(t.plural(r.imported, { one: '{n} Seite importiert', other: '{n} Seiten importiert' }));
      onDone(r);
    }
  };
  return (
    <Dialog
      title={t('Markdown importieren')}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
          <button className="btn" disabled={busy || !space || (!files.length && !paste.trim())} onClick={run}>
            {busy ? t('Importiert …') : t('Importieren')}
          </button>
        </>
      }
    >
      <p className="muted small" style={{ marginTop: 0 }}>
        {t('Jede Datei wird eine Seite. Die erste Überschrift („# Titel“) wird zum Seitentitel, HTML-Dateien werden in Markdown umgewandelt. Bilder und Skripte aus fremden Quellen werden nicht übernommen.')}
      </p>
      {editable.length > 1 && (
        <Field label={t('Bereich')}>
          <Select value={space} onChange={setSpace} options={editable.map((s) => [s.id, `${s.icon} ${s.name}`.trim()] as [string, string])} />
        </Field>
      )}
      <Field label={t('Dateien')}>
        <input type="file" multiple accept=".md,.markdown,.txt,.html,.htm,text/markdown,text/plain,text/html" onChange={(e) => void pick(e.target.files).then(() => (e.target.value = ''))} />
      </Field>
      {files.length > 0 && (
        <div className="ck-list" style={{ marginBottom: 12 }}>
          {files.map((f, i) => (
            <div key={`${f.name}${i}`}>
              <span className="ck-grow">{f.name}</span>
              <span className="muted small">{sizeLabel(f.content.length)}</span>
              <button className="icon-btn" aria-label={t('{name} entfernen', { name: f.name })} onClick={() => setFiles(files.filter((_, n) => n !== i))}>
                ✕
              </button>
            </div>
          ))}
          <div className="muted small">
            {files.length} {t('Dateien ·')} {sizeLabel(total)}
          </div>
        </div>
      )}
      <Field label={t('… oder Markdown einfügen')}>
        <Textarea value={paste} onChange={setPaste} rows={5} className="mono" placeholder={t('# Titel\n\nText …')} />
      </Field>
      {paste.trim() && (
        <Field label={t('Titel (falls der Text keine Überschrift hat)')}>
          <Input value={title} onChange={setTitle} maxLength={200} />
        </Field>
      )}
    </Dialog>
  );
}

// --- share + publish -------------------------------------------------------------------------------------------------------------

export function ShareDialog({ page, onChanged, onClose }: { page: { id: string; title: string; version: number; published: { article_id: string; version: number | null; outdated: boolean } | null }; onChanged: () => void; onClose: () => void }) {
  const t = useT('collab');
  const shares = useLoad<any[]>(() => api.get(`/api/wiki/pages/${page.id}/shares`), [page.id]);
  const pub = useLoad<any>(() => api.get(`/api/wiki/pages/${page.id}/publish`).catch((e) => ({ unavailable: String(e.message) })), [page.id]);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const active = shares.data?.filter((s) => !s.revoked_at) ?? [];
  const create = async () => {
    setBusy(true);
    const r = await act(() => api.post(`/api/wiki/pages/${page.id}/shares`, { label }), t('Link erstellt'));
    setBusy(false);
    if (r) {
      setLabel('');
      void shares.reload();
      onChanged();
    }
  };
  const publish = async (on: boolean) => {
    setBusy(true);
    const r = await act(() => (on ? api.post(`/api/wiki/pages/${page.id}/publish`, {}) : api.del(`/api/wiki/pages/${page.id}/publish`)), on ? t('Im Help Center veröffentlicht') : t('Veröffentlichung zurückgezogen'));
    setBusy(false);
    if (r) {
      void pub.reload();
      onChanged();
    }
  };
  return (
    <Dialog title={t('Teilen und veröffentlichen')} onClose={onClose} wide>
      <h3 style={{ marginBottom: 4 }}>
        <Link2 size={16} /> {t('Öffentlicher Link (nur lesen)')}
      </h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t('Jede Person mit dem Link kann die Seite lesen – ohne Anmeldung, ohne bearbeiten zu können. Karten, @Erwähnungen und interne Verweise werden dort nicht angezeigt. Ein Link lässt sich jederzeit widerrufen.')}
      </p>
      {shares.loading ? (
        <Spinner />
      ) : (
        <div className="ck-list" style={{ marginBottom: 10 }} data-tour="wiki-share-list">
          {!shares.data?.length && <div className="muted">{t('Noch kein Link.')}</div>}
          {shares.data?.map((s) => (
            <div key={s.id} style={s.revoked_at ? { opacity: 0.55 } : undefined}>
              <div className="ck-grow">
                <b>{s.label || t('Link')}</b> <span className="muted small">· {d(s.created_at)} · {s.views} {t('Aufrufe')}{s.last_used_at ? t(' · zuletzt {time}', { time: ago(s.last_used_at) }) : ''}</span>
                {s.url ? <div className="mono" style={{ overflowWrap: 'anywhere' }}>{s.url}</div> : <div className="muted small">{t('widerrufen')}</div>}
              </div>
              {s.url && (
                <>
                  <Copy text={s.url} />
                  <button
                    className="btn small secondary"
                    onClick={async () => {
                      if (!confirmAsk(t('Diesen Link widerrufen? Er funktioniert danach nicht mehr.'))) return;
                      if (await act(() => api.del(`/api/wiki/pages/${page.id}/shares/${s.id}`), t('Link widerrufen'))) {
                        void shares.reload();
                        onChanged();
                      }
                    }}
                  >
                    {t('Widerrufen')}
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="ck-row wrap">
        <Input value={label} onChange={setLabel} maxLength={120} placeholder={t('Bezeichnung (optional), z. B. „Kunde Müller“')} style={{ flex: 1, minWidth: 200 }} />
        <button className="btn" disabled={busy || active.length >= 10} onClick={create}>
          {t('Link erstellen')}
        </button>
      </div>
      <hr />
      <h3 style={{ marginBottom: 4 }}>
        <Globe size={16} /> {t('Im Help Center veröffentlichen')}
      </h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t('Aus der Seite wird ein Artikel der Wissensdatenbank (öffentlich, mit eigener Adresse). Der Artikel ist eine Kopie – spätere Änderungen an der Seite erscheinen dort erst, wenn du erneut veröffentlichst.')}
      </p>
      {pub.loading ? (
        <Spinner />
      ) : pub.data?.unavailable ? (
        <p className="muted">{pub.data.unavailable}</p>
      ) : pub.data?.published ? (
        <div className="ck-row wrap">
          <span className="badge green">{t('Veröffentlicht')}</span>
          {pub.data.outdated && <span className="badge yellow">{t('Seite wurde seitdem geändert')}</span>}
          {pub.data.url && (
            <a href={pub.data.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={13} /> {t('Artikel öffnen')}
            </a>
          )}
          <span className="ck-grow" />
          <button className="btn small" disabled={busy} onClick={() => publish(true)}>
            {t('Aktualisieren')}
          </button>
          <button className="btn small secondary" disabled={busy} onClick={() => publish(false)}>
            {t('Zurückziehen')}
          </button>
        </div>
      ) : (
        <button className="btn" disabled={busy} onClick={() => publish(true)} data-tour="wiki-publish">
          {t('Veröffentlichen')}
        </button>
      )}
    </Dialog>
  );
}

// --- versions ----------------------------------------------------------------------------------------------------------------------------

/** Changed lines with two lines of context; long unchanged stretches collapse to "…". */
function foldDiff(lines: { t: 'same' | 'add' | 'del'; text: string }[]) {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.t === 'same') return;
    for (let k = Math.max(0, i - 2); k <= Math.min(lines.length - 1, i + 2); k++) keep[k] = true;
  });
  const out: { t: string; text: string }[] = [];
  let gap = false;
  lines.forEach((l, i) => {
    if (keep[i]) {
      gap = false;
      out.push(l);
    } else if (!gap) {
      gap = true;
      out.push({ t: 'sep', text: '…' });
    }
  });
  return out;
}

// German labels (message ids of the collab catalog), shown through t()
const VIA: Record<string, string> = { ai: 'KI', import: 'Import', toggle: 'Checkliste', restore: 'Wiederherstellung', mcp: 'KI-App', api: 'API' };

export function VersionsDialog({ page, store, canEdit, onRestored, onClose }: { page: { id: string; title: string }; store: CardStore; canEdit: boolean; onRestored: (p: any) => void; onClose: () => void }) {
  const t = useT('collab');
  const list = useLoad<any[]>(() => api.get(`/api/wiki/pages/${page.id}/versions`), [page.id]);
  const [sel, setSel] = useState<string>('');
  const [tab, setTab] = useState<'diff' | 'view'>('diff');
  const ver = useLoad<any>(() => (sel ? api.get(`/api/wiki/pages/${page.id}/versions/${sel}?diff=1`) : Promise.resolve(undefined)), [sel]);
  useEffect(() => {
    if (!sel && list.data?.[1]) setSel(list.data[1].id);
    else if (!sel && list.data?.[0]) setSel(list.data[0].id);
  }, [list.data, sel]);
  const current = list.data?.find((v) => v.id === sel)?.current;
  const folded = useMemo(() => (ver.data?.diff ? foldDiff(ver.data.diff) : []), [ver.data]);
  return (
    <Dialog
      title={t('Verlauf: {title}', { title: page.title })}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            {t('Schließen')}
          </button>
          {canEdit && (
            <button
              className="btn"
              disabled={!sel || !!current || ver.loading}
              onClick={async () => {
                if (!confirmAsk(t('Diese Fassung ({date}) wiederherstellen? Der heutige Stand bleibt im Verlauf erhalten.', { date: dt(ver.data?.created_at) }))) return;
                const r = await act(() => api.post(`/api/wiki/pages/${page.id}/versions/${sel}/restore`, {}), t('Fassung wiederhergestellt'));
                if (r) onRestored(r);
              }}
              data-tour="wiki-restore"
            >
              {t('Diese Fassung wiederherstellen')}
            </button>
          )}
        </>
      }
    >
      {list.loading ? (
        <Spinner />
      ) : (
        <div className="wkv" data-tour="wiki-versions">
          <div className="wkv-list" role="listbox" aria-label={t('Fassungen')}>
            {list.data?.map((v) => (
              <button key={v.id} className={v.id === sel ? 'on' : ''} onClick={() => setSel(v.id)} role="option" aria-selected={v.id === sel}>
                <b>{dt(v.saved_at)}</b> {v.current && <span className="badge blue">{t('aktuell')}</span>}
                <div className="muted small">
                  {v.author_name || t('Unbekannt')}
                  {VIA[v.via] ? ` · ${t(VIA[v.via])}` : ''}
                  {v.note ? ` · ${v.note}` : ''}
                </div>
              </button>
            ))}
          </div>
          <div className="wkv-view">
            {ver.loading || !ver.data ? (
              <Spinner />
            ) : (
              <>
                <div className="tabs" style={{ marginBottom: 10 }}>
                  <button className={tab === 'diff' ? 'on' : ''} onClick={() => setTab('diff')}>
                    {t('Unterschied zum aktuellen Stand')}
                  </button>
                  <button className={tab === 'view' ? 'on' : ''} onClick={() => setTab('view')}>
                    {t('Diese Fassung')}
                  </button>
                </div>
                <h3 style={{ marginTop: 0 }}>{ver.data.title}</h3>
                {tab === 'diff' ? (
                  current ? (
                    <p className="muted">{t('Das ist der aktuelle Stand.')}</p>
                  ) : folded.length ? (
                    <div className="wkv-diff">
                      {folded.map((l, i) => (
                        <div key={i} className={l.t === 'sep' ? 'sep' : l.t}>
                          {l.t === 'add' ? '+ ' : l.t === 'del' ? '− ' : l.t === 'same' ? '  ' : ''}
                          {l.text || ' '}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="muted">{t('Kein Unterschied im Text.')}</p>
                  )
                ) : (
                  <Prose html={ver.data.html} store={store} />
                )}
              </>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

// --- move ----------------------------------------------------------------------------------------------------------------------------------

export function MoveDialog({ page, spaces, pages, onMoved, onClose }: { page: { id: string; title: string; space_id: string }; spaces: Space[]; pages: TreePage[]; onMoved: () => void; onClose: () => void }) {
  const t = useT('collab');
  const editable = spaces.filter((s) => s.access !== 'view');
  const [space, setSpace] = useState(editable.some((s) => s.id === page.space_id) ? page.space_id : (editable[0]?.id ?? ''));
  const [parent, setParent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { rows, blocked } = useMemo(() => {
    const kids = new Map<string, TreePage[]>();
    for (const p of pages.filter((x) => x.space_id === space)) kids.set(p.parent_id ?? '', [...(kids.get(p.parent_id ?? '') ?? []), p]);
    const blocked = new Set<string>();
    const mark = (id: string) => {
      blocked.add(id);
      for (const c of kids.get(id) ?? []) mark(c.id);
    };
    mark(page.id);
    const rows: { p: TreePage; depth: number }[] = [];
    const walk = (pid: string, depth: number) => {
      for (const c of kids.get(pid) ?? []) {
        rows.push({ p: c, depth });
        if (depth < 11) walk(c.id, depth + 1);
      }
    };
    walk('', 0);
    return { rows, blocked };
  }, [pages, space, page.id]);
  const move = async () => {
    setBusy(true);
    const r = await act(() => api.post(`/api/wiki/pages/${page.id}/move`, { space_id: space, parent_id: parent }), t('Verschoben'));
    setBusy(false);
    if (r) onMoved();
  };
  return (
    <Dialog
      title={t('„{title}“ verschieben', { title: page.title })}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
          <button className="btn" disabled={busy || !space} onClick={move}>
            {t('Hierher verschieben')}
          </button>
        </>
      }
    >
      {editable.length > 1 && (
        <Field label={t('Bereich')}>
          <Select
            value={space}
            onChange={(v) => {
              setSpace(v);
              setParent(null);
            }}
            options={editable.map((s) => [s.id, `${s.icon} ${s.name}`.trim()] as [string, string])}
          />
        </Field>
      )}
      <div className="wkp-move" role="listbox" aria-label={t('Ziel')}>
        <button className={parent === null ? 'on' : ''} onClick={() => setParent(null)} role="option" aria-selected={parent === null}>
          {t('An oberster Ebene des Bereichs')}
        </button>
        {rows.map(({ p, depth }) => (
          <button key={p.id} className={parent === p.id ? 'on' : ''} disabled={blocked.has(p.id)} style={{ paddingLeft: 10 + depth * 16 }} onClick={() => setParent(p.id)} role="option" aria-selected={parent === p.id}>
            {p.icon || '📄'} {p.title}
          </button>
        ))}
      </div>
    </Dialog>
  );
}

// --- trash --------------------------------------------------------------------------------------------------------------------------------------

export function TrashDialog({ onChanged, onClose }: { onChanged: () => void; onClose: () => void }) {
  const t = useT('collab');
  const list = useLoad<any[]>(() => api.get('/api/wiki/trash'));
  return (
    <Dialog title={t('Papierkorb')} onClose={onClose}>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t('Gelöschte Seiten bleiben 30 Tage im Papierkorb. Unterseiten kommen mit ihrer Seite zurück.')}
      </p>
      {list.loading ? (
        <Spinner />
      ) : !list.data?.length ? (
        <Empty>{t('Der Papierkorb ist leer.')}</Empty>
      ) : (
        <div className="ck-list">
          {list.data.map((p) => (
            <div key={p.id}>
              <span>{p.icon || '📄'}</span>
              <div className="ck-grow">
                <b>{p.title}</b>
                <div className="muted small">
                  {p.space_name} {t('· gelöscht')} {ago(p.trashed_at)}
                  {p.pages > 1 ? t.plural(p.pages - 1, { other: ' · mit {n} Unterseiten' }) : ''}
                </div>
              </div>
              <button
                className="btn small secondary"
                onClick={async () => {
                  if (await act(() => api.post(`/api/wiki/pages/${p.id}/restore`, {}), t('Wiederhergestellt'))) {
                    void list.reload();
                    onChanged();
                  }
                }}
              >
                {t('Wiederherstellen')}
              </button>
              <button
                className="icon-btn"
                title={t('Endgültig löschen')}
                aria-label={t('{title} endgültig löschen', { title: p.title })}
                onClick={async () => {
                  if (!confirmAsk(t('„{title}“ endgültig löschen?', { title: p.title }))) return;
                  if (await act(() => api.del(`/api/wiki/pages/${p.id}?purge=1`), t('Endgültig gelöscht'))) void list.reload();
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

// --- icon -----------------------------------------------------------------------------------------------------------------------------------------

export function IconDialog({ value, onPick, onClose }: { value: string; onPick: (v: string) => void; onClose: () => void }) {
  const t = useT('collab');
  const [v, setV] = useState(value);
  return (
    <Dialog
      title={t('Symbol der Seite')}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={() => onPick('')}>
            {t('Kein Symbol')}
          </button>
          <button className="btn" onClick={() => onPick(v)}>
            {t('Übernehmen')}
          </button>
        </>
      }
    >
      <Field label={t('Emoji')}>
        <Input value={v} onChange={setV} maxLength={8} style={{ width: 120 }} />
      </Field>
      <div className="wkp-emoji-row">
        {ICON_CHOICES.map((e) => (
          <button key={e} type="button" onClick={() => onPick(e)} aria-label={t('Symbol {icon}', { icon: e })}>
            {e}
          </button>
        ))}
      </div>
    </Dialog>
  );
}

// --- AI helper ------------------------------------------------------------------------------------------------------------------------------------

// German labels (message ids of the collab catalog), shown through t()
const AI_ACTIONS: [string, string, string][] = [
  ['summarize', 'Zusammenfassen', 'Kurzfassung mit den wichtigsten Punkten'],
  ['rewrite', 'Umschreiben', 'klarer, kürzer, freundlicher – oder wie du es beschreibst'],
  ['continue', 'Weiterschreiben', 'schreibt die Seite sinnvoll weiter'],
  ['translate', 'Übersetzen', 'in eine andere Sprache, Formatierung bleibt'],
  ['tasks', 'Aufgaben finden', 'macht aus dem Text eine Checkliste'],
];

export function AiDialog({ pageId, selection, onInsert, onReplace, onClose }: { pageId: string; selection: string; onInsert: (text: string) => void; onReplace: (text: string, selection: boolean) => void; onClose: () => void }) {
  const t = useT('collab');
  const [action, setAction] = useState('summarize');
  const [instruction, setInstruction] = useState('');
  const [language, setLanguage] = useState(() => t('Englisch'));
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ text: string; selection: boolean } | null>(null);
  const run = async () => {
    setBusy(true);
    setRes(null);
    try {
      const r = await api.post(`/api/wiki/pages/${pageId}/ai`, { action, instruction, language, selection: selection || undefined });
      setRes({ text: r.text, selection: !!r.selection });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t('KI-Schreibhilfe')} onClose={onClose} wide>
      <p className="muted small" style={{ marginTop: 0 }}>
        {selection ? t.plural(selection.length, { other: 'Gilt für deine Auswahl ({n} Zeichen).' }) : t('Gilt für die ganze Seite.')} {t('Die KI macht einen Vorschlag – er wird erst übernommen, wenn du es willst. Prüfe den Text, bevor du ihn nutzt.')}
      </p>
      <div className="ck-pick-tabs">
        {AI_ACTIONS.map(([k, l]) => (
          <button key={k} type="button" className={k === action ? 'on' : ''} onClick={() => setAction(k)} title={t(AI_ACTIONS.find((a) => a[0] === k)?.[2] ?? '')}>
            {t(l)}
          </button>
        ))}
      </div>
      {action === 'translate' ? (
        <Field label={t('Sprache')}>
          <Input value={language} onChange={setLanguage} maxLength={40} />
        </Field>
      ) : (
        <Field label={action === 'rewrite' ? t('Wie soll es klingen?') : t('Zusätzliche Hinweise (optional)')}>
          <Input value={instruction} onChange={setInstruction} maxLength={500} placeholder={action === 'rewrite' ? t('z. B. förmlicher, für Einsteiger') : ''} />
        </Field>
      )}
      <button className="btn" disabled={busy} onClick={run}>
        {busy ? t('Schreibt …') : t('Vorschlag erstellen')}
      </button>
      {res && (
        <div style={{ marginTop: 14 }}>
          <h3>{t('Vorschlag')}</h3>
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', border: '1px solid var(--line)', borderRadius: 10, padding: 12, maxHeight: 280, overflow: 'auto', background: 'var(--bg)' }}>
            {res.text}
          </pre>
          <div className="ck-row wrap">
            <button className="btn" onClick={() => onInsert(res.text)}>
              {t('Unten einfügen')}
            </button>
            {(selection || action === 'rewrite' || action === 'translate') && (
              <button className="btn secondary" onClick={() => onReplace(res.text, res.selection)}>
                {res.selection ? t('Auswahl ersetzen') : t('Seite ersetzen')}
              </button>
            )}
            <button className="btn ghost" onClick={() => setRes(null)}>
              {t('Verwerfen')}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// --- comments ----------------------------------------------------------------------------------------------------------------------------------------------

interface Comment {
  id: string;
  parent_id: string | null;
  body: string;
  html: string;
  quote: string;
  author_id: string | null;
  author_name: string;
  via: string;
  resolved_at: string | null;
  created_at: string;
}

export function CommentsPanel({ pageId, me, owner, canResolve, people, store, focus, onCount, onClose }: { pageId: string; me: string; owner: boolean; canResolve: boolean; people: Person[]; store: CardStore; focus?: string; onCount: (open: number, total: number) => void; onClose: () => void }) {
  const t = useT('collab');
  useFocusReturn();
  useEscape(onClose);
  const list = useLoad<Comment[]>(() => api.get(`/api/wiki/pages/${pageId}/comments`), [pageId]);
  const [text, setText] = useState('');
  const [reply, setReply] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const all = list.data ?? [];
  useEffect(() => onCount(all.filter((c) => !c.parent_id && !c.resolved_at).length, all.length), [list.data]);
  useEffect(() => {
    if (focus && list.data) document.getElementById(`wkc-${focus}`)?.scrollIntoView({ block: 'center' });
  }, [focus, list.data]);
  const roots = all.filter((c) => !c.parent_id && (showDone || !c.resolved_at));
  const resolvedCount = all.filter((c) => !c.parent_id && c.resolved_at).length;
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    const r = await act(() => api.post(`/api/wiki/pages/${pageId}/comments`, { body: text, parent_id: reply ?? undefined }));
    setBusy(false);
    if (r) {
      setText('');
      setReply(null);
      void list.reload();
    }
  };
  const one = (c: Comment, isReply = false) => (
    <div key={c.id} id={`wkc-${c.id}`} className={`wkc${isReply ? ' reply' : ''}${c.resolved_at ? ' resolved' : ''}`}>
      <Avatar name={c.author_name} size={isReply ? 24 : 28} agent={c.via === 'mcp' || c.via === 'agent'} />
      <div className="wkc-body">
        <div className="wkc-head">
          <b>{c.author_name || t('Unbekannt')}</b>
          <span className="muted small">{ago(c.created_at)}</span>
          {c.resolved_at && <span className="badge green">{t('erledigt')}</span>}
        </div>
        {c.quote && <div className="wkc-quote">{c.quote}</div>}
        {edit?.id === c.id ? (
          <div>
            <AutoTextarea value={edit.text} onChange={(v) => setEdit({ id: c.id, text: v })} people={people} rows={3} ariaLabel={t('Kommentar bearbeiten')} />
            <div className="ck-row" style={{ marginTop: 6 }}>
              <button
                className="btn small"
                onClick={async () => {
                  if (await act(() => api.patch(`/api/wiki/pages/${pageId}/comments/${c.id}`, { body: edit.text }))) {
                    setEdit(null);
                    void list.reload();
                  }
                }}
              >
                {t('Speichern')}
              </button>
              <button className="btn small ghost" onClick={() => setEdit(null)}>
                {t('Abbrechen')}
              </button>
            </div>
          </div>
        ) : (
          <Prose html={c.html} store={store} chat />
        )}
        {!edit && (
          <div className="wkc-acts">
            {!isReply && <button onClick={() => setReply(c.id)}>{t('Antworten')}</button>}
            {!isReply && (canResolve || c.author_id === me) && (
              <button
                onClick={async () => {
                  if (await act(() => api.patch(`/api/wiki/pages/${pageId}/comments/${c.id}`, { resolved: !c.resolved_at }))) void list.reload();
                }}
              >
                {c.resolved_at ? t('Wieder öffnen') : t('Erledigt')}
              </button>
            )}
            {c.author_id === me && <button onClick={() => setEdit({ id: c.id, text: c.body })}>{t('Bearbeiten')}</button>}
            {(c.author_id === me || owner) && (
              <button
                onClick={async () => {
                  if (!confirmAsk(t('Kommentar löschen?'))) return;
                  if (await act(() => api.del(`/api/wiki/pages/${pageId}/comments/${c.id}`))) void list.reload();
                }}
              >
                {t('Löschen')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
  return (
    <aside className="wkp-panel" role="complementary" aria-label={t('Kommentare')} data-tour="wiki-comments">
      <div className="wkp-panel-head">
        <h3>{t('Kommentare')}</h3>
        <button className="icon-btn" onClick={onClose} aria-label={t('Schließen')}>
          ✕
        </button>
      </div>
      <div className="wkp-panel-body">
        {list.loading && <Spinner />}
        {!list.loading && !roots.length && <p className="muted">{resolvedCount ? t('Alle Kommentare sind erledigt.') : t('Noch keine Kommentare. Mit @ erwähnst du jemanden – die Person bekommt eine Benachrichtigung.')}</p>}
        {roots.map((c) => (
          <div key={c.id}>
            {one(c)}
            {all.filter((r) => r.parent_id === c.id).map((r) => one(r, true))}
          </div>
        ))}
        {resolvedCount > 0 && (
          <CheckBox checked={showDone} onChange={setShowDone} label={t('Erledigte anzeigen ({n})', { n: resolvedCount })} />
        )}
      </div>
      {(
        <div className="wkp-panel-foot">
          {reply && (
            <div className="muted small" style={{ marginBottom: 4 }}>
              {t('Antwort auf')} {all.find((c) => c.id === reply)?.author_name}{' '}
              <button className="icon-btn" aria-label={t('Antwort abbrechen')} onClick={() => setReply(null)}>
                ✕
              </button>
            </div>
          )}
          <AutoTextarea
            value={text}
            onChange={setText}
            people={people}
            up
            rows={3}
            placeholder={t('Kommentar schreiben … @ erwähnt eine Person')}
            ariaLabel={t('Neuer Kommentar')}
            onKey={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) return e.preventDefault(), void send(), true;
            }}
          />
          <div className="ck-row" style={{ marginTop: 6 }}>
            <span className="muted small ck-grow">{t('Strg+Enter sendet')}</span>
            <button className="btn small" disabled={busy || !text.trim()} onClick={send}>
              <Check size={14} /> {t('Kommentieren')}
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

