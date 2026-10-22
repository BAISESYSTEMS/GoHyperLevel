import { useState } from 'react';
import { api, d } from '../api';
import { Badge, Check, Field, Modal, Select, Spinner, Textarea, act } from '../ui';
import { Sub, fileHref } from './CommunityParts';
import { readCsvFile } from '../csv-file';

/**
 * Community → Mitglieder → Importieren / Exportieren: move members in from a CSV list (also Skool's export) with a dry run first,
 * move posts in as Markdown files, and take members and posts out again. Server side: modules/community-import.ts.
 */

const FIELD_LABEL: Record<string, string> = { email: 'E-Mail', name: 'Name', first_name: 'Vorname', last_name: 'Nachname', joined: 'Mitglied seit', tier: 'Stufe', points: 'Punkte', tags: 'Tags', phone: 'Telefon' };
const STATE: Record<string, [string, 'green' | 'blue' | 'red' | 'gray']> = { new: ['Neu', 'green'], contact_exists: ['Kontakt bekannt', 'blue'], member_exists: ['Schon dabei', 'gray'], invalid: ['Ungültig', 'red'], duplicate: ['Doppelt', 'gray'] };

export function ImportModal({ group, onClose, onDone }: { group: any; onClose: () => void; onDone: () => void }) {
  const [tab, setTab] = useState('members');
  return (
    <Modal title="Importieren und Exportieren" onClose={onClose} wide>
      <div className="cma" data-tour="community-import">
        <Sub
          value={tab}
          onChange={setTab}
          tabs={[
            ['members', 'Mitglieder importieren'],
            ['posts', 'Beiträge importieren'],
            ['export', 'Exportieren'],
            ['skool', 'Umzug von Skool'],
          ]}
        />
        {tab === 'members' && <Members group={group} onDone={onDone} />}
        {tab === 'posts' && <Posts group={group} onDone={onDone} />}
        {tab === 'export' && <Export group={group} />}
        {tab === 'skool' && <SkoolGuide onStart={() => setTab('members')} />}
      </div>
    </Modal>
  );
}

function Members({ group, onDone }: { group: any; onDone: () => void }) {
  const [csv, setCsv] = useState('');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [tierMap, setTierMap] = useState<Record<string, string>>({});
  const [dateOrder, setDateOrder] = useState('auto');
  const [opt, setOpt] = useState({ send_mail: false, trigger_workflows: false, import_points: true, grant_tier_access: true, confirm_rights: false });
  const [plan, setPlan] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const body = () => ({ csv, mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)), tier_map: Object.fromEntries(Object.entries(tierMap).filter(([, v]) => v)), date_order: dateOrder });
  const check = async () => {
    setBusy(true);
    const p = await act(() => api.post<any>(`/api/community/groups/${group.id}/import/members/preview`, body()));
    setBusy(false);
    if (p) setPlan(p);
  };
  const go = async () => {
    setBusy(true);
    const r = await act(() => api.post<any>(`/api/community/groups/${group.id}/import/members`, { ...body(), ...opt }));
    setBusy(false);
    if (r) {
      setResult(r);
      onDone();
    }
  };
  if (result)
    return (
      <div className="cma-note info" role="status">
        <strong>Fertig.</strong> {result.created} neu angelegt, {result.updated} bekannte Kontakte aufgenommen, {result.skipped} übersprungen
        {result.points ? `, ${result.points} Startpunkte vergeben` : ''}
        {result.mails ? `, ${result.mails} E-Mails gesendet` : ''}. Die Personen können sich ab sofort mit ihrer E-Mail-Adresse anmelden.
      </div>
    );
  const onFile = async (el: HTMLInputElement) => {
    const f = el.files?.[0];
    if (f) (setCsv(await readCsvFile(f)), setPlan(null));
  };
  const headers: string[] = plan?.header ?? [];
  return (
    <>
      <div className="cma-drop">
        <p style={{ marginTop: 0 }}>
          <strong>CSV-Datei mit deinen Mitgliedern</strong>
          <br />
          <span className="muted small">Spalten wie Name oder Vorname/Nachname, E-Mail, Mitglied seit, Stufe – die Namen erkennen wir selbst (auch englische, auch Skool-Export).</span>
        </p>
        <input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => onFile(e.target)} aria-label="CSV-Datei wählen" />
      </div>
      <Field label="… oder hier einfügen">
        <Textarea rows={4} value={csv} onChange={(v) => (setCsv(v), setPlan(null))} placeholder={'Name,Email,Joined\nAnna Muster,anna@example.de,2023-03-14'} />
      </Field>
      <div className="cma-actions" style={{ marginTop: 0 }}>
        <button className="btn" disabled={!csv.trim() || busy} onClick={check}>
          {busy ? 'Prüfe …' : 'Prüfen (nichts wird gespeichert)'}
        </button>
        {plan && (
          <div style={{ width: 230 }}>
            <Select value={dateOrder} onChange={(v) => (setDateOrder(v), setPlan(null))} options={[['auto', 'Datum: automatisch erkennen'], ['dmy', 'Datum: Tag/Monat/Jahr'], ['mdy', 'Datum: Monat/Tag/Jahr']]} />
          </div>
        )}
      </div>
      {plan && (
        <>
          {plan.warnings.map((w: string) => (
            <div key={w} className="cma-note">
              {w}
            </div>
          ))}
          <div className="cma-chips">
            <Badge tone="green">{plan.counts.new} neu</Badge>
            <Badge tone="blue">{plan.counts.contact_exists} Kontakte bekannt</Badge>
            <Badge>{plan.counts.member_exists} schon dabei</Badge>
            <Badge tone={plan.counts.invalid ? 'red' : 'gray'}>{plan.counts.invalid} ungültig</Badge>
            <Badge>{plan.counts.duplicate} doppelt</Badge>
          </div>
          <h4 style={{ margin: '4px 0 0' }}>Zuordnung der Spalten</h4>
          <div className="cma-two">
            {['email', 'name', 'first_name', 'last_name', 'joined', 'tier', 'points'].map((f) => (
              <Field key={f} label={FIELD_LABEL[f]}>
                <Select
                  value={mapping[f] ?? plan.columns[f] ?? ''}
                  onChange={(v) => {
                    setMapping({ ...mapping, [f]: v });
                    setPlan(null);
                  }}
                  placeholder="nicht vorhanden"
                  options={headers.map((h) => [h, h])}
                />
              </Field>
            ))}
          </div>
          {plan.unmatched_tiers.length > 0 && plan.tiers.length > 0 && (
            <>
              <h4 style={{ margin: '4px 0 0' }}>Stufen zuordnen</h4>
              <p className="muted small" style={{ margin: 0 }}>
                Diese Namen aus der Datei gibt es bei dir nicht als Stufe. Wähle, in welche Stufe sie kommen – sonst landen sie in der ersten kostenlosen Stufe.
              </p>
              <div className="cma-two">
                {plan.unmatched_tiers.map((n: string) => (
                  <Field key={n} label={`„${n}“ →`}>
                    <Select value={tierMap[n] ?? ''} onChange={(v) => (setTierMap({ ...tierMap, [n]: v }), setPlan(null))} placeholder="Standard-Stufe" options={plan.tiers.map((t: any) => [t.id, t.name])} />
                  </Field>
                ))}
              </div>
            </>
          )}
          <div className="table-wrap" style={{ maxHeight: 280, overflow: 'auto' }}>
            <table className="t cma-table">
              <thead>
                <tr>
                  <th>Zeile</th>
                  <th>Name</th>
                  <th>E-Mail</th>
                  <th>Seit</th>
                  <th>Stufe</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {plan.items.slice(0, 60).map((i: any) => (
                  <tr key={i.line}>
                    <td>{i.line}</td>
                    <td>{i.name || '–'}</td>
                    <td>{i.email}</td>
                    <td>{i.joined_at ? d(i.joined_at) : '–'}</td>
                    <td>{plan.tiers.find((t: any) => t.id === i.tier_id)?.name ?? '–'}</td>
                    <td>
                      <Badge tone={STATE[i.state][1]}>{STATE[i.state][0]}</Badge>
                      {i.reason && <div className="muted small">{i.reason}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.truncated || plan.items.length > 60 ? <p className="muted small">Gezeigt werden die ersten 60 von {plan.counts.total} Zeilen – Probleme stehen zuerst.</p> : null}
          <h4 style={{ margin: '4px 0 0' }}>Optionen</h4>
          <Check checked={opt.import_points} onChange={(v) => setOpt({ ...opt, import_points: v })} label="Punkte aus der Datei als Startguthaben übernehmen" />
          <Check checked={opt.grant_tier_access} onChange={(v) => setOpt({ ...opt, grant_tier_access: v })} label="Kurse der Stufe freischalten" />
          <Check checked={opt.send_mail} onChange={(v) => setOpt({ ...opt, send_mail: v })} label="Jedem eine E-Mail mit dem Link zur Community senden" />
          <Check checked={opt.trigger_workflows} onChange={(v) => setOpt({ ...opt, trigger_workflows: v })} label="Workflows für neue Kontakte starten (sonst bleibt der Import still)" />
          <Check checked={opt.confirm_rights} onChange={(v) => setOpt({ ...opt, confirm_rights: v })} label="Ich darf diese Personen kontaktieren und speichern (z. B. weil sie meiner Community selbst beigetreten sind)." />
          <div className="cma-actions">
            <button className="btn" disabled={!opt.confirm_rights || busy || (plan.counts.new + plan.counts.contact_exists === 0)} onClick={go}>
              {busy ? 'Importiere …' : `${plan.counts.new + plan.counts.contact_exists} Personen importieren`}
            </button>
          </div>
        </>
      )}
      {busy && !plan && <Spinner />}
    </>
  );
}

function Posts({ group, onDone }: { group: any; onDone: () => void }) {
  const [files, setFiles] = useState<{ name: string; content: string }[]>([]);
  const [channel, setChannel] = useState('');
  const [keep, setKeep] = useState(true);
  const [plan, setPlan] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const body = () => ({ files, channel_id: channel || undefined, keep_dates: keep });
  const onFiles = async (el: HTMLInputElement) => {
    const list = Array.from(el.files ?? []).slice(0, 500);
    setFiles(await Promise.all(list.map(async (f) => ({ name: f.name, content: await f.text() }))));
    setPlan(null);
  };
  if (result) return <div className="cma-note info">Fertig: {result.created} Beiträge übernommen, {result.skipped} übersprungen (doppelt oder mit Problem).</div>;
  return (
    <>
      <p className="muted" style={{ margin: 0 }}>
        Jede Markdown-Datei (.md) wird ein Beitrag. Titel und Datum stehen oben zwischen zwei <code>---</code>-Zeilen: <code>title</code>, <code>date</code> (2024-05-01), <code>author</code> (E-Mail eines Mitglieds), <code>channel</code>, <code>pinned</code>. Ohne Titel gilt die erste Überschrift. Beiträge erscheinen mit dem alten Datum, ohne Benachrichtigung und ohne Punkte.
      </p>
      <div className="cma-drop">
        <input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" multiple onChange={(e) => onFiles(e.target)} aria-label="Markdown-Dateien wählen" />
        <p className="muted small" style={{ marginBottom: 0 }}>
          {files.length ? `${files.length} Dateien gewählt` : 'Bis zu 500 Dateien, je höchstens 120 KB'}
        </p>
      </div>
      <div className="cma-two">
        <Field label="Standard-Kanal">
          <Select value={channel} onChange={(v) => (setChannel(v), setPlan(null))} placeholder="Erster freier Kanal" options={(group.channels ?? []).map((c: any) => [c.id, c.name])} />
        </Field>
        <Check checked={keep} onChange={(v) => (setKeep(v), setPlan(null))} label="Datum aus der Datei übernehmen" />
      </div>
      <div className="cma-actions" style={{ marginTop: 0 }}>
        <button className="btn" disabled={!files.length} onClick={async () => setPlan(await act(() => api.post<any>(`/api/community/groups/${group.id}/import/posts/preview`, body())))}>
          Prüfen (nichts wird gespeichert)
        </button>
      </div>
      {plan && (
        <>
          <div className="table-wrap" style={{ maxHeight: 280, overflow: 'auto' }}>
            <table className="t cma-table">
              <thead>
                <tr>
                  <th>Datei</th>
                  <th>Titel</th>
                  <th>Kanal</th>
                  <th>Datum</th>
                  <th>Hinweis</th>
                </tr>
              </thead>
              <tbody>
                {plan.items.map((i: any) => (
                  <tr key={i.file}>
                    <td>{i.file}</td>
                    <td>{i.title || '–'}</td>
                    <td>{i.channel_name}</td>
                    <td>{d(i.created_at)}</td>
                    <td>{i.problem ? <Badge tone="red">{i.problem}</Badge> : i.warnings.map((w: string) => <div key={w} className="muted small">{w}</div>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="cma-actions">
            <button
              className="btn"
              disabled={!plan.ok}
              onClick={async () => {
                const r = await act(() => api.post<any>(`/api/community/groups/${group.id}/import/posts`, body()));
                if (r) (setResult(r), onDone());
              }}
            >
              {plan.ok} Beiträge übernehmen
            </button>
          </div>
        </>
      )}
    </>
  );
}

function Export({ group }: { group: any }) {
  return (
    <div className="cma-grid">
      <section className="cma-sec">
        <h3>Mitglieder</h3>
        <p className="lead">CSV mit Vorname, Nachname, E-Mail, Beitrittsdatum, Stufe, Level, Punkten und Status – zum Sichern oder für einen Umzug.</p>
        <a className="btn" href={fileHref(`/api/community/groups/${group.id}/export/members.csv`)}>
          Mitglieder als CSV laden
        </a>
      </section>
      <section className="cma-sec">
        <h3>Beiträge</h3>
        <p className="lead">JSON mit allen Beiträgen samt Kommentaren, Autor, Kanal und Datum.</p>
        <a className="btn" href={fileHref(`/api/community/groups/${group.id}/export/posts.json`)}>
          Beiträge als JSON laden
        </a>
      </section>
    </div>
  );
}

function SkoolGuide({ onStart }: { onStart: () => void }) {
  return (
    <div className="prose">
      <p style={{ marginTop: 0 }}>
        Skool hat keine öffentliche Schnittstelle (API). Der einzige Weg ist die Export-Funktion von Skool für die Mitgliederliste – so geht der Umzug:
      </p>
      <ol>
        <li>
          In Skool als Gruppen-Admin: <strong>Einstellungen → Mitglieder</strong> (Admin-Bereich) und dort die Mitgliederliste als <strong>CSV exportieren</strong>. Skool schickt dir die Datei per E-Mail oder lädt sie herunter.
        </li>
        <li>
          Hier unter <strong>Mitglieder importieren</strong> die Datei wählen. Namen, E-Mail-Adressen und das Beitrittsdatum werden erkannt; mit <strong>Prüfen</strong> siehst du vorher genau, was passiert.
        </li>
        <li>Ordne die Skool-Stufen deinen Stufen zu und entscheide, ob die Mitglieder eine E-Mail mit dem Link bekommen.</li>
        <li>
          Beiträge, die du behalten willst, kopierst du als Markdown-Dateien (eine pro Beitrag, mit <code>title</code> und <code>date</code> oben) und importierst sie unter <strong>Beiträge importieren</strong>.
        </li>
        <li>Zahlende Mitglieder legen ihr Abo bei dir neu an – dafür schickst du ihnen den Einladungs-Link der Beitrittsseite. Zahlungsdaten lassen sich nicht aus Skool mitnehmen.</li>
      </ol>
      <p className="muted small">Die genaue Beschriftung in Skool ändert sich gelegentlich – die Schritte stehen mit Screenshots-Tipps auch in docs/community.md.</p>
      <button className="btn" onClick={onStart}>
        Zum Import
      </button>
    </div>
  );
}
