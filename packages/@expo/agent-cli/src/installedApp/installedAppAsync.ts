// @ref llp/0004-smart-start-and-project-state.rfc.md §Installed-app fingerprint check
// Compare the fingerprint embedded in the installed app with the project's, per platform, and turn
// the comparison into one verdict per platform. Reported by `status`; not a command of its own.

import fs from 'fs';
import path from 'path';

import { readLastBuildRecord } from '../plan/lastBuild';
import { PROGRAM_PREFIX } from '../programName';
import { generateFingerprintAsync, type FingerprintResult } from '../project/fingerprint';
import { resolveFingerprintCliVersion } from '../project/fingerprintCache';
import { readProjectNativeDirsAsync } from '../project/nativeCode';
import { diffSources, formatChangedSources } from '../project/sourceDiff';
import { readConfiguredAppId } from '../runtime/appId';
import { CommandError } from '../utils/errors';
import { readInstalledFingerprintAndroidAsync } from './android';
import { FIRST_EMBEDDING_CONSTANTS_VERSION, readFingerprintEmbedSupport } from './embedSupport';
import { debugEvent } from './events';
import type { InstalledAppDevice, InstalledFingerprintResult } from './installedFingerprint';
import { readInstalledFingerprintIosSimulatorAsync } from './iosSimulator';
import type { InstalledAppOptions, InstalledAppPlatform } from './options';

export type CheckStatus = 'up-to-date' | 'rebuild-required' | 'unknown';

export type CheckReason =
  | 'hash-match'
  | 'hash-mismatch'
  | 'fingerprint-version-mismatch'
  | 'embed-unsupported'
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
}

/** What the apps installed on this machine's devices say about the project. */
export interface InstalledAppReport {
  /** The strongest verdict across the platforms that answered. */
  outcome: CheckStatus;
  platforms: Partial<Record<InstalledAppPlatform, PlatformCheck>>;
}

/** Reads a fingerprint off a device. Injected by the tests; the platform readers are the defaults. */
export type InstalledFingerprintReader = (input: {
  platform: InstalledAppPlatform;
  appId: string;
  device: string | null;
  expectedHash: string;
}) => Promise<InstalledFingerprintResult>;

export interface CheckDependencies {
  readInstalled?: InstalledFingerprintReader;
  generateFingerprint?: typeof generateFingerprintAsync;
  readAppId?: typeof readConfiguredAppId;
  readFingerprintVersion?: typeof resolveFingerprintCliVersion;
  readEmbedSupport?: typeof readFingerprintEmbedSupport;
  readUnrecordedGeneratedDir?: typeof hasUnrecordedGeneratedDirAsync;
}

/**
 * Whether a platform's native directory is generated (not checked in) and no build of it was
 * recorded by this CLI. `dev` prebuilds when the app config or a plugin moved; a build made outside
 * it may have compiled a stale directory, and the fingerprint cannot tell, because on a CNG project
 * it hashes the inputs rather than the generated code.
 */
async function hasUnrecordedGeneratedDirAsync(
  projectRoot: string,
  platform: InstalledAppPlatform
): Promise<boolean> {
  if (!fs.existsSync(path.join(projectRoot, platform))) {
    return false;
  }
  const checkedIn = (await readProjectNativeDirsAsync(projectRoot))[platform];
  return !checkedIn && readLastBuildRecord(projectRoot)[platform] == null;
}

const defaultReader: InstalledFingerprintReader = ({ platform, appId, device, expectedHash }) =>
  platform === 'ios'
    ? readInstalledFingerprintIosSimulatorAsync({
        appId,
        device: device ?? undefined,
        expectedHash,
      })
    : readInstalledFingerprintAndroidAsync({ appId, device: device ?? undefined, expectedHash });

export async function checkInstalledAppAsync(
  projectRoot: string,
  options: InstalledAppOptions,
  {
    readInstalled = defaultReader,
    generateFingerprint = generateFingerprintAsync,
    readAppId = readConfiguredAppId,
    readFingerprintVersion = resolveFingerprintCliVersion,
    readEmbedSupport = readFingerprintEmbedSupport,
    readUnrecordedGeneratedDir = hasUnrecordedGeneratedDirAsync,
  }: CheckDependencies = {}
): Promise<InstalledAppReport> {
  const deps = {
    readInstalled,
    generateFingerprint,
    readAppId,
    readFingerprintVersion,
    readEmbedSupport,
    readUnrecordedGeneratedDir,
  };
  const checks = await Promise.all(
    options.platforms.map((platform) =>
      checkPlatformAsync(projectRoot, platform, options, deps).catch((error: unknown) => {
        // Every platform this machine might reach is checked, so a missing device tool is one
        // platform without a device rather than a failure of the report.
        if (error instanceof CommandError) {
          return verdict('no-device', { recommendation: error.message });
        }
        debugEvent('platform_check_failed', { platform, error: debugEvent.error(error as Error) });
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
  // First, because it makes everything below pointless: a build on an older SDK carries no
  // fingerprint, so there is nothing on the device to compare and a rebuild would not add one.
  const embed = deps.readEmbedSupport(projectRoot);
  if (!embed.supported) {
    return verdict('embed-unsupported', {
      recommendation: embed.version
        ? `The project's expo-constants ${embed.version} does not embed app.fingerprint in a build; expo-constants ${FIRST_EMBEDDING_CONSTANTS_VERSION} and later do. There is nothing on the device to compare, so the installed app cannot be checked on this SDK.`
        : 'expo-constants is not installed, so no build of this project embeds app.fingerprint and the installed app cannot be checked.',
    });
  }

  const appId = options.appId ?? deps.readAppId(projectRoot, platform);
  if (!appId) {
    return verdict('app-id-unknown', {
      recommendation:
        platform === 'ios'
          ? 'The project names no ios.bundleIdentifier in its static app config, so there is no app to look for on the device. Set it in the app config.'
          : `The project names no android.package in its static app config and has no prebuilt android project to read one from, so there is no app to look for on the device. Set it in the app config, or run "${PROGRAM_PREFIX} prebuild -p android".`,
    });
  }

  const fingerprint = await deps.generateFingerprint(projectRoot, {
    platform,
    cache: options.fingerprintCache,
  });
  if (!fingerprint.hash) {
    return verdict('fingerprint-unavailable', {
      recommendation: `The project fingerprint could not be computed: ${fingerprint.error ?? 'no hash was returned'}.`,
    });
  }

  // The device is read last, once the verdict is known to need it: a read has a cost, and on a
  // phone it has a side effect.
  const installed = await deps.readInstalled({
    platform,
    appId,
    device: options.device,
    expectedHash: fingerprint.hash,
  });
  const matched = installed.status === 'ok' && installed.hash === fingerprint.hash;
  const check = installedVerdict(installed, {
    platform,
    fingerprint,
    deviceFilter: options.device,
    fingerprintVersion: deps.readFingerprintVersion(projectRoot),
    unrecordedGeneratedDir:
      matched && (await deps.readUnrecordedGeneratedDir(projectRoot, platform)),
  });
  return installed.hint
    ? { ...check, recommendation: `${check.recommendation} ${installed.hint}` }
    : check;
}

/** The verdict table: what each answer from the device means for this platform. */
function installedVerdict(
  installed: InstalledFingerprintResult,
  project: {
    platform: InstalledAppPlatform;
    fingerprint: FingerprintResult;
    deviceFilter: string | null;
    /** The `@expo/fingerprint` version the project hashes with, or null when it cannot be read. */
    fingerprintVersion: string | null;
    /** A generated native directory this CLI never built: see {@link hasUnrecordedGeneratedDirAsync}. */
    unrecordedGeneratedDir: boolean;
  }
): PlatformCheck {
  const { platform, fingerprint, deviceFilter } = project;
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
        recommendation: `The app on ${installed.device.name} did not report its fingerprint in time. Likely causes: the device and this computer are not on the same network; a firewall or the app's Local Network permission blocks the connection; the device screen is locked; the app is a release build or lacks expo-dev-client, so it can never respond. If the build predates this check, rebuild with npx expo run:${platform}${platform === 'ios' ? ' --device' : ''}.`,
      });
    case 'ok': {
      const found = { ...current, device: installed.device, installedHash: installed.hash };
      // An equal hash settles it whatever produced it.
      if (installed.hash === fingerprint.hash) {
        return verdict('hash-match', {
          ...found,
          recommendation: project.unrecordedGeneratedDir
            ? `The installed app matches the project. It was not built by this CLI: if the app config or a config plugin changed since the last prebuild, run "${PROGRAM_PREFIX} prebuild -p ${platform}" before trusting it. Otherwise a JS reload is enough.`
            : 'The installed app matches the project. A JS reload is enough.',
        });
      }
      // Two `@expo/fingerprint` versions can hash the same project differently, so differing
      // hashes from two known, different versions prove nothing. A null version — a build that
      // embedded none — still compares: "cannot tell" is not "different".
      const embeddedVersion = installed.fingerprintVersion;
      if (
        embeddedVersion &&
        project.fingerprintVersion &&
        embeddedVersion !== project.fingerprintVersion
      ) {
        return verdict('fingerprint-version-mismatch', {
          ...found,
          recommendation: `The installed app was fingerprinted by @expo/fingerprint ${embeddedVersion} and this project uses ${project.fingerprintVersion}, so the two hashes cannot be compared. An unchanged project hashes differently across a version bump, so the installed app may well be current. Rebuild only if you need a definite answer.`,
        });
      }
      // The embedded file carries the sources behind its hash, so a mismatch can name the input
      // that moved. Without them the wording stays generic rather than guessing.
      const moved =
        installed.sources?.length && fingerprint.sources?.length
          ? formatChangedSources(diffSources(installed.sources, fingerprint.sources))
          : '';
      return verdict('hash-mismatch', {
        ...found,
        recommendation: moved
          ? `${moved} changed since the installed app was built. Rebuild the app.`
          : 'Native inputs changed since the installed app was built. Rebuild the app.',
        commands: rebuild,
      });
    }
  }
}

/** Status follows from the reason; the rest is what the reader saw. */
function verdict(
  reason: CheckReason,
  fields: Partial<Omit<PlatformCheck, 'reason' | 'status'>> & Pick<PlatformCheck, 'recommendation'>
): PlatformCheck {
  const status: CheckStatus =
    reason === 'hash-match'
      ? 'up-to-date'
      : reason === 'hash-mismatch'
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
    ...fields,
  };
}

/**
 * A platform whose device could not be looked for, which does not count while another answered.
 * Not `no-response`: that device was found and its app did not answer, which is as uncertain as
 * `no-embedded-fingerprint` and must weigh the same.
 */
const UNREACHABLE: CheckReason[] = ['no-device', 'app-id-unknown'];

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
