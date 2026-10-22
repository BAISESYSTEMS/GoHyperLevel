import { FileSpreadsheet, FileText, FileType, Presentation } from 'lucide-react';
import { useT, type TFn } from '../i18n';
import { people, usePresence } from '../presence/store';
import { OFFICE_KINDS, type OfficeKind, type OfficeStatus } from './office-kit';

/** Small pieces shared by the Office list and the file view: labels, icons, who has a file open, the setup note. */

export const kindLabels = (t: TFn): Record<OfficeKind, string> => ({ docx: t('Dokumente'), xlsx: t('Tabellen'), pptx: t('Präsentationen'), pdf: t('PDF') });
export const kindOne = (t: TFn): Record<OfficeKind, string> => ({ docx: t('Dokument'), xlsx: t('Tabelle'), pptx: t('Präsentation'), pdf: t('PDF') });

export function KindIcon({ kind, size = 18 }: { kind: OfficeKind; size?: number }) {
  const Ico = { docx: FileText, xlsx: FileSpreadsheet, pptx: Presentation, pdf: FileType }[kind] ?? FileText;
  return <Ico size={size} className={`of-ico of-${kind}`} aria-hidden="true" />;
}

/** Who has a file open right now (app-wide presence: their page is /office/<id>). */
export function useOpenBy(fileId?: string) {
  const { peers } = usePresence();
  return people(peers.filter((p) => !!p.page && (fileId ? p.page === `/office/${fileId}` || p.page.startsWith(`/office/${fileId}/`) : p.page.startsWith('/office/'))));
}

export function Faces({ list, label }: { list: { id: string; name: string; color: string }[]; label: string }) {
  if (!list.length) return null;
  return (
    <span className="of-faces" title={label} aria-label={label}>
      {list.slice(0, 4).map((p) => (
        <span key={p.id} className="of-face" style={{ background: p.color }} aria-hidden="true">
          {p.name.slice(0, 1).toUpperCase()}
        </span>
      ))}
    </span>
  );
}

export function SetupNote({ status }: { status: OfficeStatus }) {
  const t = useT('office');
  const editors = OFFICE_KINDS.filter((k) => status.editors[k]).length;
  const engines = OFFICE_KINDS.filter((k) => status.engines[k]).length;
  if (editors === 4 && engines === 4) return null;
  return (
    <div className="of-note" role="note" data-tour="office-setup">
      {editors < 4 && (
        <p>
          <strong>{editors === 0 ? t('Editor nicht installiert') : t('Nicht alle Editoren installiert')}</strong> – {t('Dateien lassen sich trotzdem anlegen, hochladen, herunterladen und vom KI-Agenten bearbeiten. Für das Bearbeiten im Browser legt die Agentur die Editoren auf dem Server ab (PGHL_OFFICE_DIR, siehe docs/office.md).')}
        </p>
      )}
      {engines < 4 && <p className="muted small">{t('Ohne Office-Engine (PGHL_OFFICE_BIN_DIR) liest der KI-Agent nur den reinen Text und kann nicht bearbeiten oder als PDF exportieren.')}</p>}
    </div>
  );
}

