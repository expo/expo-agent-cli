// @ref llp/0027-everything-on-eas.rfc.md §The build is a simulator build
// The one thing this CLI reads and writes in `eas.json`: whether a build profile exists, and the
// simulator dev-client profile it adds when the EAS route needs one.
//
// `eas build:configure` writes `development`, `preview` and `production` [observed — eas-cli 23.2
// `build/configure.ts`], and `development` is a device build. A simulator — the EAS Simulator or the
// one on this desk — cannot install a device build, so `dev --eas` builds `development-simulator`
// instead, and adds it the way `eas build:dev` does when it is missing: three keys, nothing else in
// the file touched.

import fs from 'fs';
import path from 'path';

import { EAS_SIMULATOR_PROFILE } from '../toolchain/runsOn';
import { CommandError } from './errors';

/** The profile `dev --eas` adds, as `eas build:dev` writes it [observed — eas-cli 23.2]. */
export const EAS_SIMULATOR_PROFILE_CONTENTS = {
  developmentClient: true,
  distribution: 'internal',
  ios: { simulator: true },
} as const;

export function easJsonPath(projectRoot: string): string {
  return path.join(projectRoot, 'eas.json');
}

/** The parsed `eas.json`, or null when there is none or it does not parse. */
export function readEasJsonSync(projectRoot: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(easJsonPath(projectRoot), 'utf8'));
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Whether `eas.json` declares a build profile of this name. False when there is no file. */
export function hasBuildProfileSync(projectRoot: string, profile: string): boolean {
  const build = readEasJsonSync(projectRoot)?.build;
  return build != null && typeof build === 'object' && profile in (build as object);
}

/**
 * Add the simulator dev-client profile to `eas.json` when it is not there.
 *
 * Only the profile is written; every other key of the file is kept as it was. A missing file is
 * created with only that profile in it. Unreadable or invalid existing configuration is preserved
 * and reported as an error.
 *
 * @returns whether the file changed.
 */
export function ensureSimulatorProfileSync(projectRoot: string): boolean {
  const filePath = easJsonPath(projectRoot);
  let contents: string;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new CommandError(
        'EAS_JSON_READ',
        `Cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}. Fix access to eas.json and retry.`
      );
    }
    contents = '{}';
  }
  let current: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(contents);
    if (!isObject(parsed) || ('build' in parsed && !isObject(parsed.build))) {
      throw new Error('the root and build section must be JSON objects');
    }
    current = parsed;
  } catch (error) {
    throw new CommandError(
      'EAS_JSON_INVALID',
      `Cannot add the simulator profile to ${filePath}: ${error instanceof Error ? error.message : String(error)}. Fix eas.json and retry.`
    );
  }
  const build = (current.build ?? {}) as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(build, EAS_SIMULATOR_PROFILE)) {
    return false;
  }
  const next = {
    ...current,
    build: { ...build, [EAS_SIMULATOR_PROFILE]: EAS_SIMULATOR_PROFILE_CONTENTS },
  };
  fs.writeFileSync(easJsonPath(projectRoot), JSON.stringify(next, null, 2) + '\n');
  return true;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
