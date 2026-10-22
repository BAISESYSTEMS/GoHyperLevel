import { useEffect, useState } from 'react';
import { api, currentLocation } from '../api';
import { Icon } from '../icons';
import { Link } from '../ui';

/**
 * Below „Werkstatt“ in the menu: what waits for you – admins see the orders to approve, everyone sees new notes
 * (plan ready, approved, finished). Checks once a minute and whenever a build dialog closes.
 */
export interface Notice {
  id: string;
  build_id: string | null;
  kind: string;
  title: string;
  body: string;
  url: string;
  read_at: string | null;
  created_at: string;
}

export function useWerkstattNotes() {
  const [state, setState] = useState<{ unread: number; notices: Notice[]; pending: number }>({ unread: 0, notices: [], pending: 0 });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const load = async () => {
      if (!currentLocation()) return;
      try {
        const [n, me] = await Promise.all([api.get<{ unread: number; notices: Notice[] }>('/api/werkstatt/notices'), api.get<{ pending_approvals: number }>('/api/werkstatt/me').catch(() => ({ pending_approvals: 0 }))]);
        if (live) setState({ unread: n.unread, notices: n.notices, pending: me.pending_approvals });
      } catch {
        /* signed out or offline */
      }
    };
    void load();
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), 60_000);
    const on = () => void load();
    window.addEventListener('pghl:build-closed', on);
    window.addEventListener('pghl:notes', on);
    return () => {
      live = false;
      clearInterval(t);
      window.removeEventListener('pghl:build-closed', on);
      window.removeEventListener('pghl:notes', on);
    };
  }, [tick]);
  return { ...state, reload: () => setTick((n) => n + 1) };
}

export function WerkstattNav() {
  const { unread, pending } = useWerkstattNotes();
  if (!unread && !pending) return null;
  return (
    <div className="nav-sub" data-tour="wk-nav-notes">
      {pending > 0 && (
        <Link to="werkstatt/approvals">
          <Icon name="ok" size={15} /> {pending} zur Freigabe
        </Link>
      )}
      {unread > 0 && (
        <Link to="werkstatt">
          <Icon name="notify" size={15} /> {unread} neu
        </Link>
      )}
    </div>
  );
}
