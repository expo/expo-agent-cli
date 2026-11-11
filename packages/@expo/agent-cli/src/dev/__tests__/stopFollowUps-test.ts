import { localBackendOf } from '../../deviceBinding/types';
import { PROGRAM_PREFIX } from '../../programName';
import { mockPlatform } from '../../utils/__tests__/mockPlatform';
import { buildFollowUps, type DevStopResultJson } from '../stopAsync';

// @ref llp/0035-one-device-per-worktree.rfc.md §Session cleanup
describe(buildFollowUps, () => {
  const result = (overrides: Partial<DevStopResultJson>): DevStopResultJson => ({
    stopped: true,
    pid: 1234,
    port: 8081,
    url: 'http://127.0.0.1:8081',
    lockHeld: true,
    signal: 'SIGTERM',
    forced: false,
    forceRefusedBy: null,
    processStillRunning: false,
    portStillAnswering: false,
    easPlatform: null,
    reason: null,
    detail: null,
    untracked: false,
    waitedMs: 0,
    followups: [],
    ...overrides,
  });
  const cloud = (released: boolean | null) => ({
    backend: 'cloud' as const,
    platform: 'android' as const,
    id: 'sess-1',
    name: 'sess-1',
    released,
    shutDown: false,
    reason: null,
  });
  const local = (platform: 'ios' | 'android', released: boolean | null) => ({
    backend: localBackendOf(platform),
    platform,
    id: 'dev-1',
    name: 'dev-1',
    released,
    shutDown: false,
    reason: null,
  });

  it.each<[string, Partial<DevStopResultJson>, string[], string | null | undefined, boolean?]>([
    [
      'a kept cloud session, on its platform',
      { devices: [cloud(null)] },
      ['stop-session', 'dev'],
      '--android --eas',
    ],
    ['a released cloud session', { devices: [cloud(true)] }, ['dev'], '--android --eas'],
    [
      'nothing running and a kept cloud session',
      { stopped: false, reason: 'not-running', devices: [cloud(null)] },
      ['stop-session'],
      null,
    ],
    [
      "a failed stop of the probe's session",
      { devices: [], session: { id: 'A', stopped: false, reason: 'x', platform: null } },
      ['stop-session', 'dev'],
      undefined,
    ],
    [
      'no session on record',
      { devices: [], session: { id: null, stopped: false, reason: 'unknown', platform: null } },
      ['dev'],
      undefined,
    ],
    [
      "the probe's session stopped, on its platform",
      { devices: [], session: { id: 'A', stopped: true, reason: null, platform: 'android' } },
      ['dev'],
      '--android --eas',
    ],
    [
      'nothing running and this run stopped the session',
      {
        stopped: false,
        reason: 'not-running',
        devices: [],
        session: { id: 's', stopped: true, reason: null, platform: 'ios' },
      },
      ['dev'],
      '--ios --eas',
    ],
    ['a live pid of a run with no EAS platform', { processStillRunning: true }, ['dev'], undefined],
    [
      'a finishing dev --eas process, on its EAS platform',
      { processStillRunning: true, easPlatform: 'android' },
      ['stop-session', 'dev'],
      '--android --eas',
      true,
    ],
    [
      'a finishing dev --eas process when dev:stop --eas already ran',
      {
        processStillRunning: true,
        easPlatform: 'ios',
        session: { id: 'sess-1', stopped: true, reason: null, platform: 'ios' },
      },
      ['dev'],
      undefined,
      true,
    ],
  ])('names the follow-ups after %s', (_name, input, ids, platformFlag, finishing) => {
    const followups = buildFollowUps(result(input), finishing);

    expect(followups.map((f) => f.id)).toEqual(ids);
    if (finishing && ids[0] === 'stop-session') expect(followups[0]!.why).toContain('pid 1234');
    if (platformFlag !== undefined) {
      expect(followups.find((f) => f.id === 'dev')?.command ?? null).toBe(
        platformFlag && `${PROGRAM_PREFIX} dev ${platformFlag}`
      );
    }
  });

  // Each host's fallback is the other platform, so only a read of the device rows passes.
  it.each<[string, ReturnType<typeof local>[], NodeJS.Platform, string]>([
    ['a kept local Android emulator', [local('android', null)], 'darwin', '--android'],
    ['a released local iOS simulator', [local('ios', true)], 'linux', '--ios'],
    [
      'local devices on both platforms, on macOS',
      [local('ios', null), local('android', null)],
      'darwin',
      '--ios',
    ],
    [
      'local devices on both platforms, on Linux',
      [local('ios', null), local('android', null)],
      'linux',
      '--android',
    ],
  ])('restarts dev on the platform of %s', (_name, devices, host, platformFlag) => {
    mockPlatform(host);

    const followups = buildFollowUps(result({ devices }));

    expect(followups.map((f) => f.command)).toEqual([`${PROGRAM_PREFIX} dev ${platformFlag}`]);
  });

  it(`does not say the dev server is stopped when no dev-server lock answered`, () => {
    const followups = buildFollowUps(
      result({
        stopped: false,
        reason: 'not-running',
        devices: [],
        session: { id: 's', stopped: true, reason: null, platform: 'ios' },
      })
    );

    expect(followups.find((f) => f.id === 'dev')?.why).toBe(
      'The EAS session is stopped, and no dev-server lock answered for this project. This starts a dev server and a session again when the app is needed.'
    );
  });

  it(`says the stop failed, not that it was not checked, for a cloud session whose stop failed`, () => {
    const followups = buildFollowUps(
      result({ devices: [{ ...cloud(false), reason: 'refused\nHow: retry' }] })
    );

    expect(followups.map((f) => f.id)).toEqual(['stop-session', 'dev']);
    expect(followups[0]!.why).toBe(
      'The stop of EAS Simulator session sess-1 failed: refused. If it still runs, it bills until this ends it.'
    );
    expect(buildFollowUps(result({ devices: [cloud(null)] }))[0]!.why).toContain('was not checked');
  });

  it(`says the stop failed for the probe's session whose stop failed`, () => {
    const followups = buildFollowUps(
      result({ session: { id: 'A', stopped: false, reason: 'refused', platform: 'ios' } })
    );

    expect(followups[0]!.why).toContain('The stop of EAS Simulator session A failed: refused.');
    expect(followups[0]!.why).not.toContain('not checked');
  });
});
