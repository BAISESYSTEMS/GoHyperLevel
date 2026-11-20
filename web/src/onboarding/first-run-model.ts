/**
 * Der Ersteinstieg als Daten (pure – shared by web/src/onboarding/FirstRun.tsx, FirstSteps.tsx and tests/first-run.test.ts):
 * the three steps of the welcome wizard (1. what do you do → goals, 2. where does your data come from, 3. your first
 * success) and the "Erste Schritte" card on the dashboard, which ticks a step off from real data – never from a click.
 *
 * The German labels are the message ids of the web app's `onboarding` catalog (web/src/i18n/en/onboarding.ts).
 */

export type DataChoice = 'import' | 'umzug' | 'practice' | 'empty';
export type SuccessChoice = 'booking' | 'form' | 'site' | 'course';

export interface Choice<K extends string> {
  id: K;
  icon: string;
  label: string;
  text: string;
  /** Route below /app that does it (a `?…` intent opens the right dialog right away – web/src/onboarding/intent.ts). */
  to: string;
}

export const DATA_CHOICES: Choice<DataChoice>[] = [
  { id: 'import', icon: 'csv', label: 'Kontakte importieren', text: 'Eine CSV-Datei aus Excel, Google Sheets oder deinem alten Programm hochladen.', to: 'contacts?import=1' },
  { id: 'umzug', icon: 'umzug', label: 'Umzug aus einem anderen Tool', text: 'Kontakte, Deals und Termine aus GoHighLevel, HubSpot, Pipedrive & Co. übernehmen.', to: 'umzug' },
  { id: 'practice', icon: 'academy', label: 'Erst mal üben', text: 'Eine Übungs-Firma mit erfundenen Kontakten, Terminen und Deals – nichts wird verschickt.', to: 'dashboard' },
  { id: 'empty', icon: 'rocket', label: 'Leer starten', text: 'Ich lege selbst los – Daten kann ich jederzeit später holen.', to: 'dashboard' },
];

export const SUCCESS_CHOICES: Choice<SuccessChoice>[] = [
  { id: 'booking', icon: 'calendars', label: 'Buchungsseite live schalten', text: 'Kunden buchen selbst einen Termin bei dir – ein Link für Website, E-Mail und Social Media.', to: 'calendars?new=1' },
  { id: 'form', icon: 'forms', label: 'Kontaktformular veröffentlichen', text: 'Aus einer fertigen Vorlage – jede Anfrage landet als Kontakt in deinem CRM.', to: 'forms?gallery=1' },
  { id: 'site', icon: 'funnels', label: 'Landingpage bauen', text: 'Eine Seite für dein Angebot – mit Vorlage oder von der KI entworfen.', to: 'funnels?new=1' },
  { id: 'course', icon: 'courses', label: 'Ersten Kurs anlegen', text: 'Lektionen hochladen, Zugang verkaufen oder verschenken.', to: 'courses?new=1' },
];

/** The first success that fits the chosen goals best (the wizard preselects it). */
export function suggestedSuccess(goals: readonly string[]): SuccessChoice {
  if (goals.includes('courses')) return 'course';
  if (goals.includes('agency')) return 'site';
  if (goals.includes('office')) return 'booking';
  return 'form';
}

/** Which first successes make sense for these goals – the rest would point at areas that are not in the menu. */
export function successChoices(goals: readonly string[]): Choice<SuccessChoice>[] {
  const all = !goals.length || goals.includes('all');
  return SUCCESS_CHOICES.filter((c) => c.id !== 'course' || all || goals.includes('courses'));
}

/**
 * The goals saved when someone skips the wizard (Überspringen, ✕, Esc): in step 1 the whole menu ("Alles") – nobody gets
 * a trimmed menu they did not choose; in a later step the goals picked so far (none picked: the whole menu as well).
 */
export const skipGoals = (step: number, goals: readonly string[]): string[] => (step === 1 || !goals.length ? ['all'] : [...goals]);

/** The practice sub-account is created by the agency admin (POST /api/academy/sandbox), the move needs the settings area – others never see those choices. */
export const dataChoices = (o: { admin: boolean; settings: boolean }): Choice<DataChoice>[] =>
  DATA_CHOICES.filter((c) => (c.id !== 'practice' || o.admin) && (c.id !== 'umzug' || o.settings));

/** What the wizard remembers for the card on the dashboard (per browser and sub-account – web/src/onboarding/plan.ts). */
export interface FirstRunPlan {
  data: DataChoice;
  success: SuccessChoice;
  /** ISO time the wizard was finished or skipped. */
  at: string;
  /** Skipped with "Überspringen": the card still offers the steps, with the suggested choices. */
  skipped?: boolean;
}

/** Real numbers of the sub-account; a fact that could not be loaded stays undefined and never ticks a step off. */
export interface FirstRunFacts {
  contacts?: number;
  calendars?: number;
  forms?: number;
  funnels?: number;
  courses?: number;
  /** The first academy tour is done. */
  tour?: boolean;
  /** This sub-account is the practice company. */
  practice?: boolean;
}

export type StepKey = 'data' | 'success' | 'tour';

export interface FirstStep {
  key: StepKey;
  label: string;
  text: string;
  to: string;
  done: boolean;
}

const COUNT: Record<SuccessChoice, keyof FirstRunFacts> = { booking: 'calendars', form: 'forms', site: 'funnels', course: 'courses' };
const more = (n: unknown) => typeof n === 'number' && n > 0;

/** The three steps of the "Erste Schritte" card, in order, each ticked off from the facts. */
export function firstSteps(plan: FirstRunPlan, f: FirstRunFacts): FirstStep[] {
  const success = SUCCESS_CHOICES.find((c) => c.id === plan.success) ?? SUCCESS_CHOICES[1];
  const successStep: FirstStep = { key: 'success', label: success.label, text: success.text, to: success.to, done: more(f[COUNT[success.id]]) };
  const tour: FirstStep = { key: 'tour', label: 'Tour in 10 Minuten', text: 'Menü, Suche, Hilfe und die wichtigsten Bereiche – direkt in der echten Oberfläche.', to: 'academy', done: !!f.tour };
  if (plan.data === 'practice') {
    // the practice company is opened from the academy page (its card "Übungs-Firma"); done once it exists
    const p = DATA_CHOICES.find((c) => c.id === 'practice')!;
    return [{ key: 'data', label: p.label, text: p.text, to: 'academy', done: !!f.practice }, successStep, tour];
  }
  if (plan.data === 'empty') {
    // "Leer starten": the first success comes first; bringing data in stays on the list as the last step
    const imp = DATA_CHOICES[0];
    return [successStep, tour, { key: 'data', label: imp.label, text: imp.text, to: imp.to, done: more(f.contacts) }];
  }
  const data = DATA_CHOICES.find((c) => c.id === plan.data) ?? DATA_CHOICES[0];
  return [{ key: 'data', label: data.label, text: data.text, to: data.to, done: more(f.contacts) }, successStep, tour];
}

/** Progress for the bar: done / total, and the first open step (the card's one primary action). */
export function progressOf(steps: FirstStep[]): { done: number; total: number; next?: FirstStep } {
  return { done: steps.filter((s) => s.done).length, total: steps.length, next: steps.find((s) => !s.done) };
}
