import { useState } from 'react';
import { ago, api } from '../api';
import { Badge, Check, Empty, Field, Input, Modal, Select, Spinner, Textarea, act, confirmAsk, useLoad } from '../ui';
import { CopyField, MemberPick, NumberField, Sec, Sub, run } from './CommunityParts';

/**
 * Community → Nachrichten: the team's inbox (members write to the team, the team writes to members), reported messages, admins and
 * moderators among the members, and the member features of the group (messages, directory, map, online, video, live server).
 * Server side: modules/community-dm.ts, community-ext.ts.
 */

export function MessagesTab({ group, onChange }: { group: any; onChange: () => void }) {
  const [sub, setSub] = useState('inbox');
  const reports = useLoad(() => api.get<any[]>('/api/community/dm-reports'), []);
  return (
    <div className="cma" data-tour="community-messages">
      <Sub
        value={sub}
        onChange={setSub}
        tabs={[
          ['inbox', 'Postfach'],
          ['reports', `Gemeldete Nachrichten${reports.data?.length ? ` (${reports.data.length})` : ''}`],
          ['team', 'Admins & Moderatoren'],
          ['features', 'Mitglieder-Funktionen'],
        ]}
      />
      {sub === 'inbox' && <Inbox group={group} />}
      {sub === 'reports' && <Reports list={reports} />}
      {sub === 'team' && <Staff group={group} onChange={onChange} />}
      {sub === 'features' && <Features group={group} />}
    </div>
  );
}

// --- inbox ---------------------------------------------------------------------------------------------------------------------
function Inbox({ group }: { group: any }) {
  const threads = useLoad(() => api.get<any[]>('/api/community/messages'), []);
  const [open, setOpen] = useState<any>(null);
  const [pick, setPick] = useState(false);
  if (!threads.data) return <Spinner />;
  return (
    <>
      <div className="cma-grid">
        <Sec title="Unterhaltungen mit dem Team" lead="Mitglieder schreiben dem Team über „Team schreiben“ im Mitgliederbereich. Du siehst hier alles, was sie schreiben, und antwortest als „Team“ (oder mit dem Namen, den du wählst). Private Nachrichten zwischen Mitgliedern liest du nicht." right={<button className="btn" onClick={() => setPick(true)}>+ Neue Nachricht</button>}>
          {threads.data.length ? (
            <ul className="cma-list">
              {threads.data.map((t) => (
                <li key={t.thread_id}>
                  <div className="grow">
                    <div>
                      <strong>{t.name}</strong> {t.unread > 0 && <Badge tone="red">{t.unread} neu</Badge>}
                    </div>
                    <div className="muted small">
                      {t.email} · {ago(t.last_message_at)}
                    </div>
                    <div className="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t.last_preview}
                    </div>
                  </div>
                  <button className="btn small" onClick={() => setOpen(t)}>
                    Öffnen
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Noch keine Nachrichten.</p>
          )}
        </Sec>
      </div>
      {open && <Thread contact={open} onClose={() => (setOpen(null), void threads.reload())} />}
      {pick && (
        <Modal title="Neue Nachricht an ein Mitglied" onClose={() => setPick(false)}>
          <MemberPick group={group} onPick={(m) => (setPick(false), setOpen({ contact_id: m.contact_id, name: m.display_name || m.email, email: m.email }))} />
        </Modal>
      )}
    </>
  );
}

function Thread({ contact, onClose }: { contact: any; onClose: () => void }) {
  const t = useLoad(() => api.get<any>(`/api/community/messages/${contact.contact_id}`), [contact.contact_id]);
  const [body, setBody] = useState('');
  const [from, setFrom] = useState('');
  const send = async () => {
    if (await act(() => api.post(`/api/community/messages/${contact.contact_id}`, { body, from_name: from || undefined }), 'Gesendet')) {
      setBody('');
      void t.reload();
    }
  };
  return (
    <Modal
      title={`Nachrichten mit ${contact.name}`}
      onClose={onClose}
      wide
      footer={
        <button className="btn" disabled={!body.trim()} onClick={send}>
          Senden
        </button>
      }
    >
      {!t.data ? (
        <Spinner />
      ) : (
        <div className="cma">
          <div className="cma-thread" role="log" aria-live="polite">
            {t.data.messages.length ? (
              t.data.messages.map((m: any) => (
                <div key={m.id} className={`cma-msg${m.from_team ? ' team' : ''}`}>
                  {m.body}
                  <small>
                    {m.from_team ? m.sender_name : t.data.name} · {ago(m.created_at)}
                  </small>
                </div>
              ))
            ) : (
              <p className="muted">Noch nichts geschrieben.</p>
            )}
          </div>
          <Field label="Deine Nachricht">
            <Textarea rows={3} value={body} onChange={setBody} autoFocus />
          </Field>
          <Field label="Absendername" hint="Leer = „Team“">
            <Input value={from} maxLength={60} onChange={setFrom} placeholder="Team" />
          </Field>
        </div>
      )}
    </Modal>
  );
}

// --- reported messages -----------------------------------------------------------------------------------------------------------------
function Reports({ list }: { list: ReturnType<typeof useLoad<any[]>> }) {
  if (!list.data) return <Spinner />;
  const settle = (r: any, action: string, ok: string) => run(() => api.patch(`/api/community/dm-reports/${r.id}`, { action }), ok, () => void list.reload());
  return list.data.length ? (
    <div className="cma-grid">
      {list.data.map((r) => (
        <Sec key={r.id} title={`Gemeldet von ${r.reporter.name}`} lead={`${ago(r.created_at)}${r.reason ? ` · „${r.reason}“` : ''}`}>
          <div className="cma-thread" style={{ maxHeight: 200 }}>
            {r.context.map((c: any, i: number) => (
              <div key={i} className={`cma-msg${c.body === r.message.text ? ' team' : ''}`}>
                {c.body}
                <small>{c.sender_name}</small>
              </div>
            ))}
          </div>
          <p className="small" style={{ marginBottom: 0 }}>
            Gemeldet wurde die Nachricht von <strong>{r.sender.name}</strong> ({r.sender.email || 'Team'}).
          </p>
          <div className="cma-actions">
            <button className="btn secondary" onClick={() => settle(r, 'dismiss', 'In Ordnung')}>
              In Ordnung
            </button>
            <button className="btn secondary" onClick={() => settle(r, 'remove', 'Nachricht entfernt')}>
              Nachricht entfernen
            </button>
            <button className="btn danger" onClick={async () => (await confirmAsk(`${r.sender.name} sperren und die Nachricht entfernen?`)) && settle(r, 'ban', 'Gesperrt')}>
              Absender sperren
            </button>
          </div>
        </Sec>
      ))}
    </div>
  ) : (
    <Empty>Keine gemeldeten Nachrichten. Mitglieder melden eine Nachricht über das Menü (⋯) in der Unterhaltung.</Empty>
  );
}

// --- admins & moderators ------------------------------------------------------------------------------------------------------------------
function Staff({ group, onChange }: { group: any; onChange: () => void }) {
  const list = useLoad(() => api.get<any[]>(`/api/community/groups/${group.id}/staff`), [group.id]);
  const [adding, setAdding] = useState<string | null>(null);
  const [role, setRole] = useState('moderator');
  return (
    <>
      <div className="cma-grid">
        <Sec title="Admins und Moderatoren" lead="Mitglieder mit Rolle haben im Mitgliederbereich eine eigene Seite „Moderation“: Beiträge und Kommentare ausblenden, löschen oder anheften, Meldungen abarbeiten. Admins entscheiden zusätzlich über Beitrittsanfragen. Sie tragen ein Abzeichen und stehen auf der öffentlichen Seite.">
          {!list.data ? (
            <Spinner />
          ) : list.data.length ? (
            <ul className="cma-list">
              {list.data.map((s) => (
                <li key={s.contact_id}>
                  <div className="grow">
                    <strong>{s.name}</strong> <Badge tone={s.role === 'admin' ? 'purple' : 'blue'}>{s.role === 'admin' ? 'Admin' : 'Moderator'}</Badge>
                    <div className="muted small">{s.email}</div>
                  </div>
                  <button className="btn small ghost" onClick={async () => (await confirmAsk(`${s.name} die Rolle nehmen?`)) && run(() => api.del(`/api/community/groups/${group.id}/staff/${s.contact_id}`), 'Rolle entfernt', () => (void list.reload(), onChange()))}>
                    Rolle entfernen
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Noch niemand. Du kannst jedes Mitglied zur Moderation ernennen.</p>
          )}
          <div className="cma-actions">
            <button className="btn" onClick={() => setAdding('')}>
              + Rolle vergeben
            </button>
          </div>
        </Sec>
      </div>
      {adding !== null && (
        <Modal title="Rolle vergeben" onClose={() => setAdding(null)}>
          <Field label="Rolle">
            <Select value={role} onChange={setRole} options={[['moderator', 'Moderator – Inhalte moderieren'], ['admin', 'Admin – zusätzlich Beitrittsanfragen']]} />
          </Field>
          <MemberPick
            group={group}
            onPick={async (m) => {
              if (await act(() => api.post(`/api/community/groups/${group.id}/staff`, { contact_id: m.contact_id, role }), 'Rolle vergeben')) {
                setAdding(null);
                void list.reload();
                onChange();
              }
            }}
          />
        </Modal>
      )}
    </>
  );
}

// --- member features -------------------------------------------------------------------------------------------------------------------------
function Features({ group }: { group: any }) {
  const ext = useLoad(() => api.get<any>(`/api/community/groups/${group.id}/ext`), [group.id]);
  const [f, setF] = useState<any>(null);
  if (ext.data && !f) setF(structuredClone(ext.data));
  if (!f) return <Spinner />;
  const set = (k: string, patch: any) => setF({ ...f, [k]: { ...f[k], ...patch } });
  const save = () => run(() => api.put(`/api/community/groups/${group.id}/ext`, { dms: f.dms, directory: f.directory, map: f.map, online: f.online, video: f.video, live: f.live }), 'Gespeichert');
  return (
    <div className="cma-grid">
      <Sec title="Private Nachrichten" lead="Mitglieder einer Gruppe können sich privat schreiben, blockieren und Nachrichten melden. Es gibt Grenzen gegen Spam.">
        <Check checked={f.dms.enabled} onChange={(v) => set('dms', { enabled: v })} label="Private Nachrichten erlauben" />
        <div className="cma-two">
          <NumberField label="Höchstens pro Stunde" min={1} max={600} value={f.dms.per_hour} onChange={(v) => set('dms', { per_hour: v ?? 30 })} />
          <NumberField label="Neue Unterhaltungen pro Tag" min={1} max={500} value={f.dms.new_per_day} onChange={(v) => set('dms', { new_per_day: v ?? 15 })} />
        </div>
        <div className="cma-actions">
          <button className="btn" onClick={save}>
            Speichern
          </button>
        </div>
      </Sec>
      <Sec title="Mitglieder sichtbar machen" lead="Wer ist da, woher kommen wir? Jedes Mitglied entscheidet selbst, was es von sich zeigt (Online-Punkt, Ort auf der Karte, Aktivität).">
        <Check checked={f.directory.enabled} onChange={(v) => set('directory', { enabled: v })} label="Mitgliederverzeichnis mit Suche und Level-Filter" />
        <Check checked={f.online.enabled} onChange={(v) => set('online', { enabled: v })} label="„Online jetzt“ zeigen" />
        <Check checked={f.map.enabled} onChange={(v) => set('map', { enabled: v })} label="Mitglieder-Karte (nur Stadt, nur wer es erlaubt; ohne externe Kartendienste)" />
        <div className="cma-actions">
          <button className="btn" onClick={save}>
            Speichern
          </button>
        </div>
      </Sec>
      <Sec title="Videos und Live-Calls" lead="Mitglieder dürfen Videos in Beiträgen hochladen (bis zu einer Größe, die auf deinem Server eingestellt ist) oder verlinken. Live-Calls laufen über Jitsi.">
        <Check checked={f.video.upload} onChange={(v) => set('video', { upload: v })} label="Video-Upload in Beiträgen erlauben (sonst nur Links zu YouTube, Vimeo, Loom)" />
        <Field label="Eigener Jitsi-Server (freiwillig)" hint="Leer = meet.jit.si bzw. die Einstellung PGHL_JITSI_URL deines Servers. Nur https://adresse – ohne Pfad.">
          <Input value={f.live.jitsi_url} onChange={(v) => set('live', { jitsi_url: v })} placeholder="https://meet.example.com" />
        </Field>
        <div className="cma-actions">
          <button className="btn" onClick={save}>
            Speichern
          </button>
        </div>
      </Sec>
      <Sec title="Mitglieder-App" lead="Der Mitgliederbereich ist eine installierbare App (PWA) mit dem Namen, der Farbe und dem Logo deines Kunden. Mitglieder tippen im Browser auf „Installieren“ bzw. „Zum Home-Bildschirm“ und bekommen Push-Mitteilungen für Nachrichten, Erwähnungen und Antworten.">
        <CopyField value={group.url} label="Link zur Gruppe (zum Teilen oder als QR-Code)" />
        <p className="muted small" style={{ marginBottom: 0 }}>
          Name und Logo kommen aus dem Branding des Sub-Accounts (Agentur → Branding). Auf Android öffnet der Link direkt in der App, wenn sie als Verknüpfung installiert ist – Einzelheiten in docs/community.md.
        </p>
      </Sec>
    </div>
  );
}
