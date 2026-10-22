/* Paints the saved look before the app starts, so there is no flash of the wrong theme.
 * Reads the cache that web/src/theme/store.ts writes ("pghl.look": preferences + the generated CSS of both
 * modes). A plain blocking script because the admin app's Content-Security-Policy allows no inline scripts. */
(function () {
  try {
    var r = document.documentElement;
    var raw = localStorage.getItem('pghl.look');
    var o = raw ? JSON.parse(raw) : null;
    var p = o && o.p;
    var legacy = localStorage.getItem('pghl.theme');
    var mode = p ? p.mode : legacy === 'dark' || legacy === 'light' ? legacy : 'system';
    var dark = mode === 'dark' || (mode !== 'light' && !!window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    if (!p) {
      if (mode !== 'system') r.setAttribute('data-theme', mode);
      return;
    }
    r.setAttribute('data-theme', dark ? 'dark' : 'light');
    r.setAttribute('data-theme-id', p.theme);
    r.setAttribute('data-dept-mode', p.dept);
    r.setAttribute('data-dept-tint', p.dept_tint ? '1' : '0');
    r.setAttribute('data-sidebar', p.sidebar);
    // Raum-Modus (xr/detect.ts decided when the look was cached): roomier density, the glass tokens are in the cached CSS.
    r.setAttribute('data-spatial', o.spatial ? '1' : '0');
    r.setAttribute('data-density', o.spatial ? 'comfortable' : p.density);
    r.setAttribute('data-font', p.font);
    r.setAttribute('data-icons', p.icons);
    var css = o.css && (dark ? o.css.dark : o.css.light);
    if (css) {
      var s = document.createElement('style');
      s.id = 'pghl-theme';
      s.textContent = css;
      document.head.appendChild(s);
    }
    var side = o.side && (dark ? o.side.dark : o.side.light);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (side && meta) meta.setAttribute('content', side);
  } catch (e) {
    /* storage blocked or damaged cache: the app applies the look once it is up */
  }
})();
