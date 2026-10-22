import type { IconName } from '../icons';

/**
 * A guided tour: steps point at real elements of the app (by their `data-tour="…"` attribute),
 * explain them in a sentence or two and, where it helps, wait until the person did it.
 *
 * Step kinds:
 * - `info`     – read, then „Weiter“ (default)
 * - `click`    – goes on by itself once the highlighted element was clicked
 * - `navigate` – goes on once the app shows route `to` (e.g. after clicking a menu entry)
 * - `fill`     – waits until the highlighted field (or a field inside it) has a value
 * - `wait`     – waits for something to happen: a success message (`toast`), an element (`appear`) or a route
 */
export type StepKind = 'info' | 'click' | 'navigate' | 'fill' | 'wait';

export interface TourStep {
  title: string;
  /** One or two plain sentences. `**fett**` is allowed. `{brand}` becomes the product name. */
  text: string;
  /** What to do now, e.g. „Klicke auf **+ Kontakt**.“ */
  do?: string;
  /** `data-tour` key of the element to highlight; none = card in the middle. */
  target?: string;
  /** Route the step plays on (opened automatically), e.g. `contacts` or `settings/telephony`. */
  route?: string;
  kind?: StepKind;
  /** `navigate`: the route (prefix) that counts as arrived. */
  to?: string;
  /** `wait`: what to wait for. `toast: true` = any success message, a string = message containing it. */
  wait?: { toast?: true | string; appear?: string; route?: string };
  placement?: 'auto' | 'top' | 'bottom' | 'left' | 'right';
  /** Only for the agency (admins). */
  admin?: boolean;
  /** Only with access to this area (see server/core/permissions.ts). */
  perm?: string;
  /** „Mach's für mich“: harmless help only – type a sample value or click the element. */
  demo?: { fill?: string; click?: boolean; label?: string };
  /** The element may be missing (empty list, feature not set up): the card then explains instead. */
  optional?: boolean;
  /** Hint shown when the target is not on screen (defaults to a general hint). */
  missing?: string;
}

export type TourGroup = 'journey' | 'start' | 'company' | 'crm' | 'marketing' | 'sites' | 'revenue' | 'reputation' | 'service' | 'ai' | 'settings' | 'agency';

export interface Tour {
  id: string;
  title: string;
  /** One sentence for the card. */
  summary: string;
  icon: IconName;
  group: TourGroup;
  /** Area needed to see the tour; none = everyone. */
  perm?: string;
  /** Only for the agency (admins). */
  admin?: boolean;
  /** Rough duration in minutes. */
  minutes: number;
  /** Pages (route prefixes like `contacts` or `settings/stripe`) where the „?“ button offers this tour. */
  routes?: string[];
  /** Has exercises: offer to switch to the „Übungs-Firma“ first. */
  practice?: boolean;
  /** Extra search words. */
  keywords?: string;
  /** „Das hast du gelernt“ – shown at the end. */
  learned: string[];
  /** Matching documentation (file name in docs/, optional #anchor), opened inside the app. */
  docs?: { label: string; file: string; anchor?: string };
  /** Journey chapters: number and the next chapter's id. */
  chapter?: number;
  next?: string;
  steps: TourStep[];
}

/** What the server keeps per user and tour. */
export interface TourProgress {
  step: number;
  max_step: number;
  total: number;
  done: boolean;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface AcademyState {
  tours: Record<string, TourProgress>;
  active: { tour: string; step: number } | null;
  sandbox: { id: string; name: string } | null;
  can_sandbox: boolean;
}
