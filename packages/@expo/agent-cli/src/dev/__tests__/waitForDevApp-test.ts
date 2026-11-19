import { appWaitOf, type DevRun } from '../waitForDevApp';

const spawned = (run: Partial<Extract<DevRun, { kind: 'spawned' }>> = {}): DevRun => ({
  kind: 'spawned',
  easPlatform: null,
  boundPlatform: null,
  open: true,
  ...run,
});
const reused = (run: Partial<Extract<DevRun, { kind: 'reused' }>> = {}): DevRun => ({
  kind: 'reused',
  reopenedEas: true,
  easPlatform: 'ios',
  sessionId: 'sess-1',
  ...run,
});

// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization — ready includes the app.
describe(appWaitOf, () => {
  it.each([
    ['a start on EAS', true, spawned({ easPlatform: 'ios' }), { on: 'eas', platform: 'ios' }],
    [
      'a local open',
      true,
      spawned({ boundPlatform: 'android' }),
      { on: 'local', platform: 'android' },
    ],
    ['a run without --wait-ready', false, spawned({ easPlatform: 'ios' }), null],
    ['--no-open', true, spawned({ boundPlatform: 'android', open: false }), null],
    ['a run with no bound device', true, spawned(), null],
    ['an EAS re-run that opened its session', true, reused(), { on: 'eas', platform: 'ios' }],
    ['an EAS re-run without --wait-ready', false, reused(), null],
    ['a re-run with no session', true, reused({ sessionId: null }), null],
    ['a smoke reuse', true, reused({ reopenedEas: false }), null],
  ] as const)('%s', (_case, waitReady, run, expected) => {
    expect(appWaitOf(waitReady, run)).toEqual(expected);
  });
});
