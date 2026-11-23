import { flushEventLogger } from '2g';
import fs from 'fs';
import path from 'path';

import {
  EXIT_ERROR,
  EXIT_NEEDS_HUMAN,
  EXIT_OK,
  EXIT_OUTCOME_CANCELED,
  EXIT_OUTCOME_FAILED,
  EXIT_OUTCOME_TIMEOUT,
  exitAsync,
} from '../exitCodes';
import type { Command } from '../types';
import type { MockInstance } from 'vitest';

vi.mock('2g', () => ({ flushEventLogger: vi.fn(async () => {}) }));

// The sweep below reads this repository rather than a fixture, and the suite-wide `fs` mock is
// memfs, which has none of these files in it.
vi.unmock('fs');
vi.unmock('node:fs');

/**
 * Every `.ts` file of the CLI that a command can reach, relative to `src`.
 *
 * The tests are out because a test naming a constant is not a command emitting it.
 *
 * Walked here rather than through `src/lint/sweep.ts`, which pulls the event logger in with it and
 * would need this suite's `2g` double to be the whole module.
 */
function sourceFilesUnder(root: string, prefix = ''): string[] {
  const skipped = new Set(['__tests__', '__mocks__', 'node_modules', 'build']);
  return fs
    .readdirSync(path.join(root, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) {
        return skipped.has(entry.name) ? [] : sourceFilesUnder(root, relative);
      }
      return entry.name.endsWith('.ts') ? [relative] : [];
    })
    .sort();
}

describe('exit codes', () => {
  // The numbers are the contract a driving agent reads before it reads any output, so they are
  // pinned here rather than only where they are used (llp/0010).
  it('are the numbers of the convention', () => {
    expect(EXIT_OK).toBe(0);
    expect(EXIT_ERROR).toBe(1);
    expect(EXIT_NEEDS_HUMAN).toBe(7);
    expect(EXIT_OUTCOME_FAILED).toBe(20);
    expect(EXIT_OUTCOME_CANCELED).toBe(21);
    expect(EXIT_OUTCOME_TIMEOUT).toBe(22);
  });

  it('keeps the outcome band inside the 20-29 reservation', () => {
    for (const code of [EXIT_OUTCOME_FAILED, EXIT_OUTCOME_CANCELED, EXIT_OUTCOME_TIMEOUT]) {
      expect(code).toBeGreaterThanOrEqual(20);
      expect(code).toBeLessThanOrEqual(29);
    }
  });

  // @ref llp/0010-agent-conventions.rfc.md §Exit codes — `21` is reserved and unemitted
  // The doc comment on the constant, and the row of the table, both claim that no v1 command exits
  // 21. This is what makes the claim checkable: a command that starts emitting it fails here, and
  // whoever adds it updates the documentation in the same change.
  it('emits 21 from nowhere, which is what its documentation says', () => {
    const root = path.resolve(__dirname, '..');
    const files = sourceFilesUnder(root);
    // A floor, so a walk that stopped finding anything cannot report "nothing emits it".
    expect(files.length).toBeGreaterThan(150);

    const users = files.filter(
      (file) =>
        file !== 'exitCodes.ts' &&
        fs.readFileSync(path.join(root, file), 'utf8').includes('EXIT_OUTCOME_CANCELED')
    );

    expect(users).toEqual([]);
  });

  // @ref llp/0010-agent-conventions.rfc.md §Exit codes — a command returns its outcome or throws,
  // and only `cli.ts` exits. The type refuses a bad return value; this table keeps the exits the
  // type cannot see in the files that need them.
  it.each([
    { exit: 'process.exitCode =', pattern: /process\.exitCode\s*=(?!=)/, files: ['exitCodes.ts'] },
    { exit: 'exitAsync(', pattern: /\bexitAsync\(/, files: ['cli.ts', 'exitCodes.ts'] },
    {
      // The one way an arbitrary child code becomes a command's result.
      exit: 'forwardedExit(',
      pattern: /\bforwardedExit\(/,
      files: [
        'exitCodes.ts',
        'install/index.ts',
        'new/index.ts',
        'passthrough/auth.ts',
        'passthrough/index.ts',
        'start/index.ts',
      ],
    },
    {
      // A command that reports an error itself and returns a code would print the error and exit
      // with that code instead; the type cannot tell. Only dispatch reports.
      exit: 'reportCmdError(',
      pattern: /\breportCmdError\(/,
      files: ['cli.ts', 'utils/errors.ts'],
    },
    {
      exit: 'process.exit(',
      pattern: /process\.exit\(/,
      // Help (exit 0), the crash handler, a signal relay, and scripts this CLI writes for a child.
      files: [
        'cli.ts',
        'dev/runSteps.ts',
        'device/cloudCommand.ts',
        'help/index.ts',
        'log.ts',
        'telemetry/worker.ts',
        'utils/errors.ts',
      ],
    },
  ])('leaves through $exit only in the files that need it', ({ pattern, files }) => {
    const root = path.resolve(__dirname, '..');
    const users = sourceFilesUnder(root).filter((file) =>
      pattern.test(fs.readFileSync(path.join(root, file), 'utf8'))
    );

    expect(users).toEqual(files.map((file) => path.normalize(file)));
  });

  // `cli.ts` exits with what a command returns, so the type is the guard on that value.
  it('accepts an outcome and refuses any other command result', async () => {
    const outcome = async (): Promise<typeof EXIT_OUTCOME_FAILED> => EXIT_OUTCOME_FAILED;
    const commands: Command[] = [
      async () => EXIT_OUTCOME_FAILED,
      // @ts-expect-error — `1` is a tool error, which is a throw.
      async () => 1,
      // @ts-expect-error — a child's code passes only through `forwardedExit`.
      async () => 3 as number,
      // @ts-expect-error — a body that awaits an outcome and falls off the end would exit 0.
      async () => {
        await outcome();
      },
    ];
    expect(commands).toHaveLength(4);
  });

  it('names every code once', () => {
    const codes = [
      EXIT_OK,
      EXIT_ERROR,
      EXIT_NEEDS_HUMAN,
      EXIT_OUTCOME_FAILED,
      EXIT_OUTCOME_CANCELED,
      EXIT_OUTCOME_TIMEOUT,
    ];
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe(exitAsync, () => {
  let originalExitCode: typeof process.exitCode;
  let exitSpy: MockInstance;

  beforeEach(() => {
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    exitSpy.mockRestore();
  });

  it('flushes the event stream and leaves the event loop with the requested code', async () => {
    let flushed = false;
    vi.mocked(flushEventLogger).mockImplementation(async () => {
      flushed = true;
    });

    await exitAsync(EXIT_OUTCOME_FAILED);

    expect(flushed).toBe(true);
    expect(process.exitCode).toBe(20);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // A flush that fails must not turn an outcome into a hung process: the code still leaves.
  it('settles with the code even when the flush fails', async () => {
    vi.mocked(flushEventLogger).mockRejectedValue(new Error('no writer'));

    await exitAsync(EXIT_OUTCOME_TIMEOUT);

    expect(process.exitCode).toBe(22);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
