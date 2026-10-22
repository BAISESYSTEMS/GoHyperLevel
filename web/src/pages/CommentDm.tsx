import { useState } from 'react';
import { Icon } from '../icons';
import { api, dt } from '../api';
import { Badge, Check, Empty, Field, Input, Link, Modal, PageHead, Select, Spinner, Stat, TagInput, Textarea, act, confirmAsk, useLoad } from '../ui';
import { Callout, Fold, Item, Panel, StatusBadge } from './CreatorKit';
import { SortableGrid } from '../sortable/Sortable';

/**
 * Kommentar-zu-DM: someone comments a keyword under a post or reel (Instagram, Facebook) or answers a story with one – HyperLevel
 * answers publicly (rotating texts), sends a private message with a link and buttons, creates the contact, tags it and starts a
 * workflow. Docs: docs/comment-to-dm.md (Meta app permissions, review, limits).
 */

const PLATFORM: [string, string][] = [
  ['instagram', 'Instagram'],
  ['facebook', 'Facebook'],
  ['both', 'Instagram und Facebook'],
];
const MODE: [string, string][] = [
  ['contains', 'enthält das Stichwort (ganzes Wort)'],
  ['exact', 'ist genau das Stichwort'],
  ['any', 'jeder Kommentar'],
];
const platformLabel = (p: string) => (p === 'facebook' ? 'Facebook' : p === 'both' ? 'Instagram + Facebook' : 'Instagram');

type Rule = {
  id?: string;
  name: string;
  kind: 'comment' | 'story_reply';
  platform: string;
  scope: 'all' | 'post';
  media_id: string;
  media_label: string;
  keywords: string[];
  match_mode: string;
  public_replies: string[];
  dm_text: string;
  link_url: string;
  link_label: string;
  buttons: { type: 'reply' | 'url'; title: string; value: string }[];
  tags: string[];
  workflow_id: string;
  max_per_hour: number;
  once_per_person: boolean;
  enabled: boolean;
};
const blank = (): Rule => ({ name: '', kind: 'comment', platform: 'instagram', scope: 'all', media_id: '', media_label: '', keywords: [], match_mode: 'contains', public_replies: ['Schau in deine Nachrichten – ich habe dir den Link geschickt!'], dm_text: '', link_url: '', link_label: 'Jetzt öffnen', buttons: [], tags: [], workflow_id: '', max_per_hour: 60, once_per_person: true, enabled: true });

function RuleDialog({ rule, onClose, onSaved }: { rule?: any; onClose: () => void; onSaved: () => void }) {
  const [r, setR] = useState<Rule>(rule ? { ...blank(), ...rule } : blank());
  const [media, setMedia] = useState<any[] | null>(null);
  const [mediaErr, setMediaErr] = useState('');
  const workflows = useLoad(() => api.get<any[]>('/api/workflows'), []);
  const set = (p: Partial<Rule>) => setR({ ...r, ...p });
  const story = r.kind === 'story_reply';
  const loadMedia = async () => {
    setMediaErr('');
    try {
      setMedia(await api.get(`/api/ig-comments/media?platform=${r.platform === 'facebook' ? 'facebook' : 'instagram'}`));
    } catch (e) {
      setMedia([]);
      setMediaErr((e as Error).message);
    }
  };
  const problem =
    r.match_mode !== 'any' && !r.keywords.length
      ? 'Mindestens ein Stichwort – oder „jeder Kommentar“ wählen.'
      : !r.dm_text.trim() && !r.link_url.trim() && !r.buttons.length
        ? 'Die Direktnachricht braucht einen Text, einen Link oder Buttons.'
        : r.scope === 'post' && !r.media_id.trim()
          ? 'Bitte den Beitrag wählen oder seine ID eintragen.'
          : '';
  const save = async () => {
    const body = { ...r, public_replies: r.public_replies.map((x) => x.trim()).filter(Boolean), buttons: r.buttons.filter((b) => b.title.trim()) };
    if (await act(() => (rule ? api.patch(`/api/ig-comments/rules/${rule.id}`, body) : api.post('/api/ig-comments/rules', body)), 'Regel gespeichert')) {
      onSaved();
      onClose();
    }
  };
  const setBtn = (i: number, p: Partial<Rule['buttons'][number]>) => set({ buttons: r.buttons.map((b, j) => (j === i ? { ...b, ...p } : b)) });
  return (
    <Modal
      title={rule ? `Regel: ${rule.name}` : 'Neue Regel'}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" disabled={!!problem} title={problem} onClick={save} data-tour="igc-save">
            Speichern
          </button>
        </>
      }
    >
      <div className="cr-form-row">
        <Field label="Name (optional)">
          <Input value={r.name} onChange={(v) => set({ name: v })} maxLength={120} placeholder="Stichwort „Guide“" />
        </Field>
        <Field label="Auslöser">
          <Select value={r.kind} onChange={(v) => set({ kind: v as Rule['kind'], ...(v === 'story_reply' ? { platform: 'instagram', scope: 'all' as const } : {}) })} options={[['comment', 'Kommentar unter einem Beitrag oder Reel'], ['story_reply', 'Antwort auf eine Instagram-Story']]} />
        </Field>
      </div>
      <div className="cr-form-row" data-tour="igc-where">
        {!story && (
          <Field label="Plattform">
            <Select value={r.platform} onChange={(v) => set({ platform: v, media_id: '', media_label: '' })} options={PLATFORM} />
          </Field>
        )}
        {!story && (
          <Field label="Welcher Beitrag?">
            <Select value={r.scope} onChange={(v) => set({ scope: v as Rule['scope'] })} options={[['all', 'Alle Beiträge und Reels'], ['post', 'Nur ein bestimmter Beitrag']]} />
          </Field>
        )}
      </div>
      {!story && r.scope === 'post' && (
        <Field label="Beitrag" hint="Lade deine letzten Beiträge und wähle einen – oder trage die ID von Hand ein.">
          <div className="cr-line">
            <Input value={r.media_id} className="grow" onChange={(v) => set({ media_id: v.trim(), media_label: '' })} placeholder="ID des Beitrags oder Reels" />
            <button type="button" className="btn secondary" onClick={loadMedia}>
              Beiträge laden
            </button>
          </div>
          {r.media_label && <small className="muted">Gewählt: {r.media_label}</small>}
          {mediaErr && <p className="cr-err">{mediaErr}</p>}
          {media && media.length > 0 && (
            <div className="cr-list" style={{ marginTop: 8 }}>
              {media.map((m) => (
                <Item key={m.id} onClick={() => set({ media_id: m.id, media_label: m.label })}>
                  <strong>{m.label || m.type}</strong>
                  <div className="cr-sub">
                    {m.type} · {m.at ? dt(m.at) : ''}
                  </div>
                </Item>
              ))}
            </div>
          )}
        </Field>
      )}
      <div className="cr-form-row" data-tour="igc-keywords">
        <Field label="Das Stichwort …">
          <Select value={r.match_mode} onChange={(v) => set({ match_mode: v })} options={MODE} />
        </Field>
      </div>
      {r.match_mode !== 'any' && (
        <Field label="Stichwörter *" hint="Groß-/Kleinschreibung, Akzente, Satzzeichen und Emojis spielen keine Rolle. Mit Enter hinzufügen.">
          <TagInput value={r.keywords} onChange={(v) => set({ keywords: v })} placeholder="z. B. guide" />
        </Field>
      )}
      {!story && (
        <Field label="Öffentliche Antwort unter dem Kommentar (rotiert)" hint="Mehrere Texte wechseln sich ab – gleiche Texte unter vielen Kommentaren können als Spam gelten. Leer = keine öffentliche Antwort.">
          <div className="cr-lines" data-tour="igc-public">
            {r.public_replies.map((t, i) => (
              <div className="cr-line" key={i}>
                <Input value={t} className="grow" onChange={(v) => set({ public_replies: r.public_replies.map((x, j) => (j === i ? v : x)) })} maxLength={300} placeholder="Check deine DMs 📬" />
                <button type="button" className="btn small ghost" aria-label="Antwort entfernen" onClick={() => set({ public_replies: r.public_replies.filter((_, j) => j !== i) })}>
                  ✕
                </button>
              </div>
            ))}
            {r.public_replies.length < 10 && (
              <button type="button" className="btn small secondary" style={{ alignSelf: 'flex-start' }} onClick={() => set({ public_replies: [...r.public_replies, ''] })}>
                + Antwort
              </button>
            )}
          </div>
        </Field>
      )}
      <h4 style={{ margin: '14px 0 8px' }}>Direktnachricht</h4>
      <Field label="Text" hint={story ? 'Geht in die Unterhaltung, in der die Person auf die Story geantwortet hat.' : 'Meta erlaubt eine private Antwort je Kommentar. Danach öffnet die Antwort der Person das 24-Stunden-Fenster.'}>
        <Textarea value={r.dm_text} onChange={(v) => set({ dm_text: v })} rows={3} maxLength={1000} placeholder="Hier ist dein Guide – viel Spaß damit!" data-tour="igc-dm" />
      </Field>
      <div className="cr-form-row">
        <Field label="Link (https)">
          <Input value={r.link_url} onChange={(v) => set({ link_url: v })} placeholder="https://…/guide.pdf" />
        </Field>
        <Field label="Beschriftung des Link-Buttons">
          <Input value={r.link_label} onChange={(v) => set({ link_label: v })} maxLength={20} />
        </Field>
      </div>
      <Field label="Weitere Buttons (bis zu 3 insgesamt)" hint="„Antwort“-Buttons schicken ihren Text als Nachricht zurück – damit startest du ein Gespräch oder eine weitere Automation.">
        <div className="cr-lines">
          {r.buttons.map((b, i) => (
            <div className="cr-line" key={i}>
              <Select value={b.type} onChange={(v) => setBtn(i, { type: v as 'reply' | 'url' })} options={[['reply', 'Antwort'], ['url', 'Link']]} />
              <Input value={b.title} className="grow" onChange={(v) => setBtn(i, { title: v })} maxLength={20} placeholder="Beschriftung" />
              <Input value={b.value} className="grow" onChange={(v) => setBtn(i, { value: v })} placeholder={b.type === 'url' ? 'https://…' : 'Antworttext (leer = Beschriftung)'} />
              <button type="button" className="btn small ghost" aria-label="Button entfernen" onClick={() => set({ buttons: r.buttons.filter((_, j) => j !== i) })}>
                ✕
              </button>
            </div>
          ))}
          {r.buttons.length + (r.link_url ? 1 : 0) < 3 && (
            <button type="button" className="btn small secondary" style={{ alignSelf: 'flex-start' }} onClick={() => set({ buttons: [...r.buttons, { type: 'reply', title: '', value: '' }] })}>
              + Button
            </button>
          )}
        </div>
      </Field>
      <div className="cr-callout info" style={{ maxWidth: 420 }} aria-label="Vorschau der Nachricht" data-tour="igc-preview">
        <strong className="small">Vorschau</strong>
        <p style={{ margin: '6px 0' }}>{r.dm_text || (r.link_url ? r.link_label : 'Hallo!')}</p>
        <div className="cr-chips" style={{ marginBottom: 0 }}>
          {r.link_url && <span className="badge blue">🔗 {r.link_label || 'Jetzt öffnen'}</span>}
          {r.buttons.filter((b) => b.title).map((b, i) => (
            <span key={i} className="badge purple">
              {b.type === 'url' ? '🔗 ' : ''}
              {b.title}
            </span>
          ))}
        </div>
      </div>
      <h4 style={{ margin: '14px 0 8px' }}>Danach</h4>
      <Field label="Tags für den Kontakt" hint="Die Person wird als Kontakt angelegt (oder wiedererkannt) und bekommt diese Tags.">
        <TagInput value={r.tags} onChange={(v) => set({ tags: v })} placeholder="z. B. lead-magnet" />
      </Field>
      <Field label="Workflow starten (optional)" hint="Nur aktive Workflows. Der Auslöser „Kommentar-Stichwort getroffen“ startet weitere Abläufe.">
        <Select value={r.workflow_id} onChange={(v) => set({ workflow_id: v })} options={(workflows.data ?? []).filter((w) => w.status === 'active').map((w) => [w.id, w.name] as [string, string])} placeholder="Keinen" />
      </Field>
      <div className="cr-form-row">
        <Field label="Höchstens pro Stunde" hint="Schutz vor Spam-Sperren (1–700)">
          <Input type="number" min={1} max={700} value={r.max_per_hour} onChange={(v) => set({ max_per_hour: Math.max(1, Math.min(700, Number(v) || 60)) })} />
        </Field>
      </div>
      <Check checked={r.once_per_person} onChange={(v) => set({ once_per_person: v })} label="Jede Person bekommt die Direktnachricht nur einmal" />
      <Check checked={r.enabled} onChange={(v) => set({ enabled: v })} label="Regel ist aktiv" />
    </Modal>
  );
}

function TestBox({ rules }: { rules: number }) {
  const [text, setText] = useState('');
  const [platform, setPlatform] = useState('instagram');
  const [res, setRes] = useState<any>(null);
  const run = async () => {
    const r = await act(() => api.post('/api/ig-comments/test', { text, platform }));
    if (r) setRes(r);
  };
  return (
    <Panel title="Regel testen" sub="Schreib einen Beispielkommentar – es wird nichts gesendet." tour="igc-test">
      <div className="cr-form-row">
        <Field label="Kommentar">
          <Input value={text} onChange={setText} placeholder="Guide bitte 🙏" onKeyDown={(e) => e.key === 'Enter' && text && void run()} />
        </Field>
        <Field label="Plattform">
          <Select value={platform} onChange={setPlatform} options={[['instagram', 'Instagram'], ['facebook', 'Facebook']]} />
        </Field>
      </div>
      <button className="btn secondary" disabled={!text.trim() || !rules} onClick={run}>
        Testen
      </button>
      {res &&
        (res.match ? (
          <Callout tone="info">
            <p>
              <strong>Treffer: {res.rule.name}</strong> (Stichwort „{res.keyword}“)
            </p>
            {res.public_reply && <p className="small">Öffentliche Antwort: „{res.public_reply}“</p>}
            <p className="small">Direktnachricht: „{res.dm.text}“{res.dm.buttons.length ? ` · Buttons: ${res.dm.buttons.map((b: any) => b.title).join(', ')}` : ''}</p>
            {res.tags.length > 0 && <p className="small">Tags: {res.tags.join(', ')}</p>}
          </Callout>
        ) : (
          <Callout tone="warn">Kein Treffer – dieser Kommentar löst keine Regel aus.</Callout>
        ))}
    </Panel>
  );
}

export function CommentDm() {
  const status = useLoad(() => api.get('/api/ig-comments/status'), []);
  const rules = useLoad(() => api.get<any[]>('/api/ig-comments/rules'), []);
  const events = useLoad(() => api.get<any[]>('/api/ig-comments/events?limit=30'), []);
  const [editing, setEditing] = useState<any>(null);
  const [sub, setSub] = useState<Record<string, { ok: boolean; info?: string; error?: string }> | null>(null);
  const s = status.data;
  const connected = !!(s?.instagram.configured || s?.facebook.configured);
  const refresh = () => {
    rules.reload();
    events.reload();
    status.reload();
  };
  const toggle = async (r: any) => {
    if (await act(() => api.patch(`/api/ig-comments/rules/${r.id}`, { enabled: !r.enabled }))) rules.reload();
  };
  const remove = async (r: any) => {
    if (!confirmAsk(`Die Regel „${r.name}“ löschen?`)) return;
    if (await act(() => api.del(`/api/ig-comments/rules/${r.id}`), 'Regel gelöscht')) refresh();
  };
  const subscribe = async () => {
    const r = await act(() => api.post('/api/ig-comments/subscribe'));
    if (r) setSub(r.results);
  };
  return (
    <div className="cr cr-igc">
      <PageHead title="Kommentar-zu-DM" sub="Jemand kommentiert „Guide“ unter deinem Beitrag – du antwortest öffentlich, schickst privat den Link, legst den Kontakt an und startest einen Workflow.">
        <button className="btn" data-tour="igc-new" disabled={!connected} onClick={() => setEditing({})}>
          <Icon name="instagram" /> Neue Regel
        </button>
      </PageHead>
      {s && !connected && (
        <Callout tone="warn" tour="igc-connect">
          <strong>Instagram oder Facebook ist noch nicht verbunden.</strong> Trage unter <Link to="settings/channels">Einstellungen → Kanäle</Link> Seiten-ID, Seiten-Token und Instagram-Konto ein. Die nötigen Berechtigungen der Meta-App stehen in der Anleitung.
        </Callout>
      )}
      <SortableGrid id="igc-stats" className="stats" data-tour="igc-stats">
        <Stat label="Treffer (7 Tage)" value={s?.last_7_days.matches ?? '–'} />
        <Stat label="Direktnachrichten gesendet" value={s?.last_7_days.dms ?? '–'} />
        <Stat label="Fehlgeschlagen" value={s?.last_7_days.failed ?? '–'} sub={s?.last_7_days.failed ? 'Details unter „Letzte Treffer“' : undefined} />
        <Stat label="Gebremst (Limit)" value={s?.last_7_days.rate_limited ?? '–'} />
      </SortableGrid>
      <div className="cr-panels two">
        <Panel title="Regeln" sub="Die erste passende Regel gewinnt; eine Regel für einen bestimmten Beitrag schlägt eine für alle." tour="igc-rules" wide>
          {rules.loading && !rules.data ? (
            <Spinner />
          ) : rules.data?.length ? (
            <div className="cr-list">
              {rules.data.map((r) => (
                <Item
                  key={r.id}
                  tone={r.enabled ? undefined : undefined}
                  onClick={() => setEditing(r)}
                  side={
                    <>
                      <Badge tone={r.enabled ? 'green' : 'gray'}>{r.enabled ? 'aktiv' : 'aus'}</Badge>
                      <button
                        className="btn small secondary"
                        onClick={(e) => {
                          e.stopPropagation();
                          void toggle(r);
                        }}
                      >
                        {r.enabled ? 'Ausschalten' : 'Einschalten'}
                      </button>
                      <button
                        className="btn small ghost danger-text"
                        onClick={(e) => {
                          e.stopPropagation();
                          void remove(r);
                        }}
                      >
                        Löschen
                      </button>
                    </>
                  }
                >
                  <strong>{r.name}</strong> <span className="muted">· {r.kind === 'story_reply' ? 'Story-Antwort' : platformLabel(r.platform)}{r.scope === 'post' ? ` · ${r.media_label || r.media_id}` : ''}</span>
                  <div className="cr-sub">
                    {r.match_mode === 'any' ? 'Jeder Kommentar' : r.keywords.map((k: string) => `„${k}“`).join(', ')} → {r.dm_text ? `„${r.dm_text.slice(0, 70)}${r.dm_text.length > 70 ? '…' : ''}“` : r.link_url}
                  </div>
                  <div className="cr-sub">
                    {r.stats.matches} Treffer · {r.stats.dms} Nachrichten · {r.stats.replies} öffentliche Antworten{r.stats.failed ? ` · ${r.stats.failed} Fehler` : ''}
                    {r.stats.last_at ? ` · zuletzt ${dt(r.stats.last_at)}` : ''}
                  </div>
                </Item>
              ))}
            </div>
          ) : (
            <Empty action={connected ? <button className="btn" onClick={() => setEditing({})}>Erste Regel anlegen</button> : undefined}>Noch keine Regel.</Empty>
          )}
        </Panel>
        <TestBox rules={rules.data?.length ?? 0} />
        <Panel title="Verbindung zu Meta" sub="Kommentare kommen über den Webhook deiner Meta-App an." tour="igc-connection">
          <div className="cr-list">
            <Item side={<Badge tone={s?.instagram.configured ? 'green' : 'gray'}>{s?.instagram.configured ? 'verbunden' : 'nicht verbunden'}</Badge>}>
              <strong>Instagram</strong>
              <div className="cr-sub">{s?.instagram.username ? `@${s.instagram.username}` : s?.instagram.account_id || '–'}</div>
            </Item>
            <Item side={<Badge tone={s?.facebook.configured ? 'green' : 'gray'}>{s?.facebook.configured ? 'verbunden' : 'nicht verbunden'}</Badge>}>
              <strong>Facebook-Seite</strong>
              <div className="cr-sub">{s?.facebook.page_name || s?.facebook.page_id || '–'}</div>
            </Item>
          </div>
          <div className="actions" style={{ margin: '12px 0' }}>
            <button className="btn secondary" disabled={!connected} onClick={subscribe} data-tour="igc-subscribe">
              Kommentare abonnieren
            </button>
          </div>
          {sub && (
            <Callout tone={Object.values(sub).every((x) => x.ok) ? 'info' : 'warn'}>
              {Object.entries(sub).map(([k, v]) => (
                <p key={k}>
                  <strong>{k === 'instagram' ? 'Instagram' : 'Facebook'}:</strong> {v.ok ? v.info : v.error}
                </p>
              ))}
            </Callout>
          )}
          <Fold title="Webhook und Berechtigungen">
            <p className="small">
              Callback-URL in der Meta-App (Webhooks): <span className="cr-code">{s?.webhook_url}</span>
            </p>
            <p className="small">
              <strong>Instagram:</strong> Felder {s?.webhook_fields.instagram.join(', ')} · Berechtigungen {s?.permissions.instagram.join(', ')}
            </p>
            <p className="small">
              <strong>Facebook-Seite:</strong> Felder {s?.webhook_fields.page.join(', ')} · Berechtigungen {s?.permissions.facebook.join(', ')}
            </p>
            <p className="small muted">Für fremde Konten braucht die App „Advanced Access“ (App Review). Für dein eigenes Konto reicht der Entwicklermodus.</p>
          </Fold>
          <Fold title="Regeln von Meta">
            <ul className="small" style={{ margin: 0, paddingLeft: 20 }}>
              {(s?.policy ?? []).map((p: string) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Fold>
        </Panel>
        <Panel title="Letzte Treffer" sub="Was mit den letzten Kommentaren passiert ist." wide tour="igc-events">
          {events.data?.length ? (
            <div className="cr-list">
              {events.data.map((e) => (
                <Item key={e.id} tone={e.status === 'failed' ? 'bad' : e.status === 'rate_limited' ? 'warn' : undefined} side={<StatusBadge status={e.status} />}>
                  <strong>{e.from_username ? `@${e.from_username}` : e.from_name || 'Unbekannt'}</strong> · „{String(e.text).slice(0, 90)}“
                  <div className="cr-sub">
                    {e.rule_name || 'Regel gelöscht'} · {e.platform === 'facebook' ? 'Facebook' : 'Instagram'}
                    {e.kind === 'story_reply' ? ' (Story)' : ''} · {dt(e.created_at)} · DM: {e.dm_status === 'sent' ? 'gesendet' : e.dm_status === 'skipped' ? 'schon erhalten' : e.dm_status === 'failed' ? 'Fehler' : '–'}
                    {e.public_status ? ` · Antwort: ${e.public_status === 'sent' ? 'gesendet' : 'Fehler'}` : ''}
                  </div>
                  {e.error && <div className="cr-sub" style={{ color: 'var(--red)' }}>{e.error}</div>}
                </Item>
              ))}
            </div>
          ) : (
            <Empty>Noch kein Kommentar hat eine Regel getroffen.</Empty>
          )}
        </Panel>
      </div>
      {editing && <RuleDialog rule={editing.id ? editing : undefined} onClose={() => setEditing(null)} onSaved={refresh} />}
    </div>
  );
}
