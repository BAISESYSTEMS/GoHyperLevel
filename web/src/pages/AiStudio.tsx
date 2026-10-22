import { useState } from 'react';
import { ConnectKey, Examples, PublishDialog } from './AiStudioPublish';
import { api } from '../api';
import { useT } from '../i18n';
import './aistudio.css';
import { Empty, Field, Input, Modal, PageHead, Select, Spinner, act, navigate, useLoad } from '../ui';
import { SortableGrid } from '../sortable/Sortable';

/**
 * AI Studio (modules/ai-studio.ts, docs/ai-studio.md): projects, the chat with tool cards and file activity, the sandboxed preview
 * and the version history; the key empty state, example prompts and publishing live in AiStudioPublish.tsx. Its own lazy chunk.
 */

/** The prompt of a picked example, handed from the project list to the new project's chat. */
const PROMPT_KEY = 'pghl.studio.prompt';
const stashPrompt = (v: string) => {
  try {
    sessionStorage.setItem(PROMPT_KEY, v);
  } catch {
    /* storage blocked: the chat starts empty */
  }
};
const takePrompt = () => {
  try {
    const v = sessionStorage.getItem(PROMPT_KEY) ?? '';
    sessionStorage.removeItem(PROMPT_KEY);
    return v;
  } catch {
    return '';
  }
};

export function AiStudio({ id }: { id?: string }) {
  return id ? <Editor id={id} /> : <Projects />;
}

function Projects() {
  const t = useT('aistudio');
  const list = useLoad(() => api.get<any[]>('/api/ai-studio/projects'), []);
  const setup = useLoad(() => api.get<{ ai_ready: boolean }>('/api/ai-studio/setup'), []);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [stack, setStack] = useState('react');
  const create = async (n = name, s = stack, prompt = '') => {
    const p = await act(() => api.post('/api/ai-studio/projects', { name: n, stack: s }));
    if (!p) return;
    if (prompt) stashPrompt(prompt);
    navigate(`ai-studio/${p.id}`);
  };
  return (
    <div className="studio">
      <PageHead title={t('AI Studio')} sub={t('Apps und Websites im Chat bauen – mit deinem eigenen KI-Anbieter.')}>
        <button className="primary" onClick={() => setOpen(true)}>
          {t('Neues Projekt')}
        </button>
      </PageHead>
      {setup.data && !setup.data.ai_ready && <ConnectKey />}
      {!list.data ? (
        <Spinner />
      ) : !list.data.length ? (
        <>
          <Empty>{t('Noch keine Projekte. Starte mit einem Beispiel:')}</Empty>
          <Examples onPick={(e) => void create(t(e.title), e.stack, t(e.prompt))} />
        </>
      ) : (
        <SortableGrid id="ai-studio.projects" className="studio-grid">
          {list.data.map((p) => (
            <button key={p.id} className="card studio-card" onClick={() => navigate(`ai-studio/${p.id}`)}>
              <b>{p.name}</b>
              <span className="muted small">
                {p.stack === 'html' ? 'HTML' : t('React')} · {t('{n} Tokens', { n: p.input_tokens + p.output_tokens })} · ${p.cost_usd.toFixed(4)}
              </span>
            </button>
          ))}
        </SortableGrid>
      )}
      {open && (
        <Modal title={t('Neues Projekt')} onClose={() => setOpen(false)} footer={<button className="primary" disabled={!name.trim()} onClick={() => void create()}>{t('Anlegen')}</button>}>
          <Field label="Name">
            <Input value={name} onChange={setName} autoFocus />
          </Field>
          <Field label={t('Vorlage')}>
            <Select value={stack} onChange={setStack} options={[['react', 'React (Vite)'], ['html', 'HTML']]} />
          </Field>
        </Modal>
      )}
    </div>
  );
}

function Editor({ id }: { id: string }) {
  const t = useT('aistudio');
  const data = useLoad(() => api.get<any>(`/api/ai-studio/projects/${id}`), [id]);
  const [prompt, setPrompt] = useState(takePrompt);
  const [busy, setBusy] = useState(false);
  const [frame, setFrame] = useState(0);
  const [publish, setPublish] = useState(false);
  if (!data.data) return <Spinner />;
  const { project, turns, versions, preview_url, connections, budget, ai_ready } = data.data;
  const send = async () => {
    setBusy(true);
    await act(() => api.post(`/api/ai-studio/projects/${id}/turns`, { prompt }));
    setBusy(false);
    setPrompt('');
    data.reload();
    setFrame((n) => n + 1);
  };
  const restore = async (n: string) => {
    if (await act(() => api.post(`/api/ai-studio/projects/${id}/versions/${n}/restore`), t('Version wiederhergestellt'))) {
      data.reload();
      setFrame((n) => n + 1);
    }
  };
  return (
    <div className="studio">
      <PageHead title={project.name} sub={t('{tokens} Tokens · {cost} $ · Monatslimit {used} von {limit} $', { tokens: project.input_tokens + project.output_tokens, cost: project.cost_usd.toFixed(4), used: budget.used_usd.toFixed(2), limit: budget.limit_usd })}>
        <Select value={project.connection_id} onChange={(v) => act(() => api.patch(`/api/ai-studio/projects/${id}`, { connection_id: v })).then(data.reload)} options={[['', t('Standard-Modell')], ...connections.map((c: any) => [c.id, `${c.label} · ${c.model}`] as [string, string])]} aria={t('Modell')} />
        <Select value="" onChange={restore} placeholder={t('Versionen')} options={versions.map((v: any) => [String(v.n), `v${v.n} · ${v.label}`] as [string, string])} aria={t('Versionen')} />
        <a className="btn" href={`/api/ai-studio/projects/${id}/export`}>
          {t('ZIP exportieren')}
        </a>
        <button className="primary" data-tour="studio-publish" onClick={() => setPublish(true)}>
          {t('Veröffentlichen')}
        </button>
      </PageHead>
      {publish && <PublishDialog id={id} onClose={() => setPublish(false)} />}
      {!ai_ready && <ConnectKey />}
      <div className="studio-split">
        <section className="studio-chat" data-tour="studio-chat">
          {!turns.length && !prompt && <Examples onPick={(e) => setPrompt(t(e.prompt))} />}
          {turns.map((turn: any) => (
            <div key={turn.id} className="studio-turn">
              <p className="studio-prompt">{turn.prompt}</p>
              <p className="muted small">{t('Nachgedacht: {s} s', { s: Math.max(1, Math.round(turn.thought_ms / 1000)) })}</p>
              {turn.tools.length > 0 && (
                <details>
                  <summary>{t('{n} Werkzeuge genutzt', { n: turn.tools.length })}</summary>
                  {turn.tools.map((c: any) => (
                    <div key={c.id} className={`studio-tool${c.ok ? '' : ' err'}`}>
                      <code>{c.name}</code> {String(c.args?.path ?? c.args?.query ?? '')} <span className="muted small">{c.summary}</span>
                    </div>
                  ))}
                </details>
              )}
              {turn.files.map((f: any, i: number) => (
                <div key={i} className="muted small">
                  {f.action === 'write' ? t('geändert') : t('gelöscht')}: {f.path}
                </div>
              ))}
              {turn.error ? <p className="studio-error">{turn.error}</p> : <p>{turn.reply}</p>}
              <p className="muted small">{t('{i} ein / {o} aus · {cost} $', { i: turn.input_tokens, o: turn.output_tokens, cost: turn.cost_usd.toFixed(4) })}</p>
            </div>
          ))}
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t('Beschreibe, was gebaut oder geändert werden soll …')} aria-label={t('Nachricht')} rows={4} />
          <button className="primary" disabled={busy || !prompt.trim()} onClick={send}>
            {busy ? t('Arbeitet …') : t('Senden')}
          </button>
        </section>
        <iframe key={frame} className="studio-preview" data-tour="studio-preview" title={t('Vorschau')} src={preview_url} sandbox="allow-scripts allow-forms" />
      </div>
    </div>
  );
}
