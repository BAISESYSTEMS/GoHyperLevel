import { Icon, type IconName } from '../icons';
import { api } from '../api';
import { Link, useLoad } from '../ui';
import { Mini } from './Mini';
import type { TemplateItem } from './types';
import './boards.css';

/** A shelf for the Marktplatz page: board templates other sub-accounts published (config only – installing asks what a template reads and shows). */
export function BoardShelf() {
  const { data } = useLoad(() => api.get<{ marketplace: TemplateItem[] }>('/api/board-templates').catch(() => ({ marketplace: [] as TemplateItem[] })), []);
  const list = data?.marketplace ?? [];
  if (!list.length) return null;
  return (
    <section className="bd-shelf" aria-label="Board-Vorlagen" data-tour="mk-board-shelf">
      <header>
        <h3>
          <Icon name="boards" size={16} /> Board-Vorlagen <span className="bd-badge">{list.length}</span>
        </h3>
        <Link to="boards/vorlagen" className="btn ghost small">
          Alle ansehen
        </Link>
      </header>
      <div className="bd-shelf-row">
        {list.slice(0, 4).map((t) => (
          <Link key={t.id} to="boards/vorlagen" className="bd-shelf-card">
            <Mini cells={t.preview} accent={t.accent} />
            <b>
              <Icon name={(t.icon || 'boards') as IconName} size={14} /> {t.name}
            </b>
            <span className="muted small">
              {t.widgets} Widgets · von {t.author || 'unbekannt'} · {t.installs}× installiert
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
