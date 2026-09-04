// @ref llp/0005-runtime-loop-tools.rfc.md §Android
// @ref llp/0005-runtime-loop-tools.rfc.md §The Expo Go on the device is not the Expo Go the SDK wants
//
// Which apps an Android device has, and which version of one. Both answers come from the package
// manager on the device, and both of its commands have a quirk that decides how the answer is read
// — so these cases are the quirks, pinned against the output the real tools produce.
//
// Every fixture here is `adb`'s own output, copied from a run against a real emulator
// [emulator-5554, Android 36, 2026-09-03], because a stub of my own imagining would prove that the
// code agrees with me rather than with `adb`.

import { androidHasAppAsync, readInstalledExpoGoVersionAndroidAsync } from '../androidApps';

/** One `adb` run's result, with the fields these two functions read. */
function ran(
  over: Partial<{ stdout: string; stderr: string; exitCode: number | null; notRunnable: boolean }>
) {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    notRunnable: false,
    adb: { bin: 'adb', source: 'PATH' as const, searched: [], fromPathOnly: false },
    ...over,
  };
}

const EXPO_GO = 'host.exp.exponent';

describe(androidHasAppAsync, () => {
  it(`asks pm for the app's path, on the device the caller named`, async () => {
    const calls: string[][] = [];
    const has = await androidHasAppAsync('emulator-5554', EXPO_GO, {
      runAdbAsync: async (args) => {
        calls.push(args);
        return ran({
          stdout: 'package:/data/app/~~UEswI_PVEVJtpf7c-rESiQ==/host.exp.exponent-g5x6/base.apk\n',
        });
      },
    });

    expect(has).toBe(true);
    expect(calls).toEqual([['-s', 'emulator-5554', 'shell', 'pm', 'path', EXPO_GO]]);
  });

  // @ref ../androidApps — `pm path` is the one command of the two whose exit code means something:
  // `1` for a package the device has not got. This is why it is `pm path` and not
  // `pm list packages`, which exits 0 either way *and* matches on a substring.
  it(`reads an exit of one as "not installed"`, async () => {
    const has = await androidHasAppAsync('emulator-5554', EXPO_GO, {
      runAdbAsync: async () => ran({ exitCode: 1 }),
    });

    expect(has).toBe(false);
  });

  // The third answer, and the reason this returns `boolean | null` rather than `boolean`. The
  // caller acts on `false` by downloading a few hundred megabytes, so a lookup that did not happen
  // must not look like an app that is not there
  // (@ref ../installedApps §simulatorDiskExistsAsync, the same distinction on the iOS side).
  it.each([
    ['adb is not on this machine', ran({ notRunnable: true, exitCode: null })],
    ['the device is offline', ran({ exitCode: 255, stderr: 'error: device offline' })],
    ['pm answered something unreadable', ran({ exitCode: 0, stdout: 'wat' })],
  ])(`answers null rather than false when %s`, async (_case, result) => {
    expect(
      await androidHasAppAsync('emulator-5554', EXPO_GO, { runAdbAsync: async () => result })
    ).toBeNull();
  });
});

describe(readInstalledExpoGoVersionAndroidAsync, () => {
  /** `dumpsys package` output, trimmed to the lines around the one that is read. */
  const DUMPSYS = [
    'Packages:',
    '  Package [host.exp.exponent] (a1b2c3):',
    '    userId=10123',
    '    versionCode=444 minSdk=24 targetSdk=36',
    '    versionName=57.0.9',
    '    flags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ]',
  ].join('\n');

  it(`reads the version out of dumpsys package`, async () => {
    const calls: string[][] = [];
    const version = await readInstalledExpoGoVersionAndroidAsync('emulator-5554', EXPO_GO, {
      runAdbAsync: async (args) => {
        calls.push(args);
        return ran({ stdout: DUMPSYS });
      },
    });

    expect(version).toBe('57.0.9');
    expect(calls).toEqual([['-s', 'emulator-5554', 'shell', 'dumpsys', 'package', EXPO_GO]]);
  });

  // @ref ../androidApps — `dumpsys package` **exits 0 for a package that is not installed**,
  // printing `Unable to find package`. So the exit code decides nothing and the absence of a
  // `versionName` is the whole answer. A reader that trusted the exit code here would report a
  // version of `undefined` for an emulator with no Expo Go at all.
  it(`answers null for a package the device has not got, which still exits zero`, async () => {
    const version = await readInstalledExpoGoVersionAndroidAsync('emulator-5554', EXPO_GO, {
      runAdbAsync: async () => ran({ stdout: `Unable to find package: ${EXPO_GO}\n`, exitCode: 0 }),
    });

    expect(version).toBeNull();
  });

  it(`answers null when adb could not be run at all`, async () => {
    const version = await readInstalledExpoGoVersionAndroidAsync('emulator-5554', EXPO_GO, {
      runAdbAsync: async () => ran({ notRunnable: true, exitCode: null }),
    });

    expect(version).toBeNull();
  });

  // `versionName` appears once per package in the output, and `dumpsys package <id>` is scoped to
  // one — but the line is matched anchored rather than anywhere in the text, so a version inside
  // some other field's value cannot be picked up instead.
  it(`matches the versionName line rather than the substring anywhere`, async () => {
    const version = await readInstalledExpoGoVersionAndroidAsync('emulator-5554', EXPO_GO, {
      runAdbAsync: async () =>
        ran({
          stdout: ['    installerPackageName=versionName=9.9.9', '    versionName=54.0.8'].join(
            '\n'
          ),
        }),
    });

    expect(version).toBe('54.0.8');
  });
});
