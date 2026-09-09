// @ref llp/0015-backend-selection-and-config.rfc.md §Resolving the EAS CLI
// No printed line says `npx --yes eas-cli@latest …`. There is no package called `eas`, so that line runs nothing;
// what a reader runs is the runner and spec this CLI itself spawns, written by `easCommandPrefix()`
// [Kudo, 2026-09-09 — seventy-one lines said it before this rule].

import fs from 'fs';
import path from 'path';

import { sourceFilesUnder } from '../sweep';

// The subject of this suite is the repository itself, so it reads the real one: the suite-wide
// `fs` mock is memfs, which has none of these files in it.
vi.unmock('fs');
vi.unmock('node:fs');

const SRC = path.resolve(__dirname, '../..');

/** The source with comments removed, so a sentence *about* the old spelling is not a hit. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the spelling of an EAS CLI command line', () => {
  it(`is never the bare "npx eas", which runs nothing`, () => {
    const hits: string[] = [];
    for (const file of sourceFilesUnder(SRC)) {
      const source = withoutComments(fs.readFileSync(path.join(SRC, file), 'utf8'));
      source.split('\n').forEach((line, index) => {
        if (/npx eas[ '"`]/.test(line)) {
          hits.push(`src/${file}:${index + 1}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it(`is the runner this project spawns, written by easCommandPrefix`, async () => {
    const { easCommandPrefix } = await import('../../utils/easCli');
    // Under the unit-test environment the invoker is npx and nothing pins the CLI.
    expect(easCommandPrefix('/nowhere')).toBe('npx --yes eas-cli@latest');
  });
});
