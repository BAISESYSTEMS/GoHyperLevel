import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Icon, type IconName } from '../icons';
import { Check, Empty, Field, Input, Modal, Spinner, act, confirmAsk, navigate, toast, toastError, useLoad } from '../ui';
import { Mini } from './Mini';
import { ReviewList } from './TemplateSave';
import type { BoardFull, Catalogue, Starter, TemplateItem } from './types';

interface Listing {
  starters: Starter[];
  mine: TemplateItem[];
  marketplace: TemplateItem[];
  categories: { key: string; label: string }[];
  names: { marktplatz: string };
  can_publish: boolean;
}

/** A starter or a template, as one thing the gallery and the "new board" dialog can show. */
interface Pick {
  key: string;
  starter: boolean;
  name: string;
  description: string;
  icon: string;
  accent: string;
  widgets: number;
  preview: Starter['preview'];
  item?: TemplateItem;
}
const fromStarter = (s: Starter): Pick => ({ starter: true, ...s });
const fromTemplate = (t: TemplateItem): Pick => ({ key: t.id, starter: false, name: t.name, description: t.description, icon: t.icon, accent: t.accent, widgets: t.widgets, preview: t.preview, item: t });

const save = (name: string, data: unknown) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

function Tile({ p, catalogue, onOpen, selected, label }: { p: Pick; catalogue: Catalogue | null; onOpen: () => void; selected?: boolean; label?: string }) {
  return (
    <button type="button" className={`bd-tile${selected ? ' on' : ''}`} onClick={onOpen} aria-pressed={selected} data-key={p.key}>
      <Mini cells={p.preview} accent={p.accent} catalogue={catalogue} />
      <span className="bd-tile-text">
        <b>
          <Icon name={(p.icon || 'boards') as IconName} size={15} /> {p.name}
        </b>
        <span>{p.description}</span>
        <span className="bd-tile-meta">
          {p.widgets} Widgets
          {p.item && p.item.scope === 'marketplace' && !p.item.mine ? ` · von ${p.item.author} · ${p.item.installs}× installiert` : ''}
          {label ? ` · ${label}` : ''}
        </span>
      </span>
    </button>
  );
}

/** Install a template (or start from a starter): a foreign Marktplatz template first shows exactly what it reads and shows. */
export function useInstall() {
  return async (p: Pick, o: { name: string; scope: 'personal' | 'shared'; consent?: string[] }): Promise<BoardFull | undefined> => {
    if (p.starter) return act(() => api.post<BoardFull>('/api/boards', { name: o.name, scope: o.scope, template: p.key }), 'Board angelegt');
    return act(() => api.post<BoardFull>(`/api/board-templates/${p.key}/install`, { name: o.name, scope: o.scope, ...(o.consent ? { consent: o.consent } : {}) }), 'Board angelegt');
  };
}

/** "Neues Board": a name, where to start from, who sees it. */
export function NewBoard({ catalogue, onClose, initial }: { catalogue: Catalogue | null; onClose: () => void; initial?: string }) {
  const { data, error } = useLoad(() => api.get<Listing>('/api/board-templates'), []);
  const [key, setKey] = useState(initial ?? '');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'personal' | 'shared'>('personal');
  const [busy, setBusy] = useState(false);
  const install = useInstall();
  const blank: Pick = { key: '', starter: true, name: 'Leeres Board', description: 'Du fügst die Widgets selbst hinzu – oder sagst dem Board, was du sehen willst.', icon: 'boards', accent: '', widgets: 0, preview: [] };
  const picks = [blank, ...(data?.starters ?? []).map(fromStarter), ...(data?.mine ?? []).map(fromTemplate)];
  const cur = picks.find((p) => p.key === key) ?? blank;
  return (
    <Modal
      title="Neues Board"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const r = await install(cur, { name: name.trim() || cur.name, scope });
              setBusy(false);
              if (r) {
                onClose();
                navigate(`boards/${r.id}`);
              }
            }}
            data-tour="board-create"
          >
            Board anlegen
          </button>
        </>
      }
    >
      <div className="grid2">
        <Field label="Name">
          <Input value={name} onChange={setName} placeholder={cur.name} maxLength={80} autoFocus />
        </Field>
        <div className="field">
          <span>Wer sieht es?</span>
          <div className="chips" role="radiogroup" aria-label="Wer sieht es?">
            <button type="button" role="radio" aria-checked={scope === 'personal'} className={`chip${scope === 'personal' ? ' on' : ''}`} onClick={() => setScope('personal')}>
              Nur ich
            </button>
            <button type="button" role="radio" aria-checked={scope === 'shared'} className={`chip${scope === 'shared' ? ' on' : ''}`} onClick={() => setScope('shared')}>
              Das Team
            </button>
          </div>
        </div>
      </div>
      <h4 className="bd-h4">Womit starten?</h4>
      {error && <p className="bd-error">{error}</p>}
      {!data && !error && <Spinner />}
      <div className="bd-tiles">
        {picks.map((p) => (
          <Tile key={p.key || 'blank'} p={p} catalogue={catalogue} selected={p.key === key} onOpen={() => setKey(p.key)} label={p.item ? 'eigene Vorlage' : undefined} />
        ))}
      </div>
      <p className="muted small">Vorlagen aus dem Marktplatz findest du unter „Vorlagen“.</p>
    </Modal>
  );
}

/** One template in detail: what it contains, what it reads, and the buttons that fit the person's rights. */
function Detail({ p, catalogue, onClose, onChanged }: { p: Pick; catalogue: Catalogue | null; onClose: () => void; onChanged: () => void }) {
  const detail = useLoad(() => (p.starter ? Promise.resolve(null) : api.get<TemplateItem>(`/api/board-templates/${p.key}`)), [p.key]);
  const [name, setName] = useState(p.name);
  const [scope, setScope] = useState<'personal' | 'shared'>('personal');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const install = useInstall();
  const t = detail.data;
  const review = t?.review;
  const foreign = !!t && !t.mine;
  const needs = review?.needs ?? [];
  return (
    <Modal
      title={p.name}
      onClose={onClose}
      wide
      footer={
        <>
          {t?.can_manage && (
            <>
              <button
                className="btn ghost danger-text"
                onClick={async () => {
                  if (!confirmAsk(`Vorlage „${p.name}“ löschen?`)) return;
                  if (await act(() => api.del(`/api/board-templates/${p.key}`), 'Vorlage gelöscht')) {
                    onChanged();
                    onClose();
                  }
                }}
              >
                <Icon name="trash" size={14} /> Löschen
              </button>
              {t.scope === 'marketplace' && (
                <button
                  className="btn secondary"
                  onClick={async () => {
                    if (await act(() => api.post(`/api/board-templates/${p.key}/unpublish`, {}), 'Aus dem Marktplatz genommen')) {
                      onChanged();
                      onClose();
                    }
                  }}
                >
                  Aus dem Marktplatz nehmen
                </button>
              )}
            </>
          )}
          {!p.starter && (
            <button
              className="btn secondary"
              onClick={async () => {
                try {
                  save(`board-vorlage-${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'vorlage'}.json`, await api.get(`/api/board-templates/${p.key}/export`));
                } catch (e) {
                  toastError(e);
                }
              }}
            >
              <Icon name="download" size={14} /> Exportieren
            </button>
          )}
          <button
            className="btn"
            disabled={busy || (!p.starter && !t) || (foreign && needs.length > 0 && !agree) || review?.verdict === 'fail'}
            onClick={async () => {
              setBusy(true);
              const r = await install(p, { name: name.trim() || p.name, scope, ...(foreign ? { consent: needs.map((n) => n.key) } : {}) });
              setBusy(false);
              if (r) {
                onClose();
                navigate(`boards/${r.id}`);
              }
            }}
          >
            Board daraus anlegen
          </button>
        </>
      }
    >
      <div className="bd-detail">
        <Mini cells={p.preview} accent={p.accent} catalogue={catalogue} />
        <div>
          {p.description && <p>{p.description}</p>}
          {t && (
            <p className="muted small">
              {t.category_label} · Version {t.version} · von {t.author || 'unbekannt'}
              {t.scope === 'marketplace' ? ` · ${t.installs}× installiert` : ''}
            </p>
          )}
          {t?.items && (
            <ul className="bd-detail-items">
              {t.items.map((i, n) => (
                <li key={n}>{i.title}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="grid2">
        <Field label="Name des neuen Boards">
          <Input value={name} onChange={setName} maxLength={80} />
        </Field>
        <div className="field">
          <span>Wer sieht es?</span>
          <div className="chips" role="radiogroup" aria-label="Wer sieht es?">
            <button type="button" role="radio" aria-checked={scope === 'personal'} className={`chip${scope === 'personal' ? ' on' : ''}`} onClick={() => setScope('personal')}>
              Nur ich
            </button>
            <button type="button" role="radio" aria-checked={scope === 'shared'} className={`chip${scope === 'shared' ? ' on' : ''}`} onClick={() => setScope('shared')}>
              Das Team
            </button>
          </div>
        </div>
      </div>
      {detail.loading && !p.starter && <Spinner />}
      {review && (
        <>
          <h4 className="bd-h4">{foreign ? 'Das macht diese Vorlage' : 'Prüfung'}</h4>
          <ReviewList review={review} />
          {foreign && needs.length > 0 && (
            <div className="bd-consent">
              <ul>
                {needs.map((n) => (
                  <li key={n.key}>{n.label}</li>
                ))}
              </ul>
              <Check checked={agree} onChange={setAgree} label="Ich habe das gelesen und möchte die Vorlage installieren." />
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

/** The "Vorlagen" tab: starters, own templates and – for everyone in the installation – the Marktplatz. */
export function Gallery({ catalogue }: { catalogue: Catalogue | null }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [open, setOpen] = useState<Pick | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const { data, error, loading, reload } = useLoad(() => api.get<Listing>(`/api/board-templates?q=${encodeURIComponent(q)}${cat ? `&category=${cat}` : ''}`), [q, cat]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === '/' && !(e.target as HTMLElement)?.closest('input, textarea, select') && (e.preventDefault(), document.querySelector<HTMLInputElement>('.bd-gallery .bd-search input')?.focus());
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  const section = (title: string, list: Pick[], note?: string) =>
    list.length > 0 && (
      <section className="bd-section">
        <h3>{title}</h3>
        {note && <p className="muted small">{note}</p>}
        <div className="bd-tiles">
          {list.map((p) => (
            <Tile key={p.key} p={p} catalogue={catalogue} onOpen={() => setOpen(p)} />
          ))}
        </div>
      </section>
    );
  const none = data && !data.starters.length && !data.mine.length && !data.marketplace.length;
  return (
    <div className="bd-gallery" data-tour="board-templates">
      <div className="bd-picker-bar">
        <label className="bd-search">
          <Icon name="search" size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Vorlagen suchen" aria-label="Vorlagen suchen" />
        </label>
        <div className="chips" role="group" aria-label="Kategorie">
          <button type="button" className={`chip${cat === '' ? ' on' : ''}`} onClick={() => setCat('')}>
            Alle
          </button>
          {data?.categories.map((c) => (
            <button key={c.key} type="button" className={`chip${cat === c.key ? ' on' : ''}`} onClick={() => setCat(cat === c.key ? '' : c.key)}>
              {c.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn secondary small" onClick={() => file.current?.click()}>
          <Icon name="upload" size={14} /> Vorlage importieren
        </button>
        <input
          ref={file}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            try {
              const t = await api.post<TemplateItem & { integrity_ok?: boolean }>('/api/board-templates/import', { bundle: JSON.parse(await f.text()) });
              toast(t.integrity_ok === false ? `„${t.name}“ importiert – die Prüfsumme stimmt nicht, die Datei wurde verändert.` : `„${t.name}“ importiert`);
              reload();
            } catch (err) {
              toastError(err);
            }
          }}
        />
      </div>
      {error && <p className="bd-error">{error}</p>}
      {loading && !data && <Spinner />}
      {data && (
        <>
          {section('Zum Starten', data.starters.map(fromStarter))}
          {section('Meine Vorlagen', data.mine.map(fromTemplate), 'Nur in diesem Sub-Account sichtbar – oder im Marktplatz veröffentlicht.')}
          {section(`Aus dem ${data.names.marktplatz}`, data.marketplace.map(fromTemplate), 'Von anderen Sub-Accounts dieser Installation veröffentlicht. Vor dem Installieren siehst du, was eine Vorlage liest und zeigt.')}
          {none && <Empty>Keine Vorlage passt zu deiner Suche.</Empty>}
        </>
      )}
      {open && <Detail p={open} catalogue={catalogue} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}

/** The starters as one-click tiles (the empty list page): each makes a personal board and opens it. */
export function Starters({ catalogue }: { catalogue: Catalogue | null }) {
  const { data } = useLoad(() => api.get<Listing>('/api/board-templates'), []);
  const install = useInstall();
  const [busy, setBusy] = useState('');
  if (!data) return null;
  return (
    <div className="bd-tiles" data-tour="board-starters">
      {data.starters.map(fromStarter).map((p) => (
        <Tile
          key={p.key}
          p={p}
          catalogue={catalogue}
          selected={busy === p.key}
          onOpen={async () => {
            if (busy) return;
            setBusy(p.key);
            const r = await install(p, { name: p.name, scope: 'personal' });
            setBusy('');
            if (r) navigate(`boards/${r.id}`);
          }}
        />
      ))}
    </div>
  );
}
