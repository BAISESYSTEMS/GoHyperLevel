import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { iosHeadPlugin } from './scripts/vite-ios-head';

type ModuleInfo = { importedIds: readonly string[] } | null;
const ENTRY = fileURLToPath(new URL('./web/src/main.tsx', import.meta.url)).replace(/\\/g, '/');

/** Everything the entry imports statically: the first download (shell, login, dashboard). One per build. */
const graphs = new WeakMap<object, Set<string>>();
function staticGraph(getModuleInfo: (id: string) => ModuleInfo): Set<string> {
  const known = graphs.get(getModuleInfo);
  if (known) return known;
  const seen = new Set<string>();
  const stack = [ENTRY];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of getModuleInfo(id)?.importedIds ?? []) stack.push(dep.replace(/\\/g, '/'));
  }
  graphs.set(getModuleInfo, seen);
  return seen;
}

/**
 * Vendor and editor chunks: they change less often than the app code (long-term cached across deploys)
 * and keep heavy editors out of the pages that merely link to them. Pages themselves are split by
 * route (web/src/lazy.tsx); the funnel builder is the funnels page's own chunk. The shell's modules are
 * named "app" explicitly – otherwise Rollup would pull shared ones (ui, api) into an editor chunk and the
 * first download would need it. Budget: tests/bundle-budget.test.ts, docs/performance.md.
 */
function manualChunks(id: string, { getModuleInfo }: { getModuleInfo: (id: string) => ModuleInfo }): string | undefined {
  const p = id.replace(/\\/g, '/');
  if (p.includes('/node_modules/')) {
    if (/\/node_modules\/(react|react-dom|scheduler)\//.test(p)) return 'react';
    if (p.includes('/node_modules/lucide-react/')) return 'icons';
    if (p.includes('/node_modules/@twilio/')) return 'twilio';
    return undefined;
  }
  if (p.endsWith('/web/src/icons.tsx')) return 'icons';
  if (p.includes('/web/src/pages/EmailBuilder.tsx') || p.includes('/server/services/email-render.ts') || p.includes('/server/services/email-starters.ts')) return 'email-builder';
  if (p.includes('/web/src/charts/')) return 'charts';
  // Workflow builder tools both editors share (list page and the lazy canvas): their own chunk, so the canvas never imports the page's chunk.
  if (/\/web\/src\/workflow-canvas\/(?!WorkflowCanvas|canvas\.css)|\/web\/src\/pages\/WorkflowTools\.tsx|\/server\/services\/workflow-(validate|layout)\.ts/.test(p)) return 'workflow-builder';
  if (p !== ENTRY && !p.startsWith('\0') && staticGraph(getModuleInfo).has(p)) return 'app';
  return undefined;
}

export default defineConfig({
  root: 'web',
  plugins: [react(), iosHeadPlugin()],
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
    // The oldest browsers the app promises to run on – the Android app's WebView minimum (MIN_WEBVIEW_MAJOR in
    // android/…/WebHealth.kt) is the same Chrome number. Nothing in the code needs more, so the output is the same
    // as with Vite's default (Chrome 107); a newer syntax feature in the source gets lowered instead of silently
    // leaving older WebViews with a blank page.
    target: ['chrome92', 'edge92', 'firefox90', 'safari15'],
    rollupOptions: { output: { manualChunks } },
  },
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      ['/api', '/book', '/f', '/p', '/i', '/r', '/hooks', '/assets-public'].map((p) => [p, 'http://localhost:4700']),
    ),
  },
});
