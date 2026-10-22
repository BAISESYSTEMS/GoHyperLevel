import type { Module } from '../core/app.js';
import { companyBulkModule } from './company-bulk.js';
import { contactBulkOwnerModule } from './contact-bulk-owner.js';
import { contactDocumentsModule } from './contact-documents.js';
import { dealForecastModule } from './deal-forecast.js';
import { dealSmartTagsModule } from './deal-smart-tags.js';
import { fieldCleanupModule } from './field-cleanup.js';
import { fieldHistoryModule } from './field-history.js';
import { inboxFiltersModule } from './inbox-filters.js';
import { messageTriggersModule } from './message-triggers.js';
import { smartListsModule } from './smart-lists.js';
import { splitWinnerModule } from './split-winner.js';
import { tagBulkModule } from './tag-bulk.js';
import { workflowFoldersModule } from './workflow-folders.js';

/**
 * HighLevel parity – CRM, inbox and automation gaps (docs/api.md): each part is a module of its own; this list is the one line the
 * registry needs. After tag-meta, the team inbox, notes-plus and the undo journal, whose tables and hooks the parts use.
 */
export const crmGapModules: Module[] = [tagBulkModule, inboxFiltersModule, contactBulkOwnerModule, fieldCleanupModule, messageTriggersModule, contactDocumentsModule, workflowFoldersModule, fieldHistoryModule, dealSmartTagsModule, dealForecastModule, splitWinnerModule, companyBulkModule, smartListsModule];
