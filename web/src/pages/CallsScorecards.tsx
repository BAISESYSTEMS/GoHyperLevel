import { useState } from 'react';
import { Icon } from '../icons';
import { api } from '../api';
import { Badge, Empty, Field, Input, Modal, Select, Spinner, Stat, Textarea, act, confirmAsk, toast, useLoad } from '../ui';
import { Callout, Item } from './CreatorKit';
import { pct, useCanSettings } from './CallsKit';
import { SortableGrid } from '../sortable/Sortable';

/**
 * Scorecards: criteria with a weight (yes/no or 1 to 5), pre-scored by the AI from the transcript and checked by a manager. Per
 * criterion the manager's score counts, otherwise the AI's. The report shows who needs coaching on what. Docs: docs/telephony.md.
 */

const SCALE: [string, string][] = [
  ['five', 'Skala 1 bis 5'],
  ['yesno', 'Ja / Nein'],
];

// --- the scores of one conversation ---------------------------------------------------------------------------------------------

function ScoreView({ score, onChanged }: { score: any; onChanged: () => void }) {
  const can = useCanSettings();
  const [edit, setEdit] = useState(false);
  const [rev, setRev] = useState<Record<string, { score: number | null; comment: string }>>({});
  const [comment, setComment] = useState<string>(score.comment ?? '');
  const startEdit = () => {
    setRev(Object.fromEntries(score.criteria.map((k: any) => [k.id, { score: k.review ? k.review.score : k.ai?.score ?? null, comment: k.review?.comment ?? '' }])));
    setComment(score.comment ?? '');
    setEdit(true);
  };
  const save = async () => {
    const scores = Object.fromEntries(Object.entries(rev).filter(([id, v]) => {
      const k = score.criteria.find((x: any) => x.id === id);
      const cur = k.review ? k.review.score : k.ai?.score ?? null;
      return v.score !== cur || v.comment !== (k.review?.comment ?? '') || !!k.review;
    }));
    const r = await act(() => api.put(`/api/call-intel/${score.intel_id}/scores/${score.id}/review`, { scores, comment }), 'Bewertung gespeichert');
    if (r) {
      setEdit(false);
      onChanged();
    }
  };
  const label = (k: any, v: number | null) => (v === null || v === undefined ? 'trifft nicht zu' : k.scale === 'yesno' ? (v ? 'Ja' : 'Nein') : `${v} von 5`);
  return (
    <div className="tl-score" data-tour="score-card">
      <div className="cr-line" style={{ justifyContent: 'space-between' }}>
        <strong>{score.scorecard_name}</strong>
        <span className="cr-line">
          <span className="tl-big">{score.final_total === null ? '–' : Math.round(score.final_total)}</span>
          <span className="muted small">von 100{score.status === 'reviewed' ? ` · geprüft von ${score.reviewer_name || 'Team'}` : ' · KI-Vorschlag, noch nicht geprüft'}</span>
        </span>
      </div>
      {score.ai_error && <p className="cr-err">{score.ai_error}</p>}
      {score.status === 'reviewed' && score.ai_total !== null && score.ai_total !== score.final_total && <p className="muted small">Die KI hatte {Math.round(score.ai_total)} vergeben.</p>}
      {score.criteria.map((k: any) => {
        const ai = k.ai;
        const r = rev[k.id];
        return (
          <div className="tl-crit" key={k.id}>
            <div>
              <strong>{k.label}</strong> <span className="muted small">Gewicht {k.weight}</span>
              {k.description && <div className="muted small">{k.description}</div>}
            </div>
            <div>
              {edit && r ? (
                <Select
                  value={r.score === null ? '' : String(r.score)}
                  onChange={(v) => setRev({ ...rev, [k.id]: { ...r, score: v === '' ? null : Number(v) } })}
                  placeholder="trifft nicht zu"
                  options={k.scale === 'yesno' ? [['1', 'Ja'], ['0', 'Nein']] : [['5', '5 – sehr gut'], ['4', '4'], ['3', '3'], ['2', '2'], ['1', '1 – schwach']]}
                />
              ) : (
                <span>
                  <strong>{label(k, k.final)}</strong>
                  {k.review && ai && ai.score !== k.review.score && <span className="muted small"> (KI: {label(k, ai.score)})</span>}
                </span>
              )}
            </div>
            {ai?.reason && (
              <div className="why">
                {ai.reason}
                {ai.quote && (
                  <>
                    {' '}
                    <q>{ai.quote}</q>
                  </>
                )}
              </div>
            )}
            {edit && r ? (
              <div style={{ gridColumn: '1 / -1' }}>
                <Input value={r.comment} onChange={(v) => setRev({ ...rev, [k.id]: { ...r, comment: v } })} placeholder="Kommentar zu diesem Kriterium (optional)" maxLength={400} aria-label={`Kommentar ${k.label}`} />
              </div>
            ) : (
              k.review?.comment && <div className="why">Manager: {k.review.comment}</div>
            )}
          </div>
        );
      })}
      {edit ? (
        <>
          <Field label="Gesamtkommentar">
            <Textarea value={comment} onChange={setComment} rows={2} maxLength={2000} />
          </Field>
          <div className="actions">
            <button className="btn" onClick={save}>
              Bewertung speichern
            </button>
            <button className="btn secondary" onClick={() => setEdit(false)}>
              Abbrechen
            </button>
          </div>
        </>
      ) : (
        <>
          {score.comment && <p className="small">Kommentar: {score.comment}</p>}
          {can ? (
            <button className="btn small secondary" onClick={startEdit} data-tour="score-review">
              <Icon name="edit" size={14} /> {score.status === 'reviewed' ? 'Bewertung ändern' : 'Prüfen und korrigieren'}
            </button>
          ) : (
            <p className="muted small">Prüfen dürfen Administratoren und Personen mit Zugriff auf die Einstellungen.</p>
          )}
        </>
      )}
    </div>
  );
}

/** Scores of one conversation plus the picker to score it with another card. */
export function Scores({ intelId, ready }: { intelId: string; ready: boolean }) {
  const scores = useLoad(() => api.get<any[]>(`/api/call-intel/${intelId}/scores`), [intelId]);
  const cards = useLoad(() => api.get<any[]>('/api/call-intel/scorecards'), []);
  const [card, setCard] = useState('');
  const [busy, setBusy] = useState(false);
  const used = new Set((scores.data ?? []).map((s) => s.scorecard_id));
  const free = (cards.data ?? []).filter((c) => !used.has(c.id));
  const run = async () => {
    setBusy(true);
    const r = await act(() => api.post(`/api/call-intel/${intelId}/scores`, { scorecard_id: card }), 'Von der KI vorbewertet');
    setBusy(false);
    if (r) {
      setCard('');
      void scores.reload();
    }
  };
  return (
    <div>
      {(scores.data ?? []).map((s) => (
        <ScoreView key={s.id} score={s} onChanged={() => void scores.reload()} />
      ))}
      {ready && free.length > 0 && (
        <div className="cr-line">
          <div className="grow">
            <Select value={card} onChange={setCard} placeholder="Mit einer Scorecard bewerten …" options={free.map((c) => [c.id, c.name])} />
          </div>
          <button className="btn" disabled={!card || busy} onClick={run}>
            <Icon name="sparkles" size={14} /> KI bewertet vor
          </button>
        </div>
      )}
      {!ready && free.length > 0 && <p className="muted small">Die Vorbewertung durch die KI braucht den KI-Assistenten (Einstellungen → KI-Assistent).</p>}
      {!scores.data?.length && !cards.data?.length && <p className="muted small">Noch keine Scorecard. Lege eine unter „Scorecards“ an.</p>}
    </div>
  );
}

// --- managing cards --------------------------------------------------------------------------------------------------------------

function CardDialog({ initial, onClose, onSaved }: { initial: any | null; onClose: () => void; onSaved: () => void }) {
  const tpl = useLoad(() => api.get<any[]>('/api/call-scorecards/templates'), []);
  const [c, setC] = useState<any>(() => (initial ? JSON.parse(JSON.stringify(initial)) : { name: '', description: '', criteria: [{ id: '', label: '', description: '', weight: 1, scale: 'five' }] }));
  const set = (p: any) => setC({ ...c, ...p });
  const setK = (i: number, p: any) => set({ criteria: c.criteria.map((k: any, j: number) => (j === i ? { ...k, ...p } : k)) });
  const save = async () => {
    const body = { name: c.name, description: c.description, criteria: c.criteria.map((k: any) => ({ ...k, id: k.id || undefined })), active: c.active ?? true };
    const r = await act(() => (initial ? api.put(`/api/call-scorecards/${initial.id}`, body) : api.post('/api/call-scorecards', body)), 'Gespeichert');
    if (r) {
      onSaved();
      onClose();
    }
  };
  return (
    <Modal
      title={initial ? `Scorecard: ${initial.name}` : 'Neue Scorecard'}
      wide
      onClose={onClose}
      footer={
        <button className="btn" disabled={!c.name.trim() || !c.criteria.length} onClick={save}>
          Speichern
        </button>
      }
    >
      {!initial && (tpl.data?.length ?? 0) > 0 && (
        <div className="cr-chips">
          {tpl.data!.map((t) => (
            <button key={t.key} type="button" className="cr-chip" onClick={() => setC({ name: t.name, description: t.description, criteria: JSON.parse(JSON.stringify(t.criteria)) })}>
              Vorlage: {t.name}
            </button>
          ))}
        </div>
      )}
      <div className="cr-form-row">
        <Field label="Name">
          <Input value={c.name} onChange={(v) => set({ name: v })} maxLength={80} placeholder="z. B. Vertriebsgespräch" />
        </Field>
        <Field label="Beschreibung (optional)">
          <Input value={c.description} onChange={(v) => set({ description: v })} maxLength={400} />
        </Field>
      </div>
      <h4 style={{ margin: '8px 0' }}>Kriterien</h4>
      <p className="muted small">Das Gewicht bestimmt, wie stark ein Kriterium in die Gesamtnote (0 bis 100) eingeht. Die Beschreibung liest auch die KI: je genauer, desto besser ihre Vorbewertung.</p>
      {c.criteria.map((k: any, i: number) => (
        <div key={i} className="tl-score">
          <div className="cr-form-row">
            <Field label="Kriterium">
              <Input value={k.label} onChange={(v) => setK(i, { label: v })} maxLength={80} placeholder="z. B. Bedarf erfragt" />
            </Field>
            <Field label="Bewertung">
              <Select value={k.scale} onChange={(v) => setK(i, { scale: v })} options={SCALE} />
            </Field>
            <Field label="Gewicht (1 bis 10)">
              <Input type="number" min={1} max={10} value={k.weight} onChange={(v) => setK(i, { weight: Number(v) })} />
            </Field>
          </div>
          <Field label="Woran erkennt man es?">
            <Input value={k.description} onChange={(v) => setK(i, { description: v })} maxLength={400} placeholder="Stellt offene Fragen und hört zu, bevor er anbietet." />
          </Field>
          <button className="btn small secondary" onClick={() => set({ criteria: c.criteria.filter((_: any, j: number) => j !== i) })} disabled={c.criteria.length < 2}>
            <Icon name="trash" size={14} /> Kriterium entfernen
          </button>
        </div>
      ))}
      {c.criteria.length < 20 && (
        <button className="btn secondary" onClick={() => set({ criteria: [...c.criteria, { id: '', label: '', description: '', weight: 1, scale: 'five' }] })}>
          <Icon name="plus" size={14} /> Kriterium
        </button>
      )}
    </Modal>
  );
}

function Report({ card, onClose }: { card: any; onClose: () => void }) {
  const [days, setDays] = useState('30');
  const rep = useLoad(() => api.get(`/api/call-scorecards/${card.id}/report?days=${days}`), [card.id, days]);
  const r = rep.data;
  return (
    <Modal title={`Auswertung: ${card.name}`} wide onClose={onClose}>
      <Field label="Zeitraum">
        <Select value={days} onChange={setDays} options={[['7', '7 Tage'], ['30', '30 Tage'], ['90', '90 Tage'], ['365', '1 Jahr']]} />
      </Field>
      {!r ? (
        <Spinner />
      ) : r.scored ? (
        <>
          <SortableGrid id="calls-scorecards.stats" className="stats" style={{ marginBottom: 12 }}>
            <Stat label="Bewertete Gespräche" value={r.scored} sub={`${r.reviewed} von Managern geprüft`} />
            <Stat label="Durchschnitt" value={r.avg_total === null ? '–' : Math.round(r.avg_total)} sub="von 100" />
          </SortableGrid>
          <h4 style={{ margin: '4px 0 6px' }}>Je Kriterium</h4>
          <table className="tl-report">
            <thead>
              <tr>
                <th>Kriterium</th>
                <th className="n">Erfüllt im Schnitt</th>
                <th className="n">Gespräche</th>
              </tr>
            </thead>
            <tbody>
              {r.criteria.map((k: any) => (
                <tr key={k.id}>
                  <td>{k.label}</td>
                  <td className="n">{pct(k.avg_pct)}</td>
                  <td className="n">{k.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4 style={{ margin: '14px 0 6px' }}>Je Person</h4>
          <table className="tl-report">
            <thead>
              <tr>
                <th>Person</th>
                <th className="n">Durchschnitt</th>
                <th className="n">Gespräche</th>
              </tr>
            </thead>
            <tbody>
              {r.people.map((p: any) => (
                <tr key={p.user_id ?? 'x'}>
                  <td>{p.name}</td>
                  <td className="n">{p.avg_total === null ? '–' : Math.round(p.avg_total)}</td>
                  <td className="n">{p.scored}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <Empty>In diesem Zeitraum wurde noch nichts mit dieser Scorecard bewertet.</Empty>
      )}
    </Modal>
  );
}

export function ScorecardsDialog({ onClose }: { onClose: () => void }) {
  const can = useCanSettings();
  const list = useLoad(() => api.get<any[]>('/api/call-scorecards'), []);
  const [edit, setEdit] = useState<any | 'new' | null>(null);
  const [report, setReport] = useState<any>(null);
  return (
    <Modal
      title="Scorecards"
      wide
      onClose={onClose}
      footer={
        can ? (
          <button className="btn" onClick={() => setEdit('new')}>
            <Icon name="plus" size={14} /> Neue Scorecard
          </button>
        ) : undefined
      }
    >
      <Callout>
        Eine Scorecard prüft Gespräche nach festen Kriterien. Die KI schlägt je Kriterium eine Note mit Begründung und Zitat vor; eine Führungskraft prüft und korrigiert. Bewertungen von Menschen sind Hilfsmittel für Coaching – wer sie für Personalentscheidungen nutzt, sollte die Mitbestimmungs- und Datenschutzregeln im Betrieb klären.
      </Callout>
      {!list.data ? (
        <Spinner />
      ) : list.data.length ? (
        <div className="cr-list">
          {list.data.map((c) => (
            <Item
              key={c.id}
              onClick={() => (can ? setEdit(c) : setReport(c))}
              side={
                <>
                  {!c.active && <Badge>aus</Badge>}
                  <Badge tone="blue">{c.scored} bewertet</Badge>
                  <button className="btn small secondary" onClick={(e) => (e.stopPropagation(), setReport(c))}>
                    <Icon name="gauge" size={14} /> Auswertung
                  </button>
                  {can && (
                    <button
                      className="icon-btn"
                      aria-label={`${c.name} löschen`}
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (confirmAsk(`Scorecard „${c.name}“ mit allen Bewertungen löschen?`) && (await act(() => api.del(`/api/call-scorecards/${c.id}`), 'Gelöscht'))) void list.reload();
                      }}
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  )}
                </>
              }
            >
              <strong>{c.name}</strong>
              <div className="cr-sub">
                {c.criteria.length} Kriterien{c.description ? ` · ${c.description}` : ''}
              </div>
            </Item>
          ))}
        </div>
      ) : (
        <Empty>Noch keine Scorecard. Starte mit einer Vorlage für Vertrieb oder Kundenservice.</Empty>
      )}
      {edit && <CardDialog initial={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => (void list.reload(), toast('Scorecard gespeichert'))} />}
      {report && <Report card={report} onClose={() => setReport(null)} />}
    </Modal>
  );
}
