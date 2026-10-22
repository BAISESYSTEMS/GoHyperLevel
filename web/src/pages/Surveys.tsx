import { useState } from 'react';
import { api, d, dt, name } from '../api';
import { act, Badge, confirmAsk, Empty, Field, Input, Link, Modal, navigate, PageHead, pressable, Select, Spinner, Stat, Tabs, TagInput, Textarea, useLoad } from '../ui';
import { useTags } from '../tags';
import { MoreFields } from '../areas/fields';
import { SortableGrid } from '../sortable/Sortable';

/** Umfragen: CSAT answers after solved tickets and NPS campaigns. */

const FACES = ['😞', '🙁', '😐', '🙂', '😄'];

function Csat() {
  const [days, setDays] = useState('90');
  const [score, setScore] = useState('');
  const { data } = useLoad(() => api.get(`/api/surveys/csat?days=${days}&score=${score}`), [days, score]);
  if (!data) return <Spinner />;
  const s = data.summary;
  const max = Math.max(1, ...s.distribution);
  return (
    <>
      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 10 }}>
        <div style={{ width: 170 }}>
          <Select value={score} onChange={setScore} placeholder="Alle Bewertungen" options={[5, 4, 3, 2, 1].map((n) => [String(n), `${FACES[n - 1]} ${n} von 5`])} />
        </div>
        <div style={{ width: 170 }}>
          <Select value={days} onChange={setDays} aria="Zeitraum" options={[['30', 'Letzte 30 Tage'], ['90', 'Letzte 90 Tage'], ['365', 'Letztes Jahr']]} />
        </div>
      </div>
      <div className="grid2" style={{ gap: 14, alignItems: 'start' }}>
        <SortableGrid id="csat-stats" className="stats" style={{ marginBottom: 0 }} data-tour="csat-stats">
          <Stat label="Ø Zufriedenheit" value={s.avg !== null ? `${String(s.avg).replace('.', ',')} / 5` : '–'} sub={`${s.count} Bewertungen`} />
          <Stat label="Zufrieden (4–5)" value={s.satisfied_pct !== null ? `${s.satisfied_pct} %` : '–'} />
          <Stat label="Antwortquote" value={s.response_rate !== null ? `${s.response_rate} %` : '–'} sub={`${s.sent} Umfragen gesendet`} />
        </SortableGrid>
        <div className="card" data-tour="csat-dist">
          <h2>Verteilung</h2>
          {[5, 4, 3, 2, 1].map((n) => (
            <div key={n} className="row" style={{ alignItems: 'center', flexWrap: 'nowrap', marginBottom: 6 }} title={`${n} von 5: ${s.distribution[n - 1]}`}>
              <span style={{ width: 54 }}>
                {FACES[n - 1]} {n}
              </span>
              <div className="bar grow">
                <div style={{ width: `${(s.distribution[n - 1] / max) * 100}%` }} />
              </div>
              <span className="muted" style={{ width: 30, textAlign: 'right' }}>
                {s.distribution[n - 1]}
              </span>
            </div>
          ))}
        </div>
      </div>
      {data.responses.length ? (
        <div className="table-wrap" style={{ marginTop: 14 }} data-tour="csat-list">
          <table className="t">
            <thead>
              <tr>
                <th>Bewertung</th>
                <th>Ticket</th>
                <th>Kontakt</th>
                <th>Zuständig</th>
                <th>Datum</th>
              </tr>
            </thead>
            <tbody>
              {data.responses.map((r: any) => (
                <tr key={r.id} className="click" {...pressable(() => navigate(`tickets/${r.id}`))}>
                  <td>
                    <span style={{ fontSize: 20 }}>{FACES[r.csat_score - 1]}</span> {r.csat_score}/5
                    {r.csat_comment && <div className="small">„{r.csat_comment}“</div>}
                  </td>
                  <td>
                    #{r.number} {r.subject}
                  </td>
                  <td>{r.contact_id ? name(r) : '–'}</td>
                  <td className="muted">{r.owner_name || '–'}</td>
                  <td className="muted small">{dt(r.csat_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>Noch keine Bewertungen. Nach dem Lösen eines Tickets bekommt der Kontakt automatisch einen Link (Einstellungen → Service → Zufriedenheit).</Empty>
      )}
    </>
  );
}

const NPS_QUESTION = 'Wie wahrscheinlich ist es, dass du uns Freunden oder Kollegen empfiehlst?';

function CampaignModal({ c, onClose, onSaved }: { c?: any; onClose: () => void; onSaved: () => void }) {
  const tags = useTags();
  const lists = useLoad(() => api.get<any[]>('/api/smart-lists'), []);
  const [f, setF] = useState<any>(
    c ?? {
      name: '',
      channel: 'email',
      tags: [],
      question: NPS_QUESTION,
      subject: 'Kurze Frage: Würdest du uns weiterempfehlen?',
      body: 'Hallo {{contact.first_name|}},\n\nwie wahrscheinlich ist es, dass du uns weiterempfiehlst? Eine Antwort dauert 10 Sekunden:\n\n{{nps_link}}\n\nDanke!\n{{location.name}}',
    },
  );
  const save = async () => {
    const body = { name: f.name, question: f.question, channel: f.channel, subject: f.subject, body: f.body, tags: f.tags, smart_list_id: f.smart_list_id || '' };
    if (await act(() => (c ? api.patch(`/api/surveys/nps/${c.id}`, body) : api.post('/api/surveys/nps', body)), 'Gespeichert')) onSaved();
  };
  return (
    <Modal title={c ? 'NPS-Umfrage bearbeiten' : 'Neue NPS-Umfrage'} onClose={onClose} wide footer={<button className="btn" onClick={save}>Speichern</button>}>
      <div className="grid2">
        <Field label="Name (intern)">
          <Input value={f.name} onChange={(v) => setF({ ...f, name: v })} placeholder="NPS Herbst" autoFocus />
        </Field>
        <Field label="Kanal">
          <Select value={f.channel} onChange={(v) => setF({ ...f, channel: v })} options={[['email', 'E-Mail'], ['sms', 'SMS']]} />
        </Field>
      </div>
      <Field label="An Kontakte mit einem dieser Tags">
        <TagInput value={f.tags ?? []} onChange={(v) => setF({ ...f, tags: v })} suggestions={tags} />
      </Field>
      {f.channel === 'email' && (
        <Field label="Betreff">
          <Input value={f.subject} onChange={(v) => setF({ ...f, subject: v })} />
        </Field>
      )}
      <Field label="Nachricht" hint="{{nps_link}} wird zum persönlichen Umfrage-Link; außerdem {{contact.first_name}}, {{location.name}}. Kontakte mit „Nicht stören“ bekommen nichts.">
        <Textarea value={f.body} onChange={(v) => setF({ ...f, body: v })} rows={7} />
      </Field>
      <MoreFields id="nps-campaign" values={[f.question !== NPS_QUESTION && f.question, f.smart_list_id]}>
        <Field label="Frage (auf der Umfrage-Seite)">
          <Input value={f.question} onChange={(v) => setF({ ...f, question: v })} />
        </Field>
        <Field label="…oder aus Smart List">
          <Select value={f.smart_list_id} onChange={(v) => setF({ ...f, smart_list_id: v })} placeholder="– keine –" options={(lists.data ?? []).map((l) => [l.id, l.name])} />
        </Field>
      </MoreFields>
    </Modal>
  );
}

function Responses({ c, onClose }: { c: any; onClose: () => void }) {
  const { data } = useLoad(() => api.get<any[]>(`/api/surveys/nps/${c.id}/responses`), [c.id]);
  return (
    <Modal title={`Antworten: ${c.name}`} onClose={onClose} wide>
      {!data ? (
        <Spinner />
      ) : data.length ? (
        <table className="t">
          <tbody>
            {data.map((r) => (
              <tr key={r.id}>
                <td style={{ width: 70 }}>
                  <Badge tone={r.score >= 9 ? 'green' : r.score >= 7 ? 'gray' : 'red'}>{r.score}/10</Badge>
                </td>
                <td>
                  <Link to={`contacts/${r.contact_id}`}>{name(r)}</Link>
                  {r.comment && <div className="small">„{r.comment}“</div>}
                </td>
                <td className="muted small">{d(r.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">Noch keine Antworten.</p>
      )}
    </Modal>
  );
}

function Nps() {
  const list = useLoad(() => api.get<any[]>('/api/surveys/nps'), []);
  const [modal, setModal] = useState<{ kind: 'edit'; c?: any } | { kind: 'resp'; c: any } | null>(null);
  const send = async (c: any) => {
    if (!confirmAsk(`Umfrage „${c.name}“ jetzt an alle passenden Kontakte senden? Wer sie schon bekommen hat, bekommt sie nicht noch einmal.`)) return;
    const r = await act(() => api.post(`/api/surveys/nps/${c.id}/send`));
    if (r) {
      alert(`${r.queued} Kontakte werden angeschrieben (${r.audience} in der Zielgruppe).`);
      list.reload();
    }
  };
  return (
    <>
      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 10 }}>
        <button className="btn" onClick={() => setModal({ kind: 'edit' })}>
          + NPS-Umfrage
        </button>
      </div>
      {!list.data ? (
        <Spinner />
      ) : list.data.length ? (
        <SortableGrid id="nps-list" className="nps-grid" data-tour="nps-list">
          {list.data.map((c) => (
            <div key={c.id} className="card">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <h2 style={{ margin: 0 }}>{c.name}</h2>
                  <div className="muted small">
                    {c.channel === 'sms' ? 'SMS' : 'E-Mail'} · {c.tags.length ? `Tags: ${c.tags.join(', ')}` : c.smart_list_id ? 'Smart List' : 'keine Zielgruppe'}
                  </div>
                </div>
                <Badge tone={c.status === 'sent' ? 'green' : c.status === 'sending' ? 'blue' : 'gray'}>{c.status === 'sent' ? 'gesendet' : c.status === 'sending' ? 'wird gesendet' : 'Entwurf'}</Badge>
              </div>
              <div className="nps-score">
                <div className="big">{c.stats.score ?? '–'}</div>
                <div className="muted small">NPS</div>
              </div>
              <div className="nps-split" aria-label={`Promotoren ${c.stats.promoters}, Passive ${c.stats.passives}, Kritiker ${c.stats.detractors}`}>
                {c.stats.count > 0 && (
                  <>
                    <i className="pro" style={{ flex: c.stats.promoters }} />
                    <i className="pas" style={{ flex: c.stats.passives }} />
                    <i className="det" style={{ flex: c.stats.detractors }} />
                  </>
                )}
              </div>
              <div className="muted small">
                {c.stats.promoters} Promotoren (9–10) · {c.stats.passives} Passive · {c.stats.detractors} Kritiker (0–6) · {c.stats.count} von {c.sends?.total ?? 0} geantwortet
              </div>
              <div className="actions" style={{ marginTop: 10 }}>
                <button className="btn small" onClick={() => send(c)}>
                  {c.status === 'draft' ? 'Senden' : 'Neue Kontakte anschreiben'}
                </button>
                <button className="btn small secondary" onClick={() => setModal({ kind: 'resp', c })}>
                  Antworten
                </button>
                <button className="btn small secondary" onClick={() => setModal({ kind: 'edit', c })}>
                  Bearbeiten
                </button>
                <button className="btn small ghost" onClick={async () => confirmAsk(`„${c.name}“ samt Antworten löschen?`) && (await act(() => api.del(`/api/surveys/nps/${c.id}`))) && list.reload()}>
                  Löschen
                </button>
              </div>
            </div>
          ))}
        </SortableGrid>
      ) : (
        <Empty action={<button className="btn" onClick={() => setModal({ kind: 'edit' })}>Erste NPS-Umfrage anlegen</button>}>Net Promoter Score: frag deine Kunden per E-Mail oder SMS, wie wahrscheinlich sie dich weiterempfehlen.</Empty>
      )}
      {modal?.kind === 'edit' && <CampaignModal c={modal.c} onClose={() => setModal(null)} onSaved={() => (setModal(null), list.reload())} />}
      {modal?.kind === 'resp' && <Responses c={modal.c} onClose={() => setModal(null)} />}
    </>
  );
}

export function Surveys({ tab }: { tab?: string }) {
  const cur = tab === 'nps' ? 'nps' : 'csat';
  return (
    <>
      <PageHead title="Umfragen" sub="Zufriedenheit nach gelösten Tickets (CSAT) und Weiterempfehlung (NPS)" />
      <Tabs tabs={[['csat', 'Zufriedenheit (CSAT)'], ['nps', 'Weiterempfehlung (NPS)']]} value={cur} onChange={(v) => navigate(`surveys/${v}`)} />
      <div style={{ marginTop: 14 }}>{cur === 'csat' ? <Csat /> : <Nps />}</div>
    </>
  );
}
