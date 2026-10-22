import type { Plugin } from 'vite';
import { IOS_HEAD_MARKER, iosHead } from '../server/services/pwa-devices.js';

/**
 * Puts the iPhone/iPad/foldable <head> lines (home-screen meta, touch icons, launch images in light and dark for every current
 * screen) into web/index.html where it says `<!--ios-head-->`. The list comes from the same device table the server draws the
 * pictures for (server/services/pwa-devices.ts), so a new device is one line there – docs/ios-web-app.md.
 */
export function iosHeadPlugin(): Plugin {
  return {
    name: 'gohigh-ios-head',
    transformIndexHtml: { order: 'pre', handler: (html) => html.replace(IOS_HEAD_MARKER, iosHead()) },
  };
}
