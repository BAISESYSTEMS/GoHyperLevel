import { useMemo, useState } from 'react';
import { Icon } from '../icons';
import { useSession } from '../session';
import { ProfilesCard } from '../theme/Profiles';
import { Badge, Empty, PageHead, Spinner, act, confirmAsk, navigate } from '../ui';
import { GROUPS, JOURNEY, MODULE_TOURS, badges, journeyStatus, searchTours, visibleTours } from '../tour/catalog';
import { DocViewer, Handbook } from '../tour/docs';
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

function TourCard({ t, p }: { t: Tour; p?: TourProgress }) {
  const at = resumeAt(p);
  return (
    <div className={`card ac-card${p?.done ? ' done' : ''}`}>
      <div className="ac-card-top">
        <span className="ac-ico">
          <Icon name={t.icon} size={18} />
        </span>
        <div className="grow">
          <h3>{t.title}</h3>
          <div className="muted small">
            {t.steps.length} Schritte · ca. {t.minutes} Min.{t.admin ? ' · Agentur' : ''}
          </div>
        </div>
      </div>
      <p className="muted small ac-sum">{t.summary}</p>
      {p && !p.done && <Progress value={share(p)} label={`Fortschritt ${t.title}`} />}
      <div className="actions">
        {p?.done && <Badge tone="green">✓ erledigt</Badge>}
        <button className={`btn small${p?.done ? ' secondary' : ''}`} onClick={() => startTour(t.id, at)}>
          <Icon name="play" size={14} /> {at ? 'Weitermachen' : p?.done ? 'Nochmal' : 'Starten'}
        </button>
        {p && !p.done && at > 0 && (
          <button className="btn small ghost" onClick={() => act(() => resetTour(t.id)).then(() => startTour(t.id, 0))}>
            Von vorn
          </button>
        )}
      </div>
    </div>
  );
}

function SandboxCard() {
  const session = useSession();
  const academy = useAcademy();
  const [busy, setBusy] = useState(false);
  const sb = academy?.sandbox;
  return (
    <div className="card ac-sandbox" data-tour="academy-sandbox">
      <h2>
        <Icon name="academy" size={18} /> Übungs-Firma
      </h2>
      <p className="muted small">
        Ein eigener Sub-Account mit erfundenen Kunden, Deals, Terminen und Rechnungen (…@example.com). E-Mails und SMS werden dort nur gespeichert, nie verschickt – ideal, um alles gefahrlos auszuprobieren.
      </p>
      {sb ? (
        <div className="actions">
          {session.locationId === sb.id ? (
            <Badge tone="blue">Du bist gerade drin</Badge>
          ) : (
            <button className="btn small" onClick={() => session.switchLocation(sb.id, 'academy')}>
              In die Übungs-Firma wechseln
            </button>
          )}
          <button
            className="btn small ghost"
            disabled={busy}
            onClick={async () => {
              if (!confirmAsk(`„${sb.name}“ mit allen Übungsdaten löschen?`)) return;
              setBusy(true);
              const back = session.locations.find((l) => l.id !== sb.id);
              if ((await act(() => deleteSandbox(), 'Übungs-Firma gelöscht')) !== undefined) {
                await session.reload();
                if (session.locationId === sb.id && back) session.switchLocation(back.id, 'academy');
              }
              setBusy(false);
            }}
          >
            Löschen
          </button>
        </div>
      ) : (
        <button
          className="btn small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const r = await act(() => createSandbox(), 'Übungs-Firma angelegt');
            if (r) {
              await session.reload();
              session.switchLocation(r.id, 'academy');
            }
            setBusy(false);
          }}
        >
          {busy ? 'Wird angelegt …' : 'Übungs-Firma mit Demo-Daten anlegen'}
        </button>
      )}
    </div>
  );
}

function Overview() {
  const session = useSession();
  const academy = useAcademy();
  const [q, setQ] = useState('');
  const access = accessOf(session);
  const admin = session.user.role === 'admin';
  const progress = academy?.tours ?? {};
  const tours = useMemo(() => searchTours(visibleTours(access, MODULE_TOURS), q), [q, session.user]);
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
      <PageHead title="Akademie" sub="Geführte Touren direkt in der echten Oberfläche – Schritt für Schritt, mit Pausen, jederzeit fortsetzbar.">
        <input className="ac-search" data-tour="academy-search" placeholder="Tour suchen, z. B. Rechnung, WhatsApp …" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn secondary" data-tour="academy-handbook" onClick={() => navigate('academy/handbuch')}>
          <Icon name="printer" size={15} /> Handbuch
        </button>
      </PageHead>

      {!q && (
        <div className="card ac-journey" data-tour="academy-journey">
          <div className="ac-journey-head">
            <span className="ac-trophy">
              <Icon name="trophy" size={26} />
            </span>
            <div className="grow">
              <div className="muted small">Gesamt-Guide · {chapters.length} Kapitel · ca. {Math.round(chapterMinutes / 60)} Std.</div>
              <h2>Firma übernehmen</h2>
              <p className="muted" style={{ margin: 0 }}>
                Alles, was du brauchst, um die Firma mit {session.branding.name} zu führen – vom sicheren Zugang über die Tagesroutine bis zum Server-Betrieb. Mach ein Kapitel nach dem anderen; du kannst jederzeit pausieren.
              </p>
            </div>
            <div className="ac-journey-cta">
              {nextChapter ? (
                <button className="btn" onClick={() => startTour(nextChapter.id, resumeAt(progress[nextChapter.id]))}>
                  <Icon name="play" size={15} /> {j.done || resumeAt(progress[nextChapter.id]) ? 'Weitermachen' : 'Jetzt starten'}
                </button>
              ) : (
                <Badge tone="green">🏆 Alles geschafft</Badge>
              )}
            </div>
          </div>
          <div className="row" style={{ alignItems: 'center', gap: 10 }}>
            <div className="grow">
              <Progress value={j.share} label="Fortschritt Gesamt-Guide" />
            </div>
            <span className="small muted">
              {j.done}/{j.total} Kapitel
            </span>
          </div>
          <ol className="ac-chapters">
            {chapters.map((c) => {
              const p = progress[c.id];
              const cur = nextChapter?.id === c.id;
              return (
                <li key={c.id} className={`${p?.done ? 'done' : ''}${cur ? ' cur' : ''}`}>
                  <button onClick={() => startTour(c.id, resumeAt(p))} title={c.summary}>
                    <span className="ac-num">{p?.done ? '✓' : c.chapter}</span>
                    <span className="grow">
                      {c.title}
                      <small>
                        {c.steps.length} Schritte · {c.minutes} Min.{p && !p.done && resumeAt(p) ? ' · angefangen' : ''}
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
          <h3>Weitermachen</h3>
          <div className="actions">
            {started.map((t) => (
              <button key={t.id} className="btn small secondary" onClick={() => startTour(t.id, resumeAt(progress[t.id]))}>
                <Icon name={t.icon} size={14} /> {t.title} · Schritt {resumeAt(progress[t.id]) + 1}
              </button>
            ))}
          </div>
        </div>
      )}

      {!q && (
        <div className="ac-row">
          <div className="card ac-badges" data-tour="academy-badges">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <h2>Abzeichen</h2>
              <span className="muted small">
                {doneCount} von {allVisible.length} Touren erledigt
              </span>
            </div>
            <Progress value={allVisible.length ? doneCount / allVisible.length : 0} label="Alle Touren" />
            <div className="ac-badge-list">
              {earned.map((b) => (
                <div key={b.id} className={`ac-badge${b.earned ? ' on' : ''}`} title={b.hint}>
                  <Icon name={b.icon} size={20} />
                  <span>{b.label}</span>
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
          const list = tours.filter((t) => t.group === g.id);
          if (!list.length) return null;
          return (
            <section key={g.id} className="ac-group">
              <h2 className="ac-group-title">
                <Icon name={g.icon} size={18} /> {g.label}
                <span className="muted small">
                  {list.filter((t) => progress[t.id]?.done).length}/{list.length}
                </span>
              </h2>
              <div className="ac-grid">
                {list.map((t) => (
                  <TourCard key={t.id} t={t} p={progress[t.id]} />
                ))}
              </div>
            </section>
          );
        })}
        {!tours.length && <Empty>Keine Tour gefunden. Versuch ein anderes Wort – oder frag oben rechts beim „?“.</Empty>}
      </div>
    </>
  );
}

export function Academy({ path = [] }: { path?: string[] }) {
  if (path[0] === 'handbuch') return <Handbook />;
  if (path[0] === 'docs' && path[1]) return <DocViewer name={path[1]} />;
  return <Overview />;
}
