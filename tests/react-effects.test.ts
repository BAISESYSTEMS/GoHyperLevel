import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');

/**
 * React calls whatever an effect returns as its cleanup. A one-line effect that returns a value – `data && setX(…)` (null or
 * false), or a scroll call (current Chrome returns a Promise from scrollTo/scrollIntoView) – crashes the page when it unmounts
 * ("destroy is not a function", the app's start-error screen). Such effects need a block body.
 */
describe('React effects', () => {
  it('one-line effects never return a value React would call as cleanup', () => {
    const files = execFileSync('git', ['ls-files', 'web/src'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((f) => /\.tsx?$/.test(f));
    const bad: string[] = [];
    for (const f of files) {
      readFileSync(join(ROOT, f), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const body = line.match(/use(?:Layout)?Effect\(\(\) => (?!\{|void\b)(.*)$/)?.[1];
          if (body && /\b(?:scrollTo|scrollBy|scrollIntoView|scroll)\b\s*(?:\?\.)?\(|^[\w.?]+ &&/.test(body)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(bad).toEqual([]);
  });
});
