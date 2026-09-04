// @ref llp/0005-runtime-loop-tools.rfc.md §Putting Expo Go on a simulator that has not got it
//
// The gate used to refuse here and name `npx expo start --ios`, which is a correct instruction and
// a dead end for an agent loop: the loop cannot take it without leaving the loop. So the missing
// app is now installed, and this is the pair of subprocesses that does it — `expo-go download` for
// the binary and `simctl install` for the device.
//
// Both are stubbed here. What is worth testing is the argv, the order, and every way the pair can
// fail: a download that answers no path, a `simctl` that refuses, a device that is not booted.

import { resetApprovedSchemes } from '../approveScheme';
import { installExpoGoAsync } from '../installExpoGo';

// @ref ../approveScheme §written — the approvals are memoized per process, so a case that asserts
// an exact argv list has to start from an empty memo or inherit whatever ran before it.
beforeEach(() => resetApprovedSchemes());

/** A capture result, with the fields a caller reads. */
function captured(over: Partial<{ stdout: string; stderr: string; exitCode: number | null }> = {}) {
  return { stdout: '', stderr: '', exitCode: 0, ...over };
}

const DOWNLOADED = '{"path":"/tmp/dl/Expo-Go-57.0.9.tar.app"}';

describe(installExpoGoAsync, () => {
  it(`downloads the release for this SDK, installs it, and makes its links openable`, async () => {
    const calls: string[][] = [];
    const result = await installExpoGoAsync('SIM-1', 'ios', '57.0.19', {
      spawn: async (command, args) => {
        calls.push([command, ...args]);
        return captured({ stdout: command === 'npx' ? DOWNLOADED : '' });
      },
      tempDirAsync: async () => '/tmp/dl',
      cleanupAsync: async () => {},
    });

    expect(result).toMatchObject({ ok: true, version: '57.0.9' });
    expect(calls).toEqual([
      ['npx', '--yes', 'expo-go', 'download', 'ios', '57.0.19', '--json'],
      ['xcrun', 'simctl', 'install', 'SIM-1', '/tmp/dl/Expo-Go-57.0.9.tar.app'],
      // @ref src/device/approveScheme.ts — the install is not finished until the link works, and on
      // a freshly installed app iOS asks `Open in "Expo Go"?` first.
      [
        'xcrun',
        'simctl',
        'spawn',
        'SIM-1',
        'defaults',
        'write',
        'com.apple.launchservices.schemeapproval',
        'com.apple.CoreSimulator.CoreSimulatorBridge-->exp',
        '-string',
        'host.exp.Exponent',
      ],
      // The second obstacle, written with the first rather than after both schemes: a first-ever
      // launch puts the developer-menu onboarding sheet over the app, which would make the
      // screenshot a picture of the sheet. Once per app, hence not repeated below.
      [
        'xcrun',
        'simctl',
        'spawn',
        'SIM-1',
        'defaults',
        'write',
        'host.exp.Exponent',
        'EXDevMenuIsOnboardingFinished',
        '-bool',
        'true',
      ],
      [
        'xcrun',
        'simctl',
        'spawn',
        'SIM-1',
        'defaults',
        'write',
        'com.apple.launchservices.schemeapproval',
        'com.apple.CoreSimulator.CoreSimulatorBridge-->exps',
        '-string',
        'host.exp.Exponent',
      ],
    ]);
  });

  // @ref ./installExpoGo §approveSchemesAsync
  //
  // An install whose approval failed is still an install: Expo Go is on the device, and the worst
  // case is the dialog the approval exists to remove. Reporting the whole install as failed would
  // throw away a 423 MB download over a preference write.
  it(`still reports the install when the scheme approval failed`, async () => {
    const result = await installExpoGoAsync('SIM-1', 'ios', '57.0.19', {
      spawn: async (command, args) =>
        captured({
          stdout: command === 'npx' ? DOWNLOADED : '',
          exitCode: args.includes('defaults') ? 1 : 0,
        }),
      tempDirAsync: async () => '/tmp/dl',
      cleanupAsync: async () => {},
    });

    expect(result.ok).toBe(true);
    expect(result.version).toBe('57.0.9');
  });

  // The download goes to a temporary directory and never to the project. The bundle is ~423 MB
  // extracted [observed, 2026-09-03], and a gate that left that in someone's repo would be worse
  // than the refusal it replaced.
  it(`downloads into a temporary directory, not the project`, async () => {
    let cwd: string | undefined;
    await installExpoGoAsync('SIM-1', 'ios', '57.0.0', {
      spawn: async (command, _args, options) => {
        if (command === 'npx') {
          cwd = options?.cwd;
        }
        return captured({ stdout: command === 'npx' ? DOWNLOADED : '' });
      },
      tempDirAsync: async () => '/tmp/dl',
      cleanupAsync: async () => {},
    });

    expect(cwd).toBe('/tmp/dl');
  });

  // And it is removed afterwards, on the way out of both the success and the failure.
  it.each([
    ['a successful install', 0],
    ['a failed install', 1],
  ])(`removes the download after %s`, async (_name, installExit) => {
    const removed: string[] = [];
    await installExpoGoAsync('SIM-1', 'ios', '57.0.0', {
      spawn: async (command) =>
        captured({
          stdout: command === 'npx' ? DOWNLOADED : '',
          exitCode: command === 'npx' ? 0 : installExit,
        }),
      tempDirAsync: async () => '/tmp/dl',
      cleanupAsync: async (dir) => {
        removed.push(dir);
      },
    });

    expect(removed).toEqual(['/tmp/dl']);
  });

  // The CLI's own sentence is quoted rather than replaced: it names the SDK it has no release for.
  it(`reports what the download CLI said when it refused`, async () => {
    const result = await installExpoGoAsync('SIM-1', 'ios', '99.0.0', {
      spawn: async () =>
        captured({
          stdout: '{"error":"Unable to find a version of Expo Go for SDK 99.0.0"}',
          exitCode: 1,
        }),
      tempDirAsync: async () => '/tmp/dl',
      cleanupAsync: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Unable to find a version of Expo Go for SDK 99.0.0');
  });

  // Nothing is installed when there is nothing to install, and `simctl` is never reached.
  it(`never runs simctl when the download produced no path`, async () => {
    const calls: string[] = [];
    const result = await installExpoGoAsync('SIM-1', 'ios', '57.0.0', {
      spawn: async (command) => {
        calls.push(command);
        return captured({ stdout: '{"path":null}' });
      },
      tempDirAsync: async () => '/tmp/dl',
      cleanupAsync: async () => {},
    });

    expect(calls).toEqual(['npx']);
    expect(result.ok).toBe(false);
  });

  // @ref ./installExpoGo — `simctl install` needs a **booted** device: it answers
  // `Unable to lookup in current state: Shutdown` (code 405) for one that is not
  // [observed, 2026-09-03]. That is the caller's ordering mistake, so the reason says so rather
  // than passing the raw CoreSimulator sentence along on its own.
  it(`explains a device that was not booted`, async () => {
    const result = await installExpoGoAsync('SIM-1', 'ios', '57.0.0', {
      spawn: async (command) =>
        captured({
          stdout: command === 'npx' ? DOWNLOADED : '',
          stderr:
            command === 'npx'
              ? ''
              : 'An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\nUnable to lookup in current state: Shutdown',
          exitCode: command === 'npx' ? 0 : 1,
        }),
      tempDirAsync: async () => '/tmp/dl',
      cleanupAsync: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('booted');
  });

  // A binary that is not on `PATH` at all, which is an ordinary machine rather than a broken one.
  it(`reports a subprocess that could not be started`, async () => {
    const result = await installExpoGoAsync('SIM-1', 'ios', '57.0.0', {
      spawn: async () => ({
        ...captured({ exitCode: null }),
        spawnError: Object.assign(new Error('spawn npx ENOENT'), { code: 'ENOENT' }),
      }),
      tempDirAsync: async () => '/tmp/dl',
      cleanupAsync: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ENOENT');
  });
});

// @ref llp/0005-runtime-loop-tools.rfc.md §Android
//
// This used to refuse android by name, because the install went through `simctl` and `simctl` is
// the iOS simulator's tool and nothing else's — which left `smoke --android` with the dead end the
// whole section was written against: an emulator with no Expo Go, or with the wrong one, and an
// instruction the agent loop cannot take without leaving the loop.
//
// The download is the *same* subprocess with a different platform argument [observed, 2026-09-03:
// `expo-go download android 54.0.0 --json` answers `{"path":"…/Expo-Go-54.0.8.apk"}`, the same
// contract iOS gets]. Only the installer differs, and that is what these cases pin.
describe(`${installExpoGoAsync.name} on Android`, () => {
  /** An `adb` resolution whose bin is the bare name, so the argv a case asserts on is readable. */
  const adb = { bin: 'adb', source: 'PATH' as const, searched: [], fromPathOnly: false };
  const DOWNLOADED_APK = '{"path":"/tmp/dl/Expo-Go-54.0.8.apk"}';

  it(`downloads the apk and installs it with adb`, async () => {
    const calls: string[][] = [];
    const result = await installExpoGoAsync('emulator-5554', 'android', '54.0.0', {
      adb,
      spawn: async (command, args) => {
        calls.push([command, ...args]);
        return captured({ stdout: command === 'npx' ? DOWNLOADED_APK : 'Success' });
      },
      tempDirAsync: async () => '/tmp/dl',
      cleanupAsync: async () => {},
    });

    expect(result).toMatchObject({ ok: true, version: '54.0.8' });
    // @ref ../installExpoGo §putOnDeviceAsync — `-r` keeps the app's data across a replacement, and
    // `-d` is what lets the replacement be a *downgrade*: a project on an older SDK than the
    // emulator's Expo Go wants the older release, and without `-d` that fails with
    // `INSTALL_FAILED_VERSION_DOWNGRADE`.
    expect(calls).toEqual([
      ['npx', '--yes', 'expo-go', 'download', 'android', '54.0.0', '--json'],
      ['adb', '-s', 'emulator-5554', 'install', '-r', '-d', '/tmp/dl/Expo-Go-54.0.8.apk'],
    ]);
  });

  // @ref ../installExpoGo §approveSchemesAsync. iOS needs the scheme approval and the onboarding
  // flag written before a deep link works on a freshly installed app; Android needs neither —
  // Expo Go's `exp://` intent filter is in its manifest [observed, 2026-09-03]. So nothing is
  // written, and in particular nothing that only iOS needs is written to somebody's emulator.
  it(`writes no preferences, because Android has no dialog to approve away`, async () => {
    const calls: string[][] = [];
    await installExpoGoAsync('emulator-5554', 'android', '54.0.0', {
      adb,
      spawn: async (command, args) => {
        calls.push([command, ...args]);
        return captured({ stdout: command === 'npx' ? DOWNLOADED_APK : 'Success' });
      },
      tempDirAsync: async () => '/tmp/dl',
      cleanupAsync: async () => {},
    });

    expect(calls.some((argv) => argv.includes('defaults'))).toBe(false);
    expect(calls.some((argv) => argv.includes('xcrun'))).toBe(false);
  });

  // @ref ../installExpoGo §putOnDeviceAsync — the one way `adb install` differs from `simctl
  // install` in its *reporting*: it prints `Failure [INSTALL_FAILED_…]` and **exits 0**
  // [observed, 2026-09-03]. A caller reading only the exit code would report that install as a
  // success, which is a false green of exactly the kind this gate exists to remove.
  it(`reports a refused install that exited zero`, async () => {
    const result = await installExpoGoAsync('emulator-5554', 'android', '54.0.0', {
      adb,
      spawn: async (command) =>
        captured({
          stdout: command === 'npx' ? DOWNLOADED_APK : '',
          stderr:
            command === 'npx'
              ? ''
              : 'adb: failed to install /tmp/dl/Expo-Go-54.0.8.apk: Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]',
          exitCode: 0,
        }),
      tempDirAsync: async () => '/tmp/dl',
      cleanupAsync: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('INSTALL_FAILED_INSUFFICIENT_STORAGE');
  });

  // The `adb` this CLI resolved, not the bare name: two Android SDKs on one machine is common, and
  // an install through the wrong one puts the app on a device the rest of the run cannot see
  // (@ref ../adb).
  it(`installs through the adb this machine resolved`, async () => {
    let installer: string | null = null;
    await installExpoGoAsync('emulator-5554', 'android', '54.0.0', {
      adb: { ...adb, bin: '/opt/android/platform-tools/adb', source: 'ANDROID_HOME' },
      spawn: async (command, args) => {
        if (args.includes('install')) {
          installer = command;
        }
        return captured({ stdout: command === 'npx' ? DOWNLOADED_APK : 'Success' });
      },
      tempDirAsync: async () => '/tmp/dl',
      cleanupAsync: async () => {},
    });

    expect(installer).toBe('/opt/android/platform-tools/adb');
  });
});

// @ref llp/0005-runtime-loop-tools.rfc.md §The Expo Go on the device is not the Expo Go the SDK wants
//
// Installing over a wrong version is the same call as installing a missing one, and that is on
// purpose: `@expo/cli` notes that iOS needs no uninstall to update ("Don't need to uninstall to
// update on iOS"), so there is no second path for the replacement case.
describe(`${installExpoGoAsync.name} over a version that is already there`, () => {
  it(`installs without uninstalling first`, async () => {
    const calls: string[][] = [];
    const result = await installExpoGoAsync('SIM-1', 'ios', '57.0.19', {
      spawn: async (command, args) => {
        calls.push([command, ...args]);
        return captured({ stdout: command === 'npx' ? DOWNLOADED : '' });
      },
      tempDirAsync: async () => '/tmp/dl',
      cleanupAsync: async () => {},
    });

    expect(result.ok).toBe(true);
    expect(calls.some((argv) => argv.includes('uninstall'))).toBe(false);
  });
});
