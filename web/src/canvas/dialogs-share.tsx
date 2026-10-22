import { useEffect, useMemo, useState } from 'react';
import { api, ago, dt } from '../api';
import { Badge, Check, Copy, Field, Input, Modal, Select, Tabs, act, confirmAsk, navigate, useLoad } from '../ui';
import { Icon } from '../icons';
import { renderSvg, sceneDisplayList } from '../../../server/services/canvas-render';
import { withLocation } from './media';
import type { EditorApi } from './Editor';
import type { DialogProps } from './dialogs';

/** Output and sharing: export (PNG/SVG/PDF) and "use in …", team and public links, versions, board settings. */

// --- export -----------------------------------------------------------------------------------------------

type Format = 'png' | 'svg' | 'pdf';
type Scope = 'board' | 'selection' | 'frame';

function exportQuery(o: { format: Format; scope: Scope; ids: string[]; frameId: string; scale: number; dark: boolean; transparent: boolean; pages: boolean }) {
  const q = new URLSearchParams({ format: o.format });
  if (o.scope === 'selection' && o.ids.length) q.set('ids', o.ids.join(','));
  if (o.scope === 'frame' && o.frameId) q.set('frame_id', o.frameId);
  if (o.format === 'png') q.set('scale', String(o.scale));
  if (o.dark) q.set('theme', 'dark');
  if (o.transparent && o.format !== 'pdf') q.set('transparent', '1');
  if (o.format === 'pdf' && o.pages && o.scope === 'board') q.set('pages', 'frames');
  return q;
}

export function ExportDialog({ api: ed, data, onClose }: DialogProps) {
  const frames = ed.store.ordered.filter((e) => e.type === 'frame' && !e.hidden);
  const hasSel = ed.selection.length > 0;
  const [format, setFormat] = useState<Format>('png');
  const [scope, setScope] = useState<Scope>(data?.scope === 'frame' ? 'frame' : data?.scope === 'selection' || (hasSel && !data?.scope) ? 'selection' : 'board');
  const [frameId, setFrameId] = useState<string>(data?.frameId ?? frames[0]?.id ?? '');
  const [scale, setScale] = useState(2);
  const [dark, setDark] = useState(false);
  const [transparent, setTransparent] = useState(false);
  const [pages, setPages] = useState(true);
  const [use, setUse] = useState<null | { id: string; src: string; url: string; name: string }>(null);
  const [busy, setBusy] = useState(false);
  const opts = { format, scope, ids: ed.selection, frameId, scale, dark, transparent, pages };
  const preview = useMemo(() => {
    try {
      const o = { cards: ed.store.cards, imageHref: (s: string) => s, background: transparent ? undefined : dark ? '#121212' : '#ffffff', theme: dark ? ('dark' as const) : ('light' as const), maxSize: 420, idPrefix: 'ex' };
      const sel = scope === 'selection' && ed.selection.length ? { ids: ed.selection } : scope === 'frame' && frameId ? { frameId } : {};
      return renderSvg([...ed.store.els.values()], { ...o, ...sel }).svg;
    } catch {
      return '';
    }
  }, [scope, frameId, dark, transparent, ed.selection, ed.store.rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const dims = useMemo(() => {
    try {
      const sel = scope === 'selection' && ed.selection.length ? { ids: ed.selection } : scope === 'frame' && frameId ? { frameId } : {};
      const d = sceneDisplayList([...ed.store.els.values()], sel);
      return { w: Math.round(d.width * (format === 'png' ? scale : 1)), h: Math.round(d.height * (format === 'png' ? scale : 1)) };
    } catch {
      return null;
    }
  }, [scope, frameId, scale, format, ed.selection, ed.store.rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const href = withLocation(`/api/canvas/${ed.board.id}/export?${exportQuery(opts)}`);
  const toLibrary = async () => {
    setBusy(true);
    await ed.store.flush();
    const body: Record<string, unknown> = { format: format === 'pdf' ? 'png' : format, name: ed.board.name, scale, ...(dark ? { theme: 'dark' } : {}), ...(transparent ? { transparent: true } : {}) };
    if (scope === 'selection' && ed.selection.length) body.ids = ed.selection;
    if (scope === 'frame' && frameId) body.frame_id = frameId;
    const r = await act(() => api.post(`/api/canvas/${ed.board.id}/export`, body), 'In der Mediathek gespeichert');
    setBusy(false);
    if (r) setUse({ id: r.id, src: r.src, url: r.url, name: r.name });
  };
  if (use) return <UseDialog ed={ed} media={use} onClose={onClose} onBack={() => setUse(null)} />;
  return (
    <Modal
      title="Exportieren"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn secondary" onClick={toLibrary} disabled={busy || format === 'pdf'} title={format === 'pdf' ? 'Für PDF: erst herunterladen' : 'Speichert die Grafik und bietet Social-Post, E-Mail und Funnel an'} data-tour="canvas-export-use">
            In Mediathek / verwenden …
          </button>
          <a className="btn" href={href} download data-tour="canvas-export-download">
            <Icon name="download" /> Herunterladen
          </a>
        </>
      }
    >
      <div className="cv-two">
        <div>
          <Field label="Format">
            <div className="cv-seg">
              {(['png', 'svg', 'pdf'] as const).map((f) => (
                <button key={f} className={format === f ? 'on' : ''} onClick={() => setFormat(f)}>
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Was?">
            <Select
              value={scope}
              onChange={(v) => setScope(v as Scope)}
              options={[['board', 'Ganzes Board'], ...(hasSel ? ([['selection', `Auswahl (${ed.selection.length})`]] as [string, string][]) : []), ...(frames.length ? ([['frame', 'Ein Rahmen / Artboard']] as [string, string][]) : [])]}
            />
          </Field>
          {scope === 'frame' && <Select value={frameId} onChange={setFrameId} options={frames.map((f) => [f.id, `${f.name ?? 'Rahmen'} (${Math.round(f.w)}×${Math.round(f.h)})`] as [string, string])} />}
          {format === 'png' && (
            <Field label="Größe">
              <div className="cv-seg">
                {[1, 2, 3, 4].map((s) => (
                  <button key={s} className={scale === s ? 'on' : ''} onClick={() => setScale(s)}>
                    {s}×
                  </button>
                ))}
              </div>
            </Field>
          )}
          {format === 'pdf' && scope === 'board' && frames.length > 1 && <Check checked={pages} onChange={setPages} label="Eine Seite pro Rahmen" />}
          <Check checked={dark} onChange={setDark} label="Dunkles Design" />
          {format !== 'pdf' && <Check checked={transparent} onChange={setTransparent} label="Transparenter Hintergrund" />}
          {dims && (
            <p className="muted small">
              {format === 'pdf' && scope === 'board' && pages && frames.length > 1 ? `${frames.length} Seiten` : `${dims.w} × ${dims.h} px`}
              {format === 'svg' ? ' · Vektor, Text bleibt Text' : format === 'pdf' ? ' · Vektor, druckfertig' : ''}
            </p>
          )}
          <p className="muted small">CRM-Karten erscheinen mit dem aktuellen Stand der Daten.</p>
        </div>
        <div className={`cv-preview wide${transparent ? ' checker' : ''}${dark ? ' dark' : ''}`} dangerouslySetInnerHTML={{ __html: preview || '<p class="muted" style="padding:20px">Nichts zu exportieren.</p>' }} />
      </div>
    </Modal>
  );
}

/** What to do with an exported image: social post, e-mail campaign, funnel page, or just the link. */
function UseDialog({ ed, media, onClose, onBack }: { ed: EditorApi; media: { id: string; src: string; url: string; name: string }; onClose: () => void; onBack: () => void }) {
  const [tab, setTab] = useState('link');
  return (
    <Modal title="Grafik verwenden" onClose={onClose} wide footer={<button className="btn secondary" onClick={onBack}>Zurück zum Export</button>}>
      <div className="cv-use-head">
        <img src={media.src} alt="" />
        <div>
          <b>{media.name}</b>
          <p className="muted small">Liegt jetzt in der Mediathek und ist von dort in Social-Posts, E-Mails und Funnels nutzbar.</p>
        </div>
      </div>
      <Tabs
        tabs={[
          ['link', 'Link'],
          ['social', 'Social-Post'],
          ['email', 'E-Mail'],
          ['funnel', 'Funnel-Seite'],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'link' && (
        <div className="codebox">
          <code>{media.url}</code>
          <Copy text={media.url} />
        </div>
      )}
      {tab === 'social' && <UseSocial media={media} board={ed.board.name} onDone={onClose} />}
      {tab === 'email' && <UseEmail media={media} board={ed.board.name} onDone={onClose} />}
      {tab === 'funnel' && <UseFunnel media={media} board={ed.board.name} onDone={onClose} />}
    </Modal>
  );
}

function UseSocial({ media, board, onDone }: { media: { id: string }; board: string; onDone: () => void }) {
  const social = useLoad(() => api.get<any>('/api/social'), []);
  const [text, setText] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  if (social.loading) return <p className="muted">Lädt …</p>;
  if (social.error || !social.data?.configured || !social.data.channels?.length)
    return (
      <p className="muted">
        Es ist noch kein Social-Kanal verbunden. <a href="/app/social" onClick={(e) => (e.preventDefault(), onDone(), navigate('social'))}>Zum Social Planner</a> – danach kannst du Grafiken direkt als Entwurf einplanen.
      </p>
    );
  const channels = (social.data.channels as any[]).filter((c) => c.supported !== false && !c.disabled);
  return (
    <div>
      <Field label="Text zum Post">
        <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={`z. B. Neu: ${board}`} />
      </Field>
      <div className="cv-pick-list short">
        {channels.map((c) => (
          <label key={c.id} className={`cv-pick${chosen.includes(c.id) ? ' on' : ''}`}>
            <input type="checkbox" checked={chosen.includes(c.id)} onChange={() => setChosen((x) => (x.includes(c.id) ? x.filter((i) => i !== c.id) : [...x, c.id]))} />
            <span>
              <b>{c.name}</b> <small className="muted">{c.label}</small>
            </span>
          </label>
        ))}
      </div>
      <button
        className="btn"
        disabled={busy || !text.trim() || !chosen.length}
        onClick={async () => {
          setBusy(true);
          const r = await act(() => api.post('/api/social/posts', { content: text.trim(), integration_ids: chosen, type: 'draft', upload_ids: [media.id] }), 'Als Entwurf im Social Planner gespeichert');
          setBusy(false);
          if (r) onDone();
        }}
      >
        Als Entwurf speichern
      </button>
    </div>
  );
}

function UseEmail({ media, board, onDone }: { media: { url: string; name: string }; board: string; onDone: () => void }) {
  const [subject, setSubject] = useState(board);
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <p className="muted">Legt eine neue E-Mail-Kampagne als Entwurf an – die Grafik steht schon im Text. Empfänger und Versand bestimmst du im Kampagnen-Editor.</p>
      <Field label="Betreff">
        <Input value={subject} onChange={setSubject} />
      </Field>
      <button
        className="btn"
        disabled={busy || !subject.trim()}
        onClick={async () => {
          setBusy(true);
          const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
          const c = await act(() => api.post('/api/campaigns', { name: subject.trim(), channel: 'email', subject: subject.trim(), is_html: true, body: `<p>Hallo {{contact.first_name|du}},</p><p><img src="${esc(media.url)}" alt="${esc(media.name)}" style="max-width:100%;height:auto"></p>` }));
          setBusy(false);
          if (c) {
            onDone();
            navigate(`campaigns/${c.id}`);
          }
        }}
      >
        E-Mail-Entwurf anlegen
      </button>
    </div>
  );
}

function UseFunnel({ media, board, onDone }: { media: { url: string; name: string }; board: string; onDone: () => void }) {
  const funnels = useLoad(() => api.get<any[]>('/api/funnels'), []);
  const [fid, setFid] = useState('');
  const [page, setPage] = useState('new');
  const detail = useLoad(async () => (fid ? api.get<any>(`/api/funnels/${fid}`) : null), [fid]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!fid && funnels.data?.length) setFid(funnels.data[0].id);
  }, [funnels.data, fid]);
  if (funnels.loading) return <p className="muted">Lädt …</p>;
  if (!funnels.data?.length) return <p className="muted">Noch kein Funnel angelegt. Unter „Funnels & Websites“ geht’s los – oder gestalte Seiten als Rahmen und nutze „Rahmen → Funnel-Seiten“.</p>;
  const pages: any[] = detail.data?.pages ?? [];
  const block = { type: 'image', src: media.url, alt: media.name };
  return (
    <div>
      <div className="grid2">
        <Field label="Funnel">
          <Select
            value={fid}
            onChange={(v) => {
              setFid(v);
              setPage('new');
            }}
            options={funnels.data.map((f) => [f.id, f.name] as [string, string])}
          />
        </Field>
        <Field label="Seite">
          <Select value={page} onChange={setPage} options={[['new', 'Neue Seite'], ...pages.map((p) => [p.id, `Unten an „${p.name}“`] as [string, string])]} />
        </Field>
      </div>
      <button
        className="btn"
        disabled={busy || !fid}
        onClick={async () => {
          setBusy(true);
          const r = await act(async () => {
            if (page === 'new') return api.post(`/api/funnels/${fid}/pages`, { name: board.slice(0, 100), blocks: [block] });
            const p = pages.find((x) => x.id === page);
            return api.patch(`/api/funnel-pages/${page}`, { blocks: [...(p?.blocks ?? []), block] });
          }, 'Bild in den Funnel eingefügt');
          setBusy(false);
          if (r) {
            onDone();
            navigate(`funnels/${fid}`);
          }
        }}
      >
        Einfügen
      </button>
    </div>
  );
}

// --- sharing ----------------------------------------------------------------------------------------------

interface Person {
  id: string;
  name: string;
  email?: string;
  admin: boolean;
  member: 'edit' | 'view' | null;
  owner: boolean;
}

export function ShareDialog({ api: ed, onClose }: DialogProps) {
  const isOwner = ed.board.access === 'owner';
  const [tab, setTab] = useState('team');
  const people = useLoad(() => api.get<Person[]>(`/api/canvas/${ed.board.id}/people`), [ed.board.id]);
  const shares = useLoad(() => api.get<any[]>(`/api/canvas/${ed.board.id}/shares`).catch(() => []), [ed.board.id]);
  const [label, setLabel] = useState('');
  const team = ed.board.team_access;
  return (
    <Modal title="Teilen" onClose={onClose} wide>
      <Tabs
        tabs={[
          ['team', 'Team'],
          ['link', 'Öffentlicher Link'],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'team' && (
        <div data-tour="canvas-share-team">
          <Field label="Alle mit Zugang zu diesem Projekt" hint={isOwner ? undefined : 'Nur die Besitzerin oder der Besitzer ändert das.'}>
            <Select
              value={team}
              onChange={(v) => void ed.saveBoard({ team_access: v as 'edit' | 'view' | 'none' })}
              options={[
                ['edit', 'dürfen bearbeiten'],
                ['view', 'dürfen ansehen und kommentieren'],
                ['none', 'haben keinen Zugriff (privat)'],
              ]}
            />
          </Field>
          {!isOwner && <p className="muted small">Deine Rolle: {ed.board.access === 'edit' ? 'Bearbeiten' : 'Ansehen'}.</p>}
          <h3 style={{ margin: '14px 0 6px' }}>Personen</h3>
          <div className="cv-people-list">
            {(people.data ?? []).map((p) => (
              <div key={p.id} className="cv-person">
                <span className="cv-avatar" style={{ background: '#4c6ef5' }}>
                  {p.name.slice(0, 1).toUpperCase()}
                </span>
                <span>
                  <b>{p.name}</b> {p.owner && <Badge tone="blue">Besitzer:in</Badge>} {p.admin && <Badge tone="purple">Agentur</Badge>}
                  <br />
                  <small className="muted">{p.email}</small>
                </span>
                {isOwner && !p.owner ? (
                  <select
                    value={p.member ?? 'default'}
                    onChange={async (e) => {
                      const v = e.target.value;
                      const r = await act(() => api.put(`/api/canvas/${ed.board.id}/members`, { user_id: p.id, role: v === 'default' ? 'none' : v }));
                      if (r) await people.reload();
                    }}
                    aria-label={`Rolle von ${p.name}`}
                  >
                    <option value="default">wie Team ({team === 'edit' ? 'bearbeiten' : team === 'view' ? 'ansehen' : 'kein Zugriff'})</option>
                    <option value="edit">bearbeiten</option>
                    <option value="view">nur ansehen</option>
                  </select>
                ) : (
                  <span className="muted small">{p.owner ? 'Besitz' : (p.member ?? 'Team')}</span>
                )}
              </div>
            ))}
            {people.loading && <p className="muted">Lädt …</p>}
          </div>
        </div>
      )}
      {tab === 'link' && (
        <div data-tour="canvas-share-link">
          <p className="muted">Wer den Link hat, sieht das Board – nur ansehen, ohne Anmeldung, mit Zoom und Verschieben. CRM-Karten zeigen dort keine Live-Daten, nur ihre Form. Du kannst einen Link jederzeit widerrufen.</p>
          {isOwner ? (
            <div className="cv-link-new">
              <Input value={label} onChange={setLabel} placeholder="Bezeichnung, z. B. „Kunde Müller“" />
              <button
                className="btn"
                onClick={async () => {
                  const r = await act(() => api.post(`/api/canvas/${ed.board.id}/shares`, { label }), 'Link erstellt');
                  if (r) {
                    setLabel('');
                    await shares.reload();
                  }
                }}
              >
                Link erstellen
              </button>
            </div>
          ) : (
            <p className="muted small">Links erstellt die Besitzerin oder der Besitzer des Boards.</p>
          )}
          <div className="cv-share-list">
            {(shares.data ?? []).map((s) => (
              <div key={s.id} className={`cv-share${s.revoked_at ? ' revoked' : ''}`}>
                <div>
                  <b>{s.label || 'Link'}</b> <small className="muted">von {s.created_by} · {ago(s.created_at)} · {s.views} Aufrufe{s.last_used_at ? ` · zuletzt ${ago(s.last_used_at)}` : ''}</small>
                  {s.url ? (
                    <div className="codebox">
                      <code>{s.url}</code>
                      <Copy text={s.url} />
                    </div>
                  ) : (
                    <div className="muted small">widerrufen {dt(s.revoked_at)}</div>
                  )}
                </div>
                {s.url && isOwner && (
                  <button
                    className="btn small danger"
                    onClick={async () => {
                      if (!confirmAsk('Diesen Link widerrufen? Er funktioniert dann nicht mehr.')) return;
                      const r = await act(() => api.del(`/api/canvas/${ed.board.id}/shares/${s.id}`), 'Link widerrufen');
                      if (r) await shares.reload();
                    }}
                  >
                    Widerrufen
                  </button>
                )}
              </div>
            ))}
            {!shares.loading && !shares.data?.length && <p className="muted small">Noch kein Link.</p>}
          </div>
        </div>
      )}
    </Modal>
  );
}

// --- versions ---------------------------------------------------------------------------------------------

export function HistoryDialog({ api: ed, onClose }: DialogProps) {
  const snaps = useLoad(() => api.get<any[]>(`/api/canvas/${ed.board.id}/snapshots`), [ed.board.id]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const canEdit = ed.board.access !== 'view';
  const save = async () => {
    setBusy(true);
    await ed.store.flush();
    const r = await act(() => api.post(`/api/canvas/${ed.board.id}/snapshots`, { name: name.trim() }), 'Version gespeichert');
    setBusy(false);
    if (r) {
      setName('');
      await snaps.reload();
    }
  };
  return (
    <Modal title="Versionen" onClose={onClose} wide>
      <p className="muted">Das Board speichert sich alle 30 Minuten selbst eine Version, wenn daran gearbeitet wird. Eigene Versionen kannst du jederzeit anlegen – und eine alte zurückholen, ohne dass etwas verloren geht (vorher wird der aktuelle Stand gesichert).</p>
      {canEdit && (
        <div className="cv-link-new">
          <Input value={name} onChange={setName} placeholder="Name der Version, z. B. „Vor dem Kundentermin“" />
          <button className="btn" onClick={save} disabled={busy}>
            Version speichern
          </button>
        </div>
      )}
      <div className="cv-snap-grid" data-tour="canvas-history-list">
        {(snaps.data ?? []).map((s) => (
          <div key={s.id} className="cv-snap">
            <img src={withLocation(`/api/canvas/${ed.board.id}/snapshots/${s.id}/svg`)} alt="" loading="lazy" />
            <b>{s.name || 'Version'}</b>
            <span className="muted small">
              {dt(s.created_at)} · {s.element_count} Elemente {s.auto ? <Badge>automatisch</Badge> : null}
            </span>
            {canEdit && (
              <div className="cv-actions">
                <button
                  className="btn small secondary"
                  onClick={async () => {
                    if (!confirmAsk('Diese Version wiederherstellen? Der aktuelle Stand wird vorher als Version gesichert.')) return;
                    await ed.store.flush();
                    const r = await act(() => api.post(`/api/canvas/${ed.board.id}/snapshots/${s.id}/restore`, { clientId: ed.store.clientId }), 'Version wiederhergestellt');
                    if (r) {
                      await ed.store.catchUp();
                      onClose();
                      setTimeout(() => ed.zoomTo(), 50);
                    }
                  }}
                >
                  Wiederherstellen
                </button>
                {ed.board.access === 'owner' && (
                  <button
                    className="icon-btn"
                    title="Version löschen"
                    onClick={async () => {
                      if (!confirmAsk('Diese Version löschen?')) return;
                      const r = await act(() => api.del(`/api/canvas/${ed.board.id}/snapshots/${s.id}`));
                      if (r) await snaps.reload();
                    }}
                  >
                    <Icon name="trash" />
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        {snaps.loading && <p className="muted">Lädt …</p>}
        {!snaps.loading && !snaps.data?.length && <p className="muted">Noch keine Versionen.</p>}
      </div>
    </Modal>
  );
}

// --- settings ---------------------------------------------------------------------------------------------

export function SettingsDialog({ api: ed, onClose }: DialogProps) {
  const b = ed.board;
  const [name, setName] = useState(b.name);
  const [description, setDescription] = useState(b.description ?? '');
  const [grid, setGrid] = useState<'dots' | 'lines' | 'none'>(b.settings.grid ?? 'dots');
  const [snap, setSnap] = useState(b.settings.snap !== false);
  const [sketch, setSketch] = useState(!!b.settings.sketch);
  const [busy, setBusy] = useState(false);
  const owner = b.access === 'owner';
  const save = async () => {
    setBusy(true);
    await ed.saveBoard({ name: name.trim() || b.name, description, settings: { grid, snap, sketch } } as never);
    ed.setDefaults({ sketch: sketch || undefined });
    setBusy(false);
    onClose();
  };
  return (
    <Modal
      title="Board-Einstellungen"
      onClose={onClose}
      footer={
        <>
          {owner && (
            <button
              className="btn danger"
              style={{ marginRight: 'auto' }}
              onClick={async () => {
                if (!confirmAsk(`Board „${b.name}“ endgültig löschen? Alle Elemente, Kommentare und Versionen gehen verloren.`)) return;
                const r = await act(() => api.del(`/api/canvas/${b.id}`), 'Board gelöscht');
                if (r) navigate('canvas');
              }}
            >
              Löschen
            </button>
          )}
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" onClick={save} disabled={busy || b.access === 'view'}>
            Speichern
          </button>
        </>
      }
    >
      <Field label="Name">
        <Input value={name} onChange={setName} maxLength={200} />
      </Field>
      <Field label="Beschreibung">
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
      </Field>
      <div className="grid2">
        <Field label="Raster">
          <Select
            value={grid}
            onChange={(v) => setGrid(v as typeof grid)}
            options={[
              ['dots', 'Punkte'],
              ['lines', 'Linien'],
              ['none', 'Kein Raster'],
            ]}
          />
        </Field>
        <div style={{ alignSelf: 'end' }}>
          <Check checked={snap} onChange={setSnap} label="Am Raster einrasten" />
        </div>
      </div>
      <Check checked={sketch} onChange={setSketch} label="Neue Formen „Handgezeichnet“" />
      <div className="cv-actions" style={{ marginTop: 14 }}>
        <button
          className="btn small secondary"
          onClick={async () => {
            await ed.store.flush();
            const r = await act(() => api.post(`/api/canvas/${b.id}/duplicate`, {}), 'Board dupliziert');
            if (r) {
              onClose();
              navigate(`canvas/${r.id}`);
            }
          }}
        >
          <Icon name="copy" /> Board duplizieren
        </button>
      </div>
    </Modal>
  );
}
