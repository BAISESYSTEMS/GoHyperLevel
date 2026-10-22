import type { Tour } from '../types';

/** Native mailboxes: Gmail and Outlook / Microsoft 365 over their official APIs. */
export const MAILBOX_TOURS: Tour[] = [
  {
    id: 'mailbox-sync',
    title: 'Postfach verbinden: Gmail & Outlook',
    summary: 'Gmail oder Outlook direkt verbinden: Mails im Posteingang, aus HyperLevel im selben Thread antworten, archivieren, Labels, Entwürfe und geplantes Senden.',
    icon: 'email',
    group: 'settings',
    perm: 'settings',
    minutes: 5,
    routes: ['settings/messaging'],
    keywords: 'postfach gmail outlook microsoft 365 google mail verbinden oauth imap smtp posteingang archiv label entwurf thread antworten shared mailbox gemeinsames postfach push',
    learned: ['Ein Gmail- oder Outlook-Postfach ohne Passwörter verbinden', 'Wählen, welche Ordner/Labels und wie viele Tage abgeglichen werden', 'Im Posteingang nach Postfach filtern, archivieren, labeln und im Thread antworten', 'Workflow-E-Mails über das Postfach senden und Push einrichten'],
    docs: { label: 'Postfach-Sync', file: 'mailbox-sync' },
    steps: [
      { title: 'Postfach verbinden', route: 'settings/messaging', target: 'mailbox-card', text: 'Hier verbindest du ein Gmail- oder Outlook-Postfach über die offiziellen Schnittstellen – kein IMAP-Passwort, kein SMTP. Voraussetzung: Die Agentur hat die Google-/Microsoft-App eingetragen.' },
      { title: 'Anbieter wählen', target: 'mailbox-provider', text: 'Gmail / Google Workspace oder Outlook / Microsoft 365. Bei Outlook kannst du zusätzlich ein gemeinsames Postfach (Shared Mailbox) angeben, auf das dein Konto Zugriff hat.' },
      { title: 'Für wen und wie weit', target: 'mailbox-connect', text: 'Ein Postfach des Sub-Accounts gehört dem ganzen Team. Ein persönliches nutzt nur du – Regeln legen fest, welche Mails in welchen Sub-Account kommen. Zugriff: Vollzugriff, nur lesen oder nur senden.' },
      { title: 'Die verbundenen Postfächer', target: 'mailbox-list', optional: true, missing: 'Noch kein Postfach verbunden – nach dem Verbinden erscheint es hier mit Status, letztem Abgleich und Push.', text: 'Status, letzter Abgleich und Anzahl der Nachrichten. Der erste Import läuft im Hintergrund; „Jetzt abgleichen“ stößt einen Abgleich an, „Neu verbinden“ erscheint, wenn der Zugriff entzogen wurde.' },
      { title: 'Einstellungen je Postfach', target: 'mailbox-edit', optional: true, missing: 'Die Einstellungen gibt es, sobald ein Postfach verbunden ist.', text: 'Name, Signatur, Abgleich-Zeitraum, Ordner und Labels, Absender-Filter und – bei persönlichen Postfächern – die Regeln, welche Mail in welchen Sub-Account kommt.' },
      { title: 'Zeitraum', target: 'mailbox-window', optional: true, missing: 'Öffne zuerst „Einstellungen“ bei einem Postfach.', text: 'So viele Tage zurück wird beim ersten Mal gelesen (30 bis 365). Danach holt HyperLevel nur noch Änderungen – bei Gmail über den Verlauf, bei Outlook über Delta-Abfragen.' },
      { title: 'Ordner und Labels', target: 'mailbox-folders', optional: true, missing: 'Öffne zuerst „Einstellungen“ bei einem Postfach.', text: 'Wähle, welche Gmail-Labels bzw. Outlook-Ordner abgeglichen werden. Standard: Posteingang, Gesendet und Entwürfe. Spam und Papierkorb kommen nie ins CRM.' },
      { title: 'Öffnungen und Klicks verfolgen', target: 'mailbox-tracking', optional: true, missing: 'Öffne zuerst „Einstellungen“ bei einem Postfach.', text: 'Standard: aus – persönliche 1:1-Mails werden nicht verfolgt. Eingeschaltet bekommen Mails aus HyperLevel ein Zählpixel und umgeleitete Links (das kann eine Einwilligung der Empfänger erfordern). Apple Mail, Bild-Proxys und Sicherheits-Scanner werden erkannt und nicht als Öffnung oder Klick gezählt.' },
      { title: 'E-Mails des Sub-Accounts darüber senden', target: 'mailbox-transport', optional: true, missing: 'Wähle oben beim E-Mail-Versand den Anbieter „Verbundenes Postfach“.', text: 'Mit dem Anbieter „Verbundenes Postfach“ gehen auch Automationen, Kampagnen und Nachrichten aus dem Posteingang über dieses Postfach und stehen dort unter „Gesendet“.' },
      { title: 'Im Posteingang filtern', route: 'conversations', target: 'inbox-mailbox', optional: true, missing: 'Der Filter erscheint, sobald ein Postfach verbunden ist.', perm: 'conversations', text: 'Wähle ein Postfach und einen Ordner (Posteingang, Archiv, Gesendet, Entwürfe). Ordner- und Label-Marken zeigen in der Liste, wo eine Konversation liegt.' },
      { title: 'Archivieren, Labels, Antworten', target: 'inbox-mail-actions', optional: true, missing: 'Öffne eine Konversation mit Postfach-Mail.', perm: 'conversations', text: 'Archivieren und Labels gelten in beide Richtungen, ebenso gelesen/ungelesen und Stern. „Per Postfach antworten“ schickt die Antwort im selben Thread – mit Signatur, Anhängen, Entwurf oder geplantem Senden.' },
      { title: 'Push in Sekunden', route: 'agency/integrations/setup', target: 'mailbox-agency', admin: true, optional: true, missing: 'Die Push-Karte steht unter Agentur → Integrationen → Einrichtung.', text: 'Ohne Push fragt HyperLevel alle 3 Minuten nach. Mit einem Pub/Sub-Thema (Gmail) bzw. einer öffentlichen https-Adresse (Outlook) erscheinen neue Mails in Sekunden.' },
    ],
  },
];
