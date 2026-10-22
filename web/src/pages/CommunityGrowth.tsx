import { useState } from 'react';
import { api, dt } from '../api';
import { Badge, Check, Empty, Field, Input, Link, Select, Spinner, Textarea, act, confirmAsk, useLoad } from '../ui';
import { MarkdownEditor } from './ContentKit';
import { CopyField, NumberField, Sec, Sub, fromLocalInput, run } from './CommunityParts';

/**
 * Community → Wachstum: the welcome of new members (message, post, onboarding checklist, "Start here"), broadcasts to a segment
 * by e-mail, push and bell, and the partner program for members. Server side: modules/community-growth.ts.
 */

export function GrowthTab({ group, onChange }: { group: any; onChange: () => void }) {
  const [sub, setSub] = useState('welcome');
  return (
    <div className="cma" data-tour="community-growth">
      <Sub
        value={sub}
        onChange={setSub}
        tabs={[
          ['welcome', 'Willkommen'],
          ['broadcast', 'Rundschreiben'],
          ['partner', 'Partner-Programm'],
        ]}
      />
      {sub === 'welcome' && <Welcome group={group} />}
      {sub === 'broadcast' && <Broadcast group={group} />}
      {sub === 'partner' && <Partner group={group} onChange={onChange} />}
    </div>
  );
}

const KINDS: [string, string][] = [
  ['profile', 'Profil ausfüllen (Foto oder Text)'],
  ['intro', 'Sich vorstellen (Beitrag)'],
  ['post', 'Einen Beitrag schreiben'],
  ['comment', 'Einen Beitrag kommentieren'],
  ['like', 'Ein „Gefällt mir“ geben'],
  ['challenge', 'An einer Challenge teilnehmen'],
  ['start_here', '„Hier starten“-Beitrag lesen'],
  ['custom', 'Eigener Punkt (Mitglied hakt ab)'],
];

function Welcome({ group }: { group: any }) {
  const ext = useLoad(() => api.get<any>(`/api/community/groups/${group.id}/ext`), [group.id]);
  const posts = useLoad(() => api.get<any[]>(`/api/community/groups/${group.id}/posts?limit=100`), [group.id]);
  const [f, setF] = useState<any>(null);
  if (ext.data && !f) setF({ welcome: structuredClone(ext.data.welcome), start_here: { ...ext.data.start_here } });
  if (!f) return <Spinner />;
  const w = f.welcome;
  const setW = (path: 'dm' | 'post' | 'checklist', patch: any) => setF({ ...f, welcome: { ...w, [path]: { ...w[path], ...patch } } });
  const save = () => run(() => api.put(`/api/community/groups/${group.id}/ext`, f), 'Gespeichert');
  const items: any[] = w.checklist.items;
  const setItems = (next: any[]) => setW('checklist', { items: next });
  return (
    <div className="cma-grid">
      <Sec title="Willkommens-Nachricht" lead="Jedes neue Mitglied bekommt sofort eine private Nachricht im Postfach der Community (mit Hinweis und – wenn erlaubt – Push). Antworten landen bei dir unter „Nachrichten“.">
        <Check checked={w.dm.enabled} onChange={(v) => setW('dm', { enabled: v })} label="Neue Mitglieder per Nachricht begrüßen" />
        <Field label="Absender" hint="Zum Beispiel dein Vorname. Leer = „Team“.">
          <Input value={w.dm.sender} maxLength={60} onChange={(v) => setW('dm', { sender: v })} placeholder="Team" />
        </Field>
        <Field label="Text" hint="Platzhalter: {{name}}, {{first_name}}, {{group}}">
          <Textarea rows={5} value={w.dm.text} onChange={(v) => setW('dm', { text: v })} />
        </Field>
        <div className="cma-actions">
          <button className="btn" onClick={save}>
            Speichern
          </button>
        </div>
      </Sec>
      <Sec title="Willkommens-Beitrag" lead="Ein Beitrag im Namen des Teams, der das neue Mitglied erwähnt – so bekommt es die ersten Antworten der Gruppe.">
        <Check checked={w.post.enabled} onChange={(v) => setW('post', { enabled: v })} label="Für jedes neue Mitglied einen Beitrag schreiben" />
        <Field label="Kanal">
          <Select value={w.post.channel_id} onChange={(v) => setW('post', { channel_id: v })} placeholder="Erster freier Kanal" options={(group.channels ?? []).filter((c: any) => !c.admin_only).map((c: any) => [c.id, c.name])} />
        </Field>
        <Field label="Titel">
          <Input value={w.post.title} onChange={(v) => setW('post', { title: v })} />
        </Field>
        <Field label="Text" hint="Platzhalter: {{name}}, {{mention}} (erwähnt das Mitglied), {{group}}">
          <Textarea rows={4} value={w.post.body} onChange={(v) => setW('post', { body: v })} />
        </Field>
        <div className="cma-actions">
          <button className="btn" onClick={save}>
            Speichern
          </button>
        </div>
      </Sec>
      <Sec title="„Hier starten“" lead="Ein Beitrag, den jedes Mitglied oben im Feed sieht, bis es ihn gelesen hat. Heft ihn am besten auch an.">
        <Field label="Beitrag">
          <Select value={f.start_here.post_id} onChange={(v) => setF({ ...f, start_here: { ...f.start_here, post_id: v } })} placeholder="Keiner" options={(posts.data ?? []).map((p: any) => [p.id, `${p.pinned ? '📌 ' : ''}${p.title || p.body.slice(0, 40)}`])} />
        </Field>
        <Field label="Überschrift der Karte">
          <Input value={f.start_here.label} maxLength={40} onChange={(v) => setF({ ...f, start_here: { ...f.start_here, label: v } })} />
        </Field>
        <div className="cma-actions">
          <button className="btn" onClick={save}>
            Speichern
          </button>
        </div>
      </Sec>
      <Sec title="Checkliste für den Start" lead="„So startest du“ im Feed: Die Punkte haken sich von selbst ab, sobald das Mitglied sie erledigt hat.">
        <Check checked={w.checklist.enabled} onChange={(v) => setW('checklist', { enabled: v })} label="Checkliste neuen Mitgliedern zeigen" />
        <NumberField label="Zeigen für … Tage nach dem Beitritt" min={1} max={365} value={w.checklist.days} onChange={(v) => setW('checklist', { days: v ?? 30 })} />
        <ul className="cma-list">
          {items.map((it, i) => (
            <li key={it.id ?? i}>
              <div className="grow">
                <Input value={it.label} maxLength={120} onChange={(v) => setItems(items.map((x, n) => (n === i ? { ...x, label: v } : x)))} aria-label={`Punkt ${i + 1}`} />
                <div style={{ marginTop: 6 }}>
                  <Select value={it.kind} onChange={(v) => setItems(items.map((x, n) => (n === i ? { ...x, kind: v } : x)))} options={KINDS} />
                </div>
              </div>
              <button className="btn small ghost" aria-label={`Punkt ${i + 1} entfernen`} onClick={() => setItems(items.filter((_, n) => n !== i))}>
                ✕
              </button>
            </li>
          ))}
        </ul>
        {items.length < 8 && (
          <button className="btn secondary" onClick={() => setItems([...items, { id: `punkt${items.length + 1}${Math.random().toString(36).slice(2, 5)}`, label: '', kind: 'custom' }])}>
            + Punkt hinzufügen
          </button>
        )}
        <div className="cma-actions">
          <button className="btn" onClick={save}>
            Speichern
          </button>
        </div>
      </Sec>
    </div>
  );
}

function Broadcast({ group }: { group: any }) {
  const tiers = useLoad(() => api.get<any>(`/api/community/groups/${group.id}/join`), [group.id]);
  const hist = useLoad(() => api.get<any>(`/api/community/groups/${group.id}/broadcasts`), [group.id]);
  const blank = { subject: '', body: '', channels: ['email', 'bell'] as string[], tier_ids: [] as string[], min_level: '', active_days: '', inactive_days: '', scheduled_at: '' };
  const [f, setF] = useState<any>(blank);
  const [count, setCount] = useState<any>(null);
  const segment = () => ({
    ...(f.tier_ids.length ? { tier_ids: f.tier_ids } : {}),
    ...(f.min_level ? { min_level: Number(f.min_level) } : {}),
    ...(f.active_days ? { active_days: Number(f.active_days) } : {}),
    ...(f.inactive_days ? { inactive_days: Number(f.inactive_days) } : {}),
  });
  const has = (c: string) => f.channels.includes(c);
  const toggle = (c: string) => setF({ ...f, channels: has(c) ? f.channels.filter((x: string) => x !== c) : [...f.channels, c] });
  const preview = async () => setCount(await act(() => api.post(`/api/community/groups/${group.id}/broadcasts/preview`, { segment: segment() })));
  const send = async () => {
    const n = (await api.post<any>(`/api/community/groups/${group.id}/broadcasts/preview`, { segment: segment() }).catch(() => null)) ?? null;
    if (!(await confirmAsk(`Rundschreiben${f.scheduled_at ? ' einplanen' : ' jetzt senden'}?${n ? ` Es erreicht ${n.members} Mitglieder${has('email') ? ` (${n.email} per E-Mail)` : ''}.` : ''}`))) return;
    await run(() => api.post(`/api/community/groups/${group.id}/broadcasts`, { subject: f.subject, body: f.body, channels: f.channels, segment: segment(), scheduled_at: f.scheduled_at ? fromLocalInput(f.scheduled_at) : undefined }), f.scheduled_at ? 'Eingeplant' : 'Gesendet', () => (setF(blank), setCount(null), void hist.reload()));
  };
  return (
    <div className="cma-grid">
      <Sec title="Neues Rundschreiben" lead="Eine Nachricht an alle oder an einen Teil der Mitglieder: per E-Mail (über deine Kampagnen), als Push aufs Handy und als Eintrag in der Glocke.">
        <Field label="Betreff">
          <Input value={f.subject} maxLength={140} onChange={(v) => setF({ ...f, subject: v })} placeholder="z. B. Neuer Kurs ist da" />
        </Field>
        <Field label="Text (Markdown)">
          <MarkdownEditor value={f.body} onChange={(v) => setF({ ...f, body: v })} rows={9} />
        </Field>
        <Field label="Wohin">
          <div className="cma-chips">
            {[['email', 'E-Mail'], ['push', 'Push aufs Handy'], ['bell', 'Glocke in der Community']].map(([k, l]) => (
              <label key={k} className={`cma-chip${has(k) ? ' on' : ''}`}>
                <input type="checkbox" checked={has(k)} onChange={() => toggle(k)} /> {l}
              </label>
            ))}
          </div>
        </Field>
        <h4 style={{ margin: '8px 0 0' }}>An wen</h4>
        <p className="muted small" style={{ margin: '0 0 6px' }}>
          Ohne Auswahl bekommen alle Mitglieder die Nachricht (Gesperrte nie).
        </p>
        {(tiers.data?.tiers ?? []).length > 1 && (
          <Field label="Nur diese Stufen">
            <div className="cma-chips">
              {tiers.data.tiers.map((t: any) => (
                <label key={t.id} className={`cma-chip${f.tier_ids.includes(t.id) ? ' on' : ''}`}>
                  <input type="checkbox" checked={f.tier_ids.includes(t.id)} onChange={(e) => setF({ ...f, tier_ids: e.target.checked ? [...f.tier_ids, t.id] : f.tier_ids.filter((x: string) => x !== t.id) })} /> {t.name}
                </label>
              ))}
            </div>
          </Field>
        )}
        <div className="cma-two">
          <NumberField label="Mindestens Level" min={1} value={f.min_level === '' ? null : Number(f.min_level)} onChange={(v) => setF({ ...f, min_level: v ?? '' })} />
          <NumberField label="Aktiv in den letzten … Tagen" min={1} value={f.active_days === '' ? null : Number(f.active_days)} onChange={(v) => setF({ ...f, active_days: v ?? '' })} />
          <NumberField label="Nicht aktiv seit … Tagen" min={1} value={f.inactive_days === '' ? null : Number(f.inactive_days)} onChange={(v) => setF({ ...f, inactive_days: v ?? '' })} hint="Zum Zurückholen" />
        </div>
        <Field label="Später senden (freiwillig)">
          <Input type="datetime-local" value={f.scheduled_at} onChange={(v) => setF({ ...f, scheduled_at: v })} />
        </Field>
        {count && (
          <div className="cma-note info" role="status">
            Erreicht <strong>{count.members}</strong> Mitglieder – {count.email} per E-Mail, {count.push} mit Push auf dem Gerät.
          </div>
        )}
        <div className="cma-actions">
          <button className="btn secondary" onClick={preview}>
            Empfänger zählen
          </button>
          <button className="btn" onClick={send} disabled={!f.subject.trim() || !f.body.trim() || !f.channels.length}>
            {f.scheduled_at ? 'Einplanen' : 'Senden'}
          </button>
        </div>
      </Sec>
      <Sec title="Bisher gesendet">
        {!hist.data ? (
          <Spinner />
        ) : hist.data.broadcasts.length ? (
          <ul className="cma-list">
            {hist.data.broadcasts.map((b: any) => (
              <li key={b.id}>
                <div className="grow">
                  <div>
                    <strong>{b.subject}</strong> <Badge tone={b.status === 'sent' ? 'green' : b.status === 'scheduled' ? 'yellow' : 'gray'}>{b.status === 'sent' ? 'Gesendet' : b.status === 'scheduled' ? 'Geplant' : 'Zurückgenommen'}</Badge>
                  </div>
                  <div className="muted small">
                    {b.status === 'scheduled' ? `für ${dt(b.scheduled_at)}` : dt(b.sent_at ?? b.created_at)} · {b.recipients} Empfänger · {b.channels.map((c: string) => hist.data.channels[c]).join(', ')}
                    {b.push_devices ? ` · ${b.push_devices} Geräte` : ''}
                  </div>
                </div>
                {b.status === 'scheduled' && (
                  <button className="btn small secondary" onClick={() => run(() => api.del(`/api/community/broadcasts/${b.id}`), 'Zurückgenommen', () => void hist.reload())}>
                    Zurücknehmen
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Noch nichts gesendet.</p>
        )}
      </Sec>
    </div>
  );
}

function Partner({ group, onChange }: { group: any; onChange: () => void }) {
  const r = useLoad(() => api.get<any>(`/api/community/groups/${group.id}/affiliate`), [group.id]);
  const [pid, setPid] = useState<string | null>(null);
  const [point, setPoint] = useState(true);
  if (!r.data) return <Spinner />;
  const cur = pid ?? r.data.program?.id ?? '';
  return (
    <div className="cma-grid">
      <Sec title="Mitglieder werben Mitglieder" lead="Verbinde die Community mit einem Partner-Programm: Mitglieder bekommen im Mitgliederbereich einen eigenen Link, du zahlst Provision, sobald jemand darüber beitritt und kauft (Abrechnung und Auszahlung wie bei allen Partnern).">
        {r.data.programs.length ? (
          <>
            <Field label="Partner-Programm">
              <Select value={cur} onChange={setPid} placeholder="Keins (Partner-Seite aus)" options={r.data.programs.filter((p: any) => p.active).map((p: any) => [p.id, `${p.name} – ${p.commission_type === 'fixed' ? `${(p.commission_value / 100).toFixed(2).replace('.', ',')} €` : `${p.commission_value} %`}`])} />
            </Field>
            <Check checked={point} onChange={setPoint} label={<>Die Links des Programms zeigen auf die öffentliche Seite <span className="muted">({r.data.landing_url})</span></>} />
            <div className="cma-actions">
              <button className="btn" onClick={() => run(() => api.put(`/api/community/groups/${group.id}/affiliate`, { program_id: cur, point_links: point }), 'Gespeichert', () => (void r.reload(), onChange()))}>
                Speichern
              </button>
              <Link to="affiliates" className="btn secondary">
                Partner-Programme verwalten
              </Link>
            </div>
          </>
        ) : (
          <Empty action={<Link to="affiliates" className="btn">Programm anlegen</Link>}>Es gibt noch kein Partner-Programm. Lege eines an (Provision, Cookie-Dauer, Auszahlung) und komm dann hierher zurück.</Empty>
        )}
      </Sec>
      {r.data.program && (
        <Sec title="So funktioniert es für Mitglieder">
          <p style={{ marginTop: 0 }}>
            Im Mitgliederbereich erscheint der Reiter <strong>🤝 Partner</strong>. Ein Klick auf „Partner werden“ erzeugt den persönlichen Link, dazu sehen Mitglieder Klicks, Anmeldungen, Verkäufe und ihre Provision.
          </p>
          <ul className="muted small">
            <li>{r.data.program.affiliates} Partner im Programm</li>
            <li>Provisionen, Freigabe und Auszahlung: Verkaufen → Partner</li>
          </ul>
          <CopyField value={r.data.program.signup_url} label="Anmelde-Seite des Programms (ohne Community)" />
        </Sec>
      )}
    </div>
  );
}

