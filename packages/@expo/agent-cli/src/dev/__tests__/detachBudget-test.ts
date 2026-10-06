// @ref llp/0026-dev-owns-the-open.rfc.md §The detach budget follows the plan
// `dev --ios --detach` exited 1 at 120 s while its child ran `pod install`; the child then built,
// started Metro and opened the app [observed — live, 2026-10-05].
import type { DevServerLockInfo } from '../../devLock';
import { formatStartPlan } from '../../plan/format';
import type { StartPlan } from '../../project/types';
import {
  createDetachBudget,
  judgeDetachWait,
  waitForLockAsync,
  type DetachLogView,
  type DetachWaitPolicy,
} from '../detachBudget';

const POLICY: DetachWaitPolicy = {
  baseMs: 120_000,
  ceilingMs: 1_800_000,
  stallMs: 300_000,
  progressEveryMs: 15_000,
};

function planLines(...argvs: string[][]): string[] {
  const plan: StartPlan = {
    rule: 'dev-client-stale',
    target: 'dev-client',
    reasons: [],
    buildLocation: null,
    steps: argvs.map((argv, index) => ({
      id: `step-${index}`,
      argv,
      reason: 'A step.',
      timeClass: 'minutes',
      runsOn: null,
    })),
  };
  return formatStartPlan(plan).split('\n');
}

const BUILD_PLAN = planLines(['expo', 'prebuild', '--platform', 'ios'], ['expo', 'run:ios']);
const SERVE_PLAN = planLines(['expo', 'start', '--go']);

/** A log the test grows by hand, and a clock it moves by hand. */
function fakeRun(plan: string[]) {
  const lines = [...plan];
  let clock = 0;
  const log: DetachLogView = {
    sizeBytes: () => lines.join('\n').length,
    lines: () => lines,
    lastLine: () => lines.at(-1) ?? null,
  };
  return {
    log,
    now: () => clock,
    advance(ms: number, line?: string) {
      clock += ms;
      if (line != null) {
        lines.push(line);
      }
    },
  };
}

describe(judgeDetachWait, () => {
  it.each([
    [{ elapsedMs: 119_000, buildsNative: false, quietMs: 0 }, 'wait'],
    [{ elapsedMs: 120_000, buildsNative: false, quietMs: 0 }, 'timeout'],
    [{ elapsedMs: 120_000, buildsNative: true, quietMs: 0 }, 'wait'],
    [{ elapsedMs: 600_000, buildsNative: true, quietMs: 299_000 }, 'wait'],
    [{ elapsedMs: 600_000, buildsNative: true, quietMs: 300_000 }, 'stalled'],
    [{ elapsedMs: 1_800_000, buildsNative: true, quietMs: 0 }, 'ceiling'],
    // The base is unconditional: a quiet start is not judged before it has run out.
    [{ elapsedMs: 60_000, buildsNative: true, quietMs: 60_000 }, 'wait'],
  ] as const)('%j → %s', (state, verdict) => {
    expect(judgeDetachWait(state, POLICY)).toBe(verdict);
  });

  it(`never stops a build before a base longer than the ceiling`, () => {
    const policy = { ...POLICY, baseMs: 2_000_000 };
    expect(judgeDetachWait({ elapsedMs: 1_900_000, buildsNative: true, quietMs: 0 }, policy)).toBe(
      'wait'
    );
  });
});

describe(createDetachBudget, () => {
  it(`keeps a building plan waiting past the base while its log grows, up to the ceiling`, () => {
    const run = fakeRun(BUILD_PLAN);
    const budget = createDetachBudget({ policy: POLICY, startedAt: 0, now: run.now, log: run.log });

    for (let elapsed = 0; elapsed < 1_800_000; elapsed += 60_000) {
      expect(budget.check()).toBe('wait');
      run.advance(60_000, `› Compiling pod ${elapsed}`);
    }
    expect(budget.check()).toBe('ceiling');
  });

  it(`stops a building plan whose log has gone quiet`, () => {
    const run = fakeRun(BUILD_PLAN);
    const budget = createDetachBudget({ policy: POLICY, startedAt: 0, now: run.now, log: run.log });

    run.advance(200_000, '› Installing pods');
    expect(budget.check()).toBe('wait');
    run.advance(299_000);
    expect(budget.check()).toBe('wait');
    run.advance(1_000);
    expect(budget.check()).toBe('stalled');
  });

  it(`keeps the base for a plan that only serves`, () => {
    const run = fakeRun(SERVE_PLAN);
    const budget = createDetachBudget({ policy: POLICY, startedAt: 0, now: run.now, log: run.log });

    run.advance(119_000, 'Starting Metro Bundler');
    expect(budget.check()).toBe('wait');
    expect(budget.remainingMs()).toBe(1_000);
    run.advance(1_000, 'still starting');
    expect(budget.check()).toBe('timeout');
  });

  it(`gives a building plan the ceiling as its remaining budget`, () => {
    const run = fakeRun(BUILD_PLAN);
    const budget = createDetachBudget({ policy: POLICY, startedAt: 0, now: run.now, log: run.log });

    run.advance(600_000, '› Building');
    budget.check();
    expect(budget.buildsNative()).toBe(true);
    expect(budget.remainingMs()).toBe(1_200_000);
  });

  it(`reports progress once per interval, with the last log line`, () => {
    const run = fakeRun(BUILD_PLAN);
    const onProgress = vi.fn();
    const budget = createDetachBudget({
      policy: POLICY,
      startedAt: 0,
      now: run.now,
      log: run.log,
      onProgress,
    });

    for (let tick = 0; tick < 46; tick++) {
      run.advance(1_000, tick === 44 ? '› Installing pods' : undefined);
      budget.check();
    }

    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { elapsedMs: 15_000, lastLine: expect.any(String) },
      { elapsedMs: 30_000, lastLine: expect.any(String) },
      { elapsedMs: 45_000, lastLine: '› Installing pods' },
    ]);
  });
});

describe(waitForLockAsync, () => {
  const LOCK = { url: 'http://127.0.0.1:8081', port: 8081, pid: 42 } as DevServerLockInfo;

  it(`returns the lock a living child publishes after the base, while the budget says wait`, async () => {
    let polls = 0;
    const lock = await waitForLockAsync({
      readLock: async () => (++polls === 5 ? LOCK : null),
      hasExited: () => false,
      verdict: () => 'wait',
      pollMs: 1,
    });

    expect(lock).toEqual({ lock: LOCK, verdict: 'wait' });
  });

  it(`gives up at once when the child exits without a lock`, async () => {
    let exited = false;
    const lock = await waitForLockAsync({
      readLock: async () => {
        exited = true;
        return null;
      },
      hasExited: () => exited,
      verdict: () => 'wait',
      pollMs: 1,
    });

    expect(lock).toEqual({ lock: null, verdict: 'wait' });
  });

  it(`gives up with the budget's verdict while the child is still alive`, async () => {
    let polls = 0;
    const lock = await waitForLockAsync({
      readLock: async () => null,
      hasExited: () => false,
      verdict: () => (++polls < 3 ? 'wait' : 'ceiling'),
      pollMs: 1,
    });

    expect(lock).toEqual({ lock: null, verdict: 'ceiling' });
  });
});
