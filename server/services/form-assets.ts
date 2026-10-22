import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The browser side of the public forms lives in real files (server/assets/forms/*.js and *.css) and is minified when the server is built:
 * `npm run build` writes server/assets/forms/runtime.json into dist-server (scripts/build-form-runtime.mjs, esbuild). In production only that
 * file is read – production images have no dev dependencies. From the source tree (npm run dev, tests) the files are minified on first use
 * with esbuild when it is installed, otherwise comments and indentation are stripped (valid, a little bigger).
 */

/** server/assets/forms in the source tree, dist-server/server/assets/forms in a build (the sources are copied there as well). */
export const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'forms');

export const readAsset = (name: string): string => readFileSync(join(ASSET_DIR, name), 'utf8');

export interface BuiltRuntime {
  js: Record<string, string>;
  css: Record<string, string>;
}

let built: BuiltRuntime | null | undefined;
/** The minified parts written by the build, or null when there is no build output (source tree). */
export function builtRuntime(): BuiltRuntime | null {
  if (built === undefined) {
    const file = join(ASSET_DIR, 'runtime.json');
    try {
      built = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as BuiltRuntime) : null;
    } catch {
      built = null;
    }
  }
  return built;
}

type Esbuild = { transformSync(input: string, options: Record<string, unknown>): { code: string } };
let esbuild: Esbuild | null | undefined;
function loadEsbuild(): Esbuild | null {
  if (esbuild === undefined) {
    try {
      esbuild = createRequire(import.meta.url)('esbuild') as Esbuild;
    } catch {
      esbuild = null;
    }
  }
  return esbuild;
}

/** Comments, indentation and blank lines out; the line breaks stay, so the script cannot change meaning (no esbuild available). */
export function stripJs(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .join('\n');
}

/** Comments and whitespace out of a stylesheet of our own (no esbuild available). */
export function stripCss(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/ ?([{};,>]) ?/g, '$1')
    .replace(/([{;]) ?([\w-]+) ?: ?/g, '$1$2:')
    .replace(/;}/g, '}')
    .trim();
}

export function minifyJs(src: string): string {
  const e = loadEsbuild();
  return e ? e.transformSync(src, { loader: 'js', minify: true, target: 'es2017', charset: 'utf8', legalComments: 'none' }).code.trim() : stripJs(src);
}

export function minifyCss(src: string): string {
  const e = loadEsbuild();
  return e ? e.transformSync(src, { loader: 'css', minify: true, charset: 'utf8', legalComments: 'none' }).code.trim() : stripCss(src);
}
