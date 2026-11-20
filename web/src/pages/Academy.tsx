import { useMemo, useState } from 'react';
import { useLocale, useT } from '../i18n';
import { Icon } from '../icons';
import { useSession } from '../session';
import { ProfilesCard } from '../theme/Profiles';
import { Badge, Empty, PageHead, Spinner, act, confirmAsk, navigate } from '../ui';
import { GROUPS, JOURNEY, MODULE_TOURS, badges, journeyStatus, searchTours, visibleTours } from '../tour/catalog';
import { DocViewer, Handbook } from '../tour/docs';
import { tourText } from '../tour/handbook';
import { accessOf, startTour } from '../tour/engine';
import { Handover } from '../tour/handover';
import { createSandbox, deleteSandbox, resetTour, useAcademy } from '../tour/progress';
import type { Tour, TourProgress } from '../tour/types';

/**
 * Akademie: guided tours through the whole app – the big journey „Firma übernehmen“ for a
 * successor, one tour per area, progress and badges, the hand-over status, the practice company
 * and the printable handbook.
 */

const resumeAt = (p?: TourProgress) => (p && !p.done && p.step > 0 && p.step < p.total - 1 ? p.step : 0);
const share = (p?: TourProgress) => (p ? (p.done ? 1 : Math.min(1, (p.max_step + 1) / Math.max(1, p.total))) : 0);

function Progress({ value, label }: { value: number; label?: string }) {
  return (
    <div className="ac-progress" role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  );
}

/** A tour's title or summary in the UI language (the English lines of the handbook), with the brand filled in. */
function useTourText() {
  const locale = useLocale();
  const brand = useSession().branding.name || 'HyperLevel';
  return (s: string) => tourText(s, locale).replace(/\{brand\}/g, brand);
}

function TourCard({ tour, p }: { tour: Tour; p?: TourProgress }) {
  const t = useT('academy');
  const tx = useTourText();
  const at = resumeAt(p);
  return (
    <div className={`card ac-card${p?.done ? ' done' : ''}`}>
      <div className="ac-card-top">
        <span className="ac-ico">
          <Icon name={tour.icon} size={18} />
        </span>
        <div className="grow">
          <h3>{tx(tour.title)}</h3>
          <div className="muted small">
            {t('{n} Schritte · ca. {m} Min.', { n: tour.steps.length, m: tour.minutes })}
            {tour.admin ? ` · ${t('Agentur')}` : ''}
          </div>
        </div>
      </div>
      <p className="muted small ac-sum">{tx(tour.summary)}</p>
      {p && !p.done && <Progress value={share(p)} label={t('Fortschritt {title}', { title: tx(tour.title) })} />}
      <div className="actions">
        {p?.done && <Badge tone="green">{t('✓ erledigt')}</Badge>}
        <button className={`btn small${p?.done ? ' secondary' : ''}`} onClick={() => startTour(tour.id, at)}>
          <Icon name="play" size={14} /> {at ? t('Weitermachen') : p?.done ? t('Nochmal') : t('Starten')}
        </button>
        {p && !p.done && at > 0 && (
          <button className="btn small ghost" onClick={() => act(() => resetTour(tour.id)).then(() => startTour(tour.id, 0))}>
            {t('Von vorn')}
          </button>
        )}
      </div>
    </div>
  );
}

function SandboxCard() {
  const t = useT('academy');
  const session = useSession();
  const academy = useAcademy();
  const [busy, setBusy] = useState(false);
  const sb = academy?.sandbox;
  return (
    <div className="card ac-sandbox" data-tour="academy-sandbox">
      <h2>
        <Icon name="academy" size={18} /> {t('Übungs-Firma')}
      </h2>
      <p className="muted small">
        {t('Ein eigener Sub-Account mit erfundenen Kunden, Deals, Terminen und Rechnungen (…@example.com). E-Mails und SMS werden dort nur gespeichert, nie verschickt – ideal, um alles gefahrlos auszuprobieren.')}
      </p>
      {sb ? (
        <div className="actions">
          {session.locationId === sb.id ? (
            <Badge tone="blue">{t('Du bist gerade drin')}</Badge>
          ) : (
            <button className="btn small" onClick={() => session.switchLocation(sb.id, 'academy')}>
              {t('In die Übungs-Firma wechseln')}
            </button>
          )}
          <button
            className="btn small ghost"
            disabled={busy}
            onClick={async () => {
              if (!confirmAsk(t('„{name}“ mit allen Übungsdaten löschen?', { name: sb.name }))) return;
              setBusy(true);
              const back = session.locations.find((l) => l.id !== sb.id);
              if ((await act(() => deleteSandbox(), t('Übungs-Firma gelöscht'))) !== undefined) {
                await session.reload();
                if (session.locationId === sb.id && back) session.switchLocation(back.id, 'academy');
              }
              setBusy(false);
            }}
          >
            {t('Löschen')}
          </button>
        </div>
      ) : (
        <button
          className="btn small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const r = await act(() => createSandbox(), t('Übungs-Firma angelegt'));
            if (r) {
              await session.reload();
              session.switchLocation(r.id, 'academy');
            }
            setBusy(false);
          }}
        >
          {busy ? t('Wird angelegt …') : t('Übungs-Firma mit Demo-Daten anlegen')}
        </button>
      )}
    </div>
  );
}

function Overview() {
  const t = useT('academy');
  const tx = useTourText();
  const session = useSession();
  const academy = useAcademy();
  const [q, setQ] = useState('');
  const access = accessOf(session);
  const admin = session.user.role === 'admin';
  const progress = academy?.tours ?? {};
  const locale = useLocale();
  const tours = useMemo(() => {
    const all = visibleTours(access, MODULE_TOURS);
    const hits = searchTours(all, q);
    if (locale !== 'en' || !q.trim()) return hits;
    // in English the English titles and summaries match too (the keywords are German)
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((x) => hits.includes(x) || words.every((w) => `${tx(x.title)} ${tx(x.summary)}`.toLowerCase().includes(w)));
  }, [q, session.user, locale]);
  const chapters = visibleTours(access, JOURNEY);
  const j = journeyStatus(progress, access);
  const earned = badges(progress, access);
  const started = visibleTours(access, MODULE_TOURS).filter((t) => progress[t.id] && !progress[t.id].done && resumeAt(progress[t.id]) > 0);
  const allVisible = visibleTours(access);
  const doneCount = allVisible.filter((t) => progress[t.id]?.done).length;
  if (!academy) return <Spinner />;
  const nextChapter = j.next;
  const chapterMinutes = chapters.reduce((s, c) => s + c.minutes, 0);

  return (
    <>
      <PageHead title={t('Akademie')} sub={t('Geführte Touren direkt in der echten Oberfläche – Schritt für Schritt, mit Pausen, jederzeit fortsetzbar.')}>
        <input className="ac-search" data-tour="academy-search" placeholder={t('Tour suchen, z. B. Rechnung, WhatsApp …')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn secondary" data-tour="academy-handbook" onClick={() => navigate('academy/handbuch')}>
          <Icon name="printer" size={15} /> {t('Handbuch')}
        </button>
      </PageHead>

      {!q && (
        <div className="card ac-journey" data-tour="academy-journey">
          <div className="ac-journey-head">
            <span className="ac-trophy">
              <Icon name="trophy" size={26} />
            </span>
            <div className="grow">
              <div className="muted small">{t('Gesamt-Guide · {n} Kapitel · ca. {h} Std.', { n: chapters.length, h: Math.round(chapterMinutes / 60) })}</div>
              <h2>{t('Firma übernehmen')}</h2>
              <p className="muted" style={{ margin: 0 }}>
                {t('Alles, was du brauchst, um die Firma mit {brand} zu führen – vom sicheren Zugang über die Tagesroutine bis zum Server-Betrieb. Mach ein Kapitel nach dem anderen; du kannst jederzeit pausieren.', { brand: session.branding.name })}
              </p>
            </div>
            <div className="ac-journey-cta">
              {nextChapter ? (
                <button className="btn" onClick={() => startTour(nextChapter.id, resumeAt(progress[nextChapter.id]))}>
                  <Icon name="play" size={15} /> {j.done || resumeAt(progress[nextChapter.id]) ? t('Weitermachen') : t('Jetzt starten')}
                </button>
              ) : (
                <Badge tone="green">{t('🏆 Alles geschafft')}</Badge>
              )}
            </div>
          </div>
          <div className="row" style={{ alignItems: 'center', gap: 10 }}>
            <div className="grow">
              <Progress value={j.share} label={t('Fortschritt Gesamt-Guide')} />
            </div>
            <span className="small muted">
              {t('{done}/{total} Kapitel', { done: j.done, total: j.total })}
            </span>
          </div>
          <ol className="ac-chapters">
            {chapters.map((c) => {
              const p = progress[c.id];
              const cur = nextChapter?.id === c.id;
              return (
                <li key={c.id} className={`${p?.done ? 'done' : ''}${cur ? ' cur' : ''}`}>
                  <button onClick={() => startTour(c.id, resumeAt(p))} title={tx(c.summary)}>
                    <span className="ac-num">{p?.done ? '✓' : c.chapter}</span>
                    <span className="grow">
                      {tx(c.title)}
                      <small>
                        {t('{n} Schritte · {m} Min.', { n: c.steps.length, m: c.minutes })}
                        {p && !p.done && resumeAt(p) ? ` · ${t('angefangen')}` : ''}
                      </small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {!q && started.length > 0 && (
        <div className="card ac-continue">
          <h3>{t('Weitermachen')}</h3>
          <div className="actions">
            {started.map((x) => (
              <button key={x.id} className="btn small secondary" onClick={() => startTour(x.id, resumeAt(progress[x.id]))}>
                <Icon name={x.icon} size={14} /> {tx(x.title)} · {t('Schritt {n}', { n: resumeAt(progress[x.id]) + 1 })}
              </button>
            ))}
          </div>
        </div>
      )}

      {!q && (
        <div className="ac-row">
          <div className="card ac-badges" data-tour="academy-badges">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <h2>{t('Abzeichen')}</h2>
              <span className="muted small">{t('{done} von {total} Touren erledigt', { done: doneCount, total: allVisible.length })}</span>
            </div>
            <Progress value={allVisible.length ? doneCount / allVisible.length : 0} label={t('Alle Touren')} />
            <div className="ac-badge-list">
              {earned.map((b) => (
                <div key={b.id} className={`ac-badge${b.earned ? ' on' : ''}`} title={t(b.hint)}>
                  <Icon name={b.icon} size={20} />
                  <span>{t(b.label)}</span>
                </div>
              ))}
            </div>
          </div>
          {admin && <SandboxCard />}
        </div>
      )}

      {!q && <ProfilesCard />}

      {!q && admin && <Handover />}

      <div data-tour="academy-tours">
        {GROUPS.map((g) => {
          const list = tours.filter((x) => x.group === g.id);
          if (!list.length) return null;
          return (
            <section key={g.id} className="ac-group">
              <h2 className="ac-group-title">
                <Icon name={g.icon} size={18} /> {tx(g.label)}
                <span className="muted small">
                  {list.filter((x) => progress[x.id]?.done).length}/{list.length}
                </span>
              </h2>
              <div className="ac-grid">
                {list.map((x) => (
                  <TourCard key={x.id} tour={x} p={progress[x.id]} />
                ))}
              </div>
            </section>
          );
        })}
        {!tours.length && <Empty>{t('Keine Tour gefunden. Versuch ein anderes Wort – oder frag oben rechts beim „?“.')}</Empty>}
      </div>
    </>
  );
}

export function Academy({ path = [] }: { path?: string[] }) {
  if (path[0] === 'handbuch') return <Handbook />;
  if (path[0] === 'docs' && path[1]) return <DocViewer name={path[1]} />;
  return <Overview />;
}
