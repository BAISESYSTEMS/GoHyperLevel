import { useEffect, useState } from 'react';
import { ApiError, api, d } from '../api';
import { Badge, Check, Empty, Modal, Spinner, act, navigate, toast, toastError, useLoad } from '../ui';

/**
 * Dubletten-Assistent: doppelte Kontakte finden, beide nebeneinander ansehen, Feld für Feld wählen und zusammenführen – Aktivitäten,
 * Deals, Aufgaben, Nachrichten und Konversationen wandern mit. „Rückgängig“ (Papierkorb/Verlauf, Strg+Z) holt alles zurück.
 */

const CONF: Record<string, [string, 'green' | 'yellow']> = { high: ['Sicher', 'green'], medium: ['Wahrscheinlich', 'yellow'] };
const show = (v: unknown) => (v === null || v === undefined || String(v).trim() === '' ? '–' : String(v));

function Person({ c, keep, onKeep, others }: { c: any; keep: boolean; onKeep?: () => void; others?: React.ReactNode }) {
  return (
    <div className={`dupe-person${keep ? ' keep' : ''}`}>
      <h4>
        <a href={`/app/contacts/${c.id}`}>{c.name}</a> {keep && <Badge tone="blue">behalten</Badge>}
      </h4>
      <div className="small">{show(c.email)}</div>
      <div className="small">{show(c.phone)}</div>
      <div className="small muted">{[c.company, c.city].filter(Boolean).join(' · ') || '–'}</div>
      <div className="small muted">
        angelegt {d(c.created_at)}
        {c.owner_name ? ` · ${c.owner_name}` : ''}
      </div>
      <div className="chips">
        {Object.entries<number>(c.counts ?? {}).map(([k, n]) => (
          <span className="chip" key={k}>
            {n} {k}
          </span>
        ))}
        {!Object.keys(c.counts ?? {}).length && <span className="muted small">nichts verknüpft</span>}
      </div>
      {onKeep && !keep && (
        <button className="btn small secondary" style={{ marginTop: 8 }} onClick={onKeep}>
          Diesen behalten
        </button>
      )}
      {others}
    </div>
  );
}

export function MergeDialog({ keepId, fromId, onClose, onDone }: { keepId: string; fromId: string; onClose: () => void; onDone: (keptId: string) => void }) {
  const [keep, setKeep] = useState(keepId);
  const [from, setFrom] = useState(fromId);
  const p = useLoad(() => api.get<any>(`/api/contact-duplicates/preview?keep_id=${keep}&from_id=${from}`), [keep, from]);
  const [picks, setPicks] = useState<Record<string, 'keep' | 'from'>>({});
  const [detach, setDetach] = useState(false);
  useEffect(() => setPicks({}), [keep, from]);
  const data = p.data;
  if (!data) return <Modal title="Kontakte zusammenführen" wide className="sales-modal" onClose={onClose}>{p.error ? <p className="error">{p.error}</p> : <Spinner />}</Modal>;
  const side = (r: any): 'keep' | 'from' => picks[r.key] ?? r.pick;
  const rows = [...data.fields, ...data.custom].filter((r: any) => !r.hidden && (r.keep !== '' || r.from !== ''));
  const label = (r: any, which: 'keep' | 'from') => (r.key === 'assigned_to' ? r[`${which}_label`] || '–' : show(r[which]));
  const merge = async () => {
    try {
      const r = await api.post('/api/contact-duplicates/merge', { keep_id: keep, from_id: from, picks, confirm_detach: detach });
      toast('Zusammengeführt – über „Rückgängig“ lässt sich das zurücknehmen');
      onDone(r.contact.id);
    } catch (e) {
      if (e instanceof ApiError && e.data?.code === 'frozen_invoices') {
        setDetach(false);
        toast(e.message);
      } else toastError(e);
    }
  };
  return (
    <Modal
      title="Kontakte zusammenführen"
      wide
      className="sales-modal"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={() => (setKeep(from), setFrom(keep))} data-tour="dupe-swap">
            Rollen tauschen
          </button>
          <button className="btn" disabled={data.frozen_invoices > 0 && !detach} onClick={merge} data-tour="dupe-merge">
            Zusammenführen
          </button>
        </>
      }
    >
      <div className="dupe-people">
        <Person c={data.keep} keep />
        <Person c={data.from} keep={false} />
      </div>
      <p className="muted small">
        „{data.keep.name}“ bleibt, „{data.from.name}“ wird in ihn überführt und danach gelöscht. {data.reasons.map((r: any) => r.label).join(' · ')}
      </p>
      <div className="table-wrap" data-tour="dupe-fields">
        <table className="merge-table">
          <thead>
            <tr>
              <th>Feld</th>
              <th>Behalten ({data.keep.name})</th>
              <th>Übernehmen ({data.from.name})</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: any) => (
              <tr key={r.key} className={r.differs ? '' : 'same'}>
                <td>{r.label}</td>
                {(['keep', 'from'] as const).map((w) => (
                  <td key={w} className={label(r, w) === '–' ? 'empty' : ''}>
                    <label>
                      <input type="radio" name={`pick-${r.key}`} checked={side(r) === w} onChange={() => setPicks({ ...picks, [r.key]: w })} aria-label={`${r.label}: ${w === 'keep' ? data.keep.name : data.from.name}`} />
                      {label(r, w)}
                    </label>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small">
        <b>Tags:</b> {data.tags.merged.length ? data.tags.merged.join(', ') : '–'} (immer beide zusammen)
      </p>
      {data.moves.length > 0 && (
        <p className="small">
          <b>Wandert zu „{data.keep.name}“:</b> {data.moves.map((m: any) => `${m.from} ${m.label}`).join(', ')}
          {data.other_links ? `, ${data.other_links} weitere Verknüpfungen` : ''}. Die beiden Konversationen werden eine.
        </p>
      )}
      {data.notes.map((n: string) => (
        <div className="note-box warn" key={n}>
          {n}
        </div>
      ))}
      {data.frozen_invoices > 0 && <Check checked={detach} onChange={setDetach} label={`Ich bestätige: ${data.frozen_invoices} festgeschriebene Rechnung(en) verlieren die Verknüpfung zum Kontakt (der Rechnungsinhalt bleibt unverändert).`} />}
    </Modal>
  );
}

export function SalesDupes() {
  const [min, setMin] = useState('');
  const list = useLoad(() => api.get<any>(`/api/contact-duplicates${min ? `?min=${min}` : ''}`), [min]);
  const [merge, setMerge] = useState<{ keep: string; from: string } | null>(null);
  const [keeps, setKeeps] = useState<Record<string, string>>({});
  const data = list.data;
  return (
    <div data-tour="dupe-list">
      <div className="sales-bar">
        <span className="muted">{data ? `${data.scanned.toLocaleString('de-DE')} Kontakte geprüft · ${data.total} mögliche ${data.total === 1 ? 'Dublette' : 'Dubletten'}` : ''}</span>
        <span className="grow" />
        <Check checked={min === 'high'} onChange={(v) => setMin(v ? 'high' : '')} label="Nur sichere (E-Mail, Telefon, Name + Firma)" />
      </div>
      {!data ? (
        <Spinner />
      ) : data.groups.length === 0 ? (
        <Empty>Keine Dubletten gefunden. Der Assistent prüft E-Mail-Adressen, Telefonnummern (in jeder Schreibweise) und Namen bei derselben Firma.</Empty>
      ) : (
        data.groups.map((g: any) => {
          const keepId = keeps[g.key] ?? g.keep;
          return (
            <div className="dupe" key={g.key}>
              <div className="dupe-head">
                <Badge tone={CONF[g.confidence][1]}>{CONF[g.confidence][0]}</Badge>
                <span className="muted small">{g.reasons.map((r: string) => data.reasons[r]).join(' · ')}</span>
                <span style={{ flex: 1 }} />
                <button className="btn small secondary" onClick={async () => (await act(() => api.post('/api/contact-duplicates/ignore', { contact_ids: g.contacts.map((c: any) => c.id) }), 'Nicht mehr vorgeschlagen')) && list.reload()}>
                  Nicht dieselbe Person
                </button>
              </div>
              <div className="dupe-people">
                {g.contacts.map((c: any) => (
                  <Person
                    key={c.id}
                    c={c}
                    keep={c.id === keepId}
                    onKeep={() => setKeeps({ ...keeps, [g.key]: c.id })}
                    others={
                      c.id !== keepId && (
                        <button className="btn small" style={{ marginTop: 8, marginLeft: 6 }} onClick={() => setMerge({ keep: keepId, from: c.id })}>
                          In den behaltenen überführen…
                        </button>
                      )
                    }
                  />
                ))}
              </div>
            </div>
          );
        })
      )}
      {merge && <MergeDialog keepId={merge.keep} fromId={merge.from} onClose={() => setMerge(null)} onDone={() => (setMerge(null), list.reload())} />}
    </div>
  );
}

/** The banner on a contact's page: "This looks like a duplicate of …". */
export function ContactDupes({ contactId }: { contactId: string }) {
  const near = useLoad(() => api.get<any[]>(`/api/contact-duplicates/for?contact_id=${contactId}`).catch(() => []), [contactId]);
  const [merge, setMerge] = useState<string | null>(null);
  const list = near.data ?? [];
  if (!list.length) return null;
  const first = list[0];
  return (
    <>
      <div className="dupe-banner" role="status" data-tour="contact-dupes">
        <span className="grow">
          <b>Mögliche Dublette:</b> <a href={`/app/contacts/${first.id}`}>{first.name}</a> ({first.reason_labels.join(', ')}){list.length > 1 ? ` und ${list.length - 1} weitere` : ''}
        </span>
        <button className="btn small" onClick={() => setMerge(first.id)}>
          Zusammenführen…
        </button>
        <button className="btn small secondary" onClick={async () => (await act(() => api.post('/api/contact-duplicates/ignore', { contact_ids: [contactId, ...list.map((x) => x.id)] }), 'Nicht mehr vorgeschlagen')) && near.reload()}>
          Nicht dieselbe Person
        </button>
      </div>
      {merge && <MergeDialog keepId={contactId} fromId={merge} onClose={() => setMerge(null)} onDone={(kept) => (setMerge(null), kept === contactId ? near.reload() : navigate(`contacts/${kept}`))} />}
    </>
  );
}
