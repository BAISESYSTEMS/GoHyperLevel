import { useEffect, useRef, useState } from 'react';
import { api, dt } from '../api';
import { Badge, Check, CodeBox, Empty, Field, Input, Select, Spinner, Textarea, act, confirmAsk, toast, useLoad } from '../ui';
import { LegalNotice } from './ConsentKit';

/** Settings → Einwilligung & Recht → Cookie-Banner: the editor with a live preview, the script-blocking howto and the consent log. */

const CATS: [string, string][] = [['statistics', 'Statistik'], ['marketing', 'Marketing'], ['external_media', 'Externe Medien']];
const CHOICE: Record<string, string> = { accept_all: 'Alle akzeptiert', reject_all: 'Nur notwendige', custom: 'Eigene Auswahl' };

const SNIPPET = `<!-- Statistik: wird erst nach Zustimmung geladen -->
<script type="text/plain" data-category="statistics" src="https://stats.example.com/script.js"></script>

<!-- Marketing: Inline-Code geht genauso -->
<script type="text/plain" data-category="marketing">
  /* z. B. ein Werbe-Pixel */
</script>

<!-- Externe Medien: Einbettungen werden durch einen Platzhalter ersetzt -->
<iframe data-category="external_media" data-src="https://www.youtube-nocookie.com/embed/VIDEO_ID"></iframe>

<!-- Link zum erneuten Öffnen, z. B. im Footer -->
<a href="#cookie-settings">Cookie-Einstellungen</a>`;

function Preview({ settings }: { settings: any }) {
  const [doc, setDoc] = useState('');
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    const t = setTimeout(() => {
      api
        .text('POST', '/api/cmp/preview', { settings })
        .then((h) => mine === seq.current && setDoc(h))
        .catch(() => undefined);
    }, 350);
    return () => clearTimeout(t);
  }, [JSON.stringify(settings)]);
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }} data-tour="cmp-preview">
      <div className="muted small" style={{ padding: '8px 12px' }}>Vorschau (so sieht ein Besucher das Banner)</div>
      <iframe title="Vorschau Cookie-Banner" srcDoc={doc} sandbox="allow-scripts" style={{ width: '100%', height: 460, border: 0, background: '#f3f4f6' }} />
    </div>
  );
}

export function CmpEditor() {
  const { data, reload } = useLoad(() => api.get('/api/cmp/settings'), []);
  const log = useLoad(() => api.get('/api/cmp/log?limit=50'), []);
  const [s, setS] = useState<any>();
  useEffect(() => data && setS(data.settings), [data]);
  if (!s) return <Spinner />;
  const set = (patch: any) => setS({ ...s, ...patch });
  const cat = (k: string, patch: any) => set({ categories: { ...s.categories, [k]: { ...s.categories[k], ...patch } } });
  const color = (k: string, v: string) => set({ colors: { ...s.colors, [k]: v } });
  const save = async () => {
    const r = await act(() => api.put('/api/cmp/settings', s));
    if (r) {
      setS(r.settings);
      void reload();
      void log.reload();
      toast(r.settings.version !== data.settings.version ? 'Gespeichert – der Wortlaut hat sich geändert, alle Besucher werden neu gefragt' : 'Gespeichert');
    }
  };
  const reask = async () => {
    if (!confirmAsk('Alle Besucher beim nächsten Besuch erneut nach ihrer Auswahl fragen?')) return;
    const r = await act(() => api.post('/api/cmp/reask'), 'Alle werden neu gefragt');
    if (r) (setS(r.settings), void reload());
  };
  const stats = log.data?.last_30_days ?? {};
  return (
    <>
      <LegalNotice />
      <div className="card" data-tour="cmp-intro">
        <h2>Cookie-Banner (Einwilligungsverwaltung)</h2>
        <p className="muted">
          Eigene Einwilligungsverwaltung für Funnels, Websites, Buchungsseiten, Kunden- und Community-Portale – ohne Drittanbieter. Skripte mit <code>type="text/plain"</code> und <code>data-category</code> laufen erst nach Zustimmung; eingebettete Videos und Karten
          werden bis dahin durch einen Platzhalter ersetzt. Der Banner ersetzt den bisherigen Hinweis der Besucher-Statistik – es gibt immer nur einen.
        </p>
        <Check checked={s.enabled} onChange={(v) => set({ enabled: v })} label={<strong>Cookie-Banner auf allen öffentlichen Seiten anzeigen</strong>} tour="cmp-enabled" />
        <p className="muted small">Version {s.version} · Ändert sich der Wortlaut oder die Kategorien, entsteht eine neue Version und alle Besucher werden erneut gefragt.</p>
      </div>

      <div className="grid2" style={{ alignItems: 'start' }}>
        <div>
          <div className="card" data-tour="cmp-texts">
            <h3>Texte</h3>
            <Field label="Überschrift"><Input value={s.title} onChange={(v) => set({ title: v })} /></Field>
            <Field label="Text"><Textarea rows={5} value={s.text} onChange={(v) => set({ text: v })} /></Field>
            <div className="grid2">
              <Field label="Button „Alle akzeptieren“"><Input value={s.accept_all} onChange={(v) => set({ accept_all: v })} /></Field>
              <Field label="Button „Nur notwendige“" hint="Gleichwertig zum Akzeptieren-Button – ablehnen muss genauso einfach sein."><Input value={s.reject_all} onChange={(v) => set({ reject_all: v })} /></Field>
              <Field label="Button „Einstellungen“"><Input value={s.customize} onChange={(v) => set({ customize: v })} /></Field>
              <Field label="Button „Auswahl speichern“"><Input value={s.save} onChange={(v) => set({ save: v })} /></Field>
            </div>
            <div className="grid2">
              <Field label="Datenschutzerklärung (Adresse)" hint="Leer lassen, um den Link wegzulassen."><Input value={s.policy_url} onChange={(v) => set({ policy_url: v })} placeholder="https://… oder /datenschutz" /></Field>
              <Field label="Linktext"><Input value={s.policy_label} onChange={(v) => set({ policy_label: v })} /></Field>
              <Field label="Impressum (Adresse)"><Input value={s.imprint_url} onChange={(v) => set({ imprint_url: v })} placeholder="https://… oder /impressum" /></Field>
            </div>
          </div>

          <div className="card" data-tour="cmp-categories">
            <h3>Kategorien</h3>
            <p className="muted small">„Notwendig“ ist immer aktiv. Die anderen sind vorab aus und werden erst durch einen Klick des Besuchers eingeschaltet.</p>
            <Field label="Notwendig – Beschreibung"><Textarea rows={2} value={s.categories.necessary.description} onChange={(v) => cat('necessary', { description: v })} /></Field>
            {CATS.map(([k, l]) => (
              <div key={k} className="grid2">
                <Field label={`${l} – Name`}><Input value={s.categories[k].label} onChange={(v) => cat(k, { label: v })} /></Field>
                <Field label={`${l} – Beschreibung`}><Textarea rows={2} value={s.categories[k].description} onChange={(v) => cat(k, { description: v })} /></Field>
              </div>
            ))}
          </div>

          <div className="card" data-tour="cmp-look">
            <h3>Aussehen</h3>
            <div className="grid2">
              <Field label="Form"><Select value={s.layout} onChange={(v) => set({ layout: v })} options={[['box', 'Karte'], ['bar', 'Leiste unten'], ['center', 'Mitte (Dialog)']]} /></Field>
              <Field label="Position (bei Karte)"><Select value={s.position} onChange={(v) => set({ position: v })} options={[['left', 'Unten links'], ['right', 'Unten rechts'], ['middle', 'Unten mittig']]} /></Field>
            </div>
            <div className="grid2">
              {([['bg', 'Hintergrund'], ['text', 'Text'], ['accent', 'Akzent (Buttons)'], ['accent_text', 'Text auf Akzent']] as [string, string][]).map(([k, l]) => (
                <Field key={k} label={l}>
                  <span className="row" style={{ gap: 8 }}>
                    <input type="color" value={s.colors[k]} onChange={(e) => color(k, e.target.value)} aria-label={l} />
                    <Input value={s.colors[k]} onChange={(v) => color(k, v)} />
                  </span>
                </Field>
              ))}
            </div>
            <Check checked={s.reopen.enabled} onChange={(v) => set({ reopen: { ...s.reopen, enabled: v } })} label="Kleinen Knopf zum erneuten Öffnen einblenden (Widerruf muss jederzeit möglich sein)" />
            {s.reopen.enabled && <Field label="Beschriftung des Knopfs"><Input value={s.reopen.label} onChange={(v) => set({ reopen: { ...s.reopen, label: v } })} /></Field>}
          </div>

          <div className="card" data-tour="cmp-tech">
            <h3>Technik</h3>
            <Check checked={s.consent_mode} onChange={(v) => set({ consent_mode: v })} label="Google Consent Mode v2 – alles startet auf „denied“ und wird nach der Auswahl aktualisiert" />
            <Field label="Skripte ohne Kategorie" hint="Unbekannte Skripte von Dritten, die nicht mit data-category markiert sind.">
              <Select value={s.unknown_scripts} onChange={(v) => set({ unknown_scripts: v })} options={[['block', 'Blockieren, bis „Marketing“ erlaubt ist (empfohlen)'], ['allow', 'Nicht eingreifen (nur markierte Skripte werden gesteuert)']]} />
            </Field>
            <Field label="Auswahl gilt für … Tage"><Input type="number" value={s.expiry_days} onChange={(v) => set({ expiry_days: Number(v) })} /></Field>
          </div>

          <p className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={save} data-tour="cmp-save">Speichern</button>
            <button className="btn secondary" onClick={reask} data-tour="cmp-reask">Alle neu fragen</button>
          </p>
        </div>

        <div style={{ position: 'sticky', top: 12 }}>
          <Preview settings={s} />
          <div className="card" data-tour="cmp-howto">
            <h3>Eigene Skripte steuern</h3>
            <p className="muted small">Trage Skripte so in den Head-Code der Seite oder in HTML-Blöcke ein. Statistik- und Reichweiten-Cookies von HyperLevel selbst folgen automatisch der Auswahl.</p>
            <CodeBox text={SNIPPET} />
          </div>
        </div>
      </div>

      <div className="card" data-tour="cmp-log">
        <h3>Nachweis der Auswahlen</h3>
        <p className="muted small">Jede Entscheidung wird pseudonym mit Version, Auswahl, Seite und gekürzter IP protokolliert und 3 Jahre aufbewahrt.</p>
        <p className="row small" style={{ gap: 14 }}>
          {Object.keys(stats).length ? Object.entries(stats).map(([k, n]) => <span key={k}><Badge>{String(n)}</Badge> {CHOICE[k] ?? k}</span>) : <span className="muted">Letzte 30 Tage: noch keine Auswahlen</span>}
        </p>
        {!log.data?.rows?.length ? (
          <Empty>Noch keine Auswahlen protokolliert.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Wann</th><th>Auswahl</th><th>Statistik</th><th>Marketing</th><th>Medien</th><th>Seite</th><th>V</th></tr></thead>
              <tbody>
                {log.data.rows.map((r: any) => (
                  <tr key={r.id}>
                    <td className="small" style={{ whiteSpace: 'nowrap' }}>{dt(r.created_at)}</td>
                    <td>{CHOICE[r.choice] ?? r.choice}</td>
                    <td>{r.statistics ? 'ja' : 'nein'}</td>
                    <td>{r.marketing ? 'ja' : 'nein'}</td>
                    <td>{r.external_media ? 'ja' : 'nein'}</td>
                    <td className="small muted">{r.page}</td>
                    <td className="small">{r.version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
