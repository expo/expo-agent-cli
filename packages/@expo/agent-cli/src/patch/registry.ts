// @ref llp/0037-patch-command.rfc.md §Package-manager backends
// Where a project registers its patch files. `patch` reads it after the package manager saved a
// patch, and `patch --upstream-plan` reads it to find the patch to send: both want the file the
// next install applies, so both read the registration and not a file name.

import fs from 'fs';
import path from 'path';
import semver from 'semver';

import { CommandError } from '../utils/errors';

/** patch-package's file name: `@scope+name+1.2.3.patch`. */
export function patchPackageFileName(packageName: string, version: string): string {
  return `${packageName.replace(/\//g, '+')}+${version}.patch`;
}

function readManifest(dir: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

interface Registration {
  /** What the registration says after `<name>@`: a version, a spec, or null for any version. */
  spec: string | null;
  file: string;
}

/** `name@spec` → its name and spec; a bare `name` (pnpm: every version) has no spec. */
function splitKey(key: string): { name: string; spec: string | null } {
  const at = key.indexOf('@', 1);
  return at < 0 ? { name: key, spec: null } : { name: key.slice(0, at), spec: key.slice(at + 1) };
}

/** The `patchedDependencies` map of `pnpm-workspace.yaml`: one `key: value` line per entry. */
function pnpmWorkspacePatches(root: string): Record<string, string> {
  const file = path.join(root, 'pnpm-workspace.yaml');
  if (!fs.existsSync(file)) {
    return {};
  }
  const entries: Record<string, string> = {};
  let inside = false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inside = /^patchedDependencies:\s*$/.test(line);
      continue;
    }
    const entry = inside && /^\s+(['"]?)(.+?)\1:\s*(['"]?)(.+?)\3\s*$/.exec(line);
    if (entry) {
      entries[entry[2]!] = entry[4]!;
    }
  }
  return entries;
}

/**
 * Every patch file the project registers for a package, as its package manager recorded it:
 * `patchedDependencies` (bun and npm 12 in package.json, pnpm in pnpm-workspace.yaml or
 * package.json), a `patch:` descriptor (yarn berry), or patch-package's `<name>+<version>.patch`.
 * File names are not guessed: each manager encodes a scoped name its own way (bun `%2F`, pnpm `__`,
 * yarn `@scope-name-<protocol>-<hash>`).
 */
function registeredPatches(
  root: string,
  projectRoot: string,
  packageName: string,
  version: string
): Registration[] {
  const pkg = readManifest(root);
  const found: Registration[] = [];
  const maps = [pkg.patchedDependencies, pkg.pnpm?.patchedDependencies, pnpmWorkspacePatches(root)];
  for (const map of maps) {
    for (const [key, file] of Object.entries<unknown>(map ?? {})) {
      const { name, spec } = splitKey(key);
      if (name === packageName && typeof file === 'string') {
        found.push({ spec, file: path.resolve(root, file) });
      }
    }
  }
  // yarn 4.18.1 writes the descriptor to the workspace that depends on the package, and `~` in it
  // is the root (observed 2026-11-24).
  const manifests = projectRoot === root ? [pkg] : [pkg, readManifest(projectRoot)];
  const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'resolutions'];
  for (const value of manifests.flatMap((manifest) =>
    fields.flatMap((field) => Object.values<unknown>(manifest[field] ?? {}))
  )) {
    if (typeof value === 'string' && value.startsWith(`patch:${packageName}@`)) {
      // `patch:<name>@<spec>#~/.yarn/patches/<file>.patch`, where `~` is the root.
      const source = value.slice(value.lastIndexOf('#') + 1).split('::')[0]!;
      found.push({ spec: null, file: path.resolve(root, source.replace(/^~\//, '')) });
    }
  }
  const registered = found.filter((entry) => fs.existsSync(entry.file));
  // patch-package keeps no registration, only the file name. A leftover file must not win over a
  // patch the package manager registered, so it counts only when there is none.
  const patchPackageFile = path.join(root, 'patches', patchPackageFileName(packageName, version));
  if (!registered.length && fs.existsSync(patchPackageFile)) {
    registered.push({ spec: version, file: patchPackageFile });
  }
  return registered;
}

/**
 * How well a registration fits the installed version: 0 an exact match, 1 a range that contains it,
 * 2 a spec that is not a version (yarn's descriptor, a pnpm key with no version, a bun `file:`
 * locator). null for a version or a range the installed one is not: the manager does not apply it.
 */
function fitOf(spec: string | null, version: string): number | null {
  if (spec === null || spec === '') {
    return 2;
  }
  if (semver.valid(spec)) {
    return semver.eq(spec, version) ? 0 : null;
  }
  if (semver.validRange(spec)) {
    return semver.satisfies(version, spec) ? 1 : null;
  }
  return 2;
}

/**
 * The one patch file the package manager registered for this package at this version: the file
 * the next install applies. `projectRoot` is the workspace package, when it is not the root.
 */
export function findPatchFile(
  root: string,
  packageName: string,
  version: string,
  projectRoot: string = root
): string {
  const all = registeredPatches(root, projectRoot, packageName, version);
  const fitting = all
    .map((entry) => ({ ...entry, fit: fitOf(entry.spec, version) }))
    .filter((entry): entry is Registration & { fit: number } => entry.fit !== null);
  const best = Math.min(...fitting.map((entry) => entry.fit));
  const files = [
    ...new Set(fitting.filter((entry) => entry.fit === best).map((entry) => entry.file)),
  ];
  if (files.length === 1) {
    return files[0]!;
  }
  const listed = (entries: Registration[]) =>
    [...new Set(entries.map((entry) => path.relative(root, entry.file)))].join(', ');
  if (!files.length) {
    throw new CommandError(
      'PATCH_NOT_FOUND',
      all.length
        ? `No saved patch for ${packageName} is registered for the installed ${version}, only for other versions: ${listed(
            all
          )}. Save one for ${version} first with "patch ${packageName}".`
        : `No saved patch for ${packageName} is registered in this project. Save one first with "patch ${packageName}".`
    );
  }
  throw new CommandError(
    'PATCH_AMBIGUOUS',
    `More than one saved patch is registered for ${packageName} at the installed ${version}: ${listed(
      fitting.filter((entry) => entry.fit === best)
    )}. Remove the ones that are not in use, then run this again.`
  );
}
