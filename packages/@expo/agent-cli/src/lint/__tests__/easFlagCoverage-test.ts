// @ref llp/0015-backend-selection-and-config.rfc.md §One flag for EAS
// @ref llp/0002-testing-and-evals.plan.md §A flag is not shipped until it has run against the published binary
// Every command that takes `--eas` has a stub e2e that runs it with `--eas`.
//
// The flag is the same word on every command, and it means the same thing — on EAS — so a command
// that gains it has to prove it across the process boundary the way the others do: a whole
// `@expo/agent-cli` process, a stub `eas` on `PATH` (`e2e/stubs/eas.js`), and the argv the stub
// recorded. A unit test of the resolver pins that the flag parses; only the e2e tier pins what the
// command then asks EAS for. This test is what makes that a rule rather than a habit: the option
// schemas are read out of the source, and the e2e directory is read for an argv that carries both
// the command and the flag.

import fs from 'fs';
import path from 'path';

import { sweepSuggestedCommands } from '../sweep';

// The subject of this suite is the repository itself, so it reads the real one: the suite-wide
// `fs` mock is memfs, which has none of these files in it.
vi.unmock('fs');
vi.unmock('node:fs');

const SRC = path.resolve(__dirname, '../..');
const E2E_TESTS = path.resolve(SRC, '../e2e/__tests__');

/** The `[...]` array literals of one file, as text. Each is a candidate argv. */
function arrayLiterals(source: string): string[] {
  return source.match(/\[[^[\]]*\]/g) ?? [];
}

/**
 * Whether some e2e file spawns `command` with `flag` on the same argv.
 *
 * An argv is written as an array literal of string literals — `['smoke', '--ios', '--eas', …]` —
 * so both words have to sit in one `[...]`. Two words that are merely in the same file would pass a
 * file that tests the command and mentions the flag in a comment.
 */
function e2eRuns(command: string, flag: string, files: Map<string, string>): string[] {
  const hits: string[] = [];
  for (const [file, source] of files) {
    const runs = arrayLiterals(source).some(
      (literal) => literal.includes(`'${command}'`) && literal.includes(`'${flag}'`)
    );
    if (runs) {
      hits.push(file);
    }
  }
  return hits;
}

describe('every command that takes --eas', () => {
  const files = new Map<string, string>();
  let easCommands: string[] = [];

  beforeAll(() => {
    for (const name of fs.readdirSync(E2E_TESTS).sort()) {
      if (name.endsWith('-test.ts')) {
        files.set(name, fs.readFileSync(path.join(E2E_TESTS, name), 'utf8'));
      }
    }
    const { flagSpecs } = sweepSuggestedCommands(SRC);
    easCommands = [
      ...new Set(
        [...flagSpecs.values()]
          .filter((spec) => spec.flags.includes('--eas'))
          // `dev:run` is the registry's name for the action bare `dev` resolves to
          // (`src/dev/index.ts`); nobody types it, and its e2e is `dev`'s.
          .map((spec) => (spec.command === 'dev:run' ? 'dev' : spec.command))
      ),
    ].sort();
  });

  it(`is the set this test knows about — a new one has to be added on purpose`, () => {
    // Pinned so that a command gaining the flag is a visible diff here, next to the rule that it
    // needs an e2e, rather than a silent pass of the loop below.
    expect(easCommands).toEqual(['dev', 'navigate', 'runtime:reload', 'runtime:stop', 'smoke']);
  });

  it(`is run with --eas by a stub e2e, as a whole process against the stub eas`, () => {
    const uncovered = easCommands.filter((command) => e2eRuns(command, '--eas', files).length === 0);
    expect(uncovered).toEqual([]);
  });
});
