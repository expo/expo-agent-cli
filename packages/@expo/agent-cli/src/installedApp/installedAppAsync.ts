// @ref llp/0028-installed-app-check.rfc.md §What the answer is
// Compare the fingerprint embedded in the installed app with the project's, per platform, and turn
// the comparison into one verdict per platform. Reported by `status --explain`; not a command.

import { PROGRAM_PREFIX } from '../programName';
import { generateFingerprintAsync, type FingerprintResult } from '../project/fingerprint';
import { resolveFingerprintCliVersion } from '../project/fingerprintCache';
import {
  formatPrebuildChanges,
  getNativeDirectoryStaleness,
  type NativeDirectoryStaleness,
  type PrebuildSourceChange,
} from '../project/prebuildMarker';
import { readConfiguredAppId, readConfiguredScheme } from '../runtime/appId';
import { CommandError } from '../utils/errors';
import { readInstalledFingerprintAndroidAsync } from './android';
import { debugEvent } from './events';
import type { InstalledAppDevice, InstalledFingerprintResult } from './installedFingerprint';
import { readInstalledFingerprintIosAsync } from './ios';
import type { InstalledAppOptions, InstalledAppPlatform } from './options';

export type CheckStatus = 'up-to-date' | 'rebuild-required' | 'unknown';

export type CheckReason =
  | 'hash-match'
  | 'hash-mismatch'
  | 'prebuild-stale'
  | 'no-device'
  | 'app-not-installed'
  | 'no-embedded-fingerprint'
  | 'no-response'
  | 'app-id-unknown'
  | 'fingerprint-unavailable'
  | 'check-failed';

export interface PlatformCheck {
  status: CheckStatus;
  reason: CheckReason;
  /** What the reader saw, and what to do next. */
  recommendation: string;
  /** The commands that bring the app up to date, in order. Empty when nothing has to run. */
  commands: string[];
  device: InstalledAppDevice | null;
  installedHash: string | null;
  currentHash: string | null;
  /** Where the project hash came from: `computed`, `cache`, or null when there is none. */
  fingerprintSource: 'computed' | 'cache' | null;
  /** Whether the generated native directories match the project, from the prebuild marker. */
  prebuildStatus: NativeDirectoryStaleness['status'];
  /** The prebuild-relevant sources that moved. Empty unless `prebuildStatus` is `stale`. */
  prebuildChanges: PrebuildSourceChange[];
}

/** What the apps installed on this machine's devices say about the project. */
export interface InstalledAppReport {
  /** The strongest verdict across the platforms that answered. */
  outcome: CheckStatus;
  platforms: Partial<Record<InstalledAppPlatform, PlatformCheck>>;
}

/** Reads a fingerprint. Injected by the tests; the platform readers are the defaults. */
export type InstalledFingerprintReader = (input: {
  platform: InstalledAppPlatform;
  appId: string;
  device: string | null;
  expectedHash: Promise<string>;
  /** The project's URL scheme, for the physical iOS device probe. */
  scheme: string | null;
  timeoutMs: number;
}) => Promise<InstalledFingerprintResult>;

export interface CheckDependencies {
  readInstalled?: InstalledFingerprintReader;
  generateFingerprint?: typeof generateFingerprintAsync;
  readAppId?: typeof readConfiguredAppId;
  readScheme?: typeof readConfiguredScheme;
  readNativeDirectoryStaleness?: typeof getNativeDirectoryStaleness;
  readFingerprintVersion?: typeof resolveFingerprintCliVersion;
}

const defaultReader: InstalledFingerprintReader = ({
  platform,
  appId,
  device,
  expectedHash,
  scheme,
  timeoutMs,
}) =>
  platform === 'ios'
    ? readInstalledFingerprintIosAsync({
        appId,
        device: device ?? undefined,
        expectedHash,
        scheme,
        timeoutMs,
      })
    : readInstalledFingerprintAndroidAsync({ appId, device: device ?? undefined, expectedHash });

export async function checkInstalledAppAsync(
  projectRoot: string,
  options: InstalledAppOptions,
  {
    readInstalled = defaultReader,
    generateFingerprint = generateFingerprintAsync,
    readAppId = readConfiguredAppId,
    readScheme = readConfiguredScheme,
    readNativeDirectoryStaleness = getNativeDirectoryStaleness,
    readFingerprintVersion = resolveFingerprintCliVersion,
  }: CheckDependencies = {}
): Promise<InstalledAppReport> {
  const checks = await Promise.all(
    options.platforms.map((platform) =>
      checkPlatformAsync(projectRoot, platform, options, {
        readInstalled,
        generateFingerprint,
        readAppId,
        readScheme,
        readNativeDirectoryStaleness,
        readFingerprintVersion,
      })
        .catch((error: unknown) => {
          // Every platform this machine might reach is checked, so a missing device tool is one
          // platform without a device rather than a failure of the report.
          if (error instanceof CommandError) {
            return verdict('no-device', { recommendation: error.message });
          }
          debugEvent('platform_check_failed', {
            platform,
            error: debugEvent.error(error as Error),
          });
          return verdict('check-failed', {
            recommendation: `The check failed: ${(error as Error).message}. Fix the underlying issue, or rebuild to be safe. Run with EXPO_DEBUG=1 for details.`,
          });
        })
    )
  );

  const platforms: Partial<Record<InstalledAppPlatform, PlatformCheck>> = {};
  options.platforms.forEach((platform, index) => {
    platforms[platform] = checks[index]!;
  });
  return { outcome: aggregateOutcome(checks), platforms };
}

async function checkPlatformAsync(
  projectRoot: string,
  platform: InstalledAppPlatform,
  options: InstalledAppOptions,
  deps: Required<CheckDependencies>
): Promise<PlatformCheck> {
  const appId = options.appId ?? deps.readAppId(projectRoot, platform);
  if (!appId) {
    return verdict('app-id-unknown', {
      recommendation: `The project names no ${platform === 'ios' ? 'ios.bundleIdentifier' : 'android.package'} in its static app config and has no prebuilt ${platform} project to read one from, so there is no app to look for on the device. Set it in the app config, or run "${PROGRAM_PREFIX} prebuild -p ${platform}".`,
    });
  }

  // The device read starts while the hash is computed and only awaits it at comparison time. The
  // no-op catches keep an early return on one side from surfacing the other's rejection as
  // unhandled; the awaits below still report both.
  const fingerprintPromise = deps.generateFingerprint(projectRoot, {
    platform,
    cache: options.fingerprintCache,
  });
  const expectedHash = fingerprintPromise.then((result) => {
    if (!result.hash) {
      throw new Error(result.error ?? 'no fingerprint');
    }
    return result.hash;
  });
  expectedHash.catch(() => {});
  const installedPromise = deps.readInstalled({
    platform,
    appId,
    device: options.device,
    expectedHash,
    scheme: platform === 'ios' ? deps.readScheme(projectRoot) : null,
    timeoutMs: options.timeoutMs,
  });
  installedPromise.catch(() => {});

  const fingerprint = await fingerprintPromise;
  if (!fingerprint.hash) {
    return verdict('fingerprint-unavailable', {
      recommendation: `The project fingerprint could not be computed: ${fingerprint.error ?? 'no hash was returned'}.`,
    });
  }

  // Stale generated directories need `prebuild` before the build: a plain rebuild would compile
  // the old directories and embed the new hash, and the mismatch would vanish while the problem
  // stayed. No device is needed for this, so it is decided before the installed result.
  const staleness = deps.readNativeDirectoryStaleness(projectRoot, platform, {
    sources: fingerprint.sources,
    fingerprintVersion: deps.readFingerprintVersion(projectRoot),
  });
  const prebuild = { prebuildStatus: staleness.status, prebuildChanges: staleness.changes };
  if (staleness.status === 'stale') {
    const named = formatPrebuildChanges(staleness.changes);
    return verdict('prebuild-stale', {
      currentHash: fingerprint.hash,
      fingerprintSource: fingerprint.source ?? null,
      ...prebuild,
      recommendation: `${named ? `${named} changed after the native directories were generated` : 'The native directories were generated from a different project state'}. Regenerate them, then rebuild.`,
      // Through this CLI, not `npx expo prebuild`: the marker is recorded by the passthrough here,
      // so advising the bare command would leave the next run with nothing to compare against.
      commands: [`${PROGRAM_PREFIX} prebuild -p ${platform}`, `npx expo run:${platform}`],
    });
  }

  const installed = await installedPromise;
  const check = {
    ...installedVerdict(installed, platform, fingerprint, options.device),
    ...prebuild,
  };
  return installed.hint
    ? { ...check, recommendation: `${check.recommendation} ${installed.hint}` }
    : check;
}

/** The verdict table: what each answer from the device means for this platform. */
function installedVerdict(
  installed: InstalledFingerprintResult,
  platform: InstalledAppPlatform,
  fingerprint: FingerprintResult,
  deviceFilter: string | null
): PlatformCheck {
  const current = {
    currentHash: fingerprint.hash,
    fingerprintSource: fingerprint.source ?? null,
  };
  const rebuild = [`npx expo run:${platform}`];
  switch (installed.status) {
    case 'no-device':
      return verdict('no-device', {
        ...current,
        recommendation: deviceFilter
          ? `No ${platform === 'ios' ? 'simulator or device' : 'device or emulator'} matched --device "${deviceFilter}".`
          : platform === 'ios'
            ? 'No booted iOS simulator was found. Boot one, then run this command again.'
            : 'No authorized Android device or emulator is connected.',
      });
    case 'app-not-installed':
      return verdict('app-not-installed', {
        ...current,
        device: installed.device,
        recommendation: `The app (${installed.appId}) is not installed on ${installed.device.name}. Build and install it first.`,
        commands: rebuild,
      });
    case 'no-embedded-fingerprint':
      return verdict('no-embedded-fingerprint', {
        ...current,
        device: installed.device,
        recommendation: `The installed app has no embedded fingerprint. Likely causes: it is a release build (only debug builds embed one); it was built before fingerprint embedding existed; it was built with EXPO_SKIP_FINGERPRINT_EMBED set${platform === 'ios' ? '; it was rebundled with "expo run:ios --unstable-rebundle", which removes the fingerprint' : ''}. Install a debug build to enable detection.`,
        commands: rebuild,
      });
    case 'no-response':
      return verdict('no-response', {
        ...current,
        device: installed.device,
        recommendation: `The app on ${installed.device.name} did not report its fingerprint in time. Likely causes: the phone and this computer are not on the same network; the macOS firewall or the app's Local Network permission blocks the connection; the device screen is locked; the app is a release build or lacks expo-dev-client, so it can never respond. If the build predates this check, rebuild with npx expo run:ios --device.`,
      });
    case 'ok':
      if (installed.hash === fingerprint.hash) {
        return verdict('hash-match', {
          ...current,
          device: installed.device,
          installedHash: installed.hash,
          recommendation: 'The installed app matches the project. A JS reload is enough.',
        });
      }
      return verdict('hash-mismatch', {
        ...current,
        device: installed.device,
        installedHash: installed.hash,
        recommendation: 'Native inputs changed since the installed app was built. Rebuild the app.',
        commands: rebuild,
      });
  }
}

/** Status follows from the reason; the rest is what the reader saw. */
function verdict(
  reason: CheckReason,
  fields: Partial<Omit<PlatformCheck, 'reason' | 'status'>> &
    Pick<PlatformCheck, 'recommendation'>
): PlatformCheck {
  const status: CheckStatus =
    reason === 'hash-match'
      ? 'up-to-date'
      : reason === 'hash-mismatch' || reason === 'prebuild-stale'
        ? 'rebuild-required'
        : 'unknown';
  return {
    status,
    reason,
    commands: [],
    device: null,
    installedHash: null,
    currentHash: null,
    fingerprintSource: null,
    prebuildStatus: 'unknown',
    prebuildChanges: [],
    ...fields,
  };
}

/** A platform whose device could not be looked for, which does not count while another answered. */
const UNREACHABLE: CheckReason[] = ['no-device', 'no-response', 'app-id-unknown'];

/**
 * The strongest verdict: `rebuild-required` before `unknown` before `up-to-date`. A platform with
 * no reachable device does not count while another platform produced a verdict, so a Mac with only
 * an Android emulator attached reports what that emulator says rather than a shrug about iOS.
 */
export function aggregateOutcome(checks: PlatformCheck[]): CheckStatus {
  const reachable = checks.filter((check) => !UNREACHABLE.includes(check.reason));
  const considered = reachable.length ? reachable : checks;
  for (const status of ['rebuild-required', 'unknown'] as const) {
    if (considered.some((check) => check.status === status)) {
      return status;
    }
  }
  return 'up-to-date';
}

