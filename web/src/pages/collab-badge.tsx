import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Unread counter next to "Team-Chat" in the menu. Asked once, then once a minute while the tab is visible;
 * the chat page itself pushes the exact numbers (pghl:chat-unread) while it is open, so the menu follows live.
 */
export function ChatBadge() {
  const [n, setN] = useState({ unread: 0, mentions: 0 });
  useEffect(() => {
    let live = true;
    const ask = () => {
      if (document.visibilityState !== 'visible') return;
      api
        .get('/api/team-chat/summary')
        .then((r) => live && setN({ unread: r.unread ?? 0, mentions: r.mentions ?? 0 }))
        .catch(() => {});
    };
    ask();
    const t = setInterval(ask, 60_000);
    const on = (e: Event) => setN((e as CustomEvent).detail);
    window.addEventListener('pghl:chat-unread', on);
    document.addEventListener('visibilitychange', ask);
    return () => {
      live = false;
      clearInterval(t);
      window.removeEventListener('pghl:chat-unread', on);
      document.removeEventListener('visibilitychange', ask);
    };
  }, []);
  const total = n.mentions || n.unread;
  if (!total) return null;
  return (
    <span className={`nav-badge${n.mentions ? ' hot' : ''}`} aria-label={n.mentions ? `${n.mentions} Erwähnungen` : `${n.unread} ungelesene Nachrichten`}>
      {total > 99 ? '99+' : total}
    </span>
  );
}
