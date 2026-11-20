import { appWaitOf, type DevRun, type ReuseSession } from '../waitForDevApp';

const spawned = (run: Partial<Extract<DevRun, { kind: 'spawned' }>> = {}): DevRun => ({
  kind: 'spawned',
  easPlatform: null,
  boundPlatform: null,
  open: true,
  ...run,
});
const reused = (session: ReuseSession): DevRun => ({ kind: 'reused', easPlatform: 'ios', session });
const reopened: ReuseSession = { kind: 'reopened', sessionId: 'sess-1', staleTargetIds: ['old'] };

// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization — ready includes the app.
describe(appWaitOf, () => {
  it.each([
    [
      'a start on EAS',
      true,
      spawned({ easPlatform: 'ios' }),
      { on: 'eas', platform: 'ios', staleTargetIds: [] },
    ],
    [
      'a local open',
      true,
      spawned({ boundPlatform: 'android' }),
      { on: 'local', platform: 'android', staleTargetIds: [] },
    ],
    ['a run without --wait-ready', false, spawned({ easPlatform: 'ios' }), null],
    ['--no-open', true, spawned({ boundPlatform: 'android', open: false }), null],
    ['a run with no bound device', true, spawned(), null],
    [
      'an EAS re-run that reopened its session, past the targets from before the reopen',
      true,
      reused(reopened),
      { on: 'eas', platform: 'ios', staleTargetIds: ['old'] },
    ],
    [
      'an EAS re-run that followed the starting child',
      true,
      reused({ kind: 'followed', sessionId: 'sess-1' }),
      { on: 'eas', platform: 'ios', staleTargetIds: [] },
    ],
    ['an EAS re-run without --wait-ready', false, reused(reopened), null],
    ['a re-run with no session', true, reused({ ...reopened, sessionId: null }), null],
    ['a smoke reuse', true, reused({ kind: 'none' }), null],
  ] as const)('%s', (_case, waitReady, run, expected) => {
    expect(appWaitOf(waitReady, run)).toEqual(expected);
  });
});
