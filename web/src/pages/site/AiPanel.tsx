import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../icons';
import { api } from '../../api';
import { Spinner, Textarea, act, toast, useLoad } from '../../ui';
import { fmtDateTime, useT } from '../../i18n';
import type { Block } from './model';
import { Bubble, Chips, CostLine, DiffList, Preview, RadioCards, Working, useAiStatus, usd, type Estimate, type SectionDiff } from './ai-kit';

/**
 * The page builder's AI side panel (chat-first, like HighLevel): a greeting, suggestion chips, radio cards for scope, du/Sie,
 * language and tone; commands for the selected section ("kürzer", "FAQ hinzufügen", "in Du-Form") or the whole page; a review
 * step with the section diff and a preview; applying takes a restore point first and puts the result into the editor unsaved.
 */

interface Proposal {
  run_id: string;
  mode: 'page' | 'section';
  blocks: Block[];
  diff: { sections: SectionDiff[]; counts: Record<string, number> };
  summary: string;
  warnings: string[];
  cost_usd: number;
  attempts: number;
}
interface Msg {
  me?: boolean;
  text: string;
  undo?: string;
}

/** The top-level section that holds the selected element (or is it). */
function sectionOf(blocks: Block[], selId?: string): Block | undefined {
  if (!selId) return undefined;
  return blocks.find((b) => b.type === 'section' && (b.id === selId || JSON.stringify(b).includes(`"id":"${selId}"`)));
}

export function SiteAiPanel({ page, blocks, selId, onApply, onClose }: { page: any; funnel: any; blocks: Block[]; selId?: string; onApply(blocks: Block[]): void; onClose(): void }) {
  const t = useT('siteai');
  const status = useAiStatus();
  const section = useMemo(() => sectionOf(blocks, selId), [blocks, selId]);
  const [scope, setScope] = useState<'section' | 'page'>(section ? 'section' : 'page');
  const [address, setAddress] = useState('du');
  const [language, setLanguage] = useState(page.layout?.lang === 'en' ? 'en' : 'de');
  const [tone, setTone] = useState('freundlich');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [est, setEst] = useState<Estimate | null>(null);
  const points = useLoad(() => api.get<any[]>(`/api/site-ai/restore-points?page_id=${encodeURIComponent(page.id)}`), [page.id]);
  const box = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const flat = blocks.length > 0 && !blocks.some((b) => b.type === 'section');

  useEffect(() => {
    if (section) setScope('section');
  }, [section?.id]);
  useEffect(() => {
    api.post<Estimate>('/api/site-ai/estimate', { mode: scope === 'section' && section ? 'section' : 'page' }).then(setEst, () => setEst(null));
  }, [scope, !!section]);
  // Esc closes the panel (a dialog on top of it closes first); the editor stays usable while it is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.modal-bg')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('textarea, button')?.focus({ preventScroll: true });
  }, []);
  // the newest message, the working note or the proposal comes into view
  useEffect(() => {
    const el = body.current;
    if (proposal && card.current && el) el.scrollTo({ top: card.current.offsetTop - 70, behavior: 'smooth' });
    else if (el && (msgs.length || busy)) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [msgs.length, busy, proposal]);

  const brief = { address, language, tone };
  const say = (m: Msg) => setMsgs((list) => [...list, m]);
  const run = async (o: { command?: string; prompt?: string; label: string }) => {
    const target = scope === 'section' && section ? section : null;
    if (scope === 'section' && !section) return toast(t('Wähle zuerst einen Abschnitt in der Struktur.'));
    say({ me: true, text: o.label });
    setProposal(null);
    setBusy(target ? t('Ich überarbeite den Abschnitt …') : t('Ich schreibe die Seite – das dauert bis zu einer Minute …'));
    const r = await act(() => (target ? api.post<Proposal>('/api/site-ai/section', { page_id: page.id, section_id: target.id, command: o.command, prompt: o.prompt, current_blocks: blocks, brief }) : api.post<Proposal>('/api/site-ai/page', { page_id: page.id, prompt: o.prompt, current_blocks: blocks, brief })));
    setBusy('');
    if (!r) return say({ text: t('Das hat nicht geklappt – siehe Meldung. Versuch es mit anderen Worten noch einmal.') });
    setProposal(r);
    say({ text: r.summary || t('Hier ist mein Vorschlag. Prüfe die Änderungen und übernimm sie, wenn sie passen.') });
  };
  const apply = async () => {
    if (!proposal) return;
    const r = await act(() => api.post<{ blocks: Block[]; restore_point_id: string }>(`/api/site-ai/runs/${proposal.run_id}/apply`, { current_blocks: blocks }));
    if (!r) return;
    onApply(r.blocks);
    setProposal(null);
    say({ text: t('Übernommen – noch nicht gespeichert. „Speichern“ im Editor macht es live.'), undo: r.restore_point_id });
    points.reload();
  };
  const restore = async (pointId: string) => {
    const r = await act(() => api.post<{ blocks: Block[] }>(`/api/site-ai/restore-points/${pointId}/restore`, {}), t('Wiederhergestellt – noch nicht gespeichert'));
    if (r) {
      onApply(r.blocks);
      points.reload();
    }
  };

  const sectionChips: [string, string][] = (status.data?.commands ?? []).map((c) => [c.id, t(c.label)]);
  const PAGE_CHIPS: [string, string, string][] = [
    ['write', t('Seite neu schreiben'), 'Schreibe diese Seite neu: klare Struktur mit Hero, Nutzen, Ablauf, häufigen Fragen und einem Aufruf am Ende.'], // i18n-ignore – instruction for the AI, not shown
    ['trust', t('Mehr Vertrauen'), 'Ergänze Abschnitte, die Vertrauen schaffen (Ablauf, FAQ, Garantie) – für Kundenstimmen nur klar markierte Platzhalter.'], // i18n-ignore – instruction for the AI, not shown
    ['short', t('Kürzer & klarer'), 'Mach die ganze Seite kürzer und klarer, ohne Inhalte zu erfinden.'], // i18n-ignore – instruction for the AI, not shown
    ['du', t('Alles in Du-Form'), 'Schreibe alle Texte der Seite in die Du-Form um.'], // i18n-ignore – instruction for the AI, not shown
  ];

  return (
    <aside ref={box} className="ai-panel ai-scope" role="complementary" aria-label={t('KI-Assistent für diese Seite')}>
      <div className="ai-panel-head">
        <h3>
          <Icon name="ai" size={18} /> {t('KI-Assistent')}
        </h3>
        <button className="icon-btn" onClick={onClose} aria-label={t('Schließen')}>
          ✕
        </button>
      </div>
      <div className="ai-panel-body" ref={body}>
        {!status.data ? (
          <Spinner />
        ) : !status.data.ready ? (
          <Bubble>
            <p>{t('Die KI ist für diesen Sub-Account noch nicht bereit:')}</p>
            <p>
              <b>{status.data.reason}</b>
            </p>
          </Bubble>
        ) : (
          <>
            <Bubble>
              <p>{t('Hi! Ich helfe dir bei dieser Seite. Wähle links einen Abschnitt – dann kann ich ihn kürzen, umschreiben oder etwas ergänzen. Oder sag mir, was auf der ganzen Seite stehen soll.')}</p>
            </Bubble>
            <div className="ai-label">{t('Woran arbeiten wir?')}</div>
            <RadioCards
              name="ai-scope"
              label={t('Bereich')}
              small
              value={scope}
              onChange={(v) => setScope(v as 'section' | 'page')}
              options={[
                { value: 'section', title: t('Abschnitt'), text: section ? `„${section.name || t('ohne Namen')}“` : t('in der Struktur wählen'), icon: 'hero' },
                { value: 'page', title: t('Ganze Seite'), text: page.name, icon: 'doc' },
              ]}
            />
            {scope === 'section' && flat && <p className="notice small">{t('Diese Seite hat noch keine Abschnitte – wandle sie im Editor „In Abschnitte“ um, dann gehen Befehle für einzelne Abschnitte.')}</p>}
            <div className="ai-label">{t('Vorschläge')}</div>
            {scope === 'section' ? (
              <Chips label={t('Vorschläge')} items={sectionChips} onPick={(id) => run({ command: id, label: sectionChips.find((c) => c[0] === id)?.[1] ?? id })} />
            ) : (
              <Chips label={t('Vorschläge')} items={PAGE_CHIPS.map(([id, label]) => [id, label])} onPick={(id) => {
                const c = PAGE_CHIPS.find((x) => x[0] === id)!;
                void run({ prompt: c[2], label: c[1] });
              }} />
            )}
            <details>
              <summary className="small">{t('Ton, Anrede und Sprache')}</summary>
              <RadioCards name="ai-addr" label={t('Anrede')} small value={address} onChange={setAddress} options={[{ value: 'du', title: t('Du') }, { value: 'sie', title: t('Sie') }]} />
              <RadioCards name="ai-language" label={t('Sprache')} small value={language} onChange={setLanguage} options={[{ value: 'de', title: t('Deutsch') }, { value: 'en', title: t('Englisch') }]} />
              <RadioCards name="ai-tone2" label={t('Ton')} small value={tone} onChange={setTone} options={[{ value: 'freundlich', title: t('Freundlich') }, { value: 'professionell', title: t('Professionell') }, { value: 'locker', title: t('Locker') }, { value: 'premium', title: t('Premium') }]} />
            </details>
            {msgs.map((m, i) => (
              <Bubble key={i} me={m.me}>
                <p>{m.text}</p>
                {m.undo && (
                  <button className="btn small secondary" onClick={() => restore(m.undo!)}>
                    <Icon name="undo" size={14} /> {t('Rückgängig')}
                  </button>
                )}
              </Bubble>
            ))}
            {busy && <Working text={busy} />}
            {proposal && (
              <div className="card" ref={card} aria-label={t('Vorschlag prüfen')}>
                <h4 style={{ margin: '0 0 6px' }}>{t('Vorschlag prüfen')}</h4>
                <DiffList sections={proposal.diff.sections.filter((s) => s.change !== 'same')} />
                {proposal.diff.counts.same > 0 && <p className="muted small">{t.plural(proposal.diff.counts.same, { one: '{n} weiterer Abschnitt bleibt unverändert.', other: '{n} weitere Abschnitte bleiben unverändert.' })}</p>}
                <Preview url={`/api/site-ai/runs/${proposal.run_id}/preview`} title={t('Vorschau des Vorschlags')} />
                <div className="ai-cost">
                  <span>
                    {t('Kosten:')} <b>{usd(proposal.cost_usd)}</b>
                  </span>
                  {proposal.attempts > 1 && <span>{t('{n} Versuche', { n: proposal.attempts })}</span>}
                </div>
                <div className="actions">
                  <button className="btn secondary" onClick={() => setProposal(null)}>
                    {t('Verwerfen')}
                  </button>
                  <button className="btn ai" onClick={apply}>
                    {t('Übernehmen')}
                  </button>
                </div>
                <p className="muted small">{t('Vor dem Übernehmen speichere ich einen Wiederherstellungspunkt.')}</p>
              </div>
            )}
            {(points.data ?? []).length > 0 && (
              <details className="ai-points">
                <summary>{t('Wiederherstellungspunkte ({n})', { n: points.data!.length })}</summary>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {points.data!.map((p) => (
                    <li key={p.id}>
                      <span>
                        {p.label} <span className="muted">· {fmtDateTime(p.created_at, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                      </span>
                      <button className="btn small secondary" onClick={() => restore(p.id)}>
                        {t('Laden')}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
      {status.data?.ready && (
        <div className="ai-panel-foot">
          {scope === 'section' && section && (
            <div className="ai-context">
              <Icon name="hero" size={14} /> {t('Gewählt:')} <b>{section.name || t('Abschnitt ohne Namen')}</b>
            </div>
          )}
          <Textarea
            value={text}
            onChange={setText}
            aria-label={t('Auftrag an die KI')}
            placeholder={scope === 'section' ? t('z. B. „Mach den Abschnitt kürzer“ oder „Ergänze drei Vorteile“') : t('z. B. „Landingpage für ein kostenloses Erstgespräch“')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) {
                e.preventDefault();
                void run({ prompt: text.trim(), label: text.trim() }).then(() => setText(''));
              }
            }}
          />
          <div className="row" style={{ alignItems: 'center' }}>
            <div className="grow">
              <CostLine estimate={est} />
            </div>
            <button className="btn ai" disabled={!text.trim() || !!busy} onClick={() => run({ prompt: text.trim(), label: text.trim() }).then(() => setText(''))}>
              <Icon name="send" size={15} /> {t('Senden')}
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

/** Funnel editor: an AI-built site that is not published yet says so, with the button to publish it. */
export function SiteAiDraftBanner({ funnelId }: { funnelId: string }) {
  const t = useT('siteai');
  const d = useLoad(() => api.get<{ draft: boolean }>(`/api/site-ai/drafts/${encodeURIComponent(funnelId)}`), [funnelId]);
  if (!d.data?.draft) return null;
  return (
    <div className="ai-draft-banner ai-scope" role="status">
      <Icon name="ai" size={18} />
      <span className="grow">
        <b>{t('KI-Entwurf – noch nicht öffentlich.')}</b> {t('Prüfe Texte und Platzhalter in [eckigen Klammern]; Besucher sehen die Seiten erst nach dem Veröffentlichen.')}
      </span>
      <button className="btn ai" onClick={() => act(() => api.post(`/api/site-ai/drafts/${encodeURIComponent(funnelId)}/publish`, {}), t('Veröffentlicht')).then((r) => r && d.reload())}>
        {t('Veröffentlichen')}
      </button>
    </div>
  );
}
