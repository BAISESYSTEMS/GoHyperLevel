import { useState } from 'react';
import { api } from '../api';
import { Badge, Check, Copy, Field, Input, Link, Select, Textarea, act, confirmAsk, toast, useLoad } from '../ui';
import './quickwins.css';

/** "KI-Antwort vorschlagen" for Google reviews: tone and brand voice settings, the suggest button and editable drafts. A suggestion is only ever a draft. */

export interface ReplyCfg {
  tone: string;
  formality: 'sie' | 'du';
  instructions: string;
  signature: string;
  auto_draft: boolean;
  tones: { id: string; label: string; hint: string }[];
  ai_problem: string | null;
}

/** Settings shared by every review row of the panel (one request). Null when the route is not available for this login. */
export function useReplyCfg() {
  return useLoad(() => api.get<ReplyCfg>('/api/google-reviews/reply-settings').catch(() => null), []);
}

/** Draft the team still has to read: written by the AI (on request or automatically) and not changed since. */
export const isAiDraft = (review: any, text: string) => (review.reply_draft_source === 'ai' || review.reply_draft_source === 'auto') && !!review.reply_draft && text === review.reply_draft;

/** Tone choice and the suggest button. `onText` gets the draft and the updated review. */
export function SuggestBar({ review, cfg, hasText, onText, label = 'KI-Antwort vorschlagen' }: { review: any; cfg: ReplyCfg | null | undefined; hasText: boolean; onText: (text: string, review: any) => void; label?: string }) {
  const [tone, setTone] = useState('');
  const [busy, setBusy] = useState(false);
  if (!cfg) return null;
  const off = cfg.ai_problem;
  const run = async () => {
    if (hasText && !confirmAsk('Den Text im Feld durch einen neuen KI-Vorschlag ersetzen?')) return;
    setBusy(true);
    const r = await act(() => api.post(`/api/google-reviews/${review.id}/suggest-reply`, { tone: tone || cfg.tone }));
    setBusy(false);
    if (r) onText(r.text, r.review);
  };
  return (
    <span className="suggest-bar" data-tour="review-suggest">
      <button className="btn small secondary" disabled={busy || !!off} onClick={run} title={off ?? 'Die KI schreibt einen Entwurf im Ton deines Unternehmens – du prüfst und veröffentlichst selbst.'}>
        {busy ? 'Schreibt …' : label}
      </button>
      <select value={tone || cfg.tone} onChange={(e) => setTone(e.target.value)} aria-label="Tonfall des Vorschlags" title="Tonfall dieses Vorschlags">
        {cfg.tones.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
      {off && (
        <span className="muted small">
          {off} <Link to="settings/ai">Einstellungen</Link>
        </span>
      )}
    </span>
  );
}

/** Reviews without a connected business profile cannot be answered here: the draft is edited and copied, then pasted at Google. */
export function DraftOnly({ review, cfg, onSaved }: { review: any; cfg: ReplyCfg | null | undefined; onSaved: (r: any) => void }) {
  const [text, setText] = useState<string>(review.reply_draft ?? '');
  const [open, setOpen] = useState(!!review.reply_draft);
  const [busy, setBusy] = useState(false);
  if (!cfg || review.reply_text) return null;
  const dirty = text.trim() !== (review.reply_draft ?? '').trim();
  const save = async () => {
    setBusy(true);
    const r = await act(() => api.put(`/api/google-reviews/${review.id}/reply-draft`, { text }), 'Entwurf gespeichert');
    setBusy(false);
    if (r) onSaved(r);
  };
  const remove = async () => {
    const r = await act(() => api.del(`/api/google-reviews/${review.id}/reply-draft`));
    if (r) {
      setText('');
      setOpen(false);
      onSaved(r);
    }
  };
  if (!open)
    return (
      <div style={{ marginTop: 6 }}>
        <SuggestBar review={review} cfg={cfg} hasText={false} onText={(t, r) => (setText(t), setOpen(true), onSaved(r))} />
      </div>
    );
  return (
    <div className="g-reply g-draft">
      <div className="muted small">
        {isAiDraft(review, text) ? <Badge tone="purple">KI-Entwurf – bitte prüfen</Badge> : <Badge>Entwurf</Badge>} Wird nicht veröffentlicht: Text kopieren und bei Google einfügen.
      </div>
      <Textarea value={text} onChange={setText} rows={4} aria-label="Entwurf der Antwort" />
      <div className="actions" style={{ marginTop: 6 }}>
        <Copy text={text} label="Text kopieren" />
        <a className="btn small secondary" href={review.link} target="_blank" rel="noopener noreferrer">
          Auf Google antworten
        </a>
        <button className="btn small" disabled={busy || !dirty || !text.trim()} onClick={save}>
          Entwurf speichern
        </button>
        <SuggestBar review={review} cfg={cfg} hasText={!!text.trim()} label="Neuer Vorschlag" onText={(t, r) => (setText(t), onSaved(r))} />
        <button className="btn small ghost" onClick={remove}>
          Verwerfen
        </button>
      </div>
    </div>
  );
}

/** Tone, address, own hints, signature and the auto-draft switch. */
export function ReplySettingsPanel({ cfg, onSaved }: { cfg: ReplyCfg | null | undefined; onSaved: () => void }) {
  const [s, setS] = useState<Partial<ReplyCfg> | null>(null);
  const [busy, setBusy] = useState(false);
  if (!cfg) return null;
  const v: Partial<ReplyCfg> = { ...cfg, ...(s ?? {}) };
  const set = (patch: Partial<ReplyCfg>) => setS({ ...(s ?? {}), ...patch });
  const save = async () => {
    setBusy(true);
    const r = await act(() => api.put('/api/google-reviews/reply-settings', { tone: v.tone, formality: v.formality, instructions: v.instructions, signature: v.signature, auto_draft: v.auto_draft }), 'Gespeichert');
    setBusy(false);
    if (r) {
      setS(null);
      onSaved();
    } else toast('Nicht gespeichert');
  };
  return (
    <details className="reply-settings" data-tour="review-reply-settings">
      <summary>KI-Antworten: Tonfall und Stil</summary>
      <p className="muted small" style={{ marginTop: 6 }}>
        Die KI schreibt Antwort-Entwürfe im Stil deines Unternehmens (Persona und Fakten aus <Link to="settings/ai">Einstellungen → KI-Assistent</Link>). Sie veröffentlicht nie von selbst: du prüfst, änderst und sendest jede Antwort.
      </p>
      <div className="grid2">
        <Field label="Tonfall">
          <Select value={v.tone} onChange={(x) => set({ tone: x })} options={cfg.tones.map((t) => [t.id, `${t.label} – ${t.hint}`] as [string, string])} />
        </Field>
        <Field label="Anrede">
          <Select value={v.formality} onChange={(x) => set({ formality: x as 'sie' | 'du' })} options={[['sie', 'Sie (förmlich)'], ['du', 'du (persönlich)']]} />
        </Field>
      </div>
      <Field label="Eigene Hinweise (optional)" hint="z. B. „Nenne nie Preise.“ oder „Bei Kritik immer den Rückruf anbieten.“">
        <Textarea value={v.instructions} onChange={(x) => set({ instructions: x })} rows={3} maxLength={2000} />
      </Field>
      <Field label="Grußformel unter jeder Antwort (optional)">
        <Input value={v.signature} onChange={(x) => set({ signature: x })} maxLength={300} placeholder="Herzliche Grüße, Ihr Team von Malerei Muster" />
      </Field>
      <Check checked={!!v.auto_draft} onChange={(x) => set({ auto_draft: x })} label="Für neue Google-Bewertungen automatisch einen Entwurf schreiben (wird nie veröffentlicht)" />
      <div className="actions" style={{ marginTop: 8 }}>
        <button className="btn small" disabled={busy || !s} onClick={save}>
          Speichern
        </button>
      </div>
    </details>
  );
}
