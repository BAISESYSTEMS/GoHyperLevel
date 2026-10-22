import type { ReactElement } from 'react';
import type { EditorApi } from './Editor';
import { ChartDialog, IconsDialog, MediaDialog, MermaidDialog, TableDialog, TemplatesDialog } from './dialogs-insert';
import { ConvertTaskDialog, CrmDialog, DealDialog, FunnelDialog, WorkflowDialog, WorkflowDraftDialog } from './dialogs-crm';
import { ExportDialog, HistoryDialog, SettingsDialog, ShareDialog } from './dialogs-share';
import { ShortcutsDialog } from './dialogs-help';

/**
 * The editor's dialogs. Each one is a `Modal` (✕ top right, Esc closes) with the same props; the
 * editor opens them by kind through `EditorApi.open`.
 */

export type DialogKind = 'templates' | 'media' | 'icons' | 'table' | 'chart' | 'mermaid' | 'crm' | 'deal' | 'convertTask' | 'workflow' | 'workflowDraft' | 'funnel' | 'export' | 'share' | 'history' | 'settings' | 'shortcuts';

export interface DialogProps {
  api: EditorApi;
  data?: any;
  onClose: () => void;
}

const DIALOGS: Record<DialogKind, (p: DialogProps) => ReactElement | null> = {
  templates: TemplatesDialog,
  media: MediaDialog,
  icons: IconsDialog,
  table: TableDialog,
  chart: ChartDialog,
  mermaid: MermaidDialog,
  crm: CrmDialog,
  deal: DealDialog,
  convertTask: ConvertTaskDialog,
  workflow: WorkflowDialog,
  workflowDraft: WorkflowDraftDialog,
  funnel: FunnelDialog,
  export: ExportDialog,
  share: ShareDialog,
  history: HistoryDialog,
  settings: SettingsDialog,
  shortcuts: ShortcutsDialog,
};

export function Dialogs({ api, kind, data, onClose }: { api: EditorApi; kind: DialogKind; data?: any; onClose: () => void }) {
  const D = DIALOGS[kind];
  return D ? <D api={api} data={data} onClose={onClose} /> : null;
}
