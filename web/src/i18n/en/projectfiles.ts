import type { Catalog } from '../registry';

/** English – the project's stored files on the project profile (pages/ProjectFiles.tsx). */
export default {
  Dateien: 'Files',
  '{n} Dateien': { one: '{n} file', other: '{n} files' },
  Gelöscht: 'Deleted',
  Herunterladen: 'Download',
  Löschen: 'Delete',
  '„{path}“ endgültig löschen?': 'Delete “{path}” for good?',
  'Noch keine Dateien. Claude legt hier Anweisungen und Wissensdateien eines Claude-Projekts oder Dateien aus einem Repo ab (MCP: ghl_import_claude_project, ghl_upload_files).':
    'No files yet. Claude stores the instructions and knowledge files of a Claude project or files from a repository here (MCP: ghl_import_claude_project, ghl_upload_files).',
} satisfies Catalog;
