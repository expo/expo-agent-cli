// @ref llp/0015-backend-selection-and-config.rfc.md §Who may spend EAS credits
// Only the known sites build an argv that starts a billed EAS action.
//
// A build and a session cost credits from the moment they start, and only a person's choice may
// start one. The sites that do are guarded by that rule, so a new site has to be added here on purpose.

import fs from 'fs';
import path from 'path';

// The subject of this suite is the repository itself, so it reads the real one: the suite-wide
// `fs` mock is memfs, which has none of these files in it.
vi.unmock('fs');
vi.unmock('node:fs');

const SRC = path.resolve(__dirname, '../..');

/**
 * An argv array that starts with a billed verb, with or without `'eas'` in front of it.
 * The comma after the verb is what tells an argv from a type index such as `Report['build']`.
 */
const BILLED_ARGV =
  /\[\s*(?:'eas'\s*,\s*)?'(build|build:dev|simulator|simulator:start|workflow:run)'\s*,/g;

const KNOWN_SITES = ['dev/openAppEas.ts: simulator', 'plan/decide.ts: build'];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' || entry.name === '__fixtures__' ? [] : sourceFiles(full);
    }
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

function billedSites(): string[] {
  const sites = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    // Line comments may sit between `[` and the verb, as they do in `openAppEas.ts`.
    const source = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    for (const match of source.matchAll(BILLED_ARGV)) {
      sites.add(`${path.relative(SRC, file).split(path.sep).join('/')}: ${match[1]}`);
    }
  }
  return [...sites].sort();
}

describe('Spawning a billed EAS action', () => {
  it('should happen only at the known sites', () => {
    expect(billedSites()).toEqual(KNOWN_SITES);
  });

  it('should find an argv with eas in front of the verb', () => {
    expect(`['eas', 'build', '--platform', p]`.match(BILLED_ARGV)).toHaveLength(1);
  });

  it('should not find a type index that names the same word', () => {
    expect(`Report['build']`.match(BILLED_ARGV)).toBeNull();
  });
});
