import type { Catalog } from '../registry';

/** English – mark as spam and block sender (pages/InboxSpam.tsx). */
export default {
  Spam: 'Spam',
  Belästigung: 'Harassment',
  Sonstiges: 'Other',
  Blockiert: 'Blocked',
  '{m} Nachrichten, {c} Anrufe abgefangen': '{m} messages, {c} calls intercepted',
  'Blockierung aufgehoben': 'Unblocked',
  Entsperren: 'Unblock',
  'Als Spam markieren und Absender blockieren': 'Mark as spam and block the sender',
  'Als Spam markieren & blockieren': 'Mark as spam & block',
  'Absender blockiert': 'Sender blocked',
  Blockieren: 'Block',
  'Neue Nachrichten dieses Absenders werden still archiviert – ohne Benachrichtigung und ohne Workflow. Anrufe werden abgewiesen. Die Konversation verschwindet aus dem Posteingang (Filter „Spam“).':
    'New messages from this sender are archived silently – no notification, no workflow. Calls are rejected. The conversation leaves the inbox (filter “Spam”).',
  Grund: 'Reason',
  'Notiz (optional)': 'Note (optional)',
  'Rückgängig jederzeit mit „Entsperren“ in der Konversation.': 'Undo any time with “Unblock” in the conversation.',
} satisfies Catalog;
