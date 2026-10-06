// @ref llp/0030-local-docs.rfc.md §SDK version selection
import { PROGRAM_PREFIX } from '../programName';
import { sdkMajor } from '../project/expoGoModules';
import { CommandError } from '../utils/errors';
import { versionBundleName, versionMajor, type VersionBundleName } from './bundle';

/** Which docs version a run reads, and why that one. */
export type SdkSelection =
  | { source: 'explicit'; version: VersionBundleName }
  | { source: 'project'; version: VersionBundleName; projectSdkVersion: string }
  | {
      source: 'latest';
      version: VersionBundleName;
      /** Why the project's own SDK was not used, or null outside a project. */
      reason: string | null;
    };

export interface SdkSelectionInput {
  /** The raw `--sdk` value: `57`, `57.0.0` or `v57.0.0`. */
  flag: string | undefined;
  /** The installed `expo` version of the project, or null outside one. */
  projectSdkVersion: string | null;
  latest: VersionBundleName;
  available: VersionBundleName[];
}

/** The version `--sdk` names, or a `BAD_ARGS` error for a value that names none. */
export function parseSdkFlag(flag: string): VersionBundleName {
  const match = /^v?(\d+)(?:\.0\.0)?$/.exec(flag.trim());
  if (!match) {
    throw new CommandError(
      'BAD_ARGS',
      `--sdk takes an SDK major version such as 57, but got ${JSON.stringify(flag)}.`
    );
  }
  return versionBundleName(match[1]!);
}

/** The version a run asks for before the host is consulted: `--sdk`, else the project's SDK. */
export function requestedVersion(
  flag: string | undefined,
  projectSdkVersion: string | null
): VersionBundleName | null {
  if (flag != null) {
    return parseSdkFlag(flag);
  }
  const major = sdkMajor(projectSdkVersion);
  return major ? versionBundleName(major) : null;
}

/**
 * Whether a version is newer than every one the host had published at the last sync. Such a version
 * may have been published since, so the host is worth asking again. An older one never gets docs
 * later, so asking for it again on every search would only cost a request.
 */
export function isNewerThanKnown(version: VersionBundleName, known: VersionBundleName[]): boolean {
  return known.every((name) => versionMajor(name) < versionMajor(version));
}

export function selectSdkVersion({
  flag,
  projectSdkVersion,
  latest,
  available,
}: SdkSelectionInput): SdkSelection {
  if (flag != null) {
    const version = parseSdkFlag(flag);
    if (!available.includes(version)) {
      const error = new CommandError(
        'DOCS_SDK_UNAVAILABLE',
        `There are no docs for SDK ${version}. The docs versions that exist are ${available.join(', ')}.`
      );
      error.suggestedCommand = `${PROGRAM_PREFIX} docs:sync --sdk ${latest.replace(/^v(\d+).*$/, '$1')}`;
      throw error;
    }
    return { source: 'explicit', version };
  }

  if (projectSdkVersion == null) {
    return { source: 'latest', version: latest, reason: null };
  }
  const major = sdkMajor(projectSdkVersion);
  const version = major ? versionBundleName(major) : null;
  if (version && available.includes(version)) {
    return { source: 'project', version, projectSdkVersion };
  }
  return {
    source: 'latest',
    version: latest,
    reason: `the project's SDK ${projectSdkVersion} has no docs bundle, so these are the ${latest} docs`,
  };
}
