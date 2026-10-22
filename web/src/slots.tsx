import { lazy, Suspense, type ComponentType } from 'react';

/**
 * UI slots: places in shared screens where feature modules plug in their own panel without the screen knowing them. A slot
 * names its props; each fill is a lazily loaded component (its own chunk), registered here with one line.
 *
 *   <Slot name="call.panel" contactId={…} listId={…} />   – browser phone and power dialer (call scripts)
 *   <Slot name="inbox.message" message={…} onChanged={…} /> – under a message in Konversationen (social comments: reply, hide, AI)
 *   <Slot name="channels.meta" />                         – Einstellungen → Kanäle (several pages, social comment sources)
 *   <Slot name="reviews.panel" />                         – Bewertungen (reviews from other platforms)
 *   <Slot name="voiceai.panel" />                         – KI-Telefonagent settings (outbound AI calls)
 *   <Slot name="telephony.settings" />                    – Einstellungen → Telefonie (own numbers as caller ID)
 *   <Slot name="agency.system" />                         – Agentur → System below the server metrics (operations: backups, alerts, status page)
 *   <Slot name="cloud.abuse" />                           – Agentur → Cloud → Missbrauch (abuse notices and measures)
 *   <Slot name="cloud.waitlist" />                        – Agentur → Cloud → Warteliste (waitlist mode, the built-in list)
 *   <Slot name="settings.payments" />                     – Einstellungen → Stripe & Zahlungen (PayPal, Mollie)
 *   <Slot name="project.files" />                         – Projekt-Steckbrief below Berichte & Artefakte (stored project files)
 *   <Slot name="contract.signers" contract={…} />          – Vertrag: several signers with roles and signing order
 *   <Slot name="giftcards.panel" />                       – Umsatz → Gutscheine below the cards (loyalty points)
 *   <Slot name="shell.banner" />                          – top of every page in a sub-account (the agency's announcements)
 *   <Slot name="agency.clients" />                        – Agentur → Kunden below the list (announcements for sub-accounts)
 *   <Slot name="settings.team" />                         – Einstellungen → Team below the people (own roles)
 *   <Slot name="agents.tests" />                          – KI-Agenten → Prompt-Tests (prompt optimizer)
 *   <Slot name="agency.branding" />                       – Agentur → Branding below the settings (own wording of system mails)
 *   <Slot name="contact.document" doc={…} />              – on each document chip of a contact (share in the customer portal)
 *   <Slot name="portal.settings" />                       – Kurse → Mitgliederbereich below the settings (files in the portal)
 */
export interface SlotProps {
  'call.panel': { contactId?: string; listId?: string };
  'inbox.message': { message: any; onChanged: () => void };
  'channels.meta': Record<never, never>;
  'reviews.panel': Record<never, never>;
  'voiceai.panel': Record<never, never>;
  'telephony.settings': Record<never, never>;
  'agency.system': object;
  'cloud.abuse': object;
  'cloud.waitlist': object;
  'settings.payments': { locationId?: string };
  'project.files': object;
  'contract.signers': { contract: any; onChanged?: () => void };
  'giftcards.panel': object;
  'shell.banner': object;
  'agency.clients': object;
  'settings.team': object;
  'agents.tests': object;
  'agency.branding': object;
  'contact.document': { doc: { id: string; contact_id: string; private: boolean; name: string } };
  'portal.settings': object;
}

const FILLS: { [K in keyof SlotProps]: ComponentType<SlotProps[K]>[] } = {
  'call.panel': [lazy(() => import('./pages/CallScripts').then((m) => ({ default: m.CallScriptPanel })))],
  'inbox.message': [lazy(() => import('./pages/SocialComments').then((m) => ({ default: m.CommentActions })))],
  'channels.meta': [lazy(() => import('./pages/MetaPages').then((m) => ({ default: m.MetaPagesCard }))), lazy(() => import('./pages/SocialComments').then((m) => ({ default: m.SocialCommentsSettings })))],
  'reviews.panel': [lazy(() => import('./pages/ReviewSources').then((m) => ({ default: m.ReviewSourcesPanel }))), lazy(() => import('./pages/VideoTestimonials').then((m) => ({ default: m.VideoTestimonialsPanel }))), lazy(() => import('./pages/ReviewBulk').then((m) => ({ default: m.ReviewBulkCard })))],
  'voiceai.panel': [lazy(() => import('./pages/VoiceOutbound').then((m) => ({ default: m.VoiceOutboundPanel })))],
  'telephony.settings': [lazy(() => import('./pages/CallerIds').then((m) => ({ default: m.CallerIdsCard })))],
  'agency.system': [lazy(() => import('./pages/OpsPanel').then((m) => ({ default: m.OpsPanel })))],
  'cloud.abuse': [lazy(() => import('./pages/CloudAbuse').then((m) => ({ default: m.CloudAbuse })))],
  'cloud.waitlist': [lazy(() => import('./pages/CloudWaitlist').then((m) => ({ default: m.CloudWaitlist })))],
  'settings.payments': [lazy(() => import('./pages/PayProviders').then((m) => ({ default: m.PayProviders })))],
  'project.files': [lazy(() => import('./pages/ProjectFiles').then((m) => ({ default: m.ProjectFilesCard })))],
  'contract.signers': [lazy(() => import('./pages/ContractSigners').then((m) => ({ default: m.ContractSignersPanel })))],
  'giftcards.panel': [lazy(() => import('./pages/Loyalty').then((m) => ({ default: m.LoyaltyPanel })))],
  'shell.banner': [lazy(() => import('./pages/AgencyBanners').then((m) => ({ default: m.ShellBanners })))],
  'agency.clients': [lazy(() => import('./pages/AgencyBanners').then((m) => ({ default: m.AgencyBannersCard })))],
  'settings.team': [lazy(() => import('./pages/RoleTemplates').then((m) => ({ default: m.RoleTemplatesCard })))],
  'agents.tests': [lazy(() => import('./pages/PromptLab').then((m) => ({ default: m.PromptLabPanel })))],
  'agency.branding': [lazy(() => import('./pages/SystemMails').then((m) => ({ default: m.SystemMailsCard })))],
  'contact.document': [lazy(() => import('./pages/PortalFiles').then((m) => ({ default: m.PortalShareToggle })))],
  'portal.settings': [lazy(() => import('./pages/PortalFiles').then((m) => ({ default: m.PortalFilesSettings })))],
};

export function Slot<K extends keyof SlotProps>({ name, ...props }: { name: K } & SlotProps[K]) {
  return (
    <Suspense fallback={null}>
      {FILLS[name].map((Fill, i) => {
        const C = Fill as ComponentType<any>;
        return <C key={i} {...props} />;
      })}
    </Suspense>
  );
}
