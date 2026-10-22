import type { Module } from '../core/app.js';
import { sendFollowups, sendNoShow, sendReminders } from '../services/booking-messages.js';

/**
 * Booking polish for the calendars (Calendly parity): the background jobs and listeners behind several reminders (e-mail and
 * SMS), the follow-up after an appointment and the message for no-shows. Limits per day/week and date-specific hours are part
 * of the slot calculation itself (services/booking-rules.ts, modules/calendars.ts). Settings per calendar: docs/api.md → Kalender.
 */
export const bookingExtrasModule: Module = {
  name: 'booking-extras',
  register(app) {
    let running = false;
    app.onTick(async () => {
      if (running) return;
      running = true;
      try {
        await sendReminders(app);
        await sendFollowups(app);
      } finally {
        running = false;
      }
    });
    // "Nicht erschienen" is set by hand (or by a workflow/app): the message goes out right then, once per start time.
    app.events.on('appointment.status_changed', async (e) => {
      if (e.data.status !== 'noshow' || !e.data.appointment?.id) return;
      await sendNoShow(app, e.data.appointment);
    });
  },
};
