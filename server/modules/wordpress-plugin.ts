import type { App, Module } from '../core/app.js';
import { zipStore } from '../services/zip-store.js';
import { getBranding } from './agency.js';
import type { Tool } from './mcp.js';

/**
 * WordPress-Plugin – docs/forms.md#wordpress-plugin. A small plugin, generated per sub-account with its address baked in: shortcodes
 * `[hyperlevel_form id="…"]` and `[hyperlevel_calendar slug="…"]` (auto-height iframes of the public form and booking pages) and,
 * switched on under Einstellungen → HyperLevel in WordPress, the live-chat bubble and the attribution snippet on every page.
 * Nothing is sent from WordPress to HyperLevel except what the visitor's browser loads from the public pages.
 */

const phpString = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function pluginPhp(o: { base: string; locationId: string; brand: string; version: string }): string {
  const brand = o.brand.replace(/[^\p{L}\p{N} .&-]/gu, '').slice(0, 40) || 'HyperLevel';
  return `<?php
/*
Plugin Name: ${brand}
Description: Formulare, Terminbuchung und Live-Chat von ${brand} in WordPress einbinden – per Shortcode und Einstellung.
Version: ${o.version}
Requires at least: 5.8
Requires PHP: 7.4
License: GPLv2 or later
*/
if (!defined('ABSPATH')) { exit; }

define('HYPERLEVEL_BASE', ${phpString(o.base)});
define('HYPERLEVEL_LOCATION', ${phpString(o.locationId)});

function hyperlevel_frame($src, $id, $min) {
  $id = 'hl-' . preg_replace('/[^A-Za-z0-9_-]/', '', $id);
  return '<iframe src="' . esc_url($src) . '" id="' . esc_attr($id) . '" style="width:100%;border:0;min-height:' . intval($min) . 'px" loading="lazy" title="' . esc_attr(get_bloginfo('name')) . '"></iframe>'
    . '<script>addEventListener("message",function(e){if(e.origin===' . wp_json_encode(HYPERLEVEL_BASE) . '&&e.data&&e.data.pghlHeight){var f=document.getElementById(' . wp_json_encode($id) . ');if(f)f.style.height=e.data.pghlHeight+"px"}});</script>';
}

/** [hyperlevel_form id="FORM-ID"] */
function hyperlevel_form_shortcode($atts) {
  $a = shortcode_atts(array('id' => ''), $atts);
  $id = preg_replace('/[^A-Za-z0-9_-]/', '', $a['id']);
  if ($id === '') { return ''; }
  return hyperlevel_frame(HYPERLEVEL_BASE . '/f/' . rawurlencode($id) . '?embed=1', $id, 520);
}
add_shortcode('hyperlevel_form', 'hyperlevel_form_shortcode');

/** [hyperlevel_calendar slug="kalender-pfad"] */
function hyperlevel_calendar_shortcode($atts) {
  $a = shortcode_atts(array('slug' => ''), $atts);
  $slug = preg_replace('/[^A-Za-z0-9_-]/', '', $a['slug']);
  if ($slug === '') { return ''; }
  return hyperlevel_frame(HYPERLEVEL_BASE . '/book/' . rawurlencode($slug) . '?embed=1', $slug, 680);
}
add_shortcode('hyperlevel_calendar', 'hyperlevel_calendar_shortcode');

/** Live chat and attribution on every page – off until switched on in the settings. */
function hyperlevel_footer() {
  if (get_option('hyperlevel_chat') === '1') {
    echo '<script src="' . esc_url(HYPERLEVEL_BASE . '/chat/' . rawurlencode(HYPERLEVEL_LOCATION) . '/widget.js') . '" async></script>';
  }
  if (get_option('hyperlevel_tracking') === '1') {
    echo '<script src="' . esc_url(HYPERLEVEL_BASE . '/a/' . rawurlencode(HYPERLEVEL_LOCATION) . '/t.js') . '" async></script>';
  }
}
add_action('wp_footer', 'hyperlevel_footer');

function hyperlevel_settings_page() {
  if (!current_user_can('manage_options')) { return; }
  if (isset($_POST['hyperlevel_save']) && check_admin_referer('hyperlevel_settings')) {
    update_option('hyperlevel_chat', isset($_POST['hyperlevel_chat']) ? '1' : '0');
    update_option('hyperlevel_tracking', isset($_POST['hyperlevel_tracking']) ? '1' : '0');
    echo '<div class="updated"><p>Gespeichert.</p></div>';
  }
  echo '<div class="wrap"><h1>' . esc_html(${phpString(brand)}) . '</h1><form method="post">';
  wp_nonce_field('hyperlevel_settings');
  echo '<p><label><input type="checkbox" name="hyperlevel_chat" ' . checked(get_option('hyperlevel_chat'), '1', false) . '> Live-Chat-Blase auf allen Seiten</label></p>';
  echo '<p><label><input type="checkbox" name="hyperlevel_tracking" ' . checked(get_option('hyperlevel_tracking'), '1', false) . '> Besucher-Quellen erfassen (Attribution – nur mit Einwilligung im Cookie-Banner)</label></p>';
  echo '<p>Shortcodes: <code>[hyperlevel_form id="…"]</code>, <code>[hyperlevel_calendar slug="…"]</code></p>';
  echo '<p><button class="button button-primary" name="hyperlevel_save" value="1">Speichern</button></p></form></div>';
}
function hyperlevel_menu() {
  add_options_page(${phpString(brand)}, ${phpString(brand)}, 'manage_options', 'hyperlevel', 'hyperlevel_settings_page');
}
add_action('admin_menu', 'hyperlevel_menu');
`;
}

export const wordpressPluginModule: Module = {
  name: 'wordpress-plugin',
  register(app: App) {
    const { db, router } = app;
    const brandOf = () => getBranding(app).name || 'HyperLevel';

    router.get('/api/wordpress-plugin', 'location', (ctx) => ({
      download_url: `/api/wordpress-plugin.zip?locationId=${encodeURIComponent(ctx.locationId)}`,
      forms: db.all<any>('SELECT id, name FROM forms WHERE location_id = ? ORDER BY name LIMIT 50', ctx.locationId).map((f) => ({ name: f.name, shortcode: `[hyperlevel_form id="${f.id}"]` })),
      calendars: db.all<any>('SELECT name, slug FROM calendars WHERE location_id = ? AND active = 1 ORDER BY name LIMIT 50', ctx.locationId).map((c) => ({ name: c.name, shortcode: `[hyperlevel_calendar slug="${c.slug}"]` })),
    }));
    router.get('/api/wordpress-plugin.zip', 'location', (ctx) => {
      const php = pluginPhp({ base: app.baseUrl(), locationId: ctx.locationId, brand: brandOf() || 'HyperLevel', version: '1.0.0' });
      const readme = `=== HyperLevel ===\nStable tag: 1.0.0\n\nFormulare: [hyperlevel_form id="…"]\nTermine: [hyperlevel_calendar slug="…"]\nLive-Chat und Attribution: Einstellungen → HyperLevel.\n`;
      const zip = zipStore([
        { name: 'hyperlevel/hyperlevel.php', data: php },
        { name: 'hyperlevel/readme.txt', data: readme },
      ]);
      return { __raw: true, status: 200, headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="hyperlevel-wordpress.zip"', 'cache-control': 'no-store' }, body: zip };
    });

    const TOOLS: Tool[] = [
      {
        name: 'ghl_wordpress_shortcodes',
        title: 'WordPress-Plugin: Shortcodes',
        description: 'Liefert den Download-Pfad des WordPress-Plugins dieses Sub-Accounts und die fertigen Shortcodes für alle Formulare ([hyperlevel_form id="…"]) und Buchungskalender ([hyperlevel_calendar slug="…"]).',
        inputSchema: { type: 'object', properties: { location_id: { type: 'string' } }, required: ['location_id'], additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
        run: (call, a) => call.api('GET', '/api/wordpress-plugin', { location: a.location_id }),
      },
    ];
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};
