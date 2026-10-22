import { useEffect, useState } from 'react';
import { Icon, type IconName } from '../../icons';
import { api } from '../../api';
import { Field, Input, Modal, Spinner, Textarea, act } from '../../ui';
import { useT } from '../../i18n';
import { Bubble, Chips, CostLine, Preview, RadioCards, Working, useAiStatus, usd, type Estimate } from './ai-kit';

/**
 * Funnels & Websites → "Mit KI erstellen": a chat-style brief (suggestions, radio cards for page type, goal, tone, du/Sie and
 * language), the page plan to review, then the pages with a preview – applied as an unpublished draft.
 */

interface Plan {
  site_name: string;
  style: string;
  summary: string;
  pages: { slug: string; name: string; purpose: string; sections: string[] }[];
}
interface Generated {
  run_id: string;
  plan: Plan;
  pages: { slug: string; name: string; seo: { title: string }; sections: string[] }[];
  notes: string[];
  warnings: string[];
  cost_usd: number;
  attempts: number;
}

export function SiteAiCreate({ onClose, onCreated }: { onClose(): void; onCreated(r: { funnel_id: string }): void }) {
  const t = useT('siteai');
  const status = useAiStatus();
  const [step, setStep] = useState<'brief' | 'plan' | 'review'>('brief');
  const [busy, setBusy] = useState('');
  const [brief, setBrief] = useState({ business: '', offer: '', audience: '', extra: '', page_type: 'landing', goal: 'leads', tone: 'freundlich', address: 'du', language: 'de' });
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planCost, setPlanCost] = useState(0);
  const [gen, setGen] = useState<Generated | null>(null);
  const [page, setPage] = useState('');
  const [est, setEst] = useState<Estimate | null>(null);
  const set = (patch: Partial<typeof brief>) => setBrief({ ...brief, ...patch });

  // the estimate follows the brief (page count and length of the texts)
  useEffect(() => {
    const timer = setTimeout(() => api.post<Estimate>('/api/site-ai/estimate', { brief }).then(setEst, () => setEst(null)), 300);
    return () => clearTimeout(timer);
  }, [brief.page_type, brief.goal, brief.business.length > 0, brief.extra.length > 200]);

  const enough = brief.business.trim().length + brief.offer.trim().length + brief.extra.trim().length >= 12;
  const makePlan = async () => {
    setBusy(t('Ich überlege mir einen Seitenplan …'));
    const r = await act(() => api.post<{ plan: Plan; cost_usd: number }>('/api/site-ai/plan', { brief }));
    setBusy('');
    if (r) {
      setPlan(r.plan);
      setPlanCost(r.cost_usd);
      setStep('plan');
    }
  };
  const write = async () => {
    setBusy(t('Ich schreibe deine Seiten – das dauert bis zu einer Minute …'));
    const r = await act(() => api.post<Generated>('/api/site-ai/generate', { brief, plan }));
    setBusy('');
    if (r) {
      setGen(r);
      setPage(r.pages[0]?.slug ?? '');
      setStep('review');
    }
  };
  const apply = async () => {
    if (!gen) return;
    setBusy(t('Ich lege den Entwurf an …'));
    const r = await act(() => api.post<{ funnel_id: string }>(`/api/site-ai/runs/${gen.run_id}/apply`, {}), t('Als Entwurf angelegt – noch nicht öffentlich'));
    setBusy('');
    if (r) onCreated(r);
  };

  const TYPES: { value: string; title: string; text: string; icon: IconName }[] = [
    { value: 'landing', title: t('Landingpage'), text: t('Eine Seite, ein Ziel'), icon: 'hero' },
    { value: 'funnel', title: t('Funnel'), text: t('Mehrere Schritte nacheinander'), icon: 'funnels' },
    { value: 'website', title: t('Website'), text: t('Mehrere Seiten mit Menü'), icon: 'website' },
  ];
  const GOALS: { value: string; title: string; text: string; icon: IconName }[] = [
    { value: 'leads', title: t('Anfragen'), text: t('Formular'), icon: 'forms' },
    { value: 'booking', title: t('Termine'), text: t('Kalender'), icon: 'calendars' },
    { value: 'sale', title: t('Verkaufen'), text: t('Produkt & Kasse'), icon: 'cart' },
    { value: 'info', title: t('Informieren'), text: t('Kontakt'), icon: 'text' },
  ];
  const SECTION_LABEL: Record<string, string> = {
    hero: t('Hero'),
    benefits: t('Vorteile'),
    steps: t('Ablauf'),
    stats: t('Zahlen'),
    testimonials: t('Kundenstimmen'),
    pricing: t('Preise'),
    faq: t('FAQ'),
    cta: t('Aufruf'),
    form: t('Formular'),
    calendar: t('Kalender'),
    product: t('Produkt'),
    text: t('Text'),
    about: t('Über uns'),
    contact: t('Kontakt'),
    thanks: t('Danke'),
  };
  const TONES: [string, string][] = [
    ['freundlich', t('Freundlich')],
    ['professionell', t('Professionell')],
    ['locker', t('Locker')],
    ['premium', t('Premium')],
    ['mutig', t('Mutig')],
  ];

  const footer =
    step === 'brief' ? (
      <button className="btn ai" disabled={!enough || !!busy || !status.data?.ready || est?.fits === false} onClick={makePlan}>
        <Icon name="ai" size={15} /> {t('Seitenplan erstellen')}
      </button>
    ) : step === 'plan' ? (
      <>
        <button className="btn secondary" disabled={!!busy} onClick={() => setStep('brief')}>
          {t('← Briefing')}
        </button>
        <button className="btn ai" disabled={!!busy || !plan?.pages.length} onClick={write}>
          <Icon name="ai" size={15} /> {t('Seiten schreiben')}
        </button>
      </>
    ) : (
      <>
        <button className="btn secondary" disabled={!!busy} onClick={write}>
          {t('Neu schreiben')}
        </button>
        <button className="btn ai" disabled={!!busy} onClick={apply}>
          {t('Als Entwurf anlegen')}
        </button>
      </>
    );

  return (
    <Modal title={t('Mit KI erstellen')} onClose={onClose} wide className="ai-scope" footer={footer}>
      {!status.data ? (
        <Spinner />
      ) : !status.data.ready ? (
        <Bubble>
          <p>{t('Die KI ist für diesen Sub-Account noch nicht bereit:')}</p>
          <p>
            <b>{status.data.reason}</b>
          </p>
          <p>{t('Schalte unter Einstellungen → KI-Assistent den Assistenten ein (eigener Schlüssel) oder wähle unter KI-Anbieter eine Verbindung für „Funnel & Website AI“.')}</p>
        </Bubble>
      ) : step === 'brief' ? (
        <>
          <Bubble>
            <p>{t('Hallo! Ich baue dir eine Landingpage, einen Funnel oder eine ganze Website – mit deinem Design, deinem Formular und den Rechtstexten. Was bietest du an?')}</p>
          </Bubble>
          <Chips label={t('Vorschläge')} items={status.data.examples.map((e, i) => [String(i), e])} onPick={(i) => set({ extra: status.data!.examples[Number(i)] })} />
          <div className="ai-label">{t('Was soll entstehen?')}</div>
          <RadioCards name="ai-type" label={t('Art')} value={brief.page_type} onChange={(v) => set({ page_type: v })} options={TYPES} />
          <div className="ai-label">{t('Ziel')}</div>
          <RadioCards name="ai-goal" label={t('Ziel')} small value={brief.goal} onChange={(v) => set({ goal: v })} options={GOALS} />
          <div className="grid2">
            <Field label={t('Unternehmen')}>
              <Input value={brief.business} onChange={(v) => set({ business: v })} placeholder={t('z. B. Malerbetrieb Meier, Köln')} />
            </Field>
            <Field label={t('Angebot')}>
              <Input value={brief.offer} onChange={(v) => set({ offer: v })} placeholder={t('z. B. Innen- und Fassadenanstrich')} />
            </Field>
          </div>
          <Field label={t('Zielgruppe (optional)')}>
            <Input value={brief.audience} onChange={(v) => set({ audience: v })} placeholder={t('z. B. Eigentümer und Hausverwaltungen')} />
          </Field>
          <Field label={t('Was noch wichtig ist (optional)')}>
            <Textarea value={brief.extra} onChange={(v) => set({ extra: v })} rows={3} placeholder={t('Preise, Besonderheiten, gewünschte Seiten oder Schritte …')} />
          </Field>
          <div className="ai-label">{t('Ton & Anrede')}</div>
          <RadioCards name="ai-tone" label={t('Ton')} small value={brief.tone} onChange={(v) => set({ tone: v })} options={TONES.map(([value, title]) => ({ value, title }))} />
          <div className="grid2">
            <RadioCards name="ai-address" label={t('Anrede')} small value={brief.address} onChange={(v) => set({ address: v })} options={[{ value: 'du', title: t('Du') }, { value: 'sie', title: t('Sie') }]} />
            <RadioCards name="ai-lang" label={t('Sprache')} small value={brief.language} onChange={(v) => set({ language: v })} options={[{ value: 'de', title: t('Deutsch') }, { value: 'en', title: t('Englisch') }]} />
          </div>
          <CostLine estimate={est} status={status.data} />
        </>
      ) : step === 'plan' && plan ? (
        <>
          <Bubble>
            <p>
              <b>{plan.site_name}</b> – {plan.summary}
            </p>
            <p>{t('So würde ich es aufbauen. Passe die Namen an oder entferne Seiten, dann schreibe ich die Inhalte.')}</p>
          </Bubble>
          <ol className="ai-plan">
            {plan.pages.map((p, i) => (
              <li key={p.slug}>
                <div className="row" style={{ alignItems: 'center' }}>
                  <div className="grow">
                    <Input value={p.name} aria-label={t('Name der Seite')} onChange={(v) => setPlan({ ...plan, pages: plan.pages.map((x, j) => (j === i ? { ...x, name: v } : x)) })} />
                  </div>
                  <span className="muted small mono">/{p.slug}</span>
                  {plan.pages.length > 1 && (
                    <button className="icon-btn" aria-label={t('Seite entfernen')} onClick={() => setPlan({ ...plan, pages: plan.pages.filter((_, j) => j !== i) })}>
                      ✕
                    </button>
                  )}
                </div>
                {p.purpose && <div className="muted small">{p.purpose}</div>}
                <div className="secs">
                  {p.sections.map((s) => (
                    <span key={s}>{SECTION_LABEL[s] ?? s}</span>
                  ))}
                </div>
              </li>
            ))}
          </ol>
          <div className="ai-cost">
            <span>
              {t('Plan:')} <b>{usd(planCost)}</b>
            </span>
          </div>
          <CostLine estimate={est} />
        </>
      ) : gen ? (
        <>
          <Bubble>
            <p>{t('Fertig! Hier ist dein Entwurf – prüfe die Seiten in der Vorschau. Angelegt wird er als Entwurf: öffentlich erst, wenn du im Editor „Veröffentlichen“ klickst.')}</p>
            {gen.notes.length > 0 && (
              <ul className="ai-notes">
                {gen.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
          </Bubble>
          <div className="ai-review">
            <div className="pages">
              {gen.pages.map((p) => (
                <button key={p.slug} className={`btn small ${p.slug === page ? '' : 'secondary'}`} onClick={() => setPage(p.slug)}>
                  {p.name}
                  <span className="muted small"> · {t.plural(p.sections.length, { one: '{n} Abschnitt', other: '{n} Abschnitte' })}</span>
                </button>
              ))}
              <div className="ai-cost">
                <span>
                  {t('Kosten:')} <b>{usd(gen.cost_usd + planCost)}</b>
                </span>
                {gen.attempts > 1 && <span>{t('{n} Versuche (geprüft gegen die Blöcke des Baukastens)', { n: gen.attempts })}</span>}
              </div>
              {gen.warnings.length > 0 && (
                <details>
                  <summary className="small">{t.plural(gen.warnings.length, { one: '{n} Hinweis der Prüfung', other: '{n} Hinweise der Prüfung' })}</summary>
                  <ul className="ai-notes warn">
                    {gen.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
            {page && <Preview url={`/api/site-ai/runs/${gen.run_id}/preview?page=${encodeURIComponent(page)}`} title={t('Vorschau')} />}
          </div>
        </>
      ) : null}
      {busy && <Working text={busy} />}
    </Modal>
  );
}
