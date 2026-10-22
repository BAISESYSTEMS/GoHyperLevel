import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../icons';
import { api, currentLocation, dt } from '../api';
import { Badge, Check, Empty, Field, Input, Link, MergeHint, Select, Spinner, Stat, TagInput, Tabs, Textarea, act, confirmAsk, toast, useLoad } from '../ui';
import { AiProviderCard } from './AiProvider';
import { SignupLink } from '../referrals';
import { MoreFields } from '../areas/fields';
import { lazyPages } from '../lazy';
import { SortableGrid } from '../sortable/Sortable';
// "Termin buchen" of the chat bot – a part of the calendar view's chunk (docs/booking.md#ai-books-appointments).
const { AiBookingSettings } = lazyPages(() => import('./AiBookingSettings'), 'AiBookingSettings');

/** KI-Assistent: settings tab, inbox helpers (suggest button, side panel) and the workflow step. */

const DAYS: [string, string][] = [
  ['mon', 'Montag'],
  ['tue', 'Dienstag'],
  ['wed', 'Mittwoch'],
  ['thu', 'Donnerstag'],
  ['fri', 'Freitag'],
  ['sat', 'Samstag'],
  ['sun', 'Sonntag'],
];
const MODES: [string, string][] = [
  ['off', 'Aus – nur Vorschläge für das Team'],
  ['after_hours', 'Außerhalb der Geschäftszeiten antworten'],
  ['always', 'Immer antworten'],
];
const STATUS: Record<string, [string, 'green' | 'red' | 'yellow']> = { ok: ['ok', 'green'], error: ['Fehler', 'red'], blocked: ['Limit', 'yellow'] };

const usd = (v: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: v > 0 && v < 0.1 ? 4 : 2 }).format(v || 0);
const n = (v: number) => new Intl.NumberFormat('de-DE').format(v || 0);

export const isBotMessage = (m: any) => typeof m?.source === 'string' && m.source.startsWith('KI-');

/** Shared, briefly cached: is the assistant on for this sub-account? */
let statusCache: { at: number; loc: string; p: Promise<any> } | null = null;
function useAiStatus() {
  const loc = currentLocation();
  return useLoad(() => {
    if (!statusCache || statusCache.loc !== loc || Date.now() - statusCache.at > 60_000) statusCache = { at: Date.now(), loc, p: api.get('/api/ai/status').catch(() => ({ enabled: false })) };
    return statusCache.p;
  }, [loc]);
}

// --- settings ------------------------------------------------------------------------------

export function AiSettings() {
  const info = useLoad(() => api.get<any>('/api/ai/settings'), []);
  const [s, setS] = useState<any>();
  const [key, setKey] = useState('');
  const [editKey, setEditKey] = useState(false);
  const [tab, setTab] = useState('setup');
  const [picked, setPicked] = useState<string | null>(null);
  const providerDraft = useRef<Record<string, string> | null>(null);
  const [providerVersion, setProviderVersion] = useState(0);
  useEffect(() => setS(info.data?.settings), [info.data]);
  if (!s || !info.data) return info.error ? <Empty>{info.error}</Empty> : <Spinner />;
  const d = info.data;
  // OpenAI chosen (modules/ai-providers.ts): the Anthropic key and model fields step aside.
  const savedOpenai = d.provider?.id === 'openai';
  const openai = (picked ?? d.provider?.id) === 'openai';
  const set = (p: any) => setS({ ...s, ...p });
  const save = async (extra: any = {}) => {
    // An unsaved provider choice (and OpenAI key/model) is saved first, so „einschalten“ checks the right key.
    if (providerDraft.current) {
      const ok = await act(() => api.put('/api/ai/provider', providerDraft.current));
      if (!ok) return;
      providerDraft.current = null;
      setProviderVersion((v) => v + 1);
    }
    const r = await act(() => api.put('/api/ai/settings', { ...s, ...(key.trim() ? { api_key: key.trim() } : {}), ...extra }), 'Gespeichert');
    if (r) {
      info.setData(r);
      setKey('');
      setEditKey(false);
      statusCache = null;
    }
  };
  const saveBtn = (
    <p>
      <button className="btn" onClick={() => save()}>
        Speichern
      </button>
    </p>
  );
  return (
    <div style={{ maxWidth: 860 }}>
      <div className="card ai-status" data-tour="ai-status">
        <Icon name="ai" size={20} />
        <div className="grow">
          <strong>KI-Assistent {d.settings.enabled ? <Badge tone="green">an</Badge> : <Badge>aus</Badge>}</strong>
          <div className="muted small">
            {d.settings.enabled
              ? `${savedOpenai ? `OpenAI · ${d.provider.model}` : (d.models.find((m: any) => m.id === d.settings.model)?.label ?? d.settings.model)} · Live-Chat-Bot: ${MODES.find(([k]) => k === d.settings.bot_mode)?.[1]}${d.settings.bot_mode !== 'off' ? (d.bot_active_now ? ' (antwortet gerade)' : ' (schweigt gerade)') : ''}`
              : `Vorschläge, Zusammenfassungen und Chat-Bot mit ${savedOpenai ? 'OpenAI (GPT)' : 'Claude'} – mit deinem eigenen ${savedOpenai ? 'OpenAI' : 'Anthropic'}-Schlüssel.`}
          </div>
        </div>
        <div className="ai-usage-mini">
          <div className="small muted">
            Diesen Monat {usd(d.usage.cost_usd)} von {usd(d.usage.limit_usd)}
          </div>
          <div className="bar">
            <div style={{ width: `${Math.min(100, (d.usage.cost_usd / d.usage.limit_usd) * 100)}%` }} />
          </div>
        </div>
      </div>
      <Tabs
        tabs={[
          ['setup', 'Einrichtung'],
          ['knowledge', 'Wissen'],
          ['bot', 'Live-Chat-Bot'],
          ['usage', 'Nutzung & Limit'],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'setup' && (
        <div className="card">
          <AiProviderCard onChange={() => info.reload()} onPick={setPicked} onDraft={(b) => (providerDraft.current = b)} version={providerVersion} />
          {!openai && (
          <>
          <Field
            tour="ai-key"
            label="Anthropic-API-Schlüssel"
            hint={
              <>
                Bekommst du in der <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">Anthropic Console</a> unter „API Keys“. Er wird verschlüsselt gespeichert und nie wieder angezeigt; die Kosten laufen über dein Anthropic-Konto. <SignupLink id="anthropic" />
              </>
            }
          >
            {d.key_set && !editKey ? (
              <div className="row" style={{ alignItems: 'center' }}>
                <Badge tone="green">hinterlegt {d.key_hint}</Badge>
                <button className="btn small secondary" onClick={() => setEditKey(true)}>
                  Ersetzen
                </button>
                <button className="btn small secondary" onClick={() => confirmAsk('Schlüssel entfernen? Der Assistent wird dann ausgeschaltet.') && save({ api_key: null, enabled: false })}>
                  Entfernen
                </button>
              </div>
            ) : (
              <Input type="password" autoComplete="off" value={key} onChange={setKey} placeholder={d.key_source === 'server' ? 'leer = Schlüssel des Servers nutzen' : 'sk-ant-…'} />
            )}
          </Field>
          {d.key_source === 'server' && !d.key_set && <p className="muted small">Es wird der Schlüssel aus der Server-Umgebung genutzt (PGHL_ANTHROPIC_API_KEY).</p>}
          <p>
            <button
              className="btn secondary"
              disabled={!key.trim() && !d.key_set && d.key_source !== 'server'}
              onClick={async () => {
                const r = await act(() => api.post('/api/ai/test', { api_key: key.trim() || undefined, model: s.model }));
                if (r) toast(`Verbindung ok – ${r.name} erreichbar`);
              }}
            >
              Verbindung testen
            </button>
          </p>
          </>
          )}
          <Check checked={s.enabled} onChange={(v) => set({ enabled: v })} label="KI-Assistent einschalten" />
          <div className="grid2">
            {!openai && (
              <Field tour="ai-model" label="Modell" hint="Sonnet reicht für fast alles; Opus für knifflige Fälle, Haiku für viel Chat zu kleinem Preis.">
                <Select value={s.model} onChange={(v) => set({ model: v })} options={d.models.map((m: any) => [m.id, m.label])} />
              </Field>
            )}
          </div>
          <Field tour="ai-facts" label="Fakten zum Unternehmen" hint="Leistungen, Preise, Region, Öffnungszeiten, Ansprechpartner, Links (Termin buchen, Preisliste) …">
            <Textarea value={s.facts} onChange={(v) => set({ facts: v })} rows={6} />
          </Field>
          <MoreFields id="ai-persona" values={[s.assistant_name, s.persona]}>
            <Field label="Name im Chat">
              <Input value={s.assistant_name} onChange={(v) => set({ assistant_name: v })} placeholder="z. B. Paula" />
            </Field>
            <Field tour="ai-persona" label="Tonfall & Persona" hint="Wie soll der Assistent klingen? Du oder Sie, locker oder förmlich, was ist tabu?">
              <Textarea value={s.persona} onChange={(v) => set({ persona: v })} rows={3} />
            </Field>
          </MoreFields>
          {key.trim() && !s.enabled && <p className="muted small">Tipp: Haken bei „einschalten“ setzen, damit der Assistent nach dem Speichern loslegt.</p>}
          {saveBtn}
        </div>
      )}
      {tab === 'knowledge' && (
        <div className="card" data-tour="ai-knowledge">
          <h2>Fragen & Antworten</h2>
          <p className="muted small">Der Assistent nutzt nur dieses Wissen als Fakten – was hier nicht steht, gibt er ans Team weiter.</p>
          {s.knowledge.map((k: any, i: number) => (
            <div key={i} className="ai-qa">
              <Input value={k.q} onChange={(v) => set({ knowledge: s.knowledge.map((x: any, j: number) => (j === i ? { ...x, q: v } : x)) })} placeholder="Frage, z. B. Was kostet eine Website?" />
              <Textarea value={k.a} onChange={(v) => set({ knowledge: s.knowledge.map((x: any, j: number) => (j === i ? { ...x, a: v } : x)) })} rows={2} placeholder="Antwort" />
              <button className="icon-btn" aria-label="Frage entfernen" onClick={() => set({ knowledge: s.knowledge.filter((_: any, j: number) => j !== i) })}>
                ✕
              </button>
            </div>
          ))}
          <p>
            <button className="btn small secondary" onClick={() => set({ knowledge: [...s.knowledge, { q: '', a: '' }] })}>
              + Frage hinzufügen
            </button>
          </p>
          <Field label="Weiteres Wissen (Freitext)" hint="Abläufe, Bedingungen, Lieferzeiten, Garantie, Datenschutz-Hinweise … Keine Passwörter oder Zugangsdaten eintragen.">
            <Textarea value={s.knowledge_text} onChange={(v) => set({ knowledge_text: v })} rows={8} />
          </Field>
          <Check checked={s.use_project_profile} onChange={(v) => set({ use_project_profile: v })} label={<>Projekt-Steckbrief mitschicken {d.sources.profile ? <Badge tone="green">vorhanden</Badge> : <Badge>leer</Badge>}</>} />
          <Check checked={s.use_faq_blocks} onChange={(v) => set({ use_faq_blocks: v })} label={<>FAQ-Blöcke aus Funnels & Websites mitschicken <Badge tone={d.sources.faq_count ? 'green' : 'gray'}>{d.sources.faq_count} Fragen</Badge></>} />
          <p className="muted small">Kontaktdaten, die letzten 20 Nachrichten und dieses Wissen gehen bei jeder Anfrage an Claude; Schlüssel, Passwörter, Kartennummern und IBANs werden vorher entfernt. Das Wissen wird zwischengespeichert (Prompt-Caching), wiederholte Anfragen kosten dafür nur einen Bruchteil.</p>
          {saveBtn}
        </div>
      )}
      {tab === 'bot' && <BotSettings s={s} set={set} d={d} saveBtn={saveBtn} />}
      {tab === 'bot' && <AiBookingSettings />}
      {tab === 'usage' && <Usage s={s} set={set} saveBtn={saveBtn} />}
    </div>
  );
}

function BotSettings({ s, set, d, saveBtn }: { s: any; set: (p: any) => void; d: any; saveBtn: ReactNode }) {
  const pipelines = useLoad(() => api.get<any[]>('/api/pipelines'), []);
  const pipe = (pipelines.data ?? []).find((p) => p.id === s.pipeline_id);
  const hours = s.business_hours;
  const setDay = (day: string, p: any) => set({ business_hours: { ...hours, [day]: { ...hours[day], ...p } } });
  return (
    <div className="card">
      <Field label="Website-Chat" hint={<>Der Bot antwortet im Live-Chat (Einstellungen → Live-Chat). Seine Nachrichten sind im Posteingang lila markiert und beginnen mit 🤖.</>}>
        <Select value={s.bot_mode} onChange={(v) => set({ bot_mode: v })} options={MODES} />
      </Field>
      {s.bot_mode !== 'off' && (
        <p className="small">
          {d.open_now ? 'Gerade ist Geschäftszeit' : 'Gerade ist außerhalb der Geschäftszeiten'} ({d.timezone}) – {d.bot_active_now ? <Badge tone="green">Bot antwortet</Badge> : <Badge>Bot schweigt</Badge>}
          <span className="muted"> (Stand nach dem letzten Speichern)</span>
        </p>
      )}
      <h2 style={{ marginTop: 16 }}>Geschäftszeiten</h2>
      <p className="muted small">Gleiche Uhrzeit bei „von“ und „bis“ (z. B. 00:00–00:00) = rund um die Uhr.</p>
      <div className="ai-hours">
        {DAYS.map(([k, l]) => (
          <div key={k} className="ai-hours-row">
            <Check checked={hours[k]?.open} onChange={(v) => setDay(k, { open: v })} label={l} />
            <input type="time" value={hours[k]?.from ?? '09:00'} disabled={!hours[k]?.open} onChange={(e) => setDay(k, { from: e.target.value })} aria-label={`${l} von`} />
            <span className="muted">bis</span>
            <input type="time" value={hours[k]?.to ?? '17:00'} disabled={!hours[k]?.open} onChange={(e) => setDay(k, { to: e.target.value })} aria-label={`${l} bis`} />
          </div>
        ))}
      </div>
      <h2 style={{ marginTop: 16 }}>Übergabe an das Team</h2>
      <p className="muted small">Der Bot übergibt, wenn jemand einen Menschen verlangt, ein Stichwort fällt, er unsicher ist oder die Höchstzahl an Antworten erreicht ist. Das Team bekommt eine E-Mail (Firmen-E-Mail), der Bot schweigt danach in diesem Gespräch.</p>
      <Field label="Stichwörter für sofortige Übergabe">
        <TagInput value={s.handoff_keywords} onChange={(v) => set({ handoff_keywords: v })} placeholder="Wort + Enter" />
      </Field>
      <Field label="Text bei Übergabe">
        <Input value={s.handoff_message} onChange={(v) => set({ handoff_message: v })} />
      </Field>
      <MoreFields id="ai-bot-handoff">
      <div className="grid2">
        <Field label={`Mindest-Sicherheit: ${Math.round(s.min_confidence * 100)} %`} hint="Darunter übergibt der Bot statt zu raten.">
          <input type="range" min={0} max={100} step={5} value={Math.round(s.min_confidence * 100)} onChange={(e) => set({ min_confidence: Number(e.target.value) / 100 })} />
        </Field>
        <Field label="Höchstens Bot-Antworten pro Gespräch">
          <Input type="number" min={1} max={50} value={s.max_bot_replies} onChange={(v) => set({ max_bot_replies: Number(v) })} />
        </Field>
      </div>
      </MoreFields>
      <h2 style={{ marginTop: 16 }}>Leads</h2>
      <Check checked={s.lead_capture} onChange={(v) => set({ lead_capture: v })} label="Nach Name und E-Mail fragen, wenn sie fehlen, und den Kontakt ergänzen" />
      <Check checked={s.create_opportunity} onChange={(v) => set({ create_opportunity: v })} label="Bei Kaufinteresse eine Opportunity anlegen" />
      {s.create_opportunity && (
        <div className="grid2">
          <Field label="Pipeline">
            <Select value={s.pipeline_id} onChange={(v) => set({ pipeline_id: v, stage_id: '' })} placeholder="wählen…" options={(pipelines.data ?? []).map((p) => [p.id, p.name])} />
          </Field>
          {pipe && (
            <Field label="Stufe">
              <Select value={s.stage_id} onChange={(v) => set({ stage_id: v })} placeholder="erste Stufe" options={pipe.stages.map((x: any) => [x.id, x.name])} />
            </Field>
          )}
        </div>
      )}
      <Check checked={s.create_task} onChange={(v) => set({ create_task: v })} label="Bei Kaufinteresse eine Aufgabe „Chat-Lead nachfassen“ anlegen" />
      <h2 style={{ marginTop: 16 }}>E-Mail</h2>
      <Check checked={s.email_drafts} onChange={(v) => set({ email_drafts: v })} label="Für eingehende E-Mails einen Antwort-Entwurf anlegen" />
      <p className="muted small">E-Mails verschickt der Assistent nie selbst – Entwürfe erscheinen in der Konversation zum Prüfen, Senden oder Verwerfen (höchstens 30 pro Stunde).</p>
      {saveBtn}
    </div>
  );
}

function Usage({ s, set, saveBtn }: { s: any; set: (p: any) => void; saveBtn: ReactNode }) {
  const u = useLoad(() => api.get<any>('/api/ai/usage?limit=200'), []);
  if (!u.data) return u.error ? <Empty>{u.error}</Empty> : <Spinner />;
  const m = u.data.month;
  const pct = Math.min(100, (m.cost_usd / m.limit_usd) * 100);
  const label = (p: string) => u.data.purposes[p] ?? p;
  return (
    <>
      <SortableGrid id="ai-assistant.stats" className="stats">
        <Stat label="Kosten diesen Monat" value={usd(m.cost_usd)} sub={<>von {usd(m.limit_usd)} Limit</>} />
        <Stat label="Tokens" value={n(m.tokens)} sub={m.token_limit ? `von ${n(m.token_limit)}` : 'kein Token-Limit'} />
        <Stat label="KI-Aufrufe" value={n(m.calls)} sub={`seit ${new Date(m.since).toLocaleDateString('de-DE')}`} />
      </SortableGrid>
      <div className="card">
        <div className="bar" style={{ marginBottom: 12 }}>
          <div style={{ width: `${pct}%`, background: pct >= 100 ? 'var(--red)' : pct > 80 ? 'var(--yellow)' : undefined }} />
        </div>
        <div className="grid2">
          <Field label="Monatslimit (US-Dollar)" hint="Ist es erreicht, macht der Assistent bis Monatsende nichts mehr; der Chat-Bot übergibt dann ans Team.">
            <Input type="number" min={0.01} step={1} value={s.monthly_limit_usd} onChange={(v) => set({ monthly_limit_usd: Number(v) })} />
          </Field>
          <Field label="Token-Limit pro Monat (0 = keins)">
            <Input type="number" min={0} step={10000} value={s.monthly_token_limit} onChange={(v) => set({ monthly_token_limit: Number(v) })} />
          </Field>
        </div>
        {saveBtn}
        <p className="muted small">Kosten sind nach Anthropic-Listenpreisen geschätzt (inkl. Prompt-Cache); maßgeblich ist die Abrechnung in der Anthropic Console.</p>
      </div>
      {u.data.by_purpose.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 14 }}>
          <table className="t">
            <thead>
              <tr>
                <th>Zweck</th>
                <th>Aufrufe</th>
                <th>Tokens</th>
                <th>davon aus Cache</th>
                <th>Kosten</th>
              </tr>
            </thead>
            <tbody>
              {u.data.by_purpose.map((p: any) => (
                <tr key={p.purpose}>
                  <td>{label(p.purpose)}</td>
                  <td>{n(p.calls)}</td>
                  <td>{n(p.tokens)}</td>
                  <td>{n(p.cached_tokens)}</td>
                  <td>{usd(p.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2 style={{ marginTop: 18 }}>Letzte Aufrufe</h2>
      {u.data.recent.length ? (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Zeit</th>
                <th>Zweck</th>
                <th>Modell</th>
                <th>Status</th>
                <th>Ein / Aus / Cache</th>
                <th>Kosten</th>
                <th>Hinweis</th>
              </tr>
            </thead>
            <tbody>
              {u.data.recent.map((r: any) => (
                <tr key={r.id}>
                  <td className="small">{dt(r.created_at)}</td>
                  <td>
                    {label(r.purpose)}
                    {r.conversation_id && (
                      <>
                        {' '}
                        <Link to={`conversations/${r.conversation_id}`}>
                          <Icon name="chat" size={12} />
                        </Link>
                      </>
                    )}
                  </td>
                  <td className="small mono">{r.model}</td>
                  <td>
                    <Badge tone={STATUS[r.status]?.[1] ?? 'gray'}>{STATUS[r.status]?.[0] ?? r.status}</Badge>
                  </td>
                  <td className="small">
                    {n(r.input_tokens)} / {n(r.output_tokens)} / {n(r.cache_read_tokens + r.cache_write_tokens)}
                  </td>
                  <td>{usd(r.cost_usd)}</td>
                  <td className="small muted" style={{ maxWidth: 260 }}>
                    {r.error}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>Noch keine KI-Aufrufe.</Empty>
      )}
    </>
  );
}

// --- inbox ---------------------------------------------------------------------------------

/** "Antwort vorschlagen" next to the composer: the draft lands in the text box, nothing is sent. */
export function AiComposerAddon({ contactId, conversationId, channel, setDraft }: { contactId: string; conversationId?: string; channel: string; setDraft: (body: string, subject?: string) => void }) {
  const status = useAiStatus();
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  if (!status.data?.enabled) return null;
  const go = async () => {
    setBusy(true);
    const r = await act(() => api.post('/api/ai/suggest', { conversation_id: conversationId, contact_id: conversationId ? undefined : contactId, channel, instruction: hint }));
    setBusy(false);
    if (r) {
      setDraft(r.text, r.subject);
      toast('Vorschlag eingefügt – bitte prüfen, dann senden');
    }
  };
  return (
    <div className="ai-addon">
      <button type="button" className="btn small secondary" disabled={busy} onClick={go} title="Schreibt einen Entwurf mit dem KI-Assistenten">
        <Icon name="ai" size={14} /> {busy ? 'Schreibt…' : 'Antwort vorschlagen'}
      </button>
      <input value={hint} onChange={(e) => setHint(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !busy && go()} placeholder="Hinweis an die KI (optional)" aria-label="Hinweis an die KI" />
    </div>
  );
}

/** Side panel in Konversationen: bot status, handoff, summary + next step. */
export function AiPanel({ conversationId, refreshKey }: { conversationId: string; refreshKey?: unknown }) {
  const st = useLoad(() => api.get<any>(`/api/ai/conversations/${conversationId}`).catch(() => null), [conversationId, refreshKey]);
  const [busy, setBusy] = useState(false);
  const d = st.data;
  if (!d?.enabled) return null;
  const setBot = async (bot_status: string) => {
    const r = await act(() => api.patch(`/api/ai/conversations/${conversationId}`, { bot_status }), bot_status === 'active' ? 'Bot wieder aktiv' : 'Bot pausiert');
    if (r) st.setData(r);
  };
  return (
    <aside className="ai-panel" data-tour="ai-panel">
      <h3>
        <Icon name="ai" /> KI-Assistent
      </h3>
      {d.bot_mode !== 'off' && (
        <section>
          <div className="muted small">Live-Chat-Bot</div>
          {d.bot_status === 'active' && (
            <p>
              <Badge tone="green">aktiv</Badge> <span className="small muted">{d.bot_replies} Antworten</span>
            </p>
          )}
          {d.bot_status === 'handoff' && (
            <p>
              <Badge tone="yellow">an Team übergeben</Badge>
              <br />
              <span className="small">{d.handoff_reason}</span>
              <br />
              <span className="small muted">{dt(d.handoff_at)}</span>
            </p>
          )}
          {d.bot_status === 'paused' && (
            <p>
              <Badge>pausiert</Badge>
            </p>
          )}
          {d.bot_status === 'active' ? (
            <button className="btn small secondary" onClick={() => setBot('paused')}>
              Bot pausieren
            </button>
          ) : (
            <button className="btn small secondary" onClick={() => setBot('active')}>
              Bot wieder übernehmen lassen
            </button>
          )}
        </section>
      )}
      <section>
        <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="muted small">Zusammenfassung</span>
          <button
            className="btn small"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const r = await act(() => api.post('/api/ai/summarize', { conversation_id: conversationId }));
              setBusy(false);
              if (r) st.setData({ ...d, ...r });
            }}
          >
            {busy ? 'Fasst zusammen…' : d.summary ? 'Neu zusammenfassen' : 'Zusammenfassen'}
          </button>
        </div>
        {d.summary ? (
          <>
            <p className="ai-summary">{d.summary}</p>
            {d.next_step && (
              <p className="ai-next">
                <strong>Nächster Schritt:</strong> {d.next_step}
              </p>
            )}
            <div className="muted small">{dt(d.summary_at)}</div>
          </>
        ) : (
          <p className="muted small">Kurz das Wichtigste und der nächste Schritt – auf Knopfdruck.</p>
        )}
      </section>
      {(d.opportunity_id || d.task_id) && (
        <section>
          <div className="muted small">Vom Bot angelegt</div>
          {d.opportunity_id && (
            <p>
              <Link to="opportunities">
                <Icon name="deal" size={14} /> Opportunity
              </Link>
            </p>
          )}
          {d.task_id && (
            <p>
              <Link to="tasks">
                <Icon name="todo" size={14} /> Aufgabe
              </Link>
            </p>
          )}
        </section>
      )}
    </aside>
  );
}

// --- workflow step -------------------------------------------------------------------------

const TEXT_FIELDS: [string, string][] = [
  ['company', 'Firma'],
  ['city', 'Ort'],
  ['country', 'Land'],
  ['website', 'Website'],
  ['source', 'Quelle'],
];

export function AiTextStep({ step, set, customFields }: { step: any; set: (p: any) => void; customFields: any[] }) {
  const target = step.target ?? 'field';
  return (
    <>
      <Field label="Auftrag an die KI" hint="Kontaktdaten und die letzten Nachrichten bekommt die KI automatisch dazu.">
        <Textarea value={step.prompt} onChange={(v) => set({ prompt: v })} rows={6} placeholder="z. B. Schreibe eine persönliche Einleitung für {{contact.first_name}} passend zu den Tags." />
      </Field>
      <MergeHint />
      <Field label="Ergebnis">
        <Select
          value={target}
          onChange={(v) => set({ target: v })}
          options={[
            ['field', 'In ein Feld schreiben'],
            ['email_draft', 'Als E-Mail-Entwurf ablegen (wird nicht gesendet)'],
            ['note', 'Als Notiz speichern'],
          ]}
        />
      </Field>
      {target === 'field' && (
        <Field label="Feld" hint="Danach z. B. in E-Mails mit {{contact.custom.<feld>}} nutzen.">
          <Select value={step.field} onChange={(v) => set({ field: v })} placeholder="wählen…" options={[...customFields.map((f: any) => [`custom.${f.key}`, `Feld: ${f.label}`] as [string, string]), ...TEXT_FIELDS]} />
        </Field>
      )}
      {target === 'email_draft' && (
        <Field label="Betreff (Platzhalter erlaubt)">
          <Input value={step.subject} onChange={(v) => set({ subject: v })} />
        </Field>
      )}
      <p className="muted small">Nutzt den KI-Assistenten (Einstellungen → KI-Assistent) und zählt aufs Monatslimit. Fehler (z. B. Limit erreicht) stehen im Protokoll des Workflows.</p>
    </>
  );
}
