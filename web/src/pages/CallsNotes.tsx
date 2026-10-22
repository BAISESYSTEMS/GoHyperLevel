import { useEffect, useState } from 'react';
import { Icon } from '../icons';
import { api, dt } from '../api';
import { Badge, Modal, Spinner, Textarea, act, navigate, toast, useLoad } from '../ui';
import { dur } from './CallsKit';

/**
 * Small parts of a call that the log and the browser phone share: notes written during or after the conversation (they also land in
 * the contact's notes), the route a call took (telephone menu, queue), where it came from (campaign) and the analysis. Docs: docs/telephony.md.
 */

/** Notes of one call: the list and a box to add one. `compact` is the version inside the browser phone. */
export function CallNotes({ callId, compact }: { callId: string; compact?: boolean }) {
  const list = useLoad(() => api.get<any[]>(`/api/calls/${encodeURIComponent(callId)}/notes`), [callId]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!text.trim()) return;
    setBusy(true);
    const r = await act(() => api.post(`/api/calls/${encodeURIComponent(callId)}/notes`, { body: text }), 'Notiz gespeichert');
    setBusy(false);
    if (r) {
      setText('');
      void list.reload();
    }
  };
  return (
    <div className="phone-notes" data-tour="call-notes">
      {(list.data?.length ?? 0) > 0 && (
        <div className={compact ? 'phone-note-list' : 'cr-lines'}>
          {list.data!.map((n) => (
            <div key={n.id} className={compact ? undefined : 'tl-action'}>
              <span className={compact ? undefined : 'grow'}>
                {n.body}
                <span className="muted small">
                  {' '}
                  · {n.user_name || 'Team'}
                  {n.at_second !== null && n.at_second !== undefined ? ` · ${dur(n.at_second)}` : ` · ${dt(n.created_at)}`}
                </span>
              </span>
              {!compact && (
                <button className="icon-btn" aria-label="Notiz löschen" onClick={async () => (await act(() => api.del(`/api/calls/${encodeURIComponent(callId)}/notes/${n.id}`), 'Gelöscht')) && list.reload()}>
                  <Icon name="trash" size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {list.loading && !list.data && <Spinner />}
      <Textarea value={text} onChange={setText} rows={compact ? 2 : 3} placeholder="Notiz zum Gespräch (landet auch beim Kontakt) – Strg+Enter speichert" maxLength={4000} onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && void add()} />
      <button className="btn small" disabled={busy || !text.trim()} onClick={add}>
        Notiz speichern
      </button>
    </div>
  );
}

export function CallNotesModal({ call, onClose }: { call: { id: string; contact_name?: string; from_number?: string; to_number?: string }; onClose: () => void }) {
  return (
    <Modal title={`Notizen: ${call.contact_name || call.from_number || call.to_number || 'Anruf'}`} onClose={onClose}>
      <CallNotes callId={call.id} />
    </Modal>
  );
}

const ROUTE: Record<string, string> = { ivr: 'Telefonmenü', group: 'Gruppe', ai: 'KI-Telefonagent', voicemail: 'Voicemail', forward: 'Weiterleitung', user: 'Person' };

/** Extra lines under the number: the way through the menu, the campaign, the tracking number, the notice. */
export function CallMeta({ c }: { c: any }) {
  const attr = [c.attr_source, c.attr_medium, c.attr_campaign].filter(Boolean).join(' / ');
  if (!c.route_kind && !attr && !c.voicemail_box && !c.wait_seconds && !c.consent_announced) return null;
  return (
    <div className="muted small">
      {c.route_path ? <div>{c.route_path}</div> : c.route_kind && c.route_kind !== 'default' ? <div>{ROUTE[c.route_kind] ?? c.route_kind}</div> : null}
      {c.voicemail_box && <div>Postfach „{c.voicemail_box}“</div>}
      {attr && (
        <div title="Aus welcher Kampagne der Anrufer kam">
          <Icon name="attribution" size={12} /> {attr}
        </div>
      )}
      {c.wait_seconds > 0 && <div>wartete {dur(c.wait_seconds)}</div>}
      {c.consent_announced ? <div title="Vor der Aufzeichnung wurde der Hinweis gesprochen">Aufzeichnungshinweis gespielt</div> : null}
    </div>
  );
}

/** Notes and analysis of a call in the log. */
export function CallActions({ c, onChanged }: { c: any; onChanged: () => void }) {
  const [notes, setNotes] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setBusy(false), [c.intel_id]);
  const analyse = async () => {
    setBusy(true);
    const r = await act(() => api.post(`/api/call-intel/calls/${c.id}/analyze`));
    setBusy(false);
    if (r) {
      toast('Wird ausgewertet – das dauert ein paar Minuten.');
      onChanged();
      navigate(`calls/intel/${r.id}`);
    }
  };
  return (
    <>
      <button className="icon-btn" title="Notizen zum Anruf" aria-label="Notizen zum Anruf" onClick={() => setNotes(true)}>
        <Icon name="note" size={16} />
        {c.notes_count > 0 && <span className="small"> {c.notes_count}</span>}
      </button>
      {c.intel_id ? (
        <button className="icon-btn" title={`Auswertung öffnen (${c.intel_status === 'done' ? 'fertig' : c.intel_status === 'failed' ? 'fehlgeschlagen' : 'läuft'})`} aria-label="Auswertung öffnen" onClick={() => navigate(`calls/intel/${c.intel_id}`)}>
          <Icon name="sparkles" size={16} />
          {c.intel_status !== 'done' && <Badge tone={c.intel_status === 'failed' ? 'red' : 'blue'}>{c.intel_status === 'failed' ? '!' : '…'}</Badge>}
        </button>
      ) : (
        c.has_recording &&
        c.answered === 1 && (
          <button className="icon-btn" title="Gespräch auswerten (Transkript, Zusammenfassung, Aufgaben)" aria-label="Gespräch auswerten" disabled={busy} onClick={analyse}>
            <Icon name="sparkles" size={16} />
          </button>
        )
      )}
      {notes && <CallNotesModal call={c} onClose={() => setNotes(false)} />}
    </>
  );
}
