import type { Catalog } from '../registry';

/**
 * English – the built-in templates card on the agency's Snapshots tab (pages/SnapshotTemplates.tsx). Template names,
 * descriptions, pipeline, form and workflow names come from the server as data and stay German.
 */
export default {
  'Geladen: {forms} Formulare, {workflows} Workflows, {articles} Hilfe-Artikel, {routines} Routinen': 'Loaded: {forms} forms, {workflows} workflows, {articles} help articles, {routines} routines',
  'Nicht alles ging: {list}': 'Not everything worked: {list}',
  'Vorlagen von {brand}': 'Templates by {brand}',
  'Fertige Startpakete für eine ganze Firma – mit einem Klick in einen Sub-Account geladen. Workflows kommen als Entwurf, Hilfe-Artikel als Entwurf.':
    'Ready-made starter kits for a whole company – loaded into a sub-account in one click. Workflows and help articles arrive as drafts.',
  'hier geladen': 'loaded here',
  '{pipelines} Pipelines · {forms} Formulare · {workflows} Workflows · {templates} E-Mail-Vorlagen · {articles} Hilfe-Artikel · {dashboards} Dashboard · {routines} Routinen':
    '{pipelines} pipelines · {forms} forms · {workflows} workflows · {templates} e-mail templates · {articles} help articles · {dashboards} dashboard · {routines} routines',
  'In Sub-Account laden': 'Load into sub-account',
  '„{name}“ laden': 'Load “{name}”',
  Abbrechen: 'Cancel',
  'Lädt …': 'Loading …',
  Laden: 'Load',
  'Fügt alles als Kopie hinzu. Bestehendes bleibt unverändert; ein leerer Sub-Account bekommt statt der Standard-Pipeline die drei Pipelines der Vorlage.':
    'Adds everything as a copy. Nothing existing is changed; an empty sub-account gets the template’s three pipelines instead of the default pipeline.',
  'Ziel-Sub-Account': 'Target sub-account',
  'Workflows gleich aktivieren (sonst als Entwurf – empfohlen, bis E-Mail-Versand und Texte geprüft sind)': 'Activate workflows right away (otherwise as drafts – recommended until e-mail sending and texts are checked)',
  'Diese Vorlage ist hier schon geladen – ein zweites Mal legt alles doppelt an.': 'This template is already loaded here – loading it again creates everything twice.',
  Pipelines: 'Pipelines',
  Formulare: 'Forms',
  Workflows: 'Workflows',
} satisfies Catalog;
