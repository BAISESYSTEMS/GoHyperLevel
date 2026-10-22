#!/usr/bin/env node
/**
 * Minifies the browser side of the public forms (server/assets/forms/*.js and *.css, assembled by server/services/form-runtime.ts) and
 * writes it where the compiled server finds it: dist-server/server/assets/forms/runtime.json (every part, minified) next to a copy of the
 * source files. Runs as the last step of `npm run build`, after tsc; esbuild is a dev dependency – the production image only reads the
 * result (`npm prune --omit=dev` comes after the build).
 *
 *   node scripts/build-form-runtime.mjs [dist-server]
 */
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transform } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(process.argv[2] ?? join(root, 'dist-server'));
const from = join(root, 'server/assets/forms');
const to = join(dist, 'server/assets/forms');
const started = Date.now();

mkdirSync(to, { recursive: true });
for (const f of readdirSync(from)) if (/\.(js|css)$/.test(f)) copyFileSync(join(from, f), join(to, f));

// The compiled module reads the sources from its own assets folder (the copy above).
const rt = await import(pathToFileURL(join(dist, 'server/services/form-runtime.js')).href).catch((e) => {
  console.error(`build-form-runtime: ${join(dist, 'server/services/form-runtime.js')} not found – run tsc first (${e.message})`);
  process.exit(1);
});

const out = { js: {}, css: {} };
for (const part of rt.JS_PARTS) {
  out.js[part] = (await transform(rt.jsSource(part), { loader: 'js', minify: true, target: 'es2017', charset: 'utf8', legalComments: 'none' })).code.trim();
}
for (const part of rt.CSS_PARTS) {
  out.css[part] = (await transform(rt.cssSource(part), { loader: 'css', minify: true, charset: 'utf8', legalComments: 'none' })).code.trim();
}

// Whatever ends up in a <script> or <style> of a page has to survive being there.
const problems = [];
for (const [part, code] of Object.entries(out.js)) {
  if (/<\/script|<!--/i.test(code)) problems.push(`js ${part}: contains </script or <!--`);
  try {
    new Function(code);
  } catch (e) {
    problems.push(`js ${part}: ${e.message}`);
  }
}
try {
  new Function(Object.values(out.js).join(';'));
} catch (e) {
  problems.push(`js (all parts together): ${e.message}`);
}
for (const [part, css] of Object.entries(out.css)) {
  if (/<\/style|\/\*|\n\s*\n|;\s*}/i.test(css)) problems.push(`css ${part}: contains </style, a comment, a blank line or ";}"`);
}
if (problems.length) {
  console.error(`build-form-runtime: ${problems.join('\n  ')}`);
  process.exit(1);
}

writeFileSync(join(to, 'runtime.json'), JSON.stringify(out));
const size = (o) => Object.values(o).reduce((n, s) => n + s.length, 0);
console.log(`build-form-runtime: ${rt.JS_PARTS.length} scripts (${size(out.js)} B) and ${rt.CSS_PARTS.length} stylesheets (${size(out.css)} B) → ${join('dist-server/server/assets/forms', 'runtime.json')} (${Date.now() - started} ms)`);
