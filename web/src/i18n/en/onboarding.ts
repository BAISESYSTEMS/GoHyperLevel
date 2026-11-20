import type { Catalog } from '../registry';

/** English – Ersteinstieg: the welcome wizard, the "Erste Schritte" card, the academy hint and the practice-company banner (web/src/onboarding, web/src/tour/welcome.tsx). */
export default {
  // welcome wizard (onboarding/FirstRun.tsx)
  'Willkommen! Was machst du?': 'Welcome! What do you do?',
  'Woher kommen deine Daten?': 'Where does your data come from?',
  'Dein erster Erfolg': 'Your first win',
  'Überspringen': 'Skip',
  'Zurück': 'Back',
  'Weiter': 'Next',
  'Übungs-Firma wird angelegt …': 'Setting up the practice company …',
  'Los geht’s': 'Let’s go',
  'Schritt {n} von {total}': 'Step {n} of {total}',
  'Wir zeigen dir nur die Bereiche, die du dafür brauchst. Alles andere liegt unter „Mehr“ – nichts wird gelöscht oder gesperrt.':
    'We only show the areas you need for it. Everything else is under “More” – nothing is deleted or locked.',
  'Mit echten Daten macht HyperLevel sofort Sinn. Du kannst das jederzeit später nachholen.': 'HyperLevel makes sense right away with real data. You can always do this later.',
  'Such dir eine Sache aus, die heute live geht. Die Seite öffnet sich direkt mit dem passenden Dialog.': 'Pick one thing that goes live today. The page opens with the right dialog straight away.',
  'Danach zeigt dir die Karte „Erste Schritte“ auf dem Dashboard, was noch fehlt.': 'After that, the “First steps” card on the dashboard shows you what is still missing.',
  // choices and steps (onboarding/first-run-model.ts)
  'Kontakte importieren': 'Import contacts',
  'Eine CSV-Datei aus Excel, Google Sheets oder deinem alten Programm hochladen.': 'Upload a CSV file from Excel, Google Sheets or your old tool.',
  'Umzug aus einem anderen Tool': 'Move from another tool',
  'Kontakte, Deals und Termine aus GoHighLevel, HubSpot, Pipedrive & Co. übernehmen.': 'Bring over contacts, deals and appointments from GoHighLevel, HubSpot, Pipedrive & co.',
  'Erst mal üben': 'Practise first',
  'Eine Übungs-Firma mit erfundenen Kontakten, Terminen und Deals – nichts wird verschickt.': 'A practice company with made-up contacts, appointments and deals – nothing is sent.',
  'Leer starten': 'Start empty',
  'Ich lege selbst los – Daten kann ich jederzeit später holen.': 'I’ll get going myself – I can bring in data any time later.',
  'Buchungsseite live schalten': 'Put a booking page live',
  'Kunden buchen selbst einen Termin bei dir – ein Link für Website, E-Mail und Social Media.': 'Customers book an appointment with you themselves – one link for your website, email and social media.',
  'Kontaktformular veröffentlichen': 'Publish a contact form',
  'Aus einer fertigen Vorlage – jede Anfrage landet als Kontakt in deinem CRM.': 'From a ready-made template – every enquiry lands in your CRM as a contact.',
  'Landingpage bauen': 'Build a landing page',
  'Eine Seite für dein Angebot – mit Vorlage oder von der KI entworfen.': 'A page for your offer – from a template or drafted by AI.',
  'Ersten Kurs anlegen': 'Create your first course',
  'Lektionen hochladen, Zugang verkaufen oder verschenken.': 'Upload lessons, sell access or give it away.',
  'Tour in 10 Minuten': '10-minute tour',
  'Menü, Suche, Hilfe und die wichtigsten Bereiche – direkt in der echten Oberfläche.': 'Menu, search, help and the most important areas – right in the real interface.',
  // "Erste Schritte" card (onboarding/FirstSteps.tsx)
  'Geschafft – du bist startklar!': 'Done – you’re all set!',
  'Erste Schritte': 'First steps',
  '{done} von {total} erledigt': '{done} of {total} done',
  'Ausblenden': 'Hide',
  'Live:': 'Live:',
  'Tour starten': 'Start the tour',
  'Jetzt erledigen': 'Do it now',
  // academy hint (tour/welcome.tsx)
  'Academy': 'Academy',
  'In 10 Minuten startklar – Academy starten': 'Ready in 10 minutes – start the Academy',
  'Die geführte Tour zeigt dir Menü, Suche, Hilfe und die wichtigsten Bereiche – direkt in der echten Oberfläche, Schritt für Schritt. Danach findest du für jeden Bereich eine eigene Tour.':
    'The guided tour shows you the menu, search, help and the most important areas – right in the real interface, step by step. After that there is a tour for every area.',
  'Academy starten': 'Start the Academy',
  'Alle Touren ansehen': 'See all tours',
  'Schließen': 'Close',
  // practice company banner (tour/help.tsx#SandboxBanner)
  'Übungs-Firma:': 'Practice company:',
  'Hier ist alles erfunden – probier ruhig alles aus.': 'Everything here is made up – try anything you like.',
  'E-Mails und SMS werden nur gespeichert, nie verschickt.': 'Emails and texts are only saved, never sent.',
  'Zur Akademie': 'To the Academy',
} satisfies Catalog;
