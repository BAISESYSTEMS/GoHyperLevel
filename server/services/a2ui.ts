/**
 * A2UI 1.0 (https://a2ui.org, Google's open protocol for agent-driven interfaces): the agent describes a small interface as JSON
 * messages, the client draws it with its own components – no foreign code runs, the look stays HyperLevel's. Used for the
 * appointment picker in the website chat and in the assistant (docs/a2ui.md).
 *
 * Server → client: createSurface, updateComponents, updateDataModel, deleteSurface, agentFunctionResponse.
 * Client → server: action (a button was pressed, with its resolved context) and callAgentFunction (the client asks the server
 * something while the person is still choosing, e.g. whether a time is still free).
 */

export const A2UI_VERSION = '1.0';
export const A2UI_MIME = 'application/a2ui+json';
export const BASIC_CATALOG = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';
/** HyperLevel's own functions the renderer may call (callAgentFunction). */
export const HL_CATALOG = 'hyperlevel:booking';

export type A2uiMessage = { version: '1.0' } & Record<string, any>;
export interface Component {
  id: string;
  component: string;
  [k: string]: unknown;
}

const msg = (body: Record<string, unknown>): A2uiMessage => ({ version: '1.0', ...body });
const path = (p: string) => ({ '@path': p });

export const createSurface = (surfaceId: string, dataModel: Record<string, unknown>, components: Component[]): A2uiMessage[] => [
  msg({ createSurface: { surfaceId, catalogId: BASIC_CATALOG, dataModel } }),
  msg({ updateComponents: { surfaceId, components } }),
];
export const updateComponents = (surfaceId: string, components: Component[]) => msg({ updateComponents: { surfaceId, components } });
export const updateDataModel = (surfaceId: string, p: string, value: unknown) => msg({ updateDataModel: { surfaceId, path: p, value } });
export const agentFunctionResponse = (functionCallId: string, out: { value: unknown } | { error: { code: string; message: string } }) =>
  msg({ agentFunctionResponse: { functionCallId, ...out } });

/** "Di. 25.11. · 10:00" for a local date and time of a calendar. */
export function slotLabel(date: string, time: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const day = Number.isNaN(d.getTime()) ? date : d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' }).replace(',', '');
  return `${day} · ${time}`;
}

export interface PickerInput {
  surfaceId: string;
  calendar: { id: string; name: string; duration?: number };
  days: { date: string; times: string[] }[];
  /** Website chat: ask for name and e-mail when the contact has none yet. */
  askName?: boolean;
  askEmail?: boolean;
  /** Website chat books right away; in the assistant the choice goes back to the agent as a message. */
  mode: 'book' | 'choose';
  maxOptions?: number;
}

/** The free times as options (value "JJJJ-MM-TTTHH:MM"), spread over the days: a few per day rather than one full morning. */
export function slotOptions(days: PickerInput['days'], max = 8): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  const perDay = Math.max(2, Math.ceil(max / Math.max(1, days.length)));
  for (const d of days) {
    for (const t of d.times.slice(0, perDay)) {
      if (out.length >= max) return out;
      out.push({ label: slotLabel(d.date, t), value: `${d.date}T${t}` });
    }
  }
  return out;
}

/** An appointment picker: free times as chips, name and e-mail when needed, one button. */
export function slotPicker(o: PickerInput): A2uiMessage[] {
  const options = slotOptions(o.days, o.maxOptions ?? 8);
  const title = `**${o.calendar.name}**${o.calendar.duration ? ` · ${o.calendar.duration} Min.` : ''}`;
  const children = ['title', 'times'];
  const components: Component[] = [
    { id: 'title', component: 'Text', text: title },
    {
      id: 'times',
      component: 'ChoicePicker',
      label: 'Freie Termine',
      options,
      value: path('/slot'),
      variant: 'mutuallyExclusive',
      displayStyle: 'chips',
      // Our renderer asks the server whether the chosen time is still free (A2UI 1.0 callAgentFunction).
      ...(o.mode === 'book'
        ? { '@metadata': { onChangeCall: { '@call': 'checkSlot', catalogId: HL_CATALOG, args: { calendar_id: o.calendar.id, slot: path('/slot') } }, resultPath: '/status' } }
        : {}),
    },
  ];
  if (o.mode === 'book' && o.askName) {
    children.push('name');
    components.push({ id: 'name', component: 'TextField', label: 'Vor- und Nachname', value: path('/name'), variant: 'shortText', '@accessibility': { label: 'Vor- und Nachname' } });
  }
  if (o.mode === 'book' && o.askEmail) {
    children.push('email');
    components.push({ id: 'email', component: 'TextField', label: 'E-Mail', value: path('/email'), variant: 'shortText', '@accessibility': { label: 'E-Mail' } });
  }
  children.push('book', 'status');
  components.push(
    {
      id: 'book',
      component: 'Button',
      child: 'book_label',
      variant: 'primary',
      action: {
        event:
          o.mode === 'book'
            ? { name: 'book_slot', context: { calendar_id: o.calendar.id, slot: path('/slot'), name: path('/name'), email: path('/email') } }
            : { name: 'choose_slot', context: { calendar_id: o.calendar.id, calendar: o.calendar.name, slot: path('/slot') } },
      },
    },
    { id: 'book_label', component: 'Text', text: o.mode === 'book' ? 'Termin buchen' : 'Diesen Termin nehmen' },
    { id: 'status', component: 'Text', text: path('/status'), variant: 'caption', '@accessibility': { live: 'polite' } },
    { id: 'root', component: 'Column', children },
  );
  return createSurface(o.surfaceId, { slot: [], name: '', email: '', status: options.length ? '' : 'Gerade ist nichts frei.' }, components);
}

/** After booking: the picker turns into the confirmation. */
export function bookedView(surfaceId: string, text: string): A2uiMessage[] {
  return [
    updateComponents(surfaceId, [
      { id: 'done', component: 'Text', text: `✓ ${text}` },
      { id: 'root', component: 'Column', children: ['done'] },
    ]),
  ];
}

/** "2026-11-25T10:00" (or a one-element list of it) → date and time, or null. */
export function parseSlot(v: unknown): { date: string; time: string } | null {
  const s = String(Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/);
  return m ? { date: m[1], time: m[2] } : null;
}

/** Checks the outer shape of a client message: version 1.0 and exactly one of action / callAgentFunction. */
export function clientMessage(v: unknown): { kind: 'action'; action: any } | { kind: 'call'; call: any } | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const m = v as Record<string, any>;
  if (m.version !== A2UI_VERSION) return null;
  const keys = Object.keys(m).filter((k) => k !== 'version');
  if (keys.length !== 1) return null;
  if (keys[0] === 'action' && m.action && typeof m.action === 'object' && typeof m.action.name === 'string' && typeof m.action.surfaceId === 'string') return { kind: 'action', action: m.action };
  if (keys[0] === 'callAgentFunction' && m.callAgentFunction && typeof m.callAgentFunction.functionCallId === 'string' && typeof m.callAgentFunction.surfaceId === 'string')
    return { kind: 'call', call: m.callAgentFunction };
  return null;
}
