import { useEffect, useState, type ReactNode } from 'react';
import { api, d, dt } from '../api';
import { Icon } from '../icons';
import { Badge, Field, Input, Select, Spinner, Stat, act, confirmAsk, useLoad } from '../ui';
import { getLocale, tr, useT } from '../i18n';
import { SOURCE_LOCALE } from '../i18n/registry';
import { SortableGrid } from '../sortable/Sortable';

/** Funnel editor → page → tab „A/B-Test“: variants, split, goal and results of the page's split test. */

type Tone = 'gray' | 'green' | 'red' | 'blue' | 'yellow' | 'purple';
// German labels (message ids of the sites catalog), shown through t()
const GOALS: [string, string][] = [
  ['form', 'Formular abgeschickt'],
  ['booking', 'Termin gebucht'],
  ['purchase', 'Kauf (Stripe-Kauf-Link)'],
  ['page', 'Zielseite besucht'],
];
const STATUS: Record<string, [string, Tone]> = { draft: ['Entwurf', 'gray'], running: ['läuft', 'green'], paused: ['pausiert', 'yellow'], ended: ['beendet', 'blue'] };
const VERDICT: Record<string, [string, Tone]> = {
  control: ['Original', 'gray'],
  too_early: ['zu früh', 'gray'],
  better: ['besser ✓', 'green'],
  worse: ['schlechter', 'red'],
  no_difference: ['kein klarer Unterschied', 'yellow'],
};
/** "12 %" / "12,5 %" in German (as before), "12%" / "12.5%" in English. */
const percent = (text: string | number) => (getLocale() === SOURCE_LOCALE ? `${text} %` : `${text}%`);
const decimal = (text: string) => (getLocale() === SOURCE_LOCALE ? text.replace('.', ',') : text);
const pct = (x: number | null | undefined, digits = 1) => (x === null || x === undefined ? '–' : percent(decimal((x * 100).toFixed(digits))));
const signedPct = (x: number | null | undefined) => (x === null || x === undefined ? '–' : `${x > 0 ? '+' : ''}${pct(x)}`);
const pValue = (p: number | null | undefined) => (p === null || p === undefined ? '–' : p < 0.001 ? `p < ${decimal('0.001')}` : `p = ${decimal(p.toFixed(3))}`);

function GoalPicker({ goal, onChange, funnel, pageId }: { goal: any; onChange: (g: any) => void; funnel: any; pageId: string }) {
  const t = useT('sites');
  const type = goal?.type ?? 'form';
  const forms = useLoad(() => (type === 'form' ? api.get<any[]>('/api/forms') : Promise.resolve([])), [type]);
  const calendars = useLoad(() => (type === 'booking' ? api.get<any[]>('/api/calendars') : Promise.resolve([])), [type]);
  const products = useLoad(() => (type === 'purchase' ? api.get<any[]>('/api/products') : Promise.resolve([])), [type]);
  const pages = (funnel.pages ?? []).filter((p: any) => p.id !== pageId);
  return (
    <div className="grid2">
      <Field label={t('Ziel')}>
        <Select value={type} onChange={(v) => onChange({ type: v })} options={GOALS.map(([k, l]) => [k, t(l)] as [string, string])} />
      </Field>
      {type === 'form' && (
        <Field label={t('Formular')}>
          <Select value={goal?.form_id} onChange={(v) => onChange({ ...goal, type, form_id: v })} placeholder={t('jedes Formular')} options={(forms.data ?? []).map((f) => [f.id, f.name])} />
        </Field>
      )}
      {type === 'booking' && (
        <Field label={t('Kalender')}>
          <Select value={goal?.calendar_id} onChange={(v) => onChange({ ...goal, type, calendar_id: v })} placeholder={t('jeder Kalender')} options={(calendars.data ?? []).map((c) => [c.id, c.name])} />
        </Field>
      )}
      {type === 'purchase' && (
        <Field label={t('Produkt')}>
          <Select value={goal?.product_id} onChange={(v) => onChange({ ...goal, type, product_id: v })} placeholder={t('jedes Produkt')} options={(products.data ?? []).map((p) => [p.id, p.name])} />
        </Field>
      )}
      {type === 'page' && (
        <Field label={t('Zielseite')} hint={!goal?.page_id ? t('oder eine Adresse (z. B. /p/funnel/danke)') : undefined}>
          <Select value={goal?.page_id} onChange={(v) => onChange({ type, page_id: v })} placeholder={t('Adresse eingeben…')} options={pages.map((p: any) => [p.id, p.name])} />
          {!goal?.page_id && <Input value={goal?.url} onChange={(v) => onChange({ type, url: v })} placeholder={t('https://… oder /p/…')} />}
        </Field>
      )}
    </div>
  );
}

const ANY: Record<string, string> = { form: 'jedes Formular', booking: 'jeder Kalender', purchase: 'jedes Produkt' };
/** The goal as one line; `goal_label` and `goal_target` come from the server. */
function goalText(test: any) {
  const any = ANY[test.goal?.type];
  return `${test.goal_label}${test.goal_target ? `: ${test.goal_target}` : any ? ` (${tr('sites')(any)})` : ''}`;
}
const chance = (p: number | null | undefined) => (p === null || p === undefined ? '–' : p >= 0.995 ? `> ${percent(99)}` : p <= 0.005 ? `< ${percent(1)}` : pct(p, 0));

function ResultsTable({
  test,
  weights,
  setWeights,
  onEdit,
  onAction,
}: {
  test: any;
  weights: Record<string, number>;
  setWeights: (w: Record<string, number>) => void;
  onEdit: (v: any) => void;
  onAction: (path: string, body?: any, confirm?: string) => void;
}) {
  const t = useT('sites');
  const open = test.status !== 'ended';
  return (
    <div className="table-wrap ab-table">
      <table className="t">
        <thead>
          <tr>
            <th>{t('Variante')}</th>
            <th>{t('Aufteilung')}</th>
            <th>{t('Besucher')}</th>
            <th>{t('Conversions')}</th>
            <th>{t('Rate')}</th>
            <th>{t('Uplift')}</th>
            <th>{t('Signifikanz')}</th>
            <th title={t('Bayes: Wahrscheinlichkeit, dass diese Variante besser konvertiert als A (Original)')}>{t('Chance besser')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {test.variants.map((v: any) => {
            const [verdict, tone] = VERDICT[v.verdict] ?? ['', 'gray'];
            const label = verdict && t(verdict);
            const winner = test.winner_id === v.id;
            return (
              <tr key={v.id} className={v.archived ? 'archived' : ''}>
                <td>
                  <span className="ab-key">{v.key}</span> {v.name} {winner && <Badge tone="green">{t('Gewinner')}</Badge>}
                </td>
                <td>
                  {open ? (
                    <span className="ab-weight">
                      <input type="number" min={0} max={100} value={weights[v.id] ?? v.weight} onChange={(e) => setWeights({ ...weights, [v.id]: Number(e.target.value) })} aria-label={t('Aufteilung {key}', { key: v.key })} />{getLocale() === SOURCE_LOCALE ? ' %' : '%'}
                    </span>
                  ) : (
                    percent(v.weight)
                  )}
                </td>
                <td title={t.plural(v.views, { other: '{n} Seitenaufrufe' })}>{v.visitors}</td>
                <td>{v.conversions}</td>
                <td>
                  <strong>{pct(v.rate)}</strong>
                </td>
                <td className={v.uplift > 0 ? 'up' : v.uplift < 0 ? 'down' : ''}>{signedPct(v.uplift)}</td>
                <td className="ab-sig">
                  <Badge tone={tone}>{label}</Badge>
                  {!v.is_control && <div className="muted small">{pValue(v.p_value)}</div>}
                </td>
                <td>{v.is_control ? '–' : chance(v.prob_beat)}</td>
                <td>
                  <div className="ab-actions">
                    {open && !v.is_control && (
                      <button className="icon-btn" title={t('Variante bearbeiten')} aria-label={t('Variante {key} bearbeiten', { key: v.key })} onClick={() => onEdit(v)}>
                        <Icon name="edit" size={14} />
                      </button>
                    )}
                    {!test.winner_id && (
                      <button
                        className="btn small ghost"
                        onClick={() =>
                          onAction('winner', { variant_id: v.id }, t('Variante {key} als Gewinner übernehmen? {effect} Der Test endet.', { key: v.key, effect: v.is_control ? t('Die Seite bleibt, wie sie ist.') : t('Ihr Inhalt wird die Live-Seite.') }))
                        }
                      >
                        {t('Gewinner')}
                      </button>
                    )}
                    {open && !v.is_control && (
                      <button className="icon-btn" title={t('Variante löschen')} aria-label={t('Variante löschen')} onClick={() => onAction(`variant-delete:${v.id}`, undefined, t('Variante {key} löschen?', { key: v.key }))}>
                        <Icon name="trash" size={14} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TestPanel({ test, funnel, reload, setTest, onEdit }: { test: any; funnel: any; reload: () => void; setTest: (t: any) => void; onEdit: (v: any) => void }) {
  const t = useT('sites');
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [goal, setGoal] = useState<any>(test.goal);
  const [name, setName] = useState(test.name);
  useEffect(() => {
    setWeights({});
    setGoal(test.goal);
    setName(test.name);
  }, [test.id, test.updated_at, test.status]);
  const sum = test.variants.filter((v: any) => !v.archived).reduce((s: number, v: any) => s + (weights[v.id] ?? v.weight), 0);
  const weightsDirty = Object.keys(weights).length > 0;
  const goalDirty = JSON.stringify(goal) !== JSON.stringify(test.goal);
  const [status, tone] = STATUS[test.status] ?? ['', 'gray'];
  const st = status && t(status);
  const run = async (path: string, body?: any, confirm?: string) => {
    if (confirm && !confirmAsk(confirm)) return;
    const r = path.startsWith('variant-delete:')
      ? await act(() => api.del(`/api/ab-variants/${path.split(':')[1]}`), t('Variante gelöscht'))
      : await act(() => api.post(`/api/ab-tests/${test.id}/${path}`, body ?? {}), path === 'winner' ? t('Gewinner übernommen – die Seite ist aktualisiert') : t('Gespeichert'));
    if (r) {
      setTest(r);
      if (path === 'winner') reload();
    }
  };
  const save = async (patch: any, ok?: string) => {
    const r = await act(() => api.patch(`/api/ab-tests/${test.id}`, patch), ok ?? t('Gespeichert'));
    if (r) setTest(r);
  };

  return (
    <div className="ab-panel">
      <div className="card">
        <div className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
          <Icon name="branch" />
          <div style={{ flex: '1 1 260px', maxWidth: 360 }}>
            <Input value={name} onChange={setName} onBlur={() => name !== test.name && name.trim() && save({ name })} aria-label={t('Name des Tests')} disabled={test.status === 'ended'} />
          </div>
          <Badge tone={tone}>{st}</Badge>
          <span style={{ flex: '1 1 0' }} />
          {(test.status === 'draft' || test.status === 'paused') && (
            <button className="btn" onClick={() => run('start')} disabled={weightsDirty || goalDirty}>
              {test.status === 'draft' ? t('▶ Test starten') : t('▶ Fortsetzen')}
            </button>
          )}
          {test.status === 'running' && (
            <button className="btn secondary" onClick={() => run('pause')}>
              {t('Pausieren')}
            </button>
          )}
          {test.status !== 'ended' && (
            <button className="btn ghost" onClick={() => run('end', undefined, t('Test ohne Gewinner beenden? Die Seite bleibt, wie sie ist; die Varianten werden archiviert.'))}>
              {t('Beenden')}
            </button>
          )}
          {test.status !== 'running' && (
            <button className="btn ghost danger-text" onClick={async () => confirmAsk(t('Test mit allen Zahlen löschen?')) && (await act(() => api.del(`/api/ab-tests/${test.id}`), t('Gelöscht'))) && reload()}>
              {t('Löschen')}
            </button>
          )}
        </div>
        <p className="muted small" style={{ margin: '0 0 10px' }}>
          {test.status === 'draft' && t('Entwurf: Varianten bearbeiten, Ziel und Aufteilung festlegen, dann starten. Bis dahin sehen alle das Original.')}
          {test.status === 'running' && t('Läuft seit {date}. Jeder Besucher sieht immer dieselbe Variante (Cookie ohne persönliche Daten); Bots zählen nicht.', { date: dt(test.started_at) })}
          {test.status === 'paused' && t('Pausiert: alle sehen das Original (A), es wird nichts gezählt.')}
          {test.status === 'ended' &&
            (test.winner_id
              ? t('Beendet am {date} – Gewinner: Variante {key}.', { date: d(test.ended_at), key: String(test.variants.find((v: any) => v.id === test.winner_id)?.key) })
              : t('Beendet am {date} ohne Gewinner.', { date: d(test.ended_at) }))}
        </p>
        {test.status !== 'ended' ? (
          <>
            <GoalPicker goal={goal} onChange={setGoal} funnel={funnel} pageId={test.page_id} />
            {goalDirty && (
              <button className="btn small" onClick={() => save({ goal }, t('Ziel gespeichert'))}>
                {t('Ziel speichern')}
              </button>
            )}
          </>
        ) : (
          <p className="small">
            <Icon name="goal" size={14} /> {t('Ziel:')} {goalText(test)}
          </p>
        )}
      </div>

      <SortableGrid id="ab-tests.stats" className="stats ab-stats">
        <Stat label={t('Besucher')} value={test.visitors} sub={t('eindeutig, ohne Bots')} />
        <Stat label={t('Conversions')} value={test.conversions} sub={goalText(test)} />
        <Stat label={t('Conversion-Rate gesamt')} value={pct(test.visitors ? test.conversions / test.visitors : null)} />
        <Stat label={t('Ergebnis')} value={test.leader ? t('Variante {key}', { key: test.leader }) : '–'} sub={test.leader ? t('signifikant vorn (95 %)') : t('noch kein klarer Sieger')} />
      </SortableGrid>

      {test.small_sample && test.status !== 'draft' && (
        <div className="ab-note warn">
          <Icon name="pending" size={16} /> {t('Noch wenig Daten: Ergebnisse sind erst ab etwa 100 Besuchern je Variante und 10 Conversions belastbar. Bis dahin können Zufälle die Zahlen stark schwanken lassen.')}
        </div>
      )}
      {test.leader && test.status !== 'ended' && (
        <div className="ab-note ok">
          <Icon name="ok" size={16} /> {t('Variante {key} ist signifikant besser (z-Test, 95 %). Du kannst sie als Gewinner übernehmen.', { key: test.leader })}
        </div>
      )}

      <ResultsTable test={test} weights={weights} setWeights={setWeights} onEdit={onEdit} onAction={run} />
      {test.status !== 'ended' && (
        <div className="row" style={{ marginTop: 10, alignItems: 'center' }}>
          {test.variants.length < 4 && (
            <button className="btn small secondary" onClick={() => run('variants')}>
              {t('+ Variante {key} (Kopie der Seite)', { key: String(['A', 'B', 'C', 'D'].find((k) => !test.variants.some((v: any) => v.key === k))) })}
            </button>
          )}
          {weightsDirty && (
            <>
              <span className={sum === 100 ? 'muted small' : 'small danger-text'}>{t('Summe: {n}', { n: percent(sum) })}</span>
              <button className="btn small" disabled={sum !== 100} onClick={() => save({ weights }, t('Aufteilung gespeichert'))}>
                {t('Aufteilung speichern')}
              </button>
              <button className="btn small ghost" onClick={() => setWeights({})}>
                {t('Verwerfen')}
              </button>
            </>
          )}
          <span style={{ flex: '1 1 0' }} />
          <span className="muted small">{t('Uplift = Rate gegenüber A · Signifikanz: z-Test, zweiseitig, 95 %')}</span>
        </div>
      )}
    </div>
  );
}

export function AbTestTab({ page, funnel, renderEditor, onPageChanged }: { page: any; funnel: any; renderEditor: (variant: any, back: () => void) => ReactNode; onPageChanged?: () => void }) {
  const t = useT('sites');
  const list = useLoad(() => api.get<any[]>(`/api/ab-tests?page_id=${page.id}`), [page.id]);
  const [current, setCurrent] = useState<any>(null);
  const [editing, setEditing] = useState<any>(null);
  const [goal, setGoal] = useState<any>({ type: 'form' });
  const active = (list.data ?? []).find((x) => x.status !== 'ended');
  useEffect(() => {
    setCurrent(null);
    setEditing(null);
    if (active)
      api
        .get(`/api/ab-tests/${active.id}`)
        .then(setCurrent)
        .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, page.id]);
  if (list.loading && !list.data) return <Spinner />;
  const past = (list.data ?? []).filter((x) => x.status === 'ended');
  const reload = () => {
    list.reload();
    onPageChanged?.();
  };

  if (editing && current) {
    const v = current.variants.find((x: any) => x.id === editing.id) ?? editing;
    return (
      <>
        {renderEditor({ ...page, id: v.id, name: t('{name} – Variante {key}', { name: page.name, key: v.key }), blocks: v.blocks ?? [], seo: { ...page.seo, ...(v.seo ?? {}) }, variant: v }, async () => {
          setEditing(null);
          setCurrent(await api.get(`/api/ab-tests/${current.id}`));
        })}
      </>
    );
  }

  return (
    <div className="ab-tab" data-tour="ab-tab">
      {active ? (
        current ? (
          <TestPanel test={current} funnel={funnel} reload={reload} setTest={setCurrent} onEdit={(v) => setEditing(v)} />
        ) : (
          <Spinner />
        )
      ) : (
        <div className="card" style={{ maxWidth: 760 }} data-tour="ab-start">
          <h3 style={{ marginTop: 0 }}>
            <Icon name="branch" /> {t('A/B-Test für „{name}“', { name: page.name })}
          </h3>
          <p className="muted">
            {t('Teste eine zweite Version dieser Seite gegen das Original: Wir legen Variante B als Kopie an, du änderst z. B. Überschrift oder Button. Besucher werden nach deiner Aufteilung verteilt und sehen immer dieselbe Variante. Gezählt wird, wer das Ziel erreicht.')}
          </p>
          <GoalPicker goal={goal} onChange={setGoal} funnel={funnel} pageId={page.id} />
          <button
            className="btn"
            onClick={async () => {
              const r = await act(() => api.post('/api/ab-tests', { page_id: page.id, goal }), t('Test angelegt – jetzt Variante B bearbeiten'));
              if (r) {
                await list.reload();
                setCurrent(r);
              }
            }}
          >
            {t('A/B-Test anlegen')}
          </button>
        </div>
      )}
      {past.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <h3>{t('Frühere Tests')}</h3>
          {past.map((x) => (
            <div key={x.id} className="card ab-past">
              <div className="row" style={{ alignItems: 'center' }}>
                <strong>{x.name}</strong>
                <Badge tone="blue">{t('beendet {date}', { date: d(x.ended_at) })}</Badge>
                <span className="muted small">{t('Ziel:')} {goalText(x)}</span>
              </div>
              <div className="small" style={{ marginTop: 6 }}>
                {x.variants.map((v: any) => (
                  <span key={v.id} className="ab-past-v">
                    <span className="ab-key">{v.key}</span> {pct(v.rate)} ({v.conversions}/{v.visitors}){x.winner_id === v.id && <Badge tone="green">{t('Gewinner')}</Badge>}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Small marker next to page buttons: a test is running on this page. */
export function useRunningTests(funnelId: string) {
  const list = useLoad(() => api.get<any[]>(`/api/ab-tests?funnel_id=${funnelId}&status=running`).catch(() => []), [funnelId]);
  return new Set((list.data ?? []).map((t) => t.page_id));
}
