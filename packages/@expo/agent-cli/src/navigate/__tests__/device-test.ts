import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { vol } from 'memfs';
import path from 'path';

import { parseBootedIosSimulators } from '../../device/simulators';
import { bindingPathFor } from '../../deviceBinding/registry';
import type { Binding } from '../../deviceBinding';
import { resolveDeviceAsync } from '../device';

const realPlatform = process.platform;

function mockPlatform(value: typeof process.platform) {
  Object.defineProperty(process, 'platform', { value });
}

/** Answer every `spawn` call with the queued stdout and exit code. */
function mockSpawnQueue(answers: { stdout?: string; exitCode?: number | null }[]) {
  let call = 0;
  vi.mocked(spawn).mockImplementation((() => {
    const answer = answers[call++] ?? {};
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    process.nextTick(() => {
      if (answer.stdout) {
        child.stdout.emit('data', answer.stdout);
      }
      child.emit('close', answer.exitCode ?? 0, null);
    });
    return child as any;
  }) as any);
}

/** Every `spawn` fails to start, as a missing SDK does. */
function mockSpawnUnrunnable() {
  vi.mocked(spawn).mockImplementation((() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    process.nextTick(() =>
      child.emit('error', Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' }))
    );
    return child as any;
  }) as any);
}

const projectRoot = '/project';

const BOOTED_SIMCTL_JSON = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.watchOS-26-0': [
      { udid: 'WATCH-1', name: 'Apple Watch', state: 'Booted', dataPath: '/watch' },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
      { udid: 'IOS-1', name: 'iPhone 17', state: 'Booted', dataPath: '/ios' },
      { udid: 'IOS-2', name: 'iPad', state: 'Booted', dataPath: '/ipad' },
    ],
  },
});

const SHUTDOWN_SIMCTL_JSON = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
      { udid: 'IOS-1', name: 'iPhone 17', state: 'Shutdown', dataPath: '/ios' },
    ],
  },
});

/** What `adb -s <serial> get-state` prints for an instance that is up. */
const EMULATOR_UP = 'device\n';

/** This worktree's iOS binding, naming `IOS-1`, an hour from expiry. */
function bindSimulator(udid = 'IOS-1', { expiresAt = '2999-01-01T00:00:00.000Z' } = {}): void {
  const binding: Binding = {
    version: 1,
    device: { backend: 'local-ios', platform: 'ios', udid, name: 'iPhone 17', origin: 'created' },
    projectRoot,
    boundAt: '2026-10-08T09:00:00.000Z',
    expiresAt,
  };
  vol.fromJSON({ [bindingPathFor(projectRoot, 'ios', 'local-ios')]: JSON.stringify(binding) });
}

/** This worktree's Android binding, naming an emulator instance, an hour from expiry. */
function bindEmulator(serial = 'emulator-5554'): void {
  const binding: Binding = {
    version: 1,
    device: { backend: 'local-android', platform: 'android', serial, origin: { kind: 'explicit' } },
    projectRoot,
    boundAt: '2026-10-08T09:30:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
  };
  vol.fromJSON({
    [bindingPathFor(projectRoot, 'android', 'local-android')]: JSON.stringify(binding),
  });
}

beforeEach(() => {
  vol.reset();
  vol.fromJSON({ '/project/package.json': '{}' });
});

afterEach(() => {
  mockPlatform(realPlatform);
});

describe(parseBootedIosSimulators, () => {
  it(`should list every booted iOS simulator, and no watch`, () => {
    expect(parseBootedIosSimulators(BOOTED_SIMCTL_JSON)).toEqual([
      { udid: 'IOS-1', name: 'iPhone 17' },
      { udid: 'IOS-2', name: 'iPad' },
    ]);
  });

  it(`should list nothing for output that is not simctl JSON`, () => {
    expect(parseBootedIosSimulators('not json')).toEqual([]);
    expect(parseBootedIosSimulators('')).toEqual([]);
  });
});

// @ref llp/0030-one-device-per-worktree.rfc.md §Readers
describe(resolveDeviceAsync, () => {
  it(`should use the bound iOS simulator when --ios is given, and extend its lease`, async () => {
    bindSimulator();
    mockSpawnQueue([{ stdout: BOOTED_SIMCTL_JSON }]);

    await expect(resolveDeviceAsync('ios', { projectRoot })).resolves.toEqual({
      backend: 'local-ios',
      platform: 'ios',
      deviceId: 'IOS-1',
      name: 'iPhone 17',
    });
    // One subprocess for the one binding, and never the booted-only listing.
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      'xcrun',
      ['simctl', 'list', 'devices', '-j'],
      expect.anything()
    );
    const written = JSON.parse(
      vol.readFileSync(bindingPathFor(projectRoot, 'ios', 'local-ios'), 'utf8') as string
    );
    expect(Date.parse(written.expiresAt)).toBeGreaterThan(Date.now() + 3_500_000);
  });

  it(`should use the bound emulator instance when --android is given, through adb get-state`, async () => {
    bindEmulator();
    mockSpawnQueue([{ stdout: EMULATOR_UP }]);

    await expect(resolveDeviceAsync('android', { projectRoot })).resolves.toMatchObject({
      backend: 'local-android',
      deviceId: 'emulator-5554',
      // The resolution travels with the device, so every later `adb` call spawns the same binary
      // (`src/device/adb.ts`, F49).
      adb: expect.objectContaining({ bin: expect.any(String) }),
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      expect.stringMatching(/adb(\.exe)?$/),
      ['-s', 'emulator-5554', 'get-state'],
      expect.anything()
    );
  });

  // The cloud backend costs money and spawns an `eas`, so it is on the ladder only for the callers
  // that put it there. Every `runtime:*` action keeps the local resolution exactly.
  it(`never looks for a cloud session unless the caller asked for one`, async () => {
    mockPlatform('darwin');
    mockSpawnQueue([]);

    await resolveDeviceAsync(undefined, { projectRoot }).catch(() => {});

    // No binding on either platform, so no device tool and no `eas`.
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['ios', 'android'] as const)(
    `should name the dev command when --%s finds no binding`,
    async (platform) => {
      const error = await resolveDeviceAsync(platform, { projectRoot }).catch((e) => e);

      expect(error.code).toBe('NO_BOUND_DEVICE');
      expect(error.data).toEqual({ reason: 'none' });
      expect(error.message).toContain(
        `npx @expo/agent-cli dev --${platform} --detach --wait-ready`
      );
      expect(spawn).not.toHaveBeenCalled();
    }
  );

  it(`should refuse a bound simulator that is not up, naming the dev command`, async () => {
    bindSimulator();
    mockSpawnQueue([{ stdout: SHUTDOWN_SIMCTL_JSON }]);

    const error = await resolveDeviceAsync('ios', { projectRoot }).catch((e) => e);

    expect(error.code).toBe('NO_BOUND_DEVICE');
    expect(error.data).toEqual({ reason: 'not-up' });
    expect(error.exitCode).toBe(20);
  });

  // expired-is-gone
  it(`should refuse an expired binding as gone, even with the simulator up`, async () => {
    bindSimulator('IOS-1', { expiresAt: '2020-01-01T00:00:00.000Z' });
    mockSpawnQueue([{ stdout: BOOTED_SIMCTL_JSON }]);

    const error = await resolveDeviceAsync('ios', { projectRoot }).catch((e) => e);

    expect(error.data).toEqual({ reason: 'gone' });
    expect(error.message).toContain('lease');
  });

  // any-up-wins-across-platforms
  it(`should take the bound simulator on macOS when no platform is given`, async () => {
    mockPlatform('darwin');
    bindSimulator();
    mockSpawnQueue([{ stdout: BOOTED_SIMCTL_JSON }]);

    await expect(resolveDeviceAsync(undefined, { projectRoot })).resolves.toMatchObject({
      platform: 'ios',
    });
  });

  it(`should fall back to the bound emulator on macOS when the simulator is not up`, async () => {
    mockPlatform('darwin');
    bindSimulator();
    bindEmulator();
    mockSpawnQueue([{ stdout: SHUTDOWN_SIMCTL_JSON }, { stdout: EMULATOR_UP }]);

    await expect(resolveDeviceAsync(undefined, { projectRoot })).resolves.toMatchObject({
      platform: 'android',
      deviceId: 'emulator-5554',
    });
  });

  it(`should only look for an Android device off macOS`, async () => {
    mockPlatform('linux');
    bindSimulator();
    bindEmulator();
    mockSpawnQueue([{ stdout: EMULATOR_UP }]);

    await expect(resolveDeviceAsync(undefined, { projectRoot })).resolves.toMatchObject({
      platform: 'android',
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  // rung-refusal-reports-first-state
  it(`should report the first state that is not none when nothing is up`, async () => {
    mockPlatform('darwin');
    bindSimulator();
    mockSpawnQueue([{ stdout: SHUTDOWN_SIMCTL_JSON }]);

    const error = await resolveDeviceAsync(undefined, { projectRoot }).catch((e) => e);

    expect(error.code).toBe('NO_BOUND_DEVICE');
    expect(error.data).toEqual({ reason: 'not-up' });
    expect(error.message).toContain('--ios');
  });

  it(`should name iOS on macOS when nothing is bound anywhere`, async () => {
    mockPlatform('darwin');
    mockSpawnQueue([]);

    const error = await resolveDeviceAsync(undefined, { projectRoot }).catch((e) => e);

    expect(error.code).toBe('NO_BOUND_DEVICE');
    expect(error.message).toContain('dev --ios');
  });

  // platform-flag-throws-tool-error-first
  it(`should throw an unrunnable adb at once with --android, and after the EAS rung without`, async () => {
    mockPlatform('linux');
    bindEmulator();
    mockSpawnUnrunnable();

    const flagged = await resolveDeviceAsync('android', { projectRoot }).catch((e) => e);
    expect(flagged.code).toBe('ADB_NOT_RUNNABLE');
    // The headline a reader gets must not send them to boot a device they already have (F49).
    expect(flagged.message).not.toMatch(/no android device/i);

    const unflagged = await resolveDeviceAsync(undefined, { projectRoot }).catch((e) => e);
    expect(unflagged.code).toBe('ADB_NOT_RUNNABLE');
  });
});

// @ref llp/0005-runtime-loop-tools.rfc.md §Cloud simulator
//
// The ladder, not the argv: `src/device/__tests__/cloudSimulator-test.ts` pins what is sent to the
// EAS CLI, and what is pinned here is *when* it is sent and which backend wins.
describe(`${resolveDeviceAsync.name} with the cloud backend`, () => {
  /**
   * The runner every `eas` invocation goes through, planted where the resolver will look.
   *
   * A real `PATH` entry of this process, because these suites run on memfs and the resolver searches
   * `process.env.PATH` (`src/utils/easCli.ts` §resolveEasCli).
   */
  const RUNNER_DIR = (process.env.PATH ?? '/usr/local/bin').split(path.delimiter)[0]!;

  /** A project the cloud backend can be resolved in, and optionally a session on record. */
  function cloudProject(sessionId: string | null): void {
    vol.fromJSON({
      '/project/package.json': '{}',
      [path.join(RUNNER_DIR, 'npx')]: '#!/bin/sh\n',
      [path.join(RUNNER_DIR, 'npx.cmd')]: '#!/bin/sh\n',
      ...(sessionId
        ? { '/project/.env.eas-simulator': `EAS_SIMULATOR_SESSION_ID=${sessionId}\n` }
        : {}),
    });
  }

  /** One live `agent-device` session, in the shape `simulator:list --json` prints. */
  function listing(...rows: Record<string, string>[]): string {
    return JSON.stringify({ sessions: rows, pageInfo: { hasNextPage: false } });
  }

  const liveSession = listing({
    id: 'sess-1',
    status: 'IN_PROGRESS',
    platform: 'IOS',
    type: 'agent-device',
    createdAt: '2026-08-26T10:00:00.000Z',
  });

  /** Nothing running, and an account that does have the feature. */
  const noSessions = [{ stdout: listing() }, { stdout: '{"available": true}' }];

  it(`opens on the dotenv session when this worktree has no local device`, async () => {
    mockPlatform('darwin');
    cloudProject('sess-1');
    mockSpawnQueue([{ stdout: liveSession }]);

    await expect(
      resolveDeviceAsync(undefined, { cloud: 'fallback', projectRoot })
    ).resolves.toMatchObject({ backend: 'cloud', platform: 'ios', deviceId: 'sess-1' });
  });

  // The local device is free, instant, and the one a developer is looking at. A cloud session must
  // never quietly take a run away from it.
  it(`prefers the bound simulator over a session that is also up`, async () => {
    mockPlatform('darwin');
    cloudProject('sess-1');
    bindSimulator();
    mockSpawnQueue([{ stdout: BOOTED_SIMCTL_JSON }]);

    await expect(
      resolveDeviceAsync(undefined, { cloud: 'fallback', projectRoot })
    ).resolves.toMatchObject({ backend: 'local-ios' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  // fallback-eas-rung-dotenv-only: a worktree with no binding must not drive another worktree's
  // session, so the newest session is never taken until llp/0034 binds sessions.
  it(`asks the service nothing when the project's dotenv names no session`, async () => {
    mockPlatform('linux');
    cloudProject(null);
    mockSpawnQueue([{ stdout: liveSession }]);

    const error = await resolveDeviceAsync(undefined, { cloud: 'fallback', projectRoot }).catch(
      (e) => e
    );

    expect(error.code).toBe('NO_BOUND_DEVICE');
    // No binding and no dotenv id: no `adb`, and no `eas` for a session this worktree may not drive.
    expect(spawn).not.toHaveBeenCalled();
    expect(error.message.split('\n').at(-1)).toMatch(/^How: /);
  });

  it(`refuses a session the dotenv names when the service lists another`, async () => {
    mockPlatform('linux');
    cloudProject('sess-2');
    mockSpawnQueue([{ stdout: liveSession }]);

    const error = await resolveDeviceAsync(undefined, { cloud: 'fallback', projectRoot }).catch(
      (e) => e
    );

    expect(error.code).toBe('NO_BOUND_DEVICE');
    expect(error.message).toContain('No android device is bound');
    expect(error.message.split('\n').at(-1)).toMatch(/^How: /);
  });

  it(`still reports no device when the service lists nothing`, async () => {
    mockPlatform('linux');
    cloudProject('sess-1');
    mockSpawnQueue(noSessions);

    const error = await resolveDeviceAsync(undefined, { cloud: 'fallback', projectRoot }).catch(
      (e) => e
    );

    expect(error.code).toBe('NO_BOUND_DEVICE');
  });

  it(`names a session that is on record and not running, in the failure`, async () => {
    mockPlatform('linux');
    cloudProject('sess-1');
    mockSpawnQueue(noSessions);

    const error = await resolveDeviceAsync(undefined, { cloud: 'fallback', projectRoot }).catch(
      (e) => e
    );

    expect(error.message).toContain('EAS Simulator session on record');
    expect(error.message).toContain('npx @expo/agent-cli dev --ios --eas');
  });

  it(`keeps the route URL above the How line of the refusal`, async () => {
    mockPlatform('linux');
    cloudProject('sess-1');
    mockSpawnQueue(noSessions);

    const error = await resolveDeviceAsync(undefined, {
      cloud: 'fallback',
      projectRoot,
      url: 'exp://127.0.0.1:8081/--/settings',
      devServerRunning: true,
    }).catch((e) => e);

    const lines = error.message.split('\n');
    expect(lines.find((line: string) => line.startsWith('Or: this is the URL'))).toContain(
      'exp://127.0.0.1:8081/--/settings'
    );
    expect(lines.at(-1)).toMatch(/^How: /);
    // The next action stays the `dev` command; `--print-url` is a door, not the Try line.
    expect(error.suggestedCommand).toBe('npx @expo/agent-cli dev --android --detach --wait-ready');
    expect(lines.find((line: string) => line.startsWith('Or: this is the URL'))).toContain(
      'navigate <route> --print-url'
    );
  });

  // `--eas` names the device, so no local tool is asked at all.
  it(`asks no local tool when --eas named the backend`, async () => {
    mockPlatform('darwin');
    cloudProject('sess-1');
    bindSimulator();
    mockSpawnQueue([{ stdout: liveSession }]);

    await expect(
      resolveDeviceAsync(undefined, { cloud: 'required', projectRoot })
    ).resolves.toMatchObject({ backend: 'cloud', deviceId: 'sess-1' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it(`refuses a platform flag the session is not`, async () => {
    cloudProject('sess-1');
    mockSpawnQueue([{ stdout: liveSession }]);

    const error = await resolveDeviceAsync('android', { cloud: 'required', projectRoot }).catch(
      (e) => e
    );

    expect(error.code).toBe('CLOUD_SIMULATOR_PLATFORM_MISMATCH');
    expect(error.message).toContain('--ios');
  });

  it(`names how to start a session when --eas finds none`, async () => {
    cloudProject(null);
    mockSpawnQueue(noSessions);

    const error = await resolveDeviceAsync(undefined, { cloud: 'required', projectRoot }).catch(
      (e) => e
    );

    expect(error.code).toBe('NO_CLOUD_SIMULATOR_SESSION');
    expect(error.message).toContain('npx @expo/agent-cli dev --ios --eas');
  });

  // A tool that did not answer has said nothing, and "start a session" would start a second one.
  it(`does not claim there is no session when the eas run could not be read`, async () => {
    cloudProject('sess-1');
    mockSpawnQueue([{ stdout: '<html>', exitCode: 0 }]);

    const error = await resolveDeviceAsync(undefined, { cloud: 'required', projectRoot }).catch(
      (e) => e
    );

    expect(error.code).toBe('CLOUD_SIMULATOR_SESSION_UNKNOWN');
    expect(error.message).not.toContain('simulator:start');
  });
});
