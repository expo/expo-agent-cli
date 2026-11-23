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
  exitWithCodeAsync,
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

  // @ref llp/0010-agent-conventions.rfc.md §Exit codes — a tool error is a throw, so `logCmdError`
  // prints the `--json` envelope and flushes the events. `exitWithCodeAsync` takes only an outcome,
  // and this table keeps the other ways out of the process in the files that need them.
  it.each([
    { exit: 'process.exitCode =', pattern: /process\.exitCode\s*=(?!=)/, files: ['exitCodes.ts'] },
    {
      exit: 'exitWithAnyCodeAsync',
      pattern: /\bexitWithAnyCodeAsync\(/,
      // `logCmdError`, and the commands that pass on the exit code of the CLI they ran.
      files: [
        'exitCodes.ts',
        'install/index.ts',
        'new/index.ts',
        'passthrough/auth.ts',
        'passthrough/index.ts',
        'start/index.ts',
        'utils/errors.ts',
      ],
    },
    {
      // A command that calls it and goes on settles, and `cli.ts` then exits 0 over its code.
      exit: 'logCmdError(',
      pattern: /(?<!\.catch\()\blogCmdError\(/,
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

  // A command that returned a code would exit 0: `cli.ts` exits 0 when a command settles. So the
  // type refuses the return value, and the code goes through an exit call or a throw.
  it('refuses a command that returns an exit code', () => {
    // @ts-expect-error — a returned code would never be read.
    const command: Command = async () => EXIT_OUTCOME_FAILED;
    expect(command).toBeTypeOf('function');
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

describe(exitWithCodeAsync, () => {
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

  it('flushes the event stream before leaving the event loop with the requested code', async () => {
    let flushed = false;
    vi.mocked(flushEventLogger).mockImplementation(async () => {
      flushed = true;
    });

    exitWithCodeAsync(EXIT_OUTCOME_FAILED);
    await waitForExitAsync();

    expect(flushed).toBe(true);
    expect(process.exitCode).toBe(20);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // A flush that fails must not turn an outcome into a hung process: the code still leaves.
  it('exits even when the flush fails', async () => {
    vi.mocked(flushEventLogger).mockRejectedValue(new Error('no writer'));

    exitWithCodeAsync(EXIT_OUTCOME_TIMEOUT);
    await waitForExitAsync();

    expect(process.exitCode).toBe(22);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('never settles, so a caller has nothing left to run', async () => {
    vi.mocked(flushEventLogger).mockResolvedValue(undefined as never);
    const settled = vi.fn();

    exitWithCodeAsync(EXIT_OK).then(settled, settled);
    await waitForExitAsync();

    expect(settled).not.toHaveBeenCalled();
  });
});

/** Let the async flush and its cleanup finish. */
async function waitForExitAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
