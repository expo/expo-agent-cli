// @ref llp/0009-smart-followups.rfc.md §Examples per command
// What a `dev` run asks the shared start ladder for. The ladder itself is `buildStartFollowUps`
// (`src/followups/__tests__/start-test.ts`); this table is the part only `dev` decides.

import type { StartPlan } from '../../project/types';
import type { DevServerRun } from '../../start/startAsync';
import { PLANNED, runFollowUpRequest, type RunFollowUpPhase } from '../runFollowUps';

function mockPlan(overrides: Partial<StartPlan> = {}, argv = ['expo', 'start', '--go']): StartPlan {
  return {
    target: 'expo-go',
    rule: 'expo-go',
    reasons: [],
    steps: [{ id: 'start', argv, reason: '', timeClass: 'seconds', runsOn: null }],
    buildLocation: null,
    ...overrides,
  };
}

function ran(port: DevServerRun['port']): RunFollowUpPhase {
  return { phase: 'ran', devServer: { exitCode: 0, stdout: '', stderr: '', port } };
}

const local = { followups: true, deviceBackend: 'local' } as const;

describe(runFollowUpRequest, () => {
  const withPort = ['expo', 'start', '--go', '--port', '8082'];
  it.each([
    ['before the run, the port the plan step names', withPort, PLANNED, 8082],
    [
      'before the run, the default when the step names none',
      ['expo', 'start', '--go'],
      PLANNED,
      8081,
    ],
    [
      'after the run, the port the dev server logged',
      withPort,
      ran({ port: 8099, source: 'log' }),
      8099,
    ],
    [
      'after the run, the port the step was given',
      withPort,
      ran({ port: 8099, source: 'arg' }),
      8099,
    ],
    ['no port when nothing reported one', withPort, ran({ port: 8081, source: 'default' }), null],
    ['no port when the lock could not run', withPort, ran(null), null],
  ])(`names %s`, (_case, argv, when, port) => {
    expect(runFollowUpRequest(mockPlan({}, argv), local, when).hint.port).toBe(port);
  });

  // F120: the plan's last step, never the caller's own `expo start` options.
  it(`quotes the plan's last step, which a run:* plan does not forward --tunnel to`, () => {
    const plan = mockPlan({ target: 'dev-client' }, ['expo', 'run:ios', '--port', '8082']);

    expect(runFollowUpRequest(plan, local, PLANNED)).toEqual({
      options: { expoArgs: ['run:ios', '--port', '8082'], followups: true },
      hint: { expoGo: false, web: false, eas: false, port: 8082, localBuild: null },
    });
  });

  it.each([
    ['an Expo Go run', mockPlan(), local, { expoGo: true, web: false, eas: false }],
    ['a web run', mockPlan({ target: 'web' }), local, { expoGo: false, web: true, eas: false }],
    [
      'a run on EAS',
      mockPlan({ target: 'dev-client' }),
      { followups: true, deviceBackend: 'eas' } as const,
      { expoGo: false, web: false, eas: true },
    ],
  ])(`describes %s`, (_case, plan, options, hint) => {
    expect(runFollowUpRequest(plan, options, PLANNED).hint).toMatchObject(hint);
  });

  it(`passes on what the plan's toolchain probe found`, () => {
    const plan = mockPlan({
      buildLocation: {
        runsOn: 'local',
        platform: 'ios',
        requirement: 'Xcode on this machine',
        status: 'missing',
        detail: null,
        caveats: [],
        alternativeCommand: null,
        selection: null,
      },
    });

    expect(runFollowUpRequest(plan, local, PLANNED).hint.localBuild).toBe('missing');
  });
});
