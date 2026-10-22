import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { useSession } from '../session';
import { navigate, useRoute } from '../ui';
import { journeyStatus, toursForPath, tourById } from './catalog';
import { accessOf, startTour } from './engine';
import { FIRST_TOUR } from './learn';
import { useAcademy } from './progress';
import type { Tour } from './types';

/** „?“ in the top bar: the tours for the page you are on, „Weitermachen“ and the way to the academy. */
export function HelpButton() {
  const session = useSession();
  const route = useRoute();
  const academy = useAcademy();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const access = accessOf(session);
  const path = route.join('/') || (session.user.role === 'admin' ? 'agency' : 'dashboard');
  const tours = toursForPath(path, access).slice(0, 5);
  const progress = academy?.tours ?? {};
  const active = academy?.active ? tourById(academy.active.tour) : undefined;
  const journey = journeyStatus(progress, access);
  // „In 10 Minuten startklar“ until the first tour is done (unless the page offers it anyway).
  const first = !progress[FIRST_TOUR]?.done && !tours.some((t) => t.id === FIRST_TOUR) ? tourById(FIRST_TOUR) : undefined;

  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', off);
    window.addEventListener('keydown', esc);
    return () => (document.removeEventListener('mousedown', off), window.removeEventListener('keydown', esc));
  }, [open]);

  const begin = (t: Tour, step = 0) => {
    setOpen(false);
    startTour(t.id, step);
  };
  const resumeStep = (t: Tour) => {
    const p = progress[t.id];
    return p && !p.done && p.step > 0 && p.step < p.total - 1 ? p.step : 0;
  };

  return (
    <div className="help-wrap" ref={ref}>
      <button className="btn secondary small help-btn" data-tour="help" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Hilfe und Touren" title="Hilfe: geführte Tour für diese Seite">
        <Icon name="help" size={16} />
      </button>
      {open && (
        <div className="help-pop" role="dialog" aria-label="Hilfe">
          <div className="help-head">
            <strong>Hilfe zu dieser Seite</strong>
            <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Schließen">
              ✕
            </button>
          </div>
          {active && (
            <button className="help-row resume" onClick={() => begin(active, academy!.active!.step)}>
              <Icon name="play" size={15} />
              <span className="grow">
                Weitermachen: {active.title}
                <small>Schritt {academy!.active!.step + 1}</small>
              </span>
            </button>
          )}
          {first && (
            <button className="help-row" onClick={() => begin(first, resumeStep(first))} data-tour="help-first-tour">
              <Icon name="academy" size={15} />
              <span className="grow">
                Lernen: In 10 Minuten startklar
                <small>Geführte Tour „{first.title}“ · ca. {first.minutes} Min.</small>
              </span>
              <Icon name="play" size={14} className="ico muted" />
            </button>
          )}
          {tours.length ? (
            tours.map((t) => (
              <button key={t.id} className="help-row" onClick={() => begin(t, resumeStep(t))}>
                <Icon name={t.icon} size={15} />
                <span className="grow">
                  {t.title}
                  <small>
                    {t.steps.length} Schritte · ca. {t.minutes} Min.{progress[t.id]?.done ? ' · ✓ erledigt' : resumeStep(t) ? ' · angefangen' : ''}
                  </small>
                </span>
                <Icon name="play" size={14} className="ico muted" />
              </button>
            ))
          ) : (
            <p className="muted small" style={{ margin: '6px 10px' }}>
              Für diese Seite gibt es keine eigene Tour – in der Akademie findest du alle.
            </p>
          )}
          {journey.next && (
            <button className="help-row" onClick={() => begin(journey.next!, resumeStep(journey.next!))}>
              <Icon name="trophy" size={15} />
              <span className="grow">
                Gesamt-Guide „Firma übernehmen“
                <small>
                  {journey.done}/{journey.total} Kapitel · weiter mit {journey.next.title}
                </small>
              </span>
            </button>
          )}
          <a
            className="help-all"
            href="/app/academy"
            onClick={(e) => {
              e.preventDefault();
              setOpen(false);
              navigate('academy');
            }}
          >
            Alle Touren in der Akademie →
          </a>
        </div>
      )}
    </div>
  );
}

/** A clear hint while you are in the practice sub-account. */
export function SandboxBanner() {
  const session = useSession();
  const academy = useAcademy();
  if (!academy?.sandbox || academy.sandbox.id !== session.locationId) return null;
  return (
    <div className="sandbox-banner" data-tour="sandbox-banner">
      <Icon name="academy" size={16} />
      <span className="grow">
        <strong>Übungs-Firma:</strong> Hier ist alles erfunden – probier ruhig alles aus.<span className="sb-more"> E-Mails und SMS werden nur gespeichert, nie verschickt.</span>
      </span>
      <a
        href="/app/academy"
        onClick={(e) => {
          e.preventDefault();
          navigate('academy');
        }}
      >
        Zur Akademie
      </a>
    </div>
  );
}
