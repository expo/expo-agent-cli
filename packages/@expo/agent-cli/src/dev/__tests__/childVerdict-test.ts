import { stripVTControlCharacters } from 'util';

import { needsHumanError } from '../../needsHuman/error';
import { formatStartPlan } from '../../plan/format';
import type { StartPlan } from '../../project/types';
import { noBoundDeviceError } from '../../deviceBinding/errors';
import * as Log from '../../log';
import {
  formatErrorCodeRow,
  formatNeedsHumanBlock,
  logCmdError,
  type CommandError,
} from '../../utils/errors';
import {
  detachedPidLine,
  childOpensPlatform,
  parseDetachedChildPid,
  parseDetachedChildPort,
  parseDetachedChildVerdict,
} from '../childVerdict';

vi.mock('../../log');
vi.mock('../../events', () => ({ event: vi.fn() }));
vi.mock('../../exitCodes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../exitCodes')>()),
  exitWithCodeAsync: vi.fn(() => new Promise<never>(() => {})),
}));

/**
 * The log a detached child writes for a failure, produced by `logCmdError` itself under
 * `__EXPO_AGENT_CLI_DETACHED=1` and captured off the log module, line by line.
 */
function childLogOf(error: CommandError): string[] {
  vi.mocked(Log.exception).mockClear();
  vi.mocked(Log.warn).mockClear();
  process.env.__EXPO_AGENT_CLI_DETACHED = '1';
  try {
    void logCmdError(error);
  } finally {
    delete process.env.__EXPO_AGENT_CLI_DETACHED;
  }
  return [
    ...vi.mocked(Log.exception).mock.calls.map(([printed]) => String(printed)),
    ...vi.mocked(Log.warn).mock.calls.map((args) => args.join(' ')),
  ];
}

/**
 * The log a child writes when it fails, built out of the functions that write it.
 *
 * This is the round trip the parser depends on: `Log.exception` prints `Error.toString()` and
 * `logCmdError` prints the handoff block under it, so a log is assembled here from those two rather
 * than from a string somebody typed. The pair drifts, this test fails.
 */
function childLog(error: Error, needsHuman: ReturnType<typeof formatNeedsHumanBlock> | null) {
  return [
    'Starting project at /project',
    'Waiting on http://127.0.0.1:8081',
    error.toString(),
    ...(needsHuman ?? []),
  ];
}

describe(parseDetachedChildVerdict, () => {
  it(`should read the scenario the child named`, () => {
    const error = needsHumanError('macos-automation', {
      message:
        'The plan stopped at "start": macOS refused "npx expo start --go --ios" permission to control Simulator.app.\nWhy: automation permission is granted per app.\nHow: grant it in System Settings.',
      detectedBy: 'exit-signature',
    });

    const verdict = parseDetachedChildVerdict(
      childLog(error, formatNeedsHumanBlock(error.needsHuman))
    );

    expect(verdict?.scenario).toBe('macos-automation');
    expect(verdict?.message).toContain('macOS refused');
    // The block is re-rendered by the parent from the registry, so quoting the child's copy would
    // print the same three lines twice.
    expect(verdict?.message).not.toContain('Needs a human');
  });

  it(`should read a failure that is not a needs-human one`, () => {
    const verdict = parseDetachedChildVerdict([
      'Starting project at /project',
      'CommandError: The plan stopped at "start".',
      'Why: the bundler could not start.',
    ]);

    expect(verdict).toEqual({
      scenario: null,
      message: 'CommandError: The plan stopped at "start".\nWhy: the bundler could not start.',
      code: null,
      exitCode: null,
      data: null,
      suggestedCommand: null,
    });
  });

  // @ref llp/0035-one-device-per-worktree.rfc.md §Output and errors — the row `logCmdError`
  // writes for a detached child alone, read back with the `Try:` line, so a device refusal
  // reaches the parent's caller as the child raised it.
  it(`should read the code, the exit, the data and the Try line of a device refusal`, () => {
    const refusal = noBoundDeviceError('none', { platform: 'ios' });
    const verdict = parseDetachedChildVerdict(childLogOf(refusal));

    expect(verdict).toMatchObject({
      scenario: null,
      code: 'NO_BOUND_DEVICE',
      exitCode: 20,
      data: { reason: 'none' },
      suggestedCommand: 'npx @expo/agent-cli dev --ios --detach --wait-ready',
    });
    expect(verdict?.message).toBe(`CommandError: ${refusal.message}`);
  });

  it(`should take only the Try line next to the code row`, () => {
    const verdict = parseDetachedChildVerdict([
      'Try: npx something-earlier',
      'Waiting on http://127.0.0.1:8081',
      'CommandError: No ios device is bound to this worktree.',
      'How: run the dev command.',
      formatErrorCodeRow('NO_BOUND_DEVICE', 20),
    ]);

    expect(verdict).toMatchObject({ code: 'NO_BOUND_DEVICE', suggestedCommand: null });
  });

  it(`should keep the last error, which is the one the child stopped on`, () => {
    const verdict = parseDetachedChildVerdict([
      'CommandError: the first one, recovered from',
      'Waiting on http://127.0.0.1:8081',
      'CommandError: the one it stopped on',
    ]);

    expect(verdict?.message).toBe('CommandError: the one it stopped on');
  });

  it(`should answer null for the log of a healthy run`, () => {
    expect(
      parseDetachedChildVerdict([
        'Starting project at /project',
        'Waiting on http://127.0.0.1:8081',
        ' ERROR  [Error: boom from HomeScreen]',
        'Android Bundled 1200ms',
      ])
    ).toBeNull();
  });

  it(`should answer null for an empty log`, () => {
    expect(parseDetachedChildVerdict([])).toBeNull();
  });
});

// The plan table is a format of this CLI's own (`src/plan/format.ts`), so it round-trips the same
// way the verdict does: the log is built by `formatStartPlan` and read back here.
describe(childOpensPlatform, () => {
  /** The child's log, as `formatStartPlan` writes it, for a plan of the given steps. */
  function planLog(steps: { argv: string[]; reason: string }[], ...after: string[]): string[] {
    const plan: StartPlan = {
      rule: 'bare-stale',
      target: 'bare',
      reasons: ['Expo SDK 57.0.17.'],
      buildLocation: null,
      steps: steps.map((step, index) => ({
        id: `step-${index}`,
        argv: step.argv,
        reason: step.reason,
        timeClass: 'minutes',
        runsOn: null,
      })),
    };
    return [...formatStartPlan(plan).split('\n'), ...after];
  }

  const RUN_ANDROID = { argv: ['expo', 'run:android'], reason: 'Builds and installs the app.' };
  const PREBUILD = { argv: ['expo', 'prebuild', '--platform', 'android'], reason: 'Generates it.' };
  const START = { argv: ['expo', 'start', '--dev-client'], reason: 'Starts the dev server.' };
  const START_IOS = {
    argv: ['expo', 'start', '--go', '--ios', '--port', '9201'],
    reason: 'Serves the project and opens it on a booted iOS simulator.',
  };

  // @ref llp/0021-honest-reports.rfc.md §The rules — F140. The step that opens the app is the step
  // that can kill the dev server after it has answered `/status`. An `expo start` step opens nothing
  // any more: `dev` performs the open itself, from its own process (llp/0026).
  it.each([
    ['a plan that serves from its build step', planLog([PREBUILD, RUN_ANDROID]), true],
    [
      'an install before a start step',
      planLog([{ ...RUN_ANDROID, argv: [...RUN_ANDROID.argv, '--no-bundler'] }, START]),
      false,
    ],
    ['a plan whose only step is the dev server', planLog([START]), false],
    ['a start step with a platform flag', planLog([START_IOS]), false],
    ['a run:ios step', planLog([{ argv: ['expo', 'run:ios'], reason: 'Builds it.' }]), true],
    [
      'a start step with the short platform flag',
      planLog([{ argv: ['expo', 'start', '--go', '-i'], reason: 'Serves it.' }]),
      false,
    ],
    ['a plan that only prebuilds', planLog([PREBUILD]), false],
    ['a log with no plan in it', ['Starting project at /project'], false],
  ] as const)(`reads %s`, (_name, lines, opens) => {
    expect(childOpensPlatform(lines)).toBe(opens);
  });
});

describe('parseDetachedChildPid', () => {
  it(`reads the pid the child printed on line 1`, () => {
    expect(parseDetachedChildPid([detachedPidLine(4242), 'Smart start plan'])).toBe(4242);
  });

  // App output reaches the same log after Metro starts, so only line 1 counts.
  it(`ignores a pid line anywhere but line 1`, () => {
    expect(parseDetachedChildPid(['Smart start plan', detachedPidLine(4242)])).toBeNull();
    expect(parseDetachedChildPid([])).toBeNull();
  });
});

// @ref llp/0021-honest-reports.rfc.md §The rules — F140. Which dev-server
// steps carry work that can end the process *after* the bundler has answered.
// @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port —
// the `--detach` parent computes the move from this row and the lock.
describe(parseDetachedChildPort, () => {
  function portLog(devServerPort: StartPlan['devServerPort']): string[] {
    const plan: StartPlan = {
      rule: 'expo-go',
      target: 'expo-go',
      reasons: [],
      buildLocation: null,
      steps: [
        { id: 'start', argv: ['expo', 'start'], reason: 'r', timeClass: 'seconds', runsOn: null },
      ],
      devServerPort,
    };
    return [...stripVTControlCharacters(formatStartPlan(plan)).split('\n'), 'Waiting on 8083'];
  }

  it(`should read the planned port and the busy port it moved from`, () => {
    expect(
      parseDetachedChildPort(portLog({ port: 8082, movedFrom: 8081, state: 'picked' }))
    ).toEqual({
      port: 8082,
      movedFrom: 8081,
    });
  });

  it(`should read a plan that did not move`, () => {
    expect(
      parseDetachedChildPort(portLog({ port: 8082, movedFrom: null, state: 'picked' }))
    ).toEqual({
      port: 8082,
      movedFrom: null,
    });
    expect(
      parseDetachedChildPort(portLog({ port: 8180, movedFrom: null, state: 'named', taken: true }))
    ).toEqual({
      port: 8180,
      movedFrom: null,
    });
  });

  it(`should answer null for a log with no dev-server port`, () => {
    expect(parseDetachedChildPort(portLog(undefined))).toBeNull();
    expect(parseDetachedChildPort([])).toBeNull();
  });
});
