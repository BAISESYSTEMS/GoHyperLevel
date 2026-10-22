import type { Module } from '../core/app.js';
import { contactDuplicatesModule } from './contact-duplicates.js';
import { dealLinesModule } from './deal-lines.js';
import { meetingNotesModule } from './meeting-notes.js';
import { quotasModule } from './quotas.js';
import { quotesModule } from './quotes.js';
import { recordAccessModule } from './record-access.js';
import { sequencesModule } from './sequences.js';

/**
 * Vertrieb (docs/sales.md): record-level access with teams, sequences from the personal mailbox, deal line items and the quote builder,
 * the contact duplicate assistant, quotas with the leaderboard. Each part is a module of its own; this list is the one line the registry needs.
 */
export const salesModules: Module[] = [recordAccessModule, dealLinesModule, quotesModule, sequencesModule, contactDuplicatesModule, quotasModule, meetingNotesModule];
