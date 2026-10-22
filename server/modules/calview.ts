import type { Module } from '../core/app.js';
import { aiBookingModule } from './ai-booking.js';
import { appointmentSeriesModule } from './appointment-series.js';
import { calendarViewModule } from './calendar-view.js';

/**
 * Kalender (HighLevel parity, docs/booking.md): recurring appointments, the day/week/month/team calendar view with drag & drop and
 * the appointment drawer, and booking by AI in chat (shared tools of the phone agent, safety level "Termin buchen"). Each part is a
 * module of its own; this list is the one line the registry needs. The series module comes first: it adds the columns the others read.
 */
export const calendarViewModules: Module[] = [appointmentSeriesModule, calendarViewModule, aiBookingModule];
