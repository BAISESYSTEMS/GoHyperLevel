import type { Module } from '../core/app.js';
import { bookingGuestsModule } from './booking-guests.js';
import { bookingMultiModule } from './booking-multi.js';
import { calendarAiModule } from './calendar-ai.js';
import { contractSignersModule } from './contract-signers.js';
import { couponCodesModule } from './coupon-codes.js';
import { eventCheckinModule } from './event-checkin.js';
import { formDraftsModule } from './form-drafts.js';
import { formPdfModule } from './form-pdf.js';
import { loyaltyModule } from './loyalty.js';
import { portalAppointmentsModule } from './portal-appointments.js';
import { rentalsModule } from './rentals.js';
import { serviceMenuModule } from './service-menu.js';
import { storeExtrasModule } from './store-extras.js';
import { ticketEventsModule } from './ticket-events.js';
import { ticketEventsPublicModule } from './ticket-events-public.js';

/**
 * HighLevel parity for booking, forms, payments, commerce and documents (wave 10): each capability is a module of its own; this list
 * is the one line the registry needs. After contracts, calendars, team calendars, forms, buy links, the store and the workflow
 * engine, whose tables, routes and hooks they extend.
 */
export const parityBookingModules: Module[] = [contractSignersModule, serviceMenuModule, calendarAiModule, formPdfModule, couponCodesModule, loyaltyModule, storeExtrasModule, portalAppointmentsModule, bookingGuestsModule, formDraftsModule, eventCheckinModule, ticketEventsModule, ticketEventsPublicModule, bookingMultiModule, rentalsModule];
