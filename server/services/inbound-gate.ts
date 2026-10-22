import type { App } from '../core/app.js';

/**
 * The receive hook (`app.services.inboundGates`): before an inbound message counts – e-mail and SMS webhooks, WhatsApp /
 * Messenger / Instagram, Telegram / Discord / Slack, mail synced from Gmail or Outlook – each gate may claim it. A gate that
 * answers with `archive` gets the stored message and its conversation to archive silently (modules/inbox-spam.ts: blocked
 * senders); the caller then fires no `message.inbound`, so no workflow, notification, auto reply or ticket reacts. The
 * message itself is kept for the record (and the GDPR export).
 */
export interface InboundInput {
  locationId: string;
  contactId: string;
  channel: string;
}
export interface InboundClaim {
  archive(conversationId: string, messageId: string): void;
}
export type InboundGate = (input: InboundInput) => InboundClaim | null | undefined | false;

export function inboundGate(app: App, input: InboundInput): InboundClaim | null {
  for (const gate of (app.services.inboundGates ?? []) as InboundGate[]) {
    try {
      const claim = gate(input);
      if (claim) return claim;
    } catch (e) {
      console.error('[inbound-gate]', (e as Error).message);
    }
  }
  return null;
}
