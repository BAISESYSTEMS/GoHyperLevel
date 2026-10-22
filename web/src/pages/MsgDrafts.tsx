import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { act, confirmAsk } from '../ui';
import { Icon } from '../icons';
import { useT } from '../i18n';
import { draftAction } from './msg-drafts-model';

/**
 * SMS and WhatsApp reply drafts in the inbox (docs/team-inbox.md#sms-and-whatsapp-drafts): the newest open draft of a conversation goes into
 * the composer, where a person edits it and sends it through the normal send path; sending or discarding removes the draft.
 */

export const DRAFT_CHANNELS = ['sms', 'whatsapp'];
export interface ComposerDraft {
  id: string;
  channel: string;
  body: string;
  source?: string;
}

/** The newest SMS/WhatsApp draft of a thread (e-mail drafts keep their own buttons in the bubble). */
export function pendingDraft(messages: any[] | undefined): ComposerDraft | undefined {
  const m = (messages ?? []).filter((x) => x.status === 'draft' && DRAFT_CHANNELS.includes(x.channel) && !x.mail).at(-1);
  return m ? { id: m.id, channel: m.channel, body: String(m.body ?? ''), source: m.source || undefined } : undefined;
}

/** Removes a draft once its text went out (a draft already gone is fine). */
export async function finishDraft(id: string) {
  await api.del(`/api/messages/${id}`).catch(() => undefined);
}

/**
 * Puts a new draft into an editor without ever overwriting what someone typed (msg-drafts-model.ts): `current` is the editor's
 * text (anything non-empty when the editor can't tell), `apply` puts a draft in. Returns the draft on offer, if any, and `take`.
 */
export function useDraftFill(draft: ComposerDraft | undefined, current: string, apply: (d: ComposerDraft) => void) {
  const seen = useRef<string | null>(null);
  const applied = useRef<string | null>(null);
  const [offer, setOffer] = useState<ComposerDraft | null>(null);
  const put = (d: ComposerDraft) => {
    apply(d);
    applied.current = d.body;
    setOffer(null);
  };
  useEffect(() => {
    if (!draft) return setOffer(null);
    const a = draftAction({ draftId: draft.id, seenId: seen.current, appliedBody: applied.current, current });
    if (a === 'none') return;
    seen.current = draft.id;
    if (a === 'fill') put(draft);
    else setOffer(draft);
    // only a new draft decides – typing must not re-run this
  }, [draft?.id]);
  return { offer, take: () => offer && put(offer) };
}

/** "Neuer Entwurf verfügbar – übernehmen": the person was typing, so the new draft waits for a click. */
export function DraftOffer({ onTake }: { onTake: () => void }) {
  const t = useT('inbox');
  return (
    <div className="row small msg-draft-offer" role="status" style={{ alignItems: 'center', gap: 8 }}>
      <Icon name="bot" size={14} />
      <span className="grow">{t('Neuer Entwurf verfügbar')} –</span>
      <button type="button" className="btn small" onClick={onTake}>
        {t('übernehmen')}
      </button>
    </div>
  );
}

/** One line above the composer: where the draft comes from, and discarding it. */
export function DraftNote({ draft, available, onDiscarded }: { draft: ComposerDraft; available: boolean; onDiscarded: () => void }) {
  const t = useT('inbox');
  const label = draft.channel === 'whatsapp' ? 'WhatsApp' : 'SMS';
  const discard = async () => {
    if (!confirmAsk(t('Entwurf verwerfen?'))) return;
    if (await act(() => api.del(`/api/messages/${draft.id}`), t('Entwurf verworfen'))) onDiscarded();
  };
  return (
    <div className="row small msg-draft-note" role="status" style={{ alignItems: 'center', gap: 8 }}>
      <Icon name="bot" size={14} />
      <span className="grow">
        {available
          ? t('{channel}-Entwurf von {source} – prüfen, bei Bedarf ändern und senden.', { channel: label, source: draft.source || t('KI-Agent') })
          : t('{channel}-Entwurf von {source} – {channel} ist hier nicht eingerichtet, der Text steht im Verlauf.', { channel: label, source: draft.source || t('KI-Agent') })}
      </span>
      <button type="button" className="btn small secondary" onClick={discard}>
        {t('Verwerfen')}
      </button>
    </div>
  );
}

/** In the thread: the draft bubble points to the composer instead of sending on its own (that would skip its channel's rules). */
export function DraftBubbleActions({ m, onChanged }: { m: any; onChanged: () => void }) {
  const t = useT('inbox');
  return (
    <div className="actions" style={{ marginTop: 6, alignItems: 'center' }}>
      <span className="muted small">{t('Steht unten im Eingabefeld zum Senden.')}</span>{' '}
      <button className="btn small secondary" onClick={async () => confirmAsk(t('Entwurf verwerfen?')) && (await act(() => api.del(`/api/messages/${m.id}`))) && onChanged()}>
        {t('Verwerfen')}
      </button>
    </div>
  );
}
