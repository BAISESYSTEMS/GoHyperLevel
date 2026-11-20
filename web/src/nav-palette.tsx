import { useEffect, useMemo, useRef, useState } from 'react';
import { Search as SearchIcon } from 'lucide-react';
import { api } from './api';
import { Icon, type IconName } from './icons';
import { can, useSession } from './session';
import { useT } from './i18n';
import { navigate, useFocusLayer, useRoute } from './ui';
import { useCompanion } from './companion/store';
import { AREA_KEYWORDS } from './areas/info';
import { SETTINGS_KEYWORDS } from './areas/settings-nav';
import { scoreMatch } from './nav-match';
import { StatusDot, recentPages, sortProjects, toggleFav, useFavs, useListKeys, useOpenProject, useProjects, type Fav } from './nav';
import './nav-palette.css';

/**
 * The Ctrl/⌘+K dialog – its own chunk: nav.tsx keeps the shortcut, the "Springen" button's event and the recent pages in the
 * first download and loads this the first time the palette opens (or when the browser is idle). One place to get anywhere:
 * favourites and recent pages first, every page and the main settings, contacts and deals from the search, projects, documents
 * and Claude/Codex sessions – ranked by how well they match. The last row hands the words to the assistant ("Frag Assistent: …",
 * the agent panel opens with the text, nothing is sent before Enter). ☆ pins a page as a favourite (top of the menu).
 */

/** Settings sections Ctrl+K finds directly (labels as on the settings page, keywords from areas/settings-nav.ts). */
const SETTINGS_PAGES: [string, string][] = [
  ['company', 'Firma'],
  ['messaging', 'E-Mail & SMS'],
  ['deliverability', 'E-Mail-Zustellung'],
  ['channels', 'Kanäle'],
  ['telephony', 'Telefonie'],
  ['billing', 'Rechnungen'],
  ['stripe', 'Stripe & Zahlungen'],
  ['chat', 'Live-Chat'],
  ['ai', 'KI-Assistent'],
  ['ai-providers', 'KI-Anbieter (BYOK)'],
  ['voice', 'Stimme'],
  ['fields', 'Felder & Tags'],
  ['api', 'API & Webhooks'],
  ['import', 'Import'],
  ['team', 'Team'],
  ['appearance', 'Darstellung'],
  ['account', 'Mein Konto'],
];

interface Cmd {
  key: string;
  label: string;
  hint?: string;
  /** more words to match (keywords, the route) */
  extra?: string;
  icon: IconName | 'status';
  status?: string;
  /** order when scores tie: favourites, recent pages, pages, settings, records, actions, projects, documents, sessions */
  rank: number;
  run: () => void;
  /** a page that can be pinned as a favourite */
  fav?: Fav;
}

export function PaletteDialog({ nav, close }: { nav: [string, IconName, string, string][]; close: () => void }) {
  const t = useT('shell');
  const session = useSession();
  const route = useRoute();
  const projects = useProjects();
  const open = useOpenProject();
  const favs = useFavs();
  const { name: assistant } = useCompanion();
  const [q, setQ] = useState('');
  const [docs, setDocs] = useState<any[]>([]);
  useEffect(() => {
    (session.user.role === 'admin' ? api.get<any[]>('/api/agency/docs') : api.get<any[]>('/api/docs')).then(setDocs).catch(() => {});
  }, [session.locationId]); // eslint-disable-line react-hooks/exhaustive-deps
  // contacts and deals from the search (only areas the menu shows – hidden areas stay out of Ctrl+K too)
  const navHas = (r: string) => nav.some((n) => n[0] === r && can(session, n[3]));
  const [found, setFound] = useState<{ contacts?: any[]; opportunities?: any[] } | null>(null);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2 || (!navHas('contacts') && !navHas('opportunities'))) return setFound(null);
    const timer = setTimeout(() => api.get<any>(`/api/search?q=${encodeURIComponent(term)}`).then(setFound).catch(() => setFound(null)), 200);
    return () => clearTimeout(timer);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const here = route.join('/');
  const hereLabel = nav.find((n) => n[0] === route[0])?.[2] ?? '';
  const cmds = useMemo<Cmd[]>(() => {
    const out: Cmd[] = [];
    const pageLabel = new Map(nav.map((n) => [n[0], n] as const));
    for (const f of favs) {
      const root = f.path.split(/[/?]/)[0];
      if (root !== 'settings' && root !== 'agency' && !pageLabel.has(root)) continue;
      out.push({ key: `f${f.path}`, label: f.label, hint: t('Favorit'), icon: 'star', rank: 0, run: () => navigate(f.path), fav: f });
    }
    const recent = recentPages().filter((r) => r !== route[0] && pageLabel.has(r));
    for (const r of recent.slice(0, 4)) {
      const n = pageLabel.get(r)!;
      if (can(session, n[3])) out.push({ key: `r${r}`, label: n[2], hint: t('Zuletzt geöffnet'), icon: n[1], rank: 1, run: () => navigate(r), fav: { path: r, label: n[2], icon: n[1] } });
    }
    for (const [r, icon, label, perm] of nav) if (can(session, perm)) out.push({ key: `n${r}`, label, hint: t('Seite'), extra: `${r} ${AREA_KEYWORDS[r] ?? ''}`, icon, rank: 2, run: () => navigate(r), fav: { path: r, label, icon } });
    if (can(session, 'settings'))
      for (const [k, label] of SETTINGS_PAGES) {
        if ((k === 'team' || k === 'locations') && session.user.role !== 'admin') continue;
        const full = `${t('Einstellungen')} › ${t(label)}`;
        out.push({ key: `s${k}`, label: full, hint: t('Einstellungen'), extra: `${SETTINGS_KEYWORDS[k] ?? ''} ${k}`, icon: 'settings', rank: 3, run: () => navigate(`settings/${k}`), fav: { path: `settings/${k}`, label: full, icon: 'settings' } });
      }
    for (const c of found?.contacts ?? []) {
      const who = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.name || c.email || c.phone || '–';
      out.push({ key: `k${c.id}`, label: who, hint: c.email || t('Kontakt'), extra: `${c.email ?? ''} ${c.phone ?? ''} ${c.company ?? ''}`, icon: 'contact', rank: 4, run: () => navigate(`contacts/${c.id}`) });
    }
    for (const o of found?.opportunities ?? []) out.push({ key: `o${o.id}`, label: o.name, hint: t('Deal'), icon: 'deal', rank: 4, run: () => navigate(`opportunities?pipeline=${o.pipeline_id}`) });
    // Rückgängig: my history of changes and the trash (undo/Undo.tsx, pages/Trash.tsx).
    out.push({ key: 'verlauf', label: t('Verlauf – meine letzten Änderungen'), hint: t('Rückgängig machen'), icon: 'history', rank: 5, run: () => window.dispatchEvent(new Event('pghl:verlauf')) });
    out.push({ key: 'papierkorb', label: t('Papierkorb'), hint: t('Gelöschtes wiederherstellen'), icon: 'trash', rank: 5, run: () => navigate('trash') });
    out.push({ key: 'focus', label: t('Fokus-Modus mit {name}', { name: assistant }), hint: 'Alt+J', icon: 'goal', rank: 5, run: () => navigate('focus') });
    if (here && hereLabel) {
      const pinned = favs.some((f) => f.path === here);
      const label = route.length > 1 ? `${hereLabel} · ${route.slice(1).join(' / ')}` : hereLabel;
      out.push({ key: 'favhere', label: pinned ? t('Diese Seite aus den Favoriten nehmen') : t('Diese Seite als Favorit anheften'), hint: label, icon: 'star', rank: 5, run: () => toggleFav(session.user.id, { path: here, label, icon: nav.find((n) => n[0] === route[0])?.[1] ?? 'star' }) });
    }
    for (const p of sortProjects(projects).filter((p) => p.status !== 'archiviert')) {
      out.push({ key: `p${p.id}`, label: p.name, hint: p.tagline || t('Projekt öffnen'), icon: 'status', status: p.status, rank: 6, run: () => open(p.id, 'project') });
      for (const s of p.claude_sessions) out.push({ key: `c${p.id}${s.url}`, label: `Claude: ${p.name}`, hint: s.label, icon: 'claude', rank: 8, run: () => window.open(s.url, '_blank', 'noopener') });
      for (const s of p.codex_sessions ?? []) out.push({ key: `x${p.id}${s.url}`, label: `Codex: ${p.name}`, hint: s.label, icon: 'codex', rank: 8, run: () => window.open(s.url, '_blank', 'noopener') });
    }
    for (const d of docs) out.push({ key: `d${d.id}`, label: d.title, hint: d.project ?? t('Eingang'), icon: d.source === 'Codex' ? 'codex' : d.kind === 'artifact' ? 'artifact' : 'doc', rank: 7, run: () => window.open(d.url, '_blank', 'noopener') });
    if (session.user.role === 'admin')
      for (const [page, label, icon] of [
        ['projects', 'Alle Projekte', 'project'],
        ['contacts', 'Alle Kontakte', 'contacts'],
        ['deals', 'Alle Deals', 'opportunities'],
        ['tasks', 'Alle Aufgaben', 'tasks'],
        ['docs', 'Alle Dokumente & Artefakte', 'doc'],
      ] as [string, string, IconName][])
        out.push({ key: `a${page}`, label: t(label), hint: t('Agentur'), icon, rank: 5, run: () => navigate(`agency/${page}`) });
    return out;
  }, [projects, nav, session, docs, t, favs, found, assistant, here, hereLabel]); // eslint-disable-line react-hooks/exhaustive-deps
  const term = q.trim();
  const list = useMemo(() => {
    if (!term) {
      // nothing typed: favourites, recent pages, every page, then the rest – no duplicates of a page already listed above
      const seen = new Set<string>();
      return cmds
        .filter((c) => {
          const path = c.fav?.path ?? c.key;
          if (c.rank <= 3 && seen.has(path)) return false;
          if (c.rank <= 3) seen.add(path);
          return true;
        })
        .slice(0, 40);
    }
    const scored = cmds
      .filter((c) => c.rank !== 1)
      .map((c) => ({ c, s: c.key.startsWith('k') || c.key.startsWith('o') ? Math.max(30, scoreMatch(term, c.label, c.extra)) : scoreMatch(term, c.label, `${c.hint ?? ''} ${c.extra ?? ''}`) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.c.rank - b.c.rank);
    const seen = new Set<string>();
    const out = scored.map((x) => x.c).filter((c) => (c.fav ? (seen.has(c.fav.path) ? false : (seen.add(c.fav.path), true)) : true)).slice(0, 30);
    // the assistant takes whatever was typed
    out.push({ key: 'ask', label: t('{name} fragen: „{q}“', { name: assistant, q: term }), hint: `${isMacLike() ? '⌘' : t('Strg')} J`, icon: 'sparkles', rank: 9, run: () => window.dispatchEvent(new CustomEvent('pghl:agent', { detail: { prompt: term } })) });
    return out;
  }, [cmds, term, assistant, t]);
  const pick = (i: number) => list[i] && (close(), list[i].run());
  const keys = useListKeys(list.length, pick, close);
  // Tab stays in the palette, Esc closes it, and the focus goes back to where it was (the Springen button, the page).
  const box = useRef<HTMLDivElement>(null);
  useFocusLayer(box, close);
  return (
    <div className="modal-bg palette-bg" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={box} className="modal palette" role="dialog" aria-modal="true" aria-label={t('Springen zu')} data-tour="palette">
        <div className="palette-head">
          <SearchIcon size={17} className="ico" />
          <input
            autoFocus
            placeholder={t('Seite, Einstellung, Kontakt, Deal, Projekt – oder frag {name}…', { name: assistant })}
            aria-label={t('Springen zu')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={keys.onKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={list[keys.sel] ? `palette-opt-${keys.sel}` : undefined}
          />
          <button className="icon-btn" onClick={close} aria-label={t('Schließen')}>
            ✕
          </button>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" aria-label={t('Springen zu')}>
          {list.map((c, i) => {
            const pinned = !!c.fav && favs.some((f) => f.path === c.fav!.path);
            return (
              <div key={c.key} id={`palette-opt-${i}`} role="option" aria-selected={i === keys.sel} className={`palette-row${i === keys.sel ? ' sel' : ''}`} onMouseEnter={() => keys.setSel(i)} onClick={() => pick(i)}>
                {c.icon === 'status' ? <StatusDot status={c.status!} /> : <Icon name={c.icon} />}
                <span className="grow">{c.label}</span>
                <span className="muted small">{c.hint}</span>
                {c.fav && (
                  <button
                    type="button"
                    className={`icon-btn palette-fav${pinned ? ' on' : ''}`}
                    tabIndex={-1}
                    aria-pressed={pinned}
                    aria-label={pinned ? t('{name} aus den Favoriten nehmen', { name: c.label }) : t('{name} als Favorit anheften', { name: c.label })}
                    title={pinned ? t('Aus den Favoriten nehmen') : t('Als Favorit anheften')}
                    onClick={(e) => (e.stopPropagation(), toggleFav(session.user.id, c.fav!))}
                  >
                    {pinned ? '★' : '☆'}
                  </button>
                )}
              </div>
            );
          })}
          {!list.length && <div className="muted small" style={{ padding: 14 }}>{t('Nichts gefunden.')}</div>}
        </div>
        <div className="palette-foot muted small">{t('↑↓ auswählen · Enter öffnen · ☆ Favorit · Esc schließen')}</div>
      </div>
    </div>
  );
}

const isMacLike = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
