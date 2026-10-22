import type { IssueCode } from '../../../server/services/workflow-validate';

/**
 * German texts (message ids of the wfcanvas catalog) of the issues server/services/workflow-validate.ts finds – the same list as its
 * ISSUE_TEXT (tests/workflow-validate.test.ts keeps them equal). Kept here as literals so the translation check sees them.
 */
export const ISSUE_TEXT: Record<IssueCode, string> = {
  required: 'Pflichtfeld fehlt: {field}',
  email_empty: 'Betreff und Text fehlen',
  text_missing: 'Text fehlt',
  tags_empty: 'Mindestens einen Tag angeben',
  field_missing: 'Feld wählen',
  wait_amount: 'Dauer fehlt',
  wait_date: 'Datum fehlt',
  conditions_empty: 'Bedingung fehlt',
  condition_incomplete: 'Bedingung unvollständig (Feld oder Wert fehlt)',
  pipeline_missing: 'Pipeline wählen',
  status_missing: 'Status wählen',
  title_missing: 'Titel fehlt',
  url_invalid: 'URL fehlt oder beginnt nicht mit http(s)://',
  workflow_missing: 'Workflow wählen',
  channels_missing: 'Mindestens einen Kanal wählen',
  split_paths: 'Mindestens zwei Pfade anlegen',
  target_missing: 'Sprungziel gibt es nicht (mehr) – Schritt neu wählen',
};
