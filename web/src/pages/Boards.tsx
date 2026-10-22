import { BoardList } from '../boards/BoardList';
import { BoardView } from '../boards/BoardView';
import '../boards/boards.css';

/**
 * Living Boards ("Genius-Modulbaukasten"): workspaces composed from widgets by dragging or by telling the board what
 * you want. Routes: `boards` (list), `boards/vorlagen` (templates), `boards/<id>` (a board). Docs: docs/living-boards.md.
 */
export function Boards({ id }: { id?: string }) {
  if (id && id !== 'vorlagen') return <BoardView key={id} id={id} />;
  return <BoardList tab={id === 'vorlagen' ? 'vorlagen' : 'boards'} />;
}
