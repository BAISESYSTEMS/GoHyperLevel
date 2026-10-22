import { useState } from 'react';
import { Icon } from '../icons';
import { api } from '../api';
import { Badge, Modal, Spinner, Textarea, act, useLoad } from '../ui';
import { useT } from '../i18n';
import { Bubble, Chips, Working, usd } from '../pages/site/ai-kit';

/**
 * KI-Agenten → "Mit KI erstellen" (Agent Studio's "Build with AI"): describe the agent, review the generated config (tools from
 * the real catalogue, knowledge, safety mode, schedule) and save it as a draft agent – private, schedule off.
 */

interface Result {
  run_id: string;
  config: { name: string; emoji: string; description: string; instructions: string; model: string; mode: string; max_steps: number; knowledge: { sources: string[] }; starters: string[]; schedule: { cadence: string; time: string; prompt: string; deliver: string } | null };
  tools: { name: string; title: string; klass: string; group: string }[];
  summary: string;
  notes: string[];
  warnings: string[];
  cost_usd: number;
  attempts: number;
}

export function AgentAiCreate({ onClose, onCreated }: { onClose(): void; onCreated(agent: any): void }) {
  const t = useT('siteai');
  const status = useLoad(() => api.get<{ ready: boolean; reason: string | null; provider: { label: string; model: string }; examples: string[] }>('/api/agent-ai/status'), []);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState('');
  const [res, setRes] = useState<Result | null>(null);
  const MODE: Record<string, string> = { read: t('Nur lesen'), ask: t('Fragt vor Änderungen'), auto: t('Autonom') };
  const KNOW: Record<string, string> = { agent: t('Agent-Wissen'), ai: t('KI-Assistent'), kb: t('Hilfe-Artikel'), docs: t('Dokumente'), project: t('Projektprofil') };
  const CAD: Record<string, string> = { daily: t('täglich'), weekdays: t('werktags'), weekly: t('wöchentlich'), monthly: t('monatlich') };
  const generate = async () => {
    setBusy(t('Ich entwerfe den Agenten …'));
    const r = await act(() => api.post<Result>('/api/agent-ai/generate', { prompt }));
    setBusy('');
    if (r) setRes(r);
  };
  const save = async () => {
    if (!res) return;
    const a = await act(() => api.post(`/api/agent-ai/runs/${res.run_id}/apply`, {}), t('Als Entwurf gespeichert – privat, Zeitplan aus'));
    if (a) onCreated(a);
  };
  return (
    <Modal
      title={t('KI-Agent mit KI erstellen')}
      onClose={onClose}
      wide
      className="ai-scope"
      footer={
        res ? (
          <>
            <button className="btn secondary" disabled={!!busy} onClick={generate}>
              {t('Neu entwerfen')}
            </button>
            <button className="btn ai" disabled={!!busy} onClick={save}>
              {t('Als Entwurf speichern')}
            </button>
          </>
        ) : (
          <button className="btn ai" disabled={!!busy || prompt.trim().length < 12 || !status.data?.ready} onClick={generate}>
            <Icon name="ai" size={15} /> {t('Agent entwerfen')}
          </button>
        )
      }
    >
      {!status.data ? (
        <Spinner />
      ) : !status.data.ready ? (
        <Bubble>
          <p>{t('Die KI ist für diesen Sub-Account noch nicht bereit:')}</p>
          <p>
            <b>{status.data.reason}</b>
          </p>
        </Bubble>
      ) : !res ? (
        <>
          <Bubble>
            <p>{t('Beschreib mir deinen KI-Mitarbeiter: Was soll er tun, wann und was darf er? Ich wähle die passenden Werkzeuge aus dem Katalog und schlage Anweisungen, Sicherheitsmodus und einen Zeitplan vor.')}</p>
          </Bubble>
          <Chips label={t('Vorschläge')} items={status.data.examples.map((e, i) => [String(i), e])} onPick={(i) => setPrompt(status.data!.examples[Number(i)])} />
          <Textarea value={prompt} onChange={setPrompt} rows={4} autoFocus aria-label={t('Beschreibung des Agenten')} />
          <div className="ai-cost">
            <span>
              {status.data.provider.label}
              {status.data.provider.model ? ` · ${status.data.provider.model}` : ''}
            </span>
          </div>
        </>
      ) : (
        <>
          <Bubble>
            <p>
              <b>
                {res.config.emoji} {res.config.name}
              </b>{' '}
              – {res.summary || res.config.description}
            </p>
            {res.notes.length > 0 && (
              <ul className="ai-notes">
                {res.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
          </Bubble>
          <div className="ai-label">{t('Anweisungen')}</div>
          <pre className="ai-bubble" style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', maxHeight: 220, overflow: 'auto', margin: 0 }}>
            {res.config.instructions}
          </pre>
          <div className="ai-label">{t('Werkzeuge ({n})', { n: res.tools.length })}</div>
          <div className="ai-chips">
            {res.tools.map((x) => (
              <span key={x.name} className="ai-chip" title={x.name}>
                {x.title} <Badge tone={x.klass === 'read' ? 'gray' : x.klass === 'sensitive' ? 'red' : 'purple'}>{x.klass === 'read' ? t('liest') : x.klass === 'sensitive' ? t('versendet/löscht') : t('ändert')}</Badge>
              </span>
            ))}
          </div>
          <div className="ai-cost">
            <span>
              {t('Modus:')} <b>{MODE[res.config.mode] ?? res.config.mode}</b>
            </span>
            <span>
              {t('Schritte:')} <b>{res.config.max_steps}</b>
            </span>
            <span>
              {t('Wissen:')} <b>{res.config.knowledge.sources.map((s) => KNOW[s] ?? s).join(', ') || '–'}</b>
            </span>
            {res.config.model && (
              <span>
                {t('Modell:')} <b>{res.config.model}</b>
              </span>
            )}
          </div>
          {res.config.schedule && (
            <p className="small">
              {t('Zeitplan (gespeichert, aber ausgeschaltet):')} <b>{CAD[res.config.schedule.cadence] ?? res.config.schedule.cadence}</b> {res.config.schedule.time} – {res.config.schedule.prompt}
            </p>
          )}
          {res.warnings.length > 0 && (
            <ul className="ai-notes warn">
              {res.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <div className="ai-cost">
            <span>
              {t('Kosten:')} <b>{usd(res.cost_usd)}</b>
            </span>
            {res.attempts > 1 && <span>{t('{n} Versuche', { n: res.attempts })}</span>}
          </div>
        </>
      )}
      {busy && <Working text={busy} />}
    </Modal>
  );
}
