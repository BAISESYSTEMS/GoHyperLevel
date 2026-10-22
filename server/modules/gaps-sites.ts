import type { Module } from '../core/app.js';
import { siteSeoModule } from './site-seo.js';
import { siteDyntextModule } from './site-dyntext.js';
import { siteFontsModule } from './site-fonts.js';
import { siteProtectModule } from './site-protect.js';
import { sitePagesModule } from './site-pages.js';
import { socialApprovalModule } from './social-approval.js';
import { socialQueuesModule } from './social-queues.js';
import { agencyBannersModule } from './agency-banners.js';
import { roleTemplatesModule } from './role-templates.js';
import { templateConditionsModule } from './template-conditions.js';
import { videoTestimonialsModule } from './video-testimonials.js';
import { promptLabModule } from './prompt-lab.js';
import { adsGoogleLeadsModule } from './ads-google-leads.js';
import { reportCustomFieldsModule } from './report-custom-fields.js';
import { systemMailsModule } from './system-mails.js';
import { wordpressPluginModule } from './wordpress-plugin.js';
import { reviewRequestsPlusModule } from './review-requests-plus.js';
import { courseAiModule } from './course-ai.js';

/**
 * HighLevel parity – sites, marketing, agency (wave 10): one registry line for these feature modules.
 * - site-seo (SEO-Check, structured data), site-dyntext (URL parameters as text), site-fonts (own font files), site-pages (page
 *   offline, order) and site-protect
 *   (password-protected pages – the last of the page hooks, so its form replaces whatever the others added);
 * - social-approval (client approval by magic link) and social-queues (evergreen categories) on top of `app.services.socialPost`;
 * - agency-banners (announcements in sub-accounts), role-templates (own roles with read-only areas);
 * - template-conditions (`{{#if …}}` blocks in e-mails, SMS and documents);
 * - video-testimonials (collect page, approval, wall) and prompt-lab (tests and improvements for AI agent instructions);
 * - ads-google-leads (Google Ads lead form webhook as a lead source), report-custom-fields (own contact fields in reports),
 *   system-mails (the agency's own wording for invitation, sign-in link and SaaS welcome mails),
 *   wordpress-plugin (generated plugin with form/calendar shortcodes, chat and attribution), review-requests-plus (bulk, reminder),
 *   course-ai (course outline with lesson texts by AI, created as a draft).
 */
export const gapsSitesModules: Module[] = [
  siteSeoModule,
  siteDyntextModule,
  siteFontsModule,
  sitePagesModule,
  siteProtectModule,
  socialApprovalModule,
  socialQueuesModule,
  agencyBannersModule,
  roleTemplatesModule,
  templateConditionsModule,
  videoTestimonialsModule,
  promptLabModule,
  adsGoogleLeadsModule,
  reportCustomFieldsModule,
  systemMailsModule,
  wordpressPluginModule,
  reviewRequestsPlusModule,
  courseAiModule,
];
