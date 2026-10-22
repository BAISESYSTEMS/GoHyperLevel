import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { Badge, Field, Input, Select, Spinner, act, confirmAsk, toast, useLoad } from '../ui';
import { SignupLink } from '../referrals';

/**
 * KI-Anbieter for the KI-Assistent: Anthropic (Claude) or OpenAI (GPT), per sub-account with an agency
 * default. The OpenAI key is stored sealed and never shown again; the model can be picked or typed in.
 */

const CUSTOM = '__custom';

function ModelPicker({ value, onChange, models, fallback }: { value: string; onChange: (v: string) => void; models: { id: string; label: string }[]; fallback: string }) {
  const known = !value || models.some((m) => m.id === value);
  const [forced, setForced] = useState(false);
  const custom = forced || !known;
  return (
    <>
      <Select
        value={custom ? CUSTOM : value}
        onChange={(v) => {
          setForced(v === CUSTOM);
          if (v !== CUSTOM) onChange(v);
        }}
        options={[['', `Standard (${fallback})`], ...models.map((m) => [m.id, m.label] as [string, string]), [CUSTOM, 'Anderes Modell (Freitext) …']]}
      />
      {custom && <Input value={value} onChange={onChange} placeholder="Modell-ID, z. B. gpt-5" style={{ marginTop: 6 }} />}
    </>
  );
}

function OpenAiKeyField({ info, keyValue, setKey, onClear }: { info: any; keyValue: string; setKey: (v: string) => void; onClear: () => void }) {
  const [edit, setEdit] = useState(false);
  const source: Record<string, string> = { agency: 'Schlüssel der Agentur', server: 'Schlüssel des Servers (PGHL_OPENAI_API_KEY)' };
  return (
    <Field
      label="OpenAI-API-Schlüssel"
      tour="ai-openai-key"
      hint={
        <>
          Bekommst du unter <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">platform.openai.com → API keys</a>. Er wird verschlüsselt gespeichert und nie wieder angezeigt; die Kosten laufen über dein OpenAI-Konto. <SignupLink id="openai" />
        </>
      }
    >
      {info.key_set && !edit ? (
        <div className="row" style={{ alignItems: 'center' }}>
          <Badge tone="green">hinterlegt {info.key_hint}</Badge>
          <button className="btn small secondary" onClick={() => setEdit(true)}>
            Ersetzen
          </button>
          <button className="btn small secondary" onClick={() => confirmAsk('OpenAI-Schlüssel entfernen?') && onClear()}>
            Entfernen
          </button>
        </div>
      ) : (
        <>
          <Input type="password" autoComplete="off" value={keyValue} onChange={setKey} placeholder={info.key_source && info.key_source !== 'account' ? `leer = ${source[info.key_source]}` : 'sk-…'} />
          {!info.key_set && info.key_source && info.key_source !== 'account' && <small className="muted">Ohne eigenen Schlüssel wird der {source[info.key_source]} genutzt.</small>}
        </>
      )}
    </Field>
  );
}

/** Card at the top of Einstellungen → KI-Assistent → Einrichtung. */
export function AiProviderCard({ onChange, onPick, onDraft, version = 0 }: { onChange: () => void; onPick?: (provider: 'anthropic' | 'openai') => void; onDraft?: (body: Record<string, string> | null) => void; version?: number }) {
  const p = useLoad(() => api.get<any>('/api/ai/provider'), [version]);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  useEffect(() => {
    if (p.data) (setProvider(p.data.provider), setModel(p.data.openai.model), setKey(''));
  }, [p.data]);
  // Unsaved changes go along with the page's main „Speichern“ too.
  const dirty = !!p.data && (provider !== p.data.provider || model !== p.data.openai.model || !!key.trim());
  useEffect(() => {
    onDraft?.(dirty ? { provider, openai_model: model, ...(key.trim() ? { openai_key: key.trim() } : {}) } : null);
  }, [dirty, provider, model, key]);
  // The settings below follow the provider picked here, saved or not.
  const effective = p.data ? provider || p.data.agency_default : null;
  useEffect(() => {
    if (effective) onPick?.(effective);
  }, [effective]);
  if (!p.data) return <Spinner />;
  const d = p.data;
  const label = (id: string) => d.providers.find((x: any) => x.id === id)?.label ?? id;
  const save = async (extra: any = {}) => {
    const r = await act(() => api.put('/api/ai/provider', { provider, openai_model: model, ...(key.trim() ? { openai_key: key.trim() } : {}), ...extra }), 'Gespeichert');
    if (r) (p.setData(r), setKey(''), onChange());
  };
  return (
    <div className="ai-provider" data-tour="ai-provider">
      {d.routed && (
        <p className="card small" style={{ background: 'var(--brand-soft)' }}>
          Schnelle KI-Texte laufen gerade über <strong>{d.routed.label}{d.routed.model ? ` · ${d.routed.model}` : ''}</strong> (Einstellungen → KI-Anbieter → „Wofür welches Modell?“). Die Wahl hier gilt wieder, sobald die Zuordnung dort entfernt wird.
        </p>
      )}
      <Field label="KI-Anbieter" hint={`„Wie die Agentur“ folgt dem Standard der Agentur (gerade: ${label(d.agency_default)}). Vorschläge, Chat-Bot, Workflows, Telefonagent, Video-Recycling und App-Diktat nutzen alle diesen Anbieter.`}>
        <Select value={provider} onChange={setProvider} options={[['', `Wie die Agentur (${label(d.agency_default)})`], ['anthropic', 'Anthropic (Claude)'], ['openai', 'OpenAI (GPT)']]} />
      </Field>
      {effective === 'openai' && (
        <div className="grid2">
          <OpenAiKeyField info={d.openai} keyValue={key} setKey={setKey} onClear={() => save({ openai_key: null })} />
          <Field label="OpenAI-Modell" tour="ai-openai-model" hint="GPT-5 mini reicht für fast alles; eigene Modell-IDs (auch feinjustierte) gehen als Freitext.">
            <ModelPicker value={model} onChange={setModel} models={d.openai.models} fallback={d.openai.default_model} />
          </Field>
        </div>
      )}
      <div className="row">
        <button className="btn secondary" onClick={() => save()}>
          Anbieter speichern
        </button>
        {effective === 'openai' && (
          <button
            className="btn secondary"
            disabled={!key.trim() && !d.openai.key_source}
            onClick={async () => {
              const r = await act(() => api.post('/api/ai/provider/test', { openai_key: key.trim() || undefined, model: model || undefined }));
              if (r) toast(`Verbindung ok – ${r.model} erreichbar`);
            }}
          >
            OpenAI testen
          </button>
        )}
      </div>
      <hr />
    </div>
  );
}

/** Agency default (agency → KI-Werkzeuge). */
export function AgencyAiProvider() {
  const p = useLoad(() => api.get<any>('/api/agency/ai-provider'), []);
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  useEffect(() => {
    if (p.data) (setProvider(p.data.provider), setModel(p.data.openai.model));
  }, [p.data]);
  if (!p.data) return <Spinner />;
  const save = async (extra: any = {}) => {
    const r = await act(() => api.put('/api/agency/ai-provider', { provider, openai_model: model, ...(key.trim() ? { openai_key: key.trim() } : {}), ...extra }), 'Gespeichert');
    if (r) (p.setData(r), setKey(''));
  };
  return (
    <div className="card" data-tour="ai-provider-agency">
      <h2>
        <Icon name="ai" size={18} /> KI-Anbieter (Standard für alle Sub-Accounts)
      </h2>
      <p className="muted small">Gilt für den KI-Assistenten jedes Sub-Accounts, der unter Einstellungen → KI-Assistent nichts Eigenes gewählt hat. Ein Agentur-Schlüssel für OpenAI wird dann von allen genutzt – Limits und Protokoll bleiben je Sub-Account.</p>
      <Field label="Anbieter">
        <Select value={provider} onChange={setProvider} options={[['anthropic', 'Anthropic (Claude)'], ['openai', 'OpenAI (GPT)']]} />
      </Field>
      {provider === 'openai' && (
        <>
          <OpenAiKeyField info={p.data.openai} keyValue={key} setKey={setKey} onClear={() => save({ openai_key: null })} />
          <Field label="OpenAI-Modell">
            <ModelPicker value={model} onChange={setModel} models={p.data.openai.models} fallback="gpt-5-mini" />
          </Field>
        </>
      )}
      <div className="row">
        <button className="btn" onClick={() => save()}>
          Speichern
        </button>
        {provider === 'openai' && (
        <button
          className="btn secondary"
          disabled={!key.trim() && !p.data.openai.key_source}
          onClick={async () => {
            const r = await act(() => api.post('/api/agency/ai-provider/test', { openai_key: key.trim() || undefined, model: model || undefined }));
            if (r) toast(`Verbindung ok – ${r.model} erreichbar`);
          }}
        >
          OpenAI testen
        </button>
        )}
      </div>
    </div>
  );
}
