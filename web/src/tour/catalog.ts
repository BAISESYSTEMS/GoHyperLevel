import type { IconName } from '../icons';
import type { Tour, TourGroup, TourProgress, TourStep } from './types';
import { JOURNEY } from './content/journey';
import { START_TOURS } from './content/start';
import { CRM_TOURS } from './content/crm';
import { MARKETING_TOURS } from './content/marketing';
import { SITES_TOURS } from './content/sites';
import { REVENUE_TOURS } from './content/revenue';
import { AI_TOURS } from './content/ai';
import { SETTINGS_TOURS } from './content/settings';
import { AGENCY_TOURS } from './content/agency';
import { BACKOFFICE_TOURS } from './content/backoffice';
import { SERVICE_TOURS } from './content/service';
import { TEAMTOOLS_TOURS } from './content/teamtools';
import { DATA_TOURS } from './content/data';
import { CONNECT_TOURS } from './content/connect';
import { AGENT_TOURS } from '../agent/tour';
import { CANVAS_TOURS } from '../canvas/tour';
import { WERKSTATT_TOURS } from '../werkstatt/tour';
import { COLLAB_TOURS } from '../pages/collab-tour';
import { FEEDBACK_TOURS } from './content/feedback';
import { GENMEDIA_TOURS } from './content/genmedia';
import { WORKFLOW_TOOLS_TOURS } from './content/workflow-tools';
import { PM_TOURS } from './content/pm';
import { MAILBOX_TOURS } from './content/mailbox';
import { ADS_TOURS } from './content/ads';
import { VOICE_TOURS } from './content/voice';
import { CALC_TOURS } from './content/calc';
import { BOARD_TOURS } from './content/boards';
import { WEBINAR_TOURS } from './content/webinars';
import { CREATOR_TOURS } from './content/creator';
import { SEPA_TOURS } from './content/sepa';
import { XR_TOURS } from './content/xr';
import { UNDO_TOURS } from './content/undo';
import { UMZUG_TOURS } from './content/umzug';
import { MEMORY_TOURS } from './content/memory';
import { CALLS_TOURS } from './content/calls';
import { SALES_TOURS } from './content/sales';
import { COMPANY_TOURS } from './content/company';

/** All tours: the big journey („Firma übernehmen“, in chapters) and one tour per area. Pure data – no React. */
export { JOURNEY };
export const MODULE_TOURS: Tour[] = [
  ...START_TOURS,
  // the course „Deine Firma mit {brand} führen“ (10 lessons, docs/kurs-firma-fuehren.md)
  ...COMPANY_TOURS,
  ...UNDO_TOURS,
  ...FEEDBACK_TOURS,
  ...CRM_TOURS,
  ...CALLS_TOURS,
  ...TEAMTOOLS_TOURS,
  ...PM_TOURS,
  ...MARKETING_TOURS,
  ...WORKFLOW_TOOLS_TOURS,
  ...DATA_TOURS,
  ...SITES_TOURS,
  ...REVENUE_TOURS,
  ...BACKOFFICE_TOURS,
  ...SERVICE_TOURS,
  ...AI_TOURS,
  ...AGENT_TOURS,
  ...CANVAS_TOURS,
  ...COLLAB_TOURS,
  ...GENMEDIA_TOURS,
  ...WERKSTATT_TOURS,
  ...MAILBOX_TOURS,
  ...ADS_TOURS,
  ...VOICE_TOURS,
  ...CALC_TOURS,
  ...BOARD_TOURS,
  ...WEBINAR_TOURS,
  ...CREATOR_TOURS,
  ...SEPA_TOURS,
  ...XR_TOURS,
  ...SETTINGS_TOURS,
  ...UMZUG_TOURS,
  ...MEMORY_TOURS,
  ...SALES_TOURS,
  ...CONNECT_TOURS,
  ...AGENCY_TOURS,
];
export const TOURS: Tour[] = [...JOURNEY, ...MODULE_TOURS];

export const GROUPS: { id: TourGroup; label: string; icon: IconName }[] = [
  { id: 'start', label: 'Erste Schritte', icon: 'academy' },
  { id: 'company', label: 'Kurs: Deine Firma führen', icon: 'trophy' },
  { id: 'crm', label: 'Kunden & Tagesgeschäft', icon: 'contacts' },
  { id: 'marketing', label: 'Marketing', icon: 'campaigns' },
  { id: 'sites', label: 'Websites, Kurse & Community', icon: 'website' },
  { id: 'revenue', label: 'Umsatz', icon: 'invoices' },
  { id: 'reputation', label: 'Reputation', icon: 'reviews' },
  { id: 'service', label: 'Service & Support', icon: 'service' },
  { id: 'ai', label: 'KI', icon: 'ai' },
  { id: 'settings', label: 'Einstellungen & Kanäle', icon: 'settings' },
  { id: 'agency', label: 'Agentur & Betrieb', icon: 'agency' },
];

export const tourById = (id: string) => TOURS.find((t) => t.id === id);

/** Who is looking: agency admin or a (possibly restricted) member. */
export interface Access {
  admin: boolean;
  can: (perm: string) => boolean;
}

export const tourVisible = (t: Pick<Tour, 'admin' | 'perm'>, a: Access) => (!t.admin || a.admin) && (!t.perm || a.can(t.perm));
export const stepVisible = (s: TourStep, a: Access) => (!s.admin || a.admin) && (!s.perm || a.can(s.perm));
export const visibleTours = (a: Access, list: Tour[] = TOURS) => list.filter((t) => tourVisible(t, a));

/** Tours the „?“ button offers on a page (`settings/telephony`, `contacts/123` …), most specific first. */
export function toursForPath(path: string, a: Access): Tour[] {
  const p = path.replace(/^\/+|\/+$/g, '');
  const score = (t: Tour) => Math.max(-1, ...(t.routes ?? []).map((r) => (p === r || p.startsWith(r + '/') ? r.length : -1)));
  return visibleTours(a, MODULE_TOURS)
    .map((t) => [t, score(t)] as const)
    .filter(([, s]) => s >= 0)
    .sort((x, y) => y[1] - x[1])
    .map(([t]) => t);
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
export function searchTours(list: Tour[], q: string): Tour[] {
  const words = norm(q).split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((t) => {
    const hay = norm([t.title, t.summary, t.keywords ?? '', ...t.steps.map((s) => s.title)].join(' '));
    return words.every((w) => hay.includes(w));
  });
}

/** Share of the journey's (visible) chapters done, 0–1, plus the chapter to continue with. */
export function journeyStatus(progress: Record<string, TourProgress>, a: Access) {
  const chapters = visibleTours(a, JOURNEY);
  const done = chapters.filter((c) => progress[c.id]?.done).length;
  const next = chapters.find((c) => !progress[c.id]?.done) ?? null;
  return { chapters, done, total: chapters.length, share: chapters.length ? done / chapters.length : 0, next };
}

export interface Badge {
  id: string;
  label: string;
  hint: string;
  icon: IconName;
  earned: boolean;
}

/** Small rewards for finished tours. Group badges only count when the person can see that group. */
export function badges(progress: Record<string, TourProgress>, a: Access): Badge[] {
  const done = (t: Tour) => !!progress[t.id]?.done;
  const mods = visibleTours(a, MODULE_TOURS);
  const group = (g: TourGroup) => mods.filter((t) => t.group === g);
  const all = (list: Tour[]) => list.length > 0 && list.every(done);
  const out: Badge[] = [
    { id: 'first', label: 'Erste Tour', hint: 'Eine Tour bis zum Ende gemacht', icon: 'flag', earned: visibleTours(a).some(done) },
    { id: 'start', label: 'Orientiert', hint: 'Alle Touren unter „Erste Schritte“', icon: 'academy', earned: all(group('start')) },
    { id: 'company', label: 'Firma im Griff', hint: 'Alle Lektionen des Kurses „Deine Firma führen“', icon: 'trophy', earned: all(group('company')) },
    { id: 'crm', label: 'CRM-Profi', hint: 'Alle Touren zu Kunden & Tagesgeschäft', icon: 'contacts', earned: all(group('crm')) },
    { id: 'marketing', label: 'Marketing-Profi', hint: 'Alle Marketing-Touren', icon: 'campaigns', earned: all(group('marketing')) },
    { id: 'sites', label: 'Seiten-Baumeister', hint: 'Alle Touren zu Websites, Kursen & Community', icon: 'website', earned: all(group('sites')) },
    { id: 'revenue', label: 'Umsatz-Profi', hint: 'Alle Umsatz-Touren', icon: 'invoices', earned: all(group('revenue')) },
    { id: 'reputation', label: 'Gut bewertet', hint: 'Alle Touren zu Bewertungen und Google', icon: 'reviews', earned: all(group('reputation')) },
    { id: 'service', label: 'Service-Held', hint: 'Alle Touren zu Service & Support', icon: 'service', earned: all(group('service')) },
    { id: 'ai', label: 'KI-Pionier', hint: 'Alle KI-Touren', icon: 'ai', earned: all(group('ai')) },
    { id: 'settings', label: 'Einstellungs-Kenner', hint: 'Alle Touren zu Einstellungen & Kanälen', icon: 'settings', earned: all(group('settings')) },
  ];
  if (a.admin) out.push({ id: 'agency', label: 'Agentur-Chef', hint: 'Alle Agentur-Touren', icon: 'agency', earned: all(group('agency')) });
  const j = visibleTours(a, JOURNEY);
  out.push({ id: 'journey', label: 'Firma übernommen', hint: 'Alle Kapitel von „Firma übernehmen“', icon: 'trophy', earned: all(j) });
  out.push({ id: 'all', label: 'Absolvent', hint: 'Wirklich alle Touren der Akademie', icon: 'award', earned: all(visibleTours(a)) });
  // Groups this person cannot see at all give no badge.
  return out.filter((b) => !(['start', 'company', 'crm', 'marketing', 'sites', 'revenue', 'reputation', 'service', 'ai', 'settings', 'agency'] as string[]).includes(b.id) || group(b.id as TourGroup).length > 0);
}

export type RunStep = TourStep & { special?: 'context' | 'outro' };

/**
 * The steps this person sees: optional practice intro, the visible steps, and the „Geschafft“ card.
 * A step without its own route plays on the page of the step before – unless that one was an action
 * that changes the screen (click, navigate, wait); this way jumping back or resuming opens the right page.
 */
export function composeSteps(tour: Tour, a: Access): RunStep[] {
  let page: string | undefined;
  const steps: RunStep[] = tour.steps
    .filter((s) => stepVisible(s, a))
    .map((s) => {
      const out = s.route || !page ? s : { ...s, route: page };
      if (s.route) page = s.route;
      if (s.kind === 'click' || s.kind === 'navigate' || s.kind === 'wait') page = undefined;
      return out;
    });
  const intro: RunStep[] = tour.practice && a.admin ? [{ special: 'context', title: 'Wo möchtest du üben?', text: 'In dieser Tour legst du selbst etwas an. Am besten übst du in der **Übungs-Firma** – dort sind alle Kunden erfunden und nichts wird verschickt.' }] : [];
  return [...intro, ...steps, { special: 'outro', title: tour.chapter ? `Kapitel ${tour.chapter} geschafft!` : 'Geschafft!', text: 'Das hast du gelernt:' }];
}

/** Where a resumed tour starts: the step itself, or the last one before it that opens its own page. */
export function resumeIndex(steps: RunStep[], at: number): number {
  let i = Math.max(0, Math.min(at, steps.length - 1));
  while (i > 0 && !steps[i].route && !steps[i].special) i--;
  return i;
}

/** Every `data-tour` key the tours point at (used by the test that checks they exist in the code). */
export function tourTargets(list: Tour[] = TOURS): { tour: string; step: number; target: string }[] {
  const out: { tour: string; step: number; target: string }[] = [];
  for (const t of list) t.steps.forEach((s, i) => s.target && out.push({ tour: t.id, step: i, target: s.target }));
  return out;
}
