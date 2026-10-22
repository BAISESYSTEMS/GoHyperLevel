import type { Module } from '../core/app.js';
import { HttpError } from '../core/http.js';
import { registerActions, registerTriggers, type ActionDef, type FieldDef, type TriggerMeta } from '../services/wfx-kit.js';
import { registerContact } from '../services/webinar-register.js';
import { attributePurchase } from '../services/webinar-track.js';
import { getWebinar, linksOf, whenText, webinarTz } from '../services/webinar-store.js';

/**
 * Webinars in the automations: six triggers, the action "Kontakt für Webinar anmelden", forms that register their senders,
 * the link between a purchase and the webinar that led to it, and the background job (reminders, end-of-session booking).
 * The events themselves are emitted where things happen (services/webinar-register.ts, webinar-track.ts) with the data
 * `contactId`, `webinarId`, `webinar {id, title, slug}`, `registrationId`, `session {start, end, kind}`, `join_url`,
 * `replay_url` – plus `percent` / `watched_s` / `left_at` (watched_percent), `offer` (cta_clicked), `offset_s` (attended).
 */

const WEBINAR: FieldDef = { key: 'webinar_id', label: 'Webinar', type: 'webinar', help: 'Leer = jedes Webinar' };

const sample = {
  webinarId: 'w1',
  webinar: { id: 'w1', title: 'Mehr Kunden mit automatisierten Webinaren', slug: 'mehr-kunden' },
  registrationId: 'r1',
  session: { start: '2026-11-05T18:00:00.000Z', end: '2026-11-05T19:00:00.000Z', kind: 'fixed' },
  join_url: 'https://example.com/w/mehr-kunden/watch?t=r1.signatur',
  replay_url: 'https://example.com/w/mehr-kunden/replay?t=r1.signatur',
};

export const WEBINAR_TRIGGERS: TriggerMeta[] = [
  { type: 'webinar.registered', label: 'Für Webinar angemeldet', category: 'marketing', summary: 'Jemand meldet sich für ein Webinar an (Anmeldeseite, Formular, Workflow oder Team).', doc: 'Startet bei jeder neuen Anmeldung – einmal je Kontakt und Termin. {{event.webinar.title}}, {{event.session.start}}, {{event.join_url}} (persönlicher Link zum Raum) und {{event.replay_url}} stehen zur Verfügung. Die Bestätigung mit Kalenderdatei und die Erinnerungen verschickt das Webinar selbst (Reiter „Erinnerungen“); hier lässt sich z. B. ein Tag setzen, eine Aufgabe anlegen oder ein Willkommens-Workflow starten.', fields: [WEBINAR], sample, keywords: 'webinar anmeldung registriert termin' },
  { type: 'webinar.attended', label: 'Im Webinar erschienen', category: 'marketing', summary: 'Ein Angemeldeter betritt den Raum, während das Webinar läuft.', doc: 'Zählt erst, wenn das Video läuft – wer nur im Warteraum sitzt, ist noch nicht „erschienen“. Einmal je Anmeldung. {{event.offset_s}} sagt, bei welcher Sekunde des Videos die Person eingestiegen ist (späte Einsteiger starten mittendrin).', fields: [WEBINAR], sample: { ...sample, offset_s: 0 }, keywords: 'webinar teilgenommen erschienen anwesend' },
  { type: 'webinar.missed', label: 'Webinar verpasst', category: 'marketing', summary: 'Ein Angemeldeter war beim Termin nicht im Raum.', doc: 'Läuft kurz nach dem Ende des Termins (etwa 5 Minuten später), einmal je Anmeldung. {{event.replay_url}} führt direkt zur Aufzeichnung – ideal für eine Mail „Du hast es verpasst, hier ist die Aufzeichnung“.', fields: [WEBINAR], sample, keywords: 'webinar verpasst nicht erschienen aufzeichnung' },
  { type: 'webinar.watched_percent', label: 'Webinar angesehen (Anteil)', category: 'marketing', summary: 'Nach dem Termin: so viel Prozent hat jemand gesehen – mit Mindestwert als Filter.', doc: 'Läuft kurz nach dem Ende des Termins für jeden, der im Raum war. {{event.percent}} ist der Anteil der Videolänge (0–100), {{event.watched_s}} die gesehenen Sekunden, {{event.left_at}} der Zeitpunkt des Verlassens. Mit „Mindestens … %“ filtern: ein Workflow ab 50 % für Interessierte, einer ab 90 % für das Angebot.', fields: [WEBINAR, { key: 'min_percent', label: 'Mindestens … Prozent gesehen', type: 'number', default: 50, help: '0 = jeder, der im Raum war' }], sample: { ...sample, percent: 72, watched_s: 2592, left_at: '2026-11-05T18:43:12.000Z' }, keywords: 'webinar prozent angesehen sehdauer watch' },
  { type: 'webinar.cta_clicked', label: 'Angebot im Webinar angeklickt', category: 'marketing', summary: 'Jemand klickt den Angebots-Button im Webinar-Raum.', doc: 'Einmal je Anmeldung beim ersten Klick (jeder Klick wird in der Auswertung gezählt). {{event.offer.title}} und {{event.offer.url}} nennen das Angebot. Ein Kauf danach wird dem Webinar zugeordnet, wenn das Ziel ein Produkt ist.', fields: [WEBINAR], sample: { ...sample, offer: { title: 'Jetzt mit 20 % Webinar-Rabatt', url: 'https://example.com/buy/kurs' } }, keywords: 'webinar angebot cta button klick' },
  { type: 'webinar.replay_watched', label: 'Webinar-Aufzeichnung angesehen', category: 'marketing', summary: 'Jemand spielt die Aufzeichnung ab.', doc: 'Einmal je Anmeldung, sobald die Aufzeichnung wirklich läuft. {{event.percent}} ist die Stelle im Video, an der die Person beim ersten Signal war.', fields: [WEBINAR], sample: { ...sample, percent: 0 }, keywords: 'webinar replay aufzeichnung angesehen' },
];

type Filter = (c: Record<string, any>, d: Record<string, any>) => boolean;
const same: Filter = (c, d) => !c.webinar_id || c.webinar_id === d.webinarId;

export const webinarAutomationModule: Module = {
  name: 'webinar-automation',
  register(app) {
    const { db } = app;
    registerTriggers(app, WEBINAR_TRIGGERS);
    app.services.workflowTriggerFilters = {
      ...(app.services.workflowTriggerFilters ?? {}),
      'webinar.registered': same,
      'webinar.attended': same,
      'webinar.missed': same,
      'webinar.cta_clicked': same,
      'webinar.replay_watched': same,
      'webinar.watched_percent': ((c, d) => same(c, d) && Number(d.percent ?? 0) >= Number(c.min_percent ?? 0)) as Filter,
    };

    const register: ActionDef = {
      meta: {
        type: 'webinar_register',
        label: 'Kontakt für Webinar anmelden',
        category: 'content',
        icon: 'webinar',
        summary: 'Meldet den Kontakt für den nächsten freien Termin eines Webinars an – mit Bestätigung und Erinnerungen.',
        doc: 'Der Kontakt braucht eine E-Mail-Adresse. Er bekommt die Bestätigung mit Kalenderdatei und persönlichem Link und – je nach Einstellung des Webinars – Erinnerungen. „Sofort starten“ legt einen eigenen Termin ab jetzt an (nur wenn das Webinar das anbietet). War der Kontakt für diesen Termin schon angemeldet, passiert nichts doppelt. Danach stehen {{var.webinar_join_url}} und {{var.webinar_session}} zur Verfügung.',
        fields: [
          { ...WEBINAR, help: 'Nur veröffentlichte Webinare', required: true },
          { key: 'session', label: 'Termin', type: 'select', options: [['next', 'Nächster freier Termin'], ['ondemand', 'Sofort starten (eigener Termin ab jetzt)']], default: 'next' },
          { key: 'silent', label: 'Keine Bestätigungs-E-Mail senden', type: 'bool' },
        ],
        provides: ['var.webinar_join_url', 'var.webinar_session'],
        keywords: 'webinar anmelden registrieren termin einladen',
        needs: 'Ein veröffentlichtes Webinar (Marketing → Webinare)',
        sample: { webinar_id: '', session: 'next' },
      },
      run: async (run, step) => {
        const id = String(step.webinar_id ?? '').trim();
        if (!id) throw new Error('Bitte ein Webinar wählen');
        const w = getWebinar(app, { id }, run.location_id);
        if (!w) throw new Error('Das Webinar gibt es in diesem Sub-Account nicht');
        try {
          const r = registerContact(app, w, { contact_id: run.contact_id, session: step.session === 'ondemand' ? 'ondemand' : '', source: 'workflow', silent: step.silent === true || step.silent === 'true' });
          app.services.audit?.({ action: 'webinars.registrations.create', actor: 'Workflow', locationId: run.location_id, entityId: r.registration.id, summary: `${w.title}: ${r.contact.email}` });
          const join = linksOf(app, w, r.registration.id).join_url;
          return { result: `${r.created ? 'Angemeldet' : 'War schon angemeldet'}: „${w.title}“, ${whenText(r.session.start, webinarTz(app, w))}`, vars: { webinar_join_url: join, webinar_session: r.session.start } };
        } catch (e) {
          // A full or missing session is a message for the run log, not a crash.
          if (e instanceof HttpError) throw new Error(e.message);
          throw e;
        }
      },
    };
    registerActions(app, [register]);

    // Forms that register their senders (Anmeldung → „Formulare, die anmelden“): the next free session.
    app.events.on('form.submitted', (e) => {
      const formId = e.data.formId;
      const contactId = e.data.contactId;
      if (!formId || !contactId) return;
      const list = db.all<{ id: string }>(
        `SELECT id FROM webinars WHERE location_id = ? AND status = 'published' AND EXISTS (SELECT 1 FROM json_each(json_extract(settings, '$.registration.form_ids')) WHERE value = ?)`,
        e.locationId,
        formId,
      );
      for (const row of list) {
        const w = getWebinar(app, { id: row.id }, e.locationId);
        if (!w) continue;
        try {
          registerContact(app, w, { contact_id: contactId, source: 'form', consent: true });
        } catch (err) {
          console.warn(`[webinar] form ${formId} → ${w.slug}:`, (err as Error).message);
        }
      }
    });

    // A purchase of the offer's product by somebody who clicked the offer belongs to the webinar.
    app.events.on('product.purchased', (e) => {
      attributePurchase(app, e.locationId, { contactId: e.data.contactId, productId: e.data.productId, amount_cents: e.data.amount_cents });
    });

    // Reminders and the end-of-session bookkeeping; uploads without a row are swept once a day.
    let swept = 0;
    app.onTick(async () => {
      await app.services.webinars.tick();
      if (Date.now() - swept > 86_400_000) {
        swept = Date.now();
        app.services.webinars.sweep();
      }
    });
  },
};
