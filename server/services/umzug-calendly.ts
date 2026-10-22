import type { Account, Batch, CountRow, PartKey, RAppointment, RCalendar, RContact, SourceDef, SourceField, StepCtx, StepDef } from './umzug-core.js';
import type { Json } from './umzug-flow.js';
import { UmzugError, VendorHttp } from './umzug-http.js';
import { counter, nameParts, seg, stubCtx } from './umzug-lib.js';
import { clip, toIso } from './umzug-text.js';

/**
 * Calendly (REST API v2, https://api.calendly.com, a personal access token): event types → calendars (saved INACTIVE, without messages,
 * with the weekly hours and date-specific hours of the event type), scheduled events → appointments (one per invitee, cancelled ones
 * marked, the invitee's answers, the location and the cancellation reason in the notes), invitees → contacts (optional; Calendly knows
 * no advertising consent, so they are marked "no advertising consent" in the ledger). The token's owner's event types and events are
 * read; pages by `page_token`. A re-run neither doubles nor reminds anybody.
 */

const API = 'https://api.calendly.com';
const PAGE = 100;
/** A dry run reads the invitees of this many events only (each one is a call). */
const DRY_EVENTS = 40;
const WDAYS: Record<string, string> = { monday: 'mon', tuesday: 'tue', wednesday: 'wed', thursday: 'thu', friday: 'fri', saturday: 'sat', sunday: 'sun' };

const http = (creds: Record<string, string>, _meta: Record<string, string>, deps: { fetch?: any; sleep?: any; pauseMs?: number }) =>
  new VendorHttp({
    vendor: 'Calendly',
    base: API,
    headers: () => ({ authorization: `Bearer ${String(creds.token ?? '').trim()}` }),
    fetch: deps.fetch,
    sleep: deps.sleep,
    pauseMs: deps.pauseMs ?? 150,
    errorText: (b) => (typeof b?.message === 'string' ? b.message : typeof b?.title === 'string' ? b.title : undefined),
  });

/** The last part of a Calendly URI (the id). */
export const uuidOf = (uri: unknown): string => String(uri ?? '').split('/').filter(Boolean).pop() ?? '';

async function* pages(h: VendorHttp, path: string, query: Record<string, unknown>, ctx: StepCtx, start?: string): AsyncGenerator<{ items: Json[]; next: string | undefined }> {
  let token = start;
  for (let i = 0; i < 5000; i++) {
    if (ctx.cancelled()) return;
    const j = await h.get(path, { count: PAGE, ...query, ...(token ? { page_token: token } : {}) });
    const next = typeof j?.pagination?.next_page_token === 'string' && j.pagination.next_page_token ? j.pagination.next_page_token : undefined;
    yield { items: Array.isArray(j?.collection) ? j.collection : [], next };
    if (!next) return;
    token = next;
  }
}

const me = async (h: VendorHttp) => (await h.get('/users/me'))?.resource ?? {};

// --- calendars --------------------------------------------------------------------------------------------------

const LOCATION: Record<string, string> = { zoom_conference: 'Zoom', google_conference: 'Google Meet', microsoft_teams_conference: 'Microsoft Teams', webex_conference: 'Webex', gotomeeting_conference: 'GoTo Meeting', physical: 'Vor Ort', outbound_call: 'Wir rufen an', inbound_call: 'Du rufst an', ask_invitee: 'Wird bei der Buchung angegeben', custom: 'Eigener Ort' };

export function locationText(l: Json | undefined | null): string {
  if (!l) return '';
  const label = LOCATION[String(l.type ?? l.kind)] ?? String(l.type ?? l.kind ?? '');
  const detail = l.location ?? l.join_url ?? l.phone_number ?? '';
  return [label, detail].filter(Boolean).join(': ').trim();
}

/** Calendly's rules (weekdays and single dates, local to the schedule's zone) as weekly hours and date-specific hours. */
export function rulesToHours(rules: unknown): { availability: Record<string, [string, string][]>; date_overrides: Record<string, [string, string][]> } {
  const availability: Record<string, [string, string][]> = {};
  const date_overrides: Record<string, [string, string][]> = {};
  const fix = (t: unknown) => (String(t) === '24:00' ? '23:59' : String(t));
  const spans = (iv: unknown): [string, string][] => (Array.isArray(iv) ? iv : []).filter((x: Json) => x?.from && x?.to).map((x: Json) => [fix(x.from), fix(x.to)] as [string, string]);
  for (const r of Array.isArray(rules) ? rules : []) {
    if (r?.type === 'wday' && WDAYS[String(r.wday)]) availability[WDAYS[String(r.wday)]] = spans(r.intervals);
    else if (r?.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(r.date))) date_overrides[String(r.date)] = spans(r.intervals);
  }
  for (const k of Object.keys(availability)) if (!availability[k].length) delete availability[k];
  return { availability, date_overrides };
}

async function hoursOf(h: VendorHttp, eventTypeUri: string, userUri: string): Promise<{ timezone?: string; availability: Record<string, [string, string][]>; date_overrides: Record<string, [string, string][]> } | undefined> {
  const tryGet = async (path: string, query: Record<string, unknown>) => {
    try {
      return await h.get(path, query);
    } catch (e) {
      if (e instanceof UmzugError && e.skippable) return undefined;
      throw e;
    }
  };
  const own = await tryGet('/event_type_availability_schedules', { event_type: eventTypeUri });
  const rule = (Array.isArray(own?.collection) ? own.collection : [])[0]?.availability_rule;
  if (rule?.rules?.length) return { timezone: rule.timezone, ...rulesToHours(rule.rules) };
  // The event type follows the host's default schedule.
  const sched = await tryGet('/user_availability_schedules', { user: userUri });
  const def: Json | undefined = (Array.isArray(sched?.collection) ? sched.collection : []).find((s: Json) => s.default) ?? (Array.isArray(sched?.collection) ? sched.collection : [])[0];
  return def ? { timezone: def.timezone, ...rulesToHours(def.rules) } : undefined;
}

export function calendarOf(et: Json, hours: Awaited<ReturnType<typeof hoursOf>>, userTz?: string): RCalendar {
  const loc = locationText(Array.isArray(et.locations) ? et.locations[0] : undefined);
  const where = [typeof et.scheduling_url === 'string' ? `Buchungsseite bei Calendly: ${et.scheduling_url}` : '', et.pooling_type ? `Art: ${et.pooling_type === 'round_robin' ? 'Round Robin' : et.pooling_type === 'collective' ? 'Gemeinsam (Team)' : et.pooling_type}` : '', et.secret ? 'bei Calendly versteckt' : '', et.active === false ? 'bei Calendly deaktiviert' : ''].filter(Boolean).join(' · ');
  return {
    kind: 'calendar',
    ext: `et:${uuidOf(et.uri)}`,
    name: String(et.name ?? 'Termin'),
    description: [String(et.description_plain ?? '').trim(), where].filter(Boolean).join('\n\n'),
    duration: Number(et.duration) || 30,
    color: typeof et.color === 'string' ? et.color : undefined,
    timezone: hours?.timezone || userTz,
    availability: hours?.availability,
    date_overrides: hours?.date_overrides,
    location: loc || undefined,
  };
}

// --- appointments -----------------------------------------------------------------------------------------------

export function appointmentOf(ev: Json, inv: Json | undefined, calendar: string): RAppointment {
  const cancelled = ev.status === 'canceled' || inv?.status === 'canceled';
  const notes: string[] = [];
  const loc = locationText(ev.location);
  if (loc) notes.push(`Ort: ${loc}`);
  for (const qa of Array.isArray(inv?.questions_and_answers) ? [...inv.questions_and_answers].sort((a: Json, b: Json) => Number(a.position ?? 0) - Number(b.position ?? 0)) : []) if (qa?.question && qa?.answer) notes.push(`${String(qa.question).trim()}: ${String(qa.answer).trim()}`);
  if (inv?.text_reminder_number) notes.push(`Telefon für SMS-Erinnerung: ${inv.text_reminder_number}`);
  if (Array.isArray(ev.event_guests) && ev.event_guests.length) notes.push(`Weitere Gäste: ${ev.event_guests.map((g: Json) => g.email).filter(Boolean).join(', ')}`);
  const reason = inv?.cancellation?.reason ?? ev.cancellation?.reason;
  const by = inv?.cancellation?.canceled_by ?? ev.cancellation?.canceled_by;
  if (cancelled && (reason || by)) notes.push(`Abgesagt${by ? ` von ${by}` : ''}${reason ? `: ${reason}` : ''}`);
  if (inv?.rescheduled) notes.push('Wurde verschoben (der neue Termin steht separat)');
  if (ev.meeting_notes_plain) notes.push(`Notizen: ${String(ev.meeting_notes_plain).trim()}`);
  const host = (Array.isArray(ev.event_memberships) ? ev.event_memberships : []).map((m: Json) => m.user_name).filter(Boolean).join(', ');
  if (host) notes.push(`Gastgeber: ${host}`);
  const name = String(ev.name ?? 'Termin');
  return {
    kind: 'appointment',
    ext: inv ? `${uuidOf(ev.uri)}:${uuidOf(inv.uri)}` : uuidOf(ev.uri),
    calendar,
    title: inv?.name ? `${name} – ${inv.name}` : name,
    start_at: String(ev.start_time),
    end_at: String(ev.end_time ?? ev.start_time),
    status: cancelled ? 'cancelled' : 'confirmed',
    contact: inv?.email ? `i:${String(inv.email).toLowerCase()}` : undefined,
    contact_hint: inv?.email ? { email: String(inv.email), name: inv.name, phone: inv.text_reminder_number ?? undefined } : undefined,
    notes: notes.join('\n'),
    created_at: toIso(inv?.created_at ?? ev.created_at),
  };
}

export function contactOf(inv: Json): RContact | undefined {
  if (!inv?.email) return undefined;
  const n = nameParts(inv.name);
  return {
    kind: 'contact',
    ext: `i:${String(inv.email).toLowerCase()}`,
    values: { email: inv.email, first_name: inv.first_name || n.first, last_name: inv.last_name || n.last, phone: inv.text_reminder_number ?? undefined },
    consent: 'unknown',
    created_at: toIso(inv.created_at),
    proof: [{ basis: 'none', method: 'Terminbuchung über Calendly (Calendly kennt keine Werbeeinwilligung)', channel: 'email', at: toIso(inv.created_at) }],
  };
}

// --- steps ------------------------------------------------------------------------------------------------------

const steps = (parts: PartKey[]): StepDef[] => {
  const out: StepDef[] = [];
  if (parts.includes('calendars'))
    out.push({
      id: 'calendars',
      label: 'Termintypen → Kalender',
      part: 'calendars',
      async *run(ctx): AsyncGenerator<Batch> {
        const user = await me(ctx.http);
        for await (const pg of pages(ctx.http, '/event_types', { user: user.uri }, ctx, typeof ctx.cursor === 'string' ? ctx.cursor : undefined)) {
          const records: RCalendar[] = [];
          for (const et of pg.items.filter((x) => !x.deleted_at)) records.push(calendarOf(et, await hoursOf(ctx.http, String(et.uri), String(user.uri)), user.timezone));
          yield { records, cursor: pg.next };
        }
      },
    });
  if (parts.includes('appointments'))
    out.push({
      id: 'events',
      label: 'Termine',
      part: 'appointments',
      async *run(ctx): AsyncGenerator<Batch> {
        const user = await me(ctx.http);
        const wantContacts = ctx.parts.includes('contacts');
        let budget = ctx.limit < Infinity ? DRY_EVENTS : Infinity;
        // Event types: those with a calendar already, and a stand-in for the ones that were deleted at Calendly since.
        const known = new Set<string>();
        const typeNames = new Map<string, string>();
        for await (const pg of pages(ctx.http, '/event_types', { user: user.uri }, ctx))
          for (const et of pg.items) {
            known.add(uuidOf(et.uri));
            typeNames.set(uuidOf(et.uri), String(et.name ?? 'Termin'));
          }
        // Without the calendars part the calendars the appointments need are made here (a calendar that exists is left as it is).
        const makeAll = !ctx.parts.includes('calendars');
        const seen = new Set<string>();
        for await (const pg of pages(ctx.http, '/scheduled_events', { user: user.uri, sort: 'start_time:asc' }, ctx, typeof ctx.cursor === 'string' ? ctx.cursor : undefined)) {
          const records: (RCalendar | RAppointment | RContact)[] = [];
          for (const ev of pg.items) {
            const type = uuidOf(ev.event_type);
            const calendar = type ? `et:${type}` : 'et:ohne';
            if ((makeAll || !known.has(type)) && !seen.has(calendar)) {
              seen.add(calendar);
              const gone = !known.has(type);
              records.push({
                kind: 'calendar',
                ext: calendar,
                name: gone ? `Termine „${clip(ev.name ?? 'ohne Termintyp', 80)}“` : (typeNames.get(type) ?? 'Termin'),
                description: gone ? 'Der Termintyp existiert bei Calendly nicht mehr; die Termine liegen hier.' : undefined,
                duration: Math.max(5, Math.round((Date.parse(ev.end_time) - Date.parse(ev.start_time)) / 60_000) || 30),
              });
            }
            let invitees: Json[] = [];
            if (budget > 0) {
              budget--;
              for await (const ip of pages(ctx.http, `/scheduled_events/${seg(uuidOf(ev.uri))}/invitees`, {}, ctx)) invitees.push(...ip.items);
            }
            if (!invitees.length) {
              records.push(appointmentOf(ev, undefined, calendar));
              continue;
            }
            for (const inv of invitees) {
              const c = wantContacts ? contactOf(inv) : undefined;
              if (c) records.push(c);
              records.push(appointmentOf(ev, inv, calendar));
            }
            invitees = [];
          }
          yield { records, cursor: pg.next };
        }
      },
    });
  return out;
};

// --- describe ---------------------------------------------------------------------------------------------------

const CONTACT_FIELDS: SourceField[] = [
  { ref: 'email', label: 'E-Mail', type: 'email', std: 'email', group: 'standard' },
  { ref: 'first_name', label: 'Vorname', type: 'text', std: 'first_name', group: 'standard' },
  { ref: 'last_name', label: 'Nachname', type: 'text', std: 'last_name', group: 'standard' },
  { ref: 'phone', label: 'Telefon (für SMS-Erinnerung)', type: 'phone', std: 'phone', group: 'standard' },
];

async function describe(h: VendorHttp, parts: PartKey[]) {
  const counts: CountRow[] = [];
  const warnings: string[] = [];
  const count = counter(counts);
  const s = stubCtx(h, parts);
  const user = await me(h);
  const total = async (path: string, query: Record<string, unknown>) => {
    let n = 0;
    let p = 0;
    for await (const pg of pages(h, path, query, s)) {
      n += pg.items.length;
      if (++p >= 60 && pg.next) return { n, capped: true };
    }
    return { n, capped: false };
  };
  if (parts.includes('calendars')) await count('calendars', 'event_types', 'Termintypen', () => total('/event_types', { user: user.uri }));
  if (parts.includes('appointments')) {
    await count('appointments', 'events', 'Termine (vergangene und kommende, auch abgesagte)', () => total('/scheduled_events', { user: user.uri }));
    warnings.push('Zu jedem Termin liest HyperLevel die Teilnehmer in einem eigenen Aufruf – bei vielen Terminen dauert das. Der Probelauf liest nur die ersten.');
    warnings.push('Es werden die Termintypen und Termine des Token-Inhabers gelesen. Für andere Teammitglieder den Umzug mit deren Token wiederholen.');
  }
  return { counts, fields: parts.includes('contacts') ? CONTACT_FIELDS : [], warnings };
}

export const CALENDLY: SourceDef = {
  key: 'calendly',
  label: 'Calendly',
  tagline: 'Termintypen als Kalender, alle Termine mit Teilnehmern und Antworten',
  credentials: [{ key: 'token', label: 'Persönlicher Zugangs-Token', secret: true, placeholder: 'eyJraWQi…', hint: 'Calendly → Integrationen → „API & Webhooks“ → „Persönliche Zugangs-Tokens“ → „Token erzeugen“' }],
  howto: [
    'Bei Calendly unter „Integrationen“ → „API & Webhooks“ → „Persönliche Zugangs-Tokens“ einen Token erzeugen und kopieren.',
    'Den Token hier einfügen. HyperLevel liest nur und ändert bei Calendly nichts.',
    'Die Kalender kommen inaktiv an, ohne E-Mails und Erinnerungen: prüfe Zeiten und Texte, aktiviere sie und schalte danach die Calendly-Links um. Nach dem Umzug den Token bei Calendly löschen.',
  ],
  limits: [
    'Die Termine anderer Teammitglieder (jedes Mitglied hat eigene Termine – mit deren Token wiederholen) und Team-Zuweisungen',
    'Routing-Formulare, Workflows, E-Mail-Texte und Erinnerungen, Umfragen (Polls), Zahlungen über Calendly und eingebettete Buchungsseiten',
    'Kalender-Verbindungen (Google, Outlook) – in HyperLevel neu verbinden; das Design der Buchungsseite',
    'Calendly kennt keine Werbeeinwilligung: wer gebucht hat, ist im Einwilligungs-Nachweis „ohne Werbeeinwilligung“ vermerkt',
  ],
  parts: [
    { key: 'calendars', label: 'Termintypen → Kalender (inaktiv)', on: true, note: 'Dauer, Beschreibung, Ort, Wochenzeiten und Sonderzeiten einzelner Tage kommen mit. Die Kalender sind inaktiv, ohne Bestätigungs-Mail und ohne Erinnerung – nichts geht von selbst live.' },
    { key: 'appointments', label: 'Termine → Termine', on: true, note: 'Vergangene, kommende und abgesagte Termine, je Teilnehmer einer; die Antworten auf die Buchungsfragen stehen in den Notizen. Es wird nichts verschickt.' },
    { key: 'contacts', label: 'Teilnehmer → Kontakte', on: true, note: 'Wer gebucht hat, wird Kontakt (oder dem vorhandenen Kontakt mit gleicher E-Mail zugeordnet) – ohne Werbeeinwilligung: Newsletter erst nach einer neuen Einwilligung.' },
  ],
  exports: [],
  http,
  async connect(creds, deps): Promise<Account> {
    const h = http(creds, {}, deps);
    const u = await me(h);
    if (!u?.uri) throw new UmzugError(401, 'Calendly: Zugangsdaten ungültig oder abgelaufen');
    return { account: `cal-${uuidOf(u.current_organization) || uuidOf(u.uri)}`, label: `${u.name ?? 'Calendly'} (${u.email ?? ''})`, meta: {} };
  },
  describe: (h, parts) => describe(h, parts),
  steps: (parts) => steps(parts),
};
