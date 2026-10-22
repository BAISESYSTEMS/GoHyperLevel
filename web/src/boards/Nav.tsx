import { useEffect, useState } from 'react';
import { api, currentLocation } from '../api';
import { Icon, type IconName } from '../icons';
import { Link } from '../ui';

interface Item {
  id: string;
  name: string;
  icon: string;
  home: boolean;
}
let cache: { loc: string; items: Item[] } | null = null;

/** Sidebar: the person's boards below "Boards" – only while a boards page is open, so everybody else pays nothing for it. */
export function BoardsNav({ cur }: { cur: string[] }) {
  const on = cur[0] === 'boards';
  const [items, setItems] = useState<Item[]>(cache?.loc === currentLocation() ? cache.items : []);
  useEffect(() => {
    if (!on) return;
    let live = true;
    const load = () =>
      api
        .get<{ boards: Item[] }>('/api/boards')
        .then((r) => {
          const list = r.boards.slice(0, 12).map(({ id, name, icon, home }) => ({ id, name, icon, home }));
          cache = { loc: currentLocation(), items: list };
          if (live) setItems(list);
        })
        .catch(() => undefined);
    void load();
    window.addEventListener('pghl:boards', load);
    return () => {
      live = false;
      window.removeEventListener('pghl:boards', load);
    };
  }, [on, cur[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!on || !items.length) return null;
  return (
    <div className="nav-sub">
      {items.map((b) => (
        <Link key={b.id} to={`boards/${b.id}`} className={cur[1] === b.id ? 'on' : ''}>
          <Icon name={(b.icon || 'boards') as IconName} size={15} /> {b.name}
        </Link>
      ))}
      <Link to="boards/vorlagen" className={cur[1] === 'vorlagen' ? 'on' : ''}>
        <Icon name="template" size={15} /> Vorlagen
      </Link>
    </div>
  );
}
