import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Badge, Modal, Spinner, act } from '../ui';
import { SignupLink } from '../referrals';
import { FILTERS, PINNED, SUB_PRESETS, filterPresets } from './ai-gallery-filter';
import './AiGallery.css';

/**
 * The provider gallery of Einstellungen → KI-Anbieter: search, filters (EU-Hosting, günstig, schnell, lokal, Abo-Anmeldung) and the
 * kind of provider, a card per preset with "Konto anlegen ↗" (the partner-link mechanism of modules/referrals.ts), an "EU-Hosting"
 * badge where the provider's own documentation says where data is processed, and the live model list with prices per million tokens.
 */

const KINDS: [string, string][] = [
  ['', 'Alle'],
  ['text', 'Text-Modelle'],
  ['local', 'Lokal & Proxy'],
  ['media', 'Bild, Video & Audio'],
  ['voice', 'Sprache'],
  ['custom', 'Eigene'],
];
const usd = (v?: number) => (v === undefined || v === null ? '–' : `$${v.toLocaleString('de-DE', { minimumFractionDigits: v < 1 ? 2 : 2, maximumFractionDigits: 4 })}`);
const tokens = (n?: number) => (n ? (n >= 1_000_000 ? `${(n / 1_000_000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Mio.` : `${Math.round(n / 1000).toLocaleString('de-DE')} Tsd.`) : '–');

export function Gallery({ presets, capLabels, onPick, onSubscription }: { presets: any[]; capLabels: Record<string, string>; onPick: (p: any) => void; onSubscription: (kind: 'chatgpt' | 'claude') => void }) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const shown = useMemo(() => filterPresets(presets, { q, kind, tags }), [presets, q, kind, tags]);
  const toggle = (t: string) => setTags((x) => (x.includes(t) ? x.filter((y) => y !== t) : [...x, t]));
  const subCards = (!kind || kind === 'text') && tags.every((t) => t === 'sub') && !q.trim();
  return (
    <>
      <div className="aig-toolbar" data-tour="aig-filters">
        <input type="search" className="aig-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Anbieter suchen …" aria-label="Anbieter suchen" />
      </div>
      <div className="aig-chips" role="group" aria-label="Filter">
        <span className="lbl">Filter</span>
        {FILTERS.map(([k, l]) => (
          <button key={k} type="button" className={`aig-chip${k === 'eu' ? ' eu' : ''}`} aria-pressed={tags.includes(k)} onClick={() => toggle(k)} data-tour={k === 'eu' ? 'aig-eu' : undefined}>
            {l}
          </button>
        ))}
      </div>
      <div className="aig-chips" role="group" aria-label="Art des Anbieters">
        <span className="lbl">Art</span>
        {KINDS.map(([k, l]) => (
          <button key={k} type="button" className="aig-chip" aria-pressed={kind === k} onClick={() => setKind(k)}>
            {l}
          </button>
        ))}
      </div>
      <div className="aig-count" aria-live="polite">
        {shown.length} von {presets.length} Anbietern
      </div>
      <div className="aig-grid" data-tour="aic-presets">
        {subCards && (
          <>
            <div className="aig-card pinned">
              <button type="button" className="aig-main" onClick={() => onSubscription('chatgpt')}>
                <span className="aig-name">
                  Mit ChatGPT anmelden
                  <span className="aig-badges">
                    <span className="aig-badge sub">Abo-Anmeldung</span>
                  </span>
                </span>
                <span className="aig-meta">Dein ChatGPT-Plan statt API-Schlüssel – persönlich, für deinen Agenten, Assistenten und die Werkstatt.</span>
              </button>
            </div>
            <div className="aig-card pinned">
              <button type="button" className="aig-main" onClick={() => onSubscription('claude')}>
                <span className="aig-name">
                  Mit Claude verbinden
                  <span className="aig-badges">
                    <span className="aig-badge sub">Abo-Anmeldung</span>
                  </span>
                </span>
                <span className="aig-meta">Claude Code auf deinem Rechner mit deinem Pro- oder Max-Abo (Bridge).</span>
              </button>
            </div>
          </>
        )}
        {shown.map((p) => (
          <div key={p.id} className={`aig-card${PINNED.includes(p.id) ? ' pinned' : ''}`}>
            <button type="button" className="aig-main" onClick={() => onPick(p)}>
              <span className="aig-name">
                {p.label}
                <span className="aig-badges">
                  {PINNED.includes(p.id) && <span className="aig-badge pin">Empfohlen</span>}
                  {p.eu && (
                    <span className="aig-badge eu" title={`${p.eu.note} Quelle: ${p.eu.source}`} data-tour="aig-eu-badge">
                      EU-Hosting · {p.eu.region}
                    </span>
                  )}
                  {SUB_PRESETS.has(p.id) && <span className="aig-badge sub">Abo möglich</span>}
                  {p.local && <span className="aig-badge">lokal</span>}
                  {(p.tags ?? []).includes('cheap') && <span className="aig-badge">günstig</span>}
                  {(p.tags ?? []).includes('fast') && <span className="aig-badge">schnell</span>}
                  {(p.tags ?? []).includes('gateway') && <span className="aig-badge">Gateway</span>}
                  {(p.realtime?.audio_tts || p.realtime?.stt) && <span className="aig-badge">Live</span>}
                </span>
              </span>
              <span className="aic-caps">
                {p.capabilities.map((c: string) => (
                  <span key={c} className="aic-cap">
                    {capLabels[c] ?? c}
                  </span>
                ))}
              </span>
              <span className="aig-meta">
                {p.group === 'text' || p.group === 'local' ? `Richtwert ≈ ${usd(p.price.input)} / ${usd(p.price.output)} je 1 Mio. Tokens · ` : ''}
                {p.key_required ? p.key_hint : 'Schlüssel optional'}
              </span>
            </button>
            <div className="aig-foot">
              <SignupLink id={p.referral || p.id} />
              {p.docs && (
                <a href={p.docs} target="_blank" rel="noopener noreferrer">
                  Doku ↗
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
      {!shown.length && !subCards && <div className="aig-empty">Kein Anbieter passt zu dieser Suche. Jede OpenAI-kompatible Adresse geht auch mit „Benutzerdefiniert“.</div>}
    </>
  );
}

/** Live model list of a connection with context size and prices per million tokens (where the provider's list has them). */
export function ModelsModal({ conn, preset, onClose, onChanged }: { conn: any; preset: any; onClose: () => void; onChanged: () => void }) {
  const [q, setQ] = useState('');
  const [r, setR] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const load = async (refresh = false, text = q) => {
    setLoading(true);
    try {
      setR(await api.get(`/api/ai-connections/${conn.id}/models?${refresh ? 'refresh=1&' : ''}q=${encodeURIComponent(text)}`));
    } catch (e) {
      setR({ models: [], details: [], total: 0, live: false, error: (e as Error).message });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    const t = setTimeout(() => void load(false, q), q ? 300 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const rows: any[] = r ? (r.details?.length ? r.details : (r.models ?? []).map((id: string) => ({ id }))) : [];
  const priced = rows.some((m) => m.in !== undefined);
  const current = conn.models?.text;
  const use = async (id: string) => {
    if (await act(() => api.patch(`/api/ai-connections/${conn.id}`, { models: { ...conn.models, text: id } }), `„${id}“ ist jetzt das Standard-Modell`)) onChanged();
  };
  return (
    <Modal title={`Modelle von ${conn.label || preset?.label || conn.provider}`} onClose={onClose} wide>
      <div className="aim-bar">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Modell suchen …" aria-label="Modell suchen" />
        <button className="btn secondary aisub-btn" onClick={() => void load(true)} disabled={loading}>
          {loading ? 'Lade …' : 'Neu laden'}
        </button>
      </div>
      {r?.error && <p className="aisub-err">Liste nicht verfügbar: {r.error}</p>}
      {r && !r.live && !r.error && <p className="aisub-note">Dieser Anbieter hat keine Modell-Liste per Schnittstelle – hier stehen Vorschläge. Jede Modell-ID kannst du im Verbindungsformular selbst eintippen.</p>}
      {r?.live && !priced && <p className="aisub-note">Dieser Anbieter nennt in seiner Liste keine Preise. Eigene Preise (für die Kostenschätzung) trägst du im Formular unter „Erweitert“ ein.</p>}
      {!r ? (
        <Spinner />
      ) : (
        <>
          <div className="aim-wrap">
            <table className="aim-table">
              <thead>
                <tr>
                  <th>Modell</th>
                  <th className="num">Kontext</th>
                  <th className="num">Eingabe je 1 Mio.</th>
                  <th className="num">Ausgabe je 1 Mio.</th>
                  <th>Merkmale</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id}>
                    <td className="id aim-id">
                      {m.id}
                      {m.name && m.name !== m.id && <div className="aisub-note">{m.name}</div>}
                    </td>
                    <td className="num">{tokens(m.context)}</td>
                    <td className="num">{m.free ? 'kostenlos' : usd(m.in)}</td>
                    <td className="num">{m.free ? 'kostenlos' : usd(m.out)}</td>
                    <td>
                      {m.vision && <Badge tone="blue">Bilder</Badge>} {m.tools && <Badge tone="green">Werkzeuge</Badge>}
                    </td>
                    <td className="num">
                      {conn.editable && (m.id === current ? <Badge tone="green">Standard</Badge> : <button className="btn secondary aisub-btn" onClick={() => void use(m.id)}>Als Standard</button>)}
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={6} className="muted">
                      Keine Treffer.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="aisub-note" style={{ marginTop: 8 }}>
            {r.total > rows.length ? `${rows.length} von ${r.total} Modellen – oben suchen, um die Liste einzugrenzen. ` : `${rows.length} Modelle. `}
            Preise in US-Dollar je eine Million Tokens, wie der Anbieter sie nennt; die Kostenschätzung in HyperLevel nutzt sie, solange du keine eigenen einträgst.
          </p>
        </>
      )}
    </Modal>
  );
}

