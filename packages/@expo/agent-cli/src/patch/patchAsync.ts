// @ref llp/0037-patch-command.rfc.md
// `patch <pkg>`: the agent has already edited `node_modules/<pkg>`; this saves the edits with the
// project's package manager, makes the native build use them, and says what to do next.

import fs from 'fs';
import path from 'path';

import { buildPatchFollowUps, followUpsEnabled, reportFollowUps } from '../followups';
import type { FollowUp } from '../followups/types';
import * as Log from '../log';
import { PROGRAM_PREFIX } from '../programName';
import { consentRerunCommand } from '../utils/consent';
import { CommandError } from '../utils/errors';
import { detectPackageManager, type PackageManagerName } from '../utils/packageManager';
import { savePatchAsync, type PatchTarget } from './backends';
import {
  addBuildFromSource,
  buildFromSourceGroup,
  isPrecompiledOn,
  nativePlatformsOfFiles,
  type BuildFromSourceChange,
  type NativePlatform,
} from './buildFromSource';
import { findLinkedFiles } from './tree';

export interface PatchOptions {
  json: boolean;
  yes: boolean;
  followups: boolean;
}

export interface PatchReport {
  projectRoot: string;
  packageManager: PackageManagerName;
  package: string;
  version: string;
  patchFile: string;
  files: string[];
  native: NativePlatform[];
  buildFromSource: BuildFromSourceChange[];
  followups: FollowUp[];
}

/** The installed copy of a package, as the project resolves it. */
export function resolveInstalledPackage(
  projectRoot: string,
  packageName: string,
  roots: string[]
): { packageDir: string; version: string; manifest: Record<string, any> } {
  for (const root of roots) {
    const packageDir = path.join(root, 'node_modules', ...packageName.split('/'));
    const manifestPath = path.join(packageDir, 'package.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return { packageDir, version: String(manifest.version), manifest };
    }
  }
  const error = new CommandError(
    'PATCH_NOT_INSTALLED',
    [
      `${packageName} is not installed in ${projectRoot}, so there is nothing to patch.`,
      `How: install it first, edit its files in node_modules/${packageName}, then run this again.`,
    ].join('\n')
  );
  error.suggestedCommand = `${PROGRAM_PREFIX} install ${packageName}`;
  throw error;
}

/** Refuse a package whose files are hard links into the store: no clean copy is left to diff. */
function assertNotLinked(
  packageDir: string,
  packageName: string,
  packageManagerName: PackageManagerName
): void {
  const linked = findLinkedFiles(packageDir);
  if (linked.length) {
    const error = new CommandError(
      'PATCH_LINKED_STORE',
      [
        `The files of ${packageName} are hard links into the ${packageManagerName} store, so the edits also changed the store, and no clean copy is left to compare them with.`,
        `Linked: ${linked.slice(0, 5).join(', ')}${
          linked.length > 5 ? `, and ${linked.length - 5} more` : ''
        }`,
        `How: copy your edited files somewhere else, delete node_modules/${packageName}, reinstall with copies instead of links (bun: "bun install --backend=copyfile"; pnpm: "pnpm install --config.package-import-method=copy"), apply the edits again, and run this again.`,
      ].join('\n')
    );
    error.data = { packageManager: packageManagerName, linkedFiles: linked.length };
    throw error;
  }
}

/** The report: one JSON object under `--json`, else the lines a person reads. */
function printReport(report: PatchReport, json: boolean): void {
  if (json) {
    Log.log(JSON.stringify(report, null, 2));
    return;
  }
  const lines = [
    `Saved the patch for ${report.package}@${report.version} with ${report.packageManager}: ${
      path.relative(report.projectRoot, report.patchFile) || report.patchFile
    }`,
    `Files: ${report.files.join(', ')}`,
  ];
  for (const change of report.buildFromSource) {
    lines.push(
      `Added ${change.added.join(', ')} to expo.autolinking.${change.platform}.buildFromSource in package.json, so the ${
        change.platform === 'ios' ? 'iOS' : 'Android'
      } build compiles the patched source instead of the precompiled binary.`
    );
  }
  Log.log(lines.join('\n'));
}

export async function patchAsync(
  projectRoot: string,
  packageName: string,
  options: PatchOptions
): Promise<void> {
  const packageManager = detectPackageManager(projectRoot);
  const { packageDir, version } = resolveInstalledPackage(projectRoot, packageName, [
    projectRoot,
    packageManager.root,
  ]);

  assertNotLinked(packageDir, packageName, packageManager.name);

  const target: PatchTarget = { projectRoot, packageManager, packageName, version, packageDir };
  const result = await savePatchAsync(target, { yes: options.yes });

  if (result.status === 'no-edits') {
    throw new CommandError(
      'PATCH_NO_EDITS',
      [
        `node_modules/${packageName} has no edits, so there is no patch to save.`,
        `How: edit the files of node_modules/${packageName} first, then run this again.`,
      ].join('\n')
    );
  }

  const native = nativePlatformsOfFiles(result.files);

  if (result.status === 'needs-consent') {
    // Work the caller did not ask for (llp/0008 §The plan is announced, not negotiated): the call
    // is fixed by adding --yes, so it is exit 1 with a `Try:` line, not a success that saved nothing.
    const error = new CommandError(
      'PATCH_NEEDS_CONSENT',
      [
        `${packageManager.name} has no patch feature of its own, so this uses patch-package, which needs these changes to package.json:`,
        ...result.projectChanges.map((change) => `  - ${change}`),
        `Nothing was written. Run the same command with --yes to save the patch and make these changes.`,
      ].join('\n')
    );
    error.suggestedCommand = consentRerunCommand(['patch', packageName]);
    error.data = { pendingChanges: result.projectChanges, files: result.files };
    throw error;
  }

  const buildFromSource = native
    .filter((platform) => isPrecompiledOn(packageName, packageDir, platform))
    .flatMap((platform) =>
      addBuildFromSource(projectRoot, buildFromSourceGroup(packageName, platform), [platform])
    );

  const followups: FollowUp[] = followUpsEnabled(options.followups)
    ? buildPatchFollowUps({
        packageName,
        native: native.length > 0,
        hashedByFingerprint: isUnder(result.patchFile, path.join(packageManager.root, 'patches')),
      })
    : [];

  const report: PatchReport = {
    projectRoot,
    packageManager: packageManager.name,
    package: packageName,
    version,
    patchFile: result.patchFile,
    files: result.files,
    native,
    buildFromSource,
    followups,
  };

  printReport(report, options.json);
  reportFollowUps('patch', followups, { json: options.json });
}

function isUnder(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
