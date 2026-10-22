import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { saveBlob } from '../ios/share';
import { DISCLAIMER, csvDe, defaultInput, exportRows, normalizeInput, run, type CalcInput, type MetricKey, type RunResult } from '../../../server/services/calc-engine';
import { PRESETS, presetInput } from '../../../server/services/calc-presets';
import { KPI_ROWS, formatKpi, type Comparison, type Kpis } from '../../../server/services/calc-summary';
import { api, currentLocation, dt } from '../api';
import { Empty, Field, Input, PageHead, Spinner, Textarea, act, confirmAsk, navigate, toast, toastError, useLoad } from '../ui';
import { CalcContext, CalcModal, type CalcCtx } from './CalcKit';
import { CalcInputs } from './CalcInputs';
import { Detail, Headline, Matrix, type Focus, type Period } from './CalcResults';
import './calc.css';

/**
 * Gewinnrechner: "What do I earn at which price and how many customers – after all costs, fees and taxes?"
 * The same pure engine as the API and the MCP tools runs here in the browser (no request per keystroke); only saving a
 * scenario talks to the server. Docs: docs/gewinnrechner.md.
 */

interface ScenarioItem {
  id: string;
  name: string;
  note: string;
  preset: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  summary: Kpis | null;
}

const de = (v: number, d = 0) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: d }).format(v);
const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'szenario';
const SHORT: Record<string, string> = { 'gohigh-staffel': 'HyperLevel Staffel', 'gohigh-standort': 'HyperLevel Standort-Modell', 'saas-pro-nutzer': 'SaaS pro Nutzer', 'agentur-retainer': 'Agentur-Retainer', 'kurs-community': 'Kurs/Community', handwerk: 'Handwerk' };

const draftKey = () => `pghl.calc.draft.${currentLocation()}`;
const readDraft = (): CalcInput | null => {
  try {
    const raw = localStorage.getItem(draftKey());
    return raw ? normalizeInput(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
};
const writeDraft = (input: CalcInput | null) => {
  try {
    if (input) localStorage.setItem(draftKey(), JSON.stringify(input));
    else localStorage.removeItem(draftKey());
  } catch {
    /* storage blocked: the draft is just not kept */
  }
};

function download(name: string, text: string, type: string) {
  void saveBlob(new Blob([text], { type }), name);
}

export function Calc({ id }: { id?: string }) {
  const [input, setInput] = useState<CalcInput>(() => (id ? defaultInput() : (readDraft() ?? defaultInput())));
  const [scenario, setScenario] = useState<{ id: string; name: string; note: string } | null>(null);
  const [baseline, setBaseline] = useState<string>('');
  const [presetKey, setPresetKey] = useState<string | null>(null);
  const [metric, setMetric] = useState<MetricKey>('net_profit');
  const [period, setPeriod] = useState<Period>('month');
  const [focus, setFocus] = useState<Focus>({ cell: null });
  const [pane, setPane] = useState<'inputs' | 'results'>('results');
  const [modal, setModal] = useState<null | 'save' | 'scenarios'>(null);
  const list = useLoad<ScenarioItem[]>(() => api.get('/api/calc/scenarios'), []);

  const ctx: CalcCtx = useMemo(
    () => ({
      input,
      set: (path, value) =>
        setInput((cur) => {
          const copy: any = JSON.parse(JSON.stringify(cur));
          const parts = path.split('.');
          let o = copy;
          for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
          o[parts[parts.length - 1]] = value;
          return copy;
        }),
      update: (fn) =>
        setInput((cur) => {
          const copy: CalcInput = JSON.parse(JSON.stringify(cur));
          fn(copy);
          return copy;
        }),
    }),
    [input],
  );

  // Opening /app/calc/<id> or /app/calc?preset=<key> loads that scenario / preset.
  const loaded = useRef('');
  const applyScenario = useCallback((s: any) => {
    setInput(s.input);
    setBaseline(JSON.stringify(s.input));
    setScenario({ id: s.id, name: s.name, note: s.note });
    setPresetKey(s.preset);
    setFocus({ cell: null });
  }, []);
  const openScenario = useCallback(
    (sid: string) => {
      loaded.current = `s:${sid}`;
      api
        .get(`/api/calc/scenarios/${encodeURIComponent(sid)}`)
        .then(applyScenario)
        .catch((e) => {
          toastError(e);
          loaded.current = '';
          navigate('calc');
        });
      if (id !== sid) navigate(`calc/${sid}`);
    },
    [id, applyScenario],
  );
  useEffect(() => {
    const preset = new URLSearchParams(location.search).get('preset');
    const want = id ? `s:${id}` : preset ? `p:${preset}` : '';
    if (!want || loaded.current === want) return;
    if (id) openScenario(id);
    else if (preset && presetInput(preset)) {
      loaded.current = want;
      setInput(presetInput(preset)!);
      setPresetKey(preset);
      setScenario(null);
      setBaseline('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // The unsaved work survives a reload (per browser and sub-account; nothing is sent anywhere).
  useEffect(() => {
    const t = setTimeout(() => writeDraft(input), 400);
    return () => clearTimeout(t);
  }, [input]);

  const deferred = useDeferredValue(input);
  const last = useRef<{ input: CalcInput; res: RunResult } | null>(null);
  const calc = useMemo(() => {
    try {
      const n = normalizeInput(deferred);
      const rows = n.matrix.customers;
      const cols = n.matrix.columns === 'plan' ? n.pricing.plans.length : n.matrix.columns === 'factor' ? n.matrix.factors.length : n.matrix.prices.length;
      const cell = focus.cell && focus.cell.row < rows.length && focus.cell.col < cols ? focus.cell : null;
      const res = run(n, { customers: cell ? rows[cell.row] : n.customers.count, column: cell ? cell.col : -1, sensitivity: true });
      last.current = { input: n, res };
      return { ok: true as const, input: n, res, cell, error: '' };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message, input: last.current?.input, res: last.current?.res, cell: null };
    }
  }, [deferred, focus]);

  const dirty = scenario ? JSON.stringify(input) !== baseline : false;

  const loadPreset = useCallback((key: string) => {
    const p = presetInput(key);
    if (!p) return;
    setInput(p);
    setPresetKey(key);
    setFocus({ cell: null });
    toast(`Vorlage „${PRESETS.find((x) => x.key === key)?.name ?? key}“ geladen`);
  }, []);

  const reset = () => {
    if (!confirmAsk('Alle Eingaben auf die Standardwerte zurücksetzen?')) return;
    setInput(defaultInput());
    setPresetKey(null);
    setScenario(null);
    setBaseline('');
    setFocus({ cell: null });
    loaded.current = '';
    if (id) navigate('calc');
  };

  const exportCsv = () => {
    if (!calc.res) return;
    download(`gewinnrechner-${slug(scenario?.name ?? (presetKey ? SHORT[presetKey] : '') ?? '')}.csv`, csvDe(exportRows(calc.res)), 'text/csv;charset=utf-8');
  };
  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(input, null, 2));
      toast('Eingabe als JSON kopiert – für die API oder den Agenten');
    } catch (e) {
      toastError(e);
    }
  };

  const res = calc.res;
  const inp = calc.input;
  const focusLabel = res && inp ? (calc.cell ? `Bei ${de(res.focus.customers)} Kunden zu ${res.focus.column.label}` : `Deine Rechnung: ${de(res.focus.customers)} Kunden${inp.matrix.columns === 'plan' ? '' : ' zu den eingegebenen Preisen'}`) : '';

  return (
    <CalcContext.Provider value={ctx}>
      <div className="calc" data-pane={pane}>
        <PageHead title="Gewinnrechner" sub="Was bleibt bei welchem Preis und wie vielen Kunden nach Steuern, Gebühren und Kosten übrig? Werte ändern – die Tabelle rechnet sofort.">
          <div className="calc-actions">
            <button type="button" className="btn secondary small" onClick={() => setModal('scenarios')} data-tour="calc-scenarios">
              Szenarien{list.data?.length ? ` (${list.data.length})` : ''}
            </button>
            <button type="button" className="btn small" onClick={() => setModal('save')} data-tour="calc-save">
              {scenario ? (dirty ? 'Speichern *' : 'Speichern') : 'Als Szenario speichern'}
            </button>
            <button type="button" className="btn secondary small" onClick={exportCsv} disabled={!res} data-tour="calc-export">
              CSV
            </button>
            <button type="button" className="btn ghost small" onClick={copyJson} title="Die Eingabe als JSON – zum Einfügen in die API oder für den Agenten">
              JSON
            </button>
          </div>
        </PageHead>

        <p className="calc-disclaimer" role="note" data-tour="calc-disclaimer">
          <strong>{DISCLAIMER}.</strong> Die Zahlen sind eine Rechenhilfe mit vereinfachten Annahmen; die Steuern ersetzen keine Beratung.
        </p>

        <div className="calc-presets" data-tour="calc-presets" role="group" aria-label="Vorlagen">
          <span className="muted small">Vorlage:</span>
          {PRESETS.map((p) => (
            <button key={p.key} type="button" className={`chip${presetKey === p.key ? ' on' : ''}`} onClick={() => loadPreset(p.key)} title={p.description} aria-pressed={presetKey === p.key}>
              {SHORT[p.key] ?? p.name}
            </button>
          ))}
        </div>
        {scenario && (
          <p className="calc-scenario-line small">
            Szenario: <strong>{scenario.name}</strong>
            {dirty && <span className="calc-warn"> – ungespeicherte Änderungen</span>}
          </p>
        )}

        <div className="calc-pane-switch seg" role="group" aria-label="Ansicht">
          <button type="button" className={pane === 'inputs' ? 'on' : ''} onClick={() => setPane('inputs')} aria-pressed={pane === 'inputs'}>
            Eingaben
          </button>
          <button type="button" className={pane === 'results' ? 'on' : ''} onClick={() => setPane('results')} aria-pressed={pane === 'results'}>
            Ergebnis
          </button>
        </div>

        <div className="calc-grid">
          <aside className="calc-inputs card" aria-label="Eingaben">
            <div className="calc-inputs-head">
              <h3>Eingaben</h3>
              <button type="button" className="btn ghost small" onClick={reset}>
                Zurücksetzen
              </button>
            </div>
            <CalcInputs />
          </aside>

          <div className="calc-results">
            {!calc.ok && (
              <p className="calc-callout bad" role="alert">
                Eingabe prüfen: {calc.error}
              </p>
            )}
            {res && inp ? (
              <>
                <Headline input={inp} res={res} />
                <Matrix res={res} metric={metric} setMetric={setMetric} period={period} setPeriod={setPeriod} focus={{ cell: calc.cell }} setFocus={setFocus} />
                <Detail input={inp} res={res} period={period} focusLabel={focusLabel} isCell={!!calc.cell} onReset={() => setFocus({ cell: null })} />
              </>
            ) : (
              <Spinner />
            )}
            <section className="card calc-agent" data-tour="calc-agent">
              <h3>Mit dem HyperLevel Agent rechnen</h3>
              <p className="muted small">Der Agent und externe KI-Clients (Claude, ChatGPT, Codex über MCP) benutzen genau diesen Rechner: Fragen stellen, Szenarien speichern, vergleichen. Ein Klick legt die Frage in den Agenten.</p>
              <div className="calc-agent-chips">
                {[
                  'Was bleibt bei 300 Kunden im HyperLevel Standort-Modell nach allen Kosten und Steuern übrig?',
                  'Ab wie vielen Kunden bin ich mit der HyperLevel Staffel im Plus?',
                  'Welcher Grundpreis bringt bei 200 Kunden 5.000 € Nettogewinn im Monat?',
                  'Vergleiche meine gespeicherten Szenarien im Gewinnrechner.',
                ].map((q) => (
                  <button key={q} type="button" className="chip" onClick={() => window.dispatchEvent(new CustomEvent('pghl:agent', { detail: { prompt: q } }))}>
                    {q}
                  </button>
                ))}
              </div>
            </section>
          </div>
        </div>

        {modal === 'save' && (
          <SaveModal
            input={input}
            presetKey={presetKey}
            scenario={scenario}
            onClose={() => setModal(null)}
            onSaved={(s) => {
              setScenario({ id: s.id, name: s.name, note: s.note });
              setBaseline(JSON.stringify(s.input));
              loaded.current = `s:${s.id}`;
              list.reload();
              setModal(null);
              if (id !== s.id) navigate(`calc/${s.id}`);
            }}
          />
        )}
        {modal === 'scenarios' && (
          <ScenariosModal
            items={list.data}
            loading={list.loading}
            currentId={scenario?.id}
            onClose={() => setModal(null)}
            onChanged={() => list.reload()}
            onOpen={(sid) => {
              setModal(null);
              openScenario(sid);
            }}
            onDeleted={(sid) => {
              if (scenario?.id === sid) {
                setScenario(null);
                setBaseline('');
                loaded.current = '';
                if (id) navigate('calc');
              }
            }}
          />
        )}
      </div>
    </CalcContext.Provider>
  );
}

// --- save -------------------------------------------------------------------------------------------------------------------------

function SaveModal({ input, presetKey, scenario, onClose, onSaved }: { input: CalcInput; presetKey: string | null; scenario: { id: string; name: string; note: string } | null; onClose: () => void; onSaved: (s: any) => void }) {
  const [mode, setMode] = useState<'update' | 'new'>(scenario ? 'update' : 'new');
  const [name, setName] = useState(scenario?.name ?? '');
  const [note, setNote] = useState(scenario?.note ?? '');
  const [busy, setBusy] = useState(false);
  const update = mode === 'update' && !!scenario;
  const save = async () => {
    setBusy(true);
    const s = await act(
      () => (update ? api.patch(`/api/calc/scenarios/${scenario!.id}`, { name, note, input }) : api.post('/api/calc/scenarios', { name, note, preset: presetKey ?? undefined, input })),
      update ? 'Szenario aktualisiert' : 'Szenario gespeichert',
    );
    setBusy(false);
    if (s) onSaved(s);
  };
  return (
    <CalcModal
      title="Szenario speichern"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" onClick={save} disabled={busy || !name.trim()}>
            {update ? 'Aktualisieren' : 'Speichern'}
          </button>
        </>
      }
    >
      {scenario && (
        <div className="seg calc-save-mode" role="group" aria-label="Speichern als">
          <button type="button" className={mode === 'update' ? 'on' : ''} onClick={() => (setMode('update'), setName(scenario.name), setNote(scenario.note))}>
            „{scenario.name}“ überschreiben
          </button>
          <button type="button" className={mode === 'new' ? 'on' : ''} onClick={() => (setMode('new'), setName(`${scenario.name} (Kopie)`))}>
            Als neues Szenario
          </button>
        </div>
      )}
      <Field label="Name">
        <Input value={name} onChange={setName} maxLength={80} placeholder="z. B. Standort-Modell, 300 Kunden" autoFocus />
      </Field>
      <Field label="Notiz (optional)" hint="Wofür ist das Szenario? Wer hat es geprüft?">
        <Textarea value={note} onChange={setNote} rows={3} maxLength={500} />
      </Field>
      <p className="muted small">Gespeichert wird die komplette Eingabe für diesen Sub-Account. Der Agent und die API finden das Szenario unter diesem Namen.</p>
    </CalcModal>
  );
}

// --- scenarios, comparison -----------------------------------------------------------------------------------------------------

function ScenariosModal({ items, loading, currentId, onClose, onChanged, onOpen, onDeleted }: { items: ScenarioItem[] | undefined; loading: boolean; currentId?: string; onClose: () => void; onChanged: () => void; onOpen: (id: string) => void; onDeleted: (id: string) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 6 ? p : [...p, id]));
  const compare = async () => {
    const r = await act(() => api.post<Comparison>('/api/calc/compare', { ids: picked }));
    if (r) setCmp(r);
  };
  const remove = async (s: ScenarioItem) => {
    if (!confirmAsk(`Szenario „${s.name}“ löschen?`)) return;
    if (await act(() => api.del(`/api/calc/scenarios/${s.id}`), 'Szenario gelöscht')) {
      setPicked((p) => p.filter((x) => x !== s.id));
      onDeleted(s.id);
      onChanged();
    }
  };
  return (
    <CalcModal title={cmp ? 'Szenarien im Vergleich' : 'Gespeicherte Szenarien'} onClose={onClose} wide footer={cmp ? <button className="btn secondary" onClick={() => setCmp(null)}>Zurück zur Liste</button> : undefined}>
      {cmp ? (
        <CompareTable cmp={cmp} />
      ) : loading && !items ? (
        <Spinner />
      ) : !items?.length ? (
        <Empty>Noch kein Szenario gespeichert. Stelle links Preise und Kosten ein und speichere die Rechnung mit „Als Szenario speichern“.</Empty>
      ) : (
        <>
          <div className="table-wrap">
            <table className="t calc-scn">
              <thead>
                <tr>
                  <th aria-label="Zum Vergleich wählen" />
                  <th>Name</th>
                  <th className="num">Kunden</th>
                  <th className="num">Nettogewinn/Monat</th>
                  <th className="num">Break-even</th>
                  <th>Geändert</th>
                  <th aria-label="Aktionen" />
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.id} className={s.id === currentId ? 'cur' : ''}>
                    <td>
                      <input type="checkbox" checked={picked.includes(s.id)} onChange={() => toggle(s.id)} aria-label={`${s.name} zum Vergleich wählen`} />
                    </td>
                    <td className="strong">
                      {s.name}
                      {s.note && <div className="muted small">{s.note}</div>}
                    </td>
                    <td className="num">{s.summary ? de(s.summary.customers) : '–'}</td>
                    <td className={`num${s.summary && s.summary.net_profit_month < 0 ? ' neg' : ''}`}>{s.summary ? formatKpi(s.summary.net_profit_month, 'eur') : '–'}</td>
                    <td className="num">{s.summary?.breakeven_customers == null ? 'nie' : `ab ${de(s.summary.breakeven_customers)}`}</td>
                    <td className="small muted">
                      {dt(s.updated_at)}
                      {s.created_by ? ` · ${s.created_by}` : ''}
                    </td>
                    <td className="calc-scn-actions">
                      <button className="btn secondary small" onClick={() => onOpen(s.id)}>
                        Öffnen
                      </button>
                      <button className="icon-btn" onClick={() => remove(s)} aria-label={`${s.name} löschen`} title="Löschen">
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="calc-scn-foot">
            <button className="btn" onClick={compare} disabled={picked.length < 2}>
              {picked.length < 2 ? 'Zum Vergleich mindestens zwei wählen' : `${picked.length} Szenarien vergleichen`}
            </button>
            <span className="muted small">Bis zu sechs nebeneinander.</span>
          </div>
        </>
      )}
    </CalcModal>
  );
}

function CompareTable({ cmp }: { cmp: Comparison }) {
  const unit = (k: keyof Kpis) => KPI_ROWS.find((r) => r.key === k)!.unit;
  return (
    <>
      <div className="table-wrap">
        <table className="t calc-cmp">
          <thead>
            <tr>
              <th>Kennzahl</th>
              {cmp.scenarios.map((s) => (
                <th key={s.id} className="num">
                  {s.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cmp.rows.map((r) => (
              <tr key={r.key}>
                <td className="strong">{r.label}</td>
                {r.values.map((v, i) => (
                  <td key={i} className={`num${r.best === i ? ' best' : ''}${v !== null && v < 0 ? ' neg' : ''}`}>
                    {formatKpi(v, unit(r.key))}
                    {i > 0 && r.deltas[i] !== null && r.deltas[i] !== 0 && (
                      <div className="muted small">
                        {r.deltas[i]! > 0 ? '+' : '−'}
                        {formatKpi(Math.abs(r.deltas[i]!), unit(r.key))}
                      </div>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small calc-foot">Unterschied jeweils zum ersten Szenario; das beste Ergebnis je Zeile ist hervorgehoben. {cmp.disclaimer}.</p>
    </>
  );
}
