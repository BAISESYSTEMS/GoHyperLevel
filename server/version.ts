import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Product name and version from package.json (source tree, dist-server/ build or the Docker image). */
function readPackage(): { name: string; version: string } {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const dir of [join(here, '..'), join(here, '../..'), process.cwd()]) {
    const file = join(dir, 'package.json');
    if (!existsSync(file)) continue;
    try {
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      if (pkg?.version) return { name: String(pkg.name ?? 'gohigh'), version: String(pkg.version) };
    } catch {
      /* try the next candidate */
    }
  }
  return { name: 'gohigh', version: '0.0.0' };
}

const pkg = readPackage();

export const APP_NAME = 'HyperLevel';
export const APP_PACKAGE = pkg.name;
export const APP_VERSION = pkg.version;
