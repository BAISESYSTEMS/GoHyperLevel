/**
 * Popups that open from a button (top bar icons, "…" menus, the presence list) hang off one side of it. On a narrow screen a button
 * near the other edge pushes them out of the window – on a phone the presence list opened to the left, off screen. Every popup in
 * POPUPS is nudged back inside the window (8 px margin) and never wider than it; the nudge uses `translate`, so a popup's own
 * transform or animation stays untouched. Runs once per frame at most, after DOM changes and window resizes.
 */
const POPUPS = '.pz-pop, .act-pop, .help-pop, .menu-pop, .avatar-menu, .ck-menu, .ck-pop, .switcher-pop, .lang-pop, .mbx-pop, .pm-pop, .cv-pop, [data-clamp]';
const MARGIN = 8;

export function clampIntoView(el: HTMLElement, width = document.documentElement.clientWidth): void {
  el.style.translate = '';
  const r = el.getBoundingClientRect();
  if (!r.width) return;
  const room = width - 2 * MARGIN;
  if (r.width > room) el.style.maxWidth = `${room}px`;
  const w = Math.min(r.width, room);
  let dx = 0;
  if (r.left < MARGIN) dx = MARGIN - r.left;
  else if (r.left + w > width - MARGIN) dx = width - MARGIN - (r.left + w);
  if (dx) el.style.translate = `${Math.round(dx)}px 0`;
}

let started = false;

export function initPopoverClamp(win: Window = window): void {
  if (started || typeof MutationObserver === 'undefined') return;
  started = true;
  let queued = false;
  const run = () => {
    queued = false;
    win.document.querySelectorAll<HTMLElement>(POPUPS).forEach((el) => clampIntoView(el, win.document.documentElement.clientWidth));
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    win.requestAnimationFrame(run);
  };
  new MutationObserver(schedule).observe(win.document.body, { childList: true, subtree: true });
  win.addEventListener('resize', schedule);
}
