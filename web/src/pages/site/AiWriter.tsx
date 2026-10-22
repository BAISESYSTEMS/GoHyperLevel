import { useEffect, useState } from 'react';
import { Icon } from '../../icons';
import { api } from '../../api';
import { Field, Input, Modal, Textarea, act } from '../../ui';
import { useT } from '../../i18n';
import { Bubble, CostLine, RadioCards, Working, type Estimate } from './ai-kit';

/**
 * The AI writer for blog posts and e-mail text blocks – the Funnel & Website AI's service (same model routing, cost estimate and
 * monthly limit). `AiWriteButton` opens a small dialog; the text goes back through `onText` and lands unsaved in the editor.
 */

export interface Written {
  title?: string;
  excerpt?: string;
  text: string;
}

export function AiWriteButton({ kind, topic, current, onText }: { kind: 'blog' | 'email'; topic?: string; current?: string; onText(r: Written): void }) {
  const t = useT('siteai');
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn small ai secondary" onClick={() => setOpen(true)}>
        <Icon name="ai" size={14} /> {kind === 'blog' ? t('Mit KI schreiben') : t('Text mit KI')}
      </button>
      {open && <AiWriter kind={kind} topic={topic ?? ''} current={current ?? ''} onClose={() => setOpen(false)} onText={(r) => (onText(r), setOpen(false))} />}
    </>
  );
}

function AiWriter({ kind, topic: start, current, onClose, onText }: { kind: 'blog' | 'email'; topic: string; current: string; onClose(): void; onText(r: Written): void }) {
  const t = useT('siteai');
  const [topic, setTopic] = useState(start);
  const [instruction, setInstruction] = useState('');
  const [length, setLength] = useState('mittel');
  const [address, setAddress] = useState('du');
  const [language, setLanguage] = useState('de');
  const [revise, setRevise] = useState(!!current.trim());
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<(Written & { cost_usd: number }) | null>(null);
  const [est, setEst] = useState<Estimate | null>(null);
  useEffect(() => {
    api.post<Estimate>('/api/site-ai/estimate', { mode: 'page', prompt: topic }).then(setEst, () => setEst(null));
  }, []);
  const write = async () => {
    setBusy(true);
    const r = await act(() => api.post<Written & { cost_usd: number }>('/api/site-ai/write', { kind, topic, instruction, length, address, language, current: revise ? current : '' }));
    setBusy(false);
    if (r) setOut(r);
  };
  return (
    <Modal
      title={kind === 'blog' ? t('Blog-Beitrag mit KI') : t('E-Mail-Text mit KI')}
      onClose={onClose}
      className="ai-scope"
      footer={
        out ? (
          <>
            <button className="btn secondary" disabled={busy} onClick={write}>
              {t('Neu schreiben')}
            </button>
            <button className="btn ai" onClick={() => onText(out)}>
              {t('Übernehmen')}
            </button>
          </>
        ) : (
          <button className="btn ai" disabled={busy || (!topic.trim() && !instruction.trim() && !revise)} onClick={write}>
            <Icon name="ai" size={15} /> {t('Schreiben')}
          </button>
        )
      }
    >
      {!out ? (
        <>
          <Bubble>
            <p>{kind === 'blog' ? t('Worüber soll der Beitrag gehen? Ich schreibe ihn mit Zwischenüberschriften – Fakten, die ich nicht kenne, markiere ich als [Platzhalter].') : t('Worum geht es in der E-Mail? Ich schreibe den Text dieses Blocks – Platzhalter wie {{contact.first_name|du}} bleiben erhalten.')}</p>
          </Bubble>
          <Field label={t('Thema')}>
            <Input value={topic} onChange={setTopic} autoFocus placeholder={kind === 'blog' ? t('z. B. Wände streichen im Herbst') : t('z. B. Danke für deine Anfrage')} />
          </Field>
          <Field label={t('Was noch wichtig ist (optional)')}>
            <Textarea value={instruction} onChange={setInstruction} rows={2} />
          </Field>
          {current.trim() && (
            <RadioCards
              name="ai-revise"
              label={t('Bisheriger Text')}
              small
              value={revise ? 'revise' : 'new'}
              onChange={(v) => setRevise(v === 'revise')}
              options={[
                { value: 'revise', title: t('Überarbeiten'), text: t('den bisherigen Text') },
                { value: 'new', title: t('Neu schreiben'), text: t('ohne den bisherigen Text') },
              ]}
            />
          )}
          {kind === 'blog' && <RadioCards name="ai-length" label={t('Länge')} small value={length} onChange={setLength} options={[{ value: 'kurz', title: t('Kurz'), text: t('ca. 400 Wörter') }, { value: 'mittel', title: t('Mittel'), text: t('ca. 800 Wörter') }, { value: 'lang', title: t('Lang'), text: t('ca. 1500 Wörter') }]} />}
          <div className="grid2">
            <RadioCards name="ai-waddr" label={t('Anrede')} small value={address} onChange={setAddress} options={[{ value: 'du', title: t('Du') }, { value: 'sie', title: t('Sie') }]} />
            <RadioCards name="ai-wlang" label={t('Sprache')} small value={language} onChange={setLanguage} options={[{ value: 'de', title: t('Deutsch') }, { value: 'en', title: t('Englisch') }]} />
          </div>
          <CostLine estimate={est} />
        </>
      ) : (
        <>
          {out.title && <h3 style={{ margin: '0 0 4px' }}>{out.title}</h3>}
          {out.excerpt && <p className="muted">{out.excerpt}</p>}
          <pre className="ai-bubble" style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', maxHeight: 360, overflow: 'auto' }}>
            {out.text}
          </pre>
        </>
      )}
      {busy && <Working text={t('Ich schreibe …')} />}
    </Modal>
  );
}
