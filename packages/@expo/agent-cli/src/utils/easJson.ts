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
 * created with only that profile in it — `eas build:configure` is the plan's own step for the
 * rest, and it runs before this does.
 *
 * @returns whether the file changed.
 */
export function ensureSimulatorProfileSync(projectRoot: string): boolean {
  if (hasBuildProfileSync(projectRoot, EAS_SIMULATOR_PROFILE)) {
    return false;
  }
  const current = readEasJsonSync(projectRoot) ?? {};
  const build =
    current.build != null && typeof current.build === 'object' && !Array.isArray(current.build)
      ? (current.build as Record<string, unknown>)
      : {};
  const next = {
    ...current,
    build: { ...build, [EAS_SIMULATOR_PROFILE]: EAS_SIMULATOR_PROFILE_CONTENTS },
  };
  fs.writeFileSync(easJsonPath(projectRoot), JSON.stringify(next, null, 2) + '\n');
  return true;
}
