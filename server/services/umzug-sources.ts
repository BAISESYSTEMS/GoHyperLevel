import { SOURCE_KEYS, type SourceDef, type SourceKey } from './umzug-core.js';
import { ACTIVECAMPAIGN } from './umzug-activecampaign.js';
import { AIRTABLE } from './umzug-airtable.js';
import { BREVO } from './umzug-brevo.js';
import { KIT } from './umzug-convertkit.js';
import { INTERCOM } from './umzug-intercom.js';
import { KAJABI } from './umzug-kajabi.js';
import { KEAP } from './umzug-keap.js';
import { KLAVIYO } from './umzug-klaviyo.js';
import { KLICKTIPP } from './umzug-klicktipp.js';
import { MAILCHIMP } from './umzug-mailchimp.js';
import { CALENDLY } from './umzug-calendly.js';
import { CLICKUP } from './umzug-clickup.js';
import { LEXOFFICE } from './umzug-lexoffice.js';
import { MANYCHAT } from './umzug-manychat.js';
import { MONDAY } from './umzug-monday.js';
import { NOTION } from './umzug-notion.js';
import { PIPEDRIVE } from './umzug-pipedrive.js';
import { TYPEFORM } from './umzug-typeform.js';
import { SEVDESK } from './umzug-sevdesk.js';
import { SYSTEME } from './umzug-systeme.js';
import { SALESFORCE } from './umzug-salesforce.js';
import { TEACHABLE } from './umzug-teachable.js';
import { ZENDESK } from './umzug-zendesk.js';
import { ZOHO } from './umzug-zoho.js';

/** The sources of the switch-over importers, in the order the wizard shows them. */
export const SOURCES: Record<SourceKey, SourceDef> = { mailchimp: MAILCHIMP, activecampaign: ACTIVECAMPAIGN, kit: KIT, kajabi: KAJABI, teachable: TEACHABLE, keap: KEAP, pipedrive: PIPEDRIVE, systeme: SYSTEME, klaviyo: KLAVIYO, brevo: BREVO, klicktipp: KLICKTIPP, manychat: MANYCHAT, zendesk: ZENDESK, intercom: INTERCOM, salesforce: SALESFORCE, zoho: ZOHO, monday: MONDAY, clickup: CLICKUP, notion: NOTION, airtable: AIRTABLE, typeform: TYPEFORM, calendly: CALENDLY, lexoffice: LEXOFFICE, sevdesk: SEVDESK };

export const sourceList = (): SourceDef[] => SOURCE_KEYS.map((k) => SOURCES[k]);
