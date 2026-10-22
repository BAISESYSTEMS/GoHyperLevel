import { ago, api, currentLocation } from '../api';
import { Icon } from '../icons';
import { useT } from '../i18n';
import { can, useSession } from '../session';
import { Spinner, act, confirmAsk, useLoad } from '../ui';

/**
 * Projekt → Dateien: the project's stored files (modules/project-files.ts) – instructions and knowledge files of a claude.ai project,
 * files of a repository uploaded from Claude Code. Path, size, last change, download, delete. Slot "project.files".
 */

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function ProjectFilesCard() {
  const t = useT('projectfiles');
  const session = useSession();
  const allowed = can(session, 'settings');
  const files = useLoad(() => (allowed ? api.get<any>('/api/project-files') : Promise.resolve(null)), [session.locationId, allowed]);
  if (!allowed) return null;
  const list: any[] = files.data?.files ?? [];
  return (
    <div className="card" data-tour="project-files">
      <h2>
        <Icon name="doc" size={18} /> {t('Dateien')}
        {files.data && list.length > 0 && <span className="muted small"> · {t.plural(files.data.total, { one: '{n} Datei', other: '{n} Dateien' })}, {size(files.data.bytes)}</span>}
      </h2>
      {!files.data ? (
        <Spinner />
      ) : list.length ? (
        <div className="doc-list">
          {list.map((f) => (
            <div className="doc-row" key={f.id}>
              <Icon name="doc" size={15} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div style={{ overflowWrap: 'anywhere' }}>{f.path}</div>
                <div className="muted small">
                  {size(f.size)} · {ago(f.updated_at)}
                  {f.source ? ` · ${f.source}` : ''}
                </div>
              </div>
              <span className="doc-actions">
                <a className="icon-btn" title={t('Herunterladen')} aria-label={t('Herunterladen')} href={`/api/project-files/${encodeURIComponent(f.id)}/raw?locationId=${encodeURIComponent(currentLocation())}`}>
                  <Icon name="download" size={14} />
                </a>
                <button className="icon-btn" title={t('Löschen')} aria-label={t('Löschen')} onClick={async () => (await confirmAsk(t('„{path}“ endgültig löschen?', { path: f.path }))) && (await act(() => api.del(`/api/project-files/${f.id}`), t('Gelöscht'))) && files.reload()}>
                  <Icon name="trash" size={14} />
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted small">{t('Noch keine Dateien. Claude legt hier Anweisungen und Wissensdateien eines Claude-Projekts oder Dateien aus einem Repo ab (MCP: ghl_import_claude_project, ghl_upload_files).')}</p>
      )}
    </div>
  );
}
