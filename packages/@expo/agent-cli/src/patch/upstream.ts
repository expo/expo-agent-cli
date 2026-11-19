// @ref llp/0037-patch-command.rfc.md §`patch --upstream-plan`: a brief for the PR to `expo/expo`
// The plan for sending a saved patch to `expo/expo`; it opens nothing. The run exits 0: the steps
// are agent work after the user says yes, and llp/0010 keeps exit 7 for a step only a person can finish.

import fs from 'fs';
import path from 'path';
import semver from 'semver';

import * as Log from '../log';
import { quoteArgument } from '../utils/consent';
import { CommandError } from '../utils/errors';
import { detectPackageManager } from '../utils/packageManager';
import { findExecutableOnPath } from '../utils/pathLookup';
import { nativePlatformsOfFiles } from './buildFromSource';
import { isExpoRepoPackage, resolveInstalledPackage } from './patchAsync';

export interface UpstreamFile {
  /** Path in the installed package. */
  file: string;
  /** Path in `expo/expo`, or null when the file is compiled output that has to be ported by hand. */
  target: string | null;
  /** Where the change has to be made instead, for compiled output. */
  portTo: string | null;
}

export interface UpstreamPlan {
  package: string;
  version: string;
  repository: 'expo/expo';
  patchFile: string;
  /** The commit the package was published from, when its manifest says so; `main` otherwise. */
  base: string;
  files: UpstreamFile[];
  /** The platforms the diff touches, as the `[iOS]` / `[Android]` tags `expo/expo` uses. */
  platforms: string[];
  /** The URL of the GitHub repository with the minimal repro, from `--repro`. */
  repro: string | null;
  /** How to make a minimal repro and upload it. The agent follows it when `repro` is null. */
  reproGuide: string[];
  /** Whether `gh` is on PATH. Without it, the steps use git and github.com pages instead. */
  gh: boolean;
  /** What has to be done before the PR can open. Empty when nothing. */
  missing: string[];
  /** The command that applies the saved patch inside a clone of `expo/expo`, from its root. */
  applyCommand: string;
  /** What the agent does, in order. The first one is asking the user. */
  steps: string[];
  /** The `expo/expo` files that say how to contribute. The agent reads and follows them. */
  guides: string[];
  /** The `expo/expo` pull request template. The PR body keeps its headings. */
  prTemplate: string;
  /** The `expo/expo` bug report form. The repro README and an issue fill its fields. */
  issueTemplate: string;
}

const UPSTREAM_BLOB = 'https://github.com/expo/expo/blob/main';
export const UPSTREAM_GUIDES = [`${UPSTREAM_BLOB}/AGENTS.md`, `${UPSTREAM_BLOB}/CONTRIBUTING.md`];
export const UPSTREAM_PR_TEMPLATE = `${UPSTREAM_BLOB}/.github/PULL_REQUEST_TEMPLATE`;
const UPSTREAM_ISSUE_URL = 'https://github.com/expo/expo/issues/new?template=0-bug_report.yml';
export const UPSTREAM_ISSUE_TEMPLATE = `${UPSTREAM_BLOB}/.github/ISSUE_TEMPLATE/0-bug_report.yml`;
/** The fields of the `expo/expo` bug report form, in its order. */
const ISSUE_FIELDS = `"Minimal reproducible example" (the repository URL), "Steps to reproduce" (the platforms, the environment, the package manager, what you expect and what happens), "Environment" (the output of "npx expo-env-info") and "Expo Doctor Diagnostics" (the output of "npx expo-doctor@latest")`;

/**
 * A repro is a repository people can clone: `expo/expo` bug reports ask for a link to one. So only
 * the repository URL, not an issue, a file or a pull request in it.
 */
const GITHUB_REPO_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(?:\.git)?\/?$/;

/** `repository.directory` goes into a shell line, so it is a plain relative path or nothing. */
const REPOSITORY_DIRECTORY = /^(?!.*(?:^|\/)\.\.(?:\/|$))[\w@.+-]+(?:\/[\w@.+-]+)*$/;

/** Where the package lives in `expo/expo`: its `repository.directory`, checked. */
export function repositoryDirectory(manifest: Record<string, any>, packageName: string): string {
  const raw: unknown =
    typeof manifest.repository === 'object' ? manifest.repository?.directory : undefined;
  if (typeof raw !== 'string') {
    // Not `packages/<npm name>`: the folder need not be the npm name, and a wrong guess applies
    // the patch to another package.
    throw new CommandError(
      'PATCH_BAD_REPOSITORY',
      `The package.json of ${packageName} has no "repository.directory", so the CLI does not know where in expo/expo the package lives.`
    );
  }
  const directory = raw.replace(/\/$/, '');
  if (!REPOSITORY_DIRECTORY.test(directory)) {
    throw new CommandError(
      'PATCH_BAD_REPOSITORY',
      `The "repository.directory" of ${packageName} is not a plain relative path ("${directory}"), so there is no safe place in expo/expo to apply the patch.`
    );
  }
  return directory;
}

export function assertReproUrl(repro: string): string {
  const url = repro.trim();
  if (!GITHUB_REPO_URL.test(url)) {
    throw new CommandError(
      'BAD_ARGS',
      [
        `--repro takes the URL of a GitHub repository with the minimal repro, not "${repro}".`,
        `How: make the repro as the plan's repro guide says, upload it, then pass its URL, e.g. --repro https://github.com/<user>/<repo>.`,
      ].join('\n')
    );
  }
  return url;
}

/**
 * The commit to start the fix from: `gitHead` when it is a commit sha, else `main`. Nothing else is
 * accepted, because the value goes into a shell line, and a branch name would not check out.
 */
export function upstreamBase(manifest: Record<string, any>): string {
  const gitHead: unknown = manifest.gitHead;
  return typeof gitHead === 'string' && /^[0-9a-f]{40}$/.test(gitHead) ? gitHead : 'main';
}

/**
 * Map a file of the published package to `expo/expo`.
 *
 * Native files and `src/` are the same files in the repository. `build/` is compiled from the `src/` beside it, and
 * a PR that changes `build/` alone is not a fix anyone can merge, so it names the source to port to.
 */
export function mapUpstreamFile(file: string, directory: string): UpstreamFile {
  // A `build/` directory at any depth (`build/`, `plugin/build/`): expo/expo ignores
  // `/packages/**/build/`. `android/build.gradle` is not one.
  const compiled = /(^|\/)build\//.exec(file);
  if (compiled) {
    const source = `${file.slice(0, compiled.index)}${compiled[1]}src/${file.slice(
      compiled.index + compiled[0].length
    )}`.replace(/\.d\.ts$|\.js$/, '.ts');
    return { file, target: null, portTo: `${directory}/${source} (or .tsx)` };
  }
  return { file, target: `${directory}/${file}`, portTo: null };
}

/** The files a patch changes, relative to the package root. */
export function filesOfPatch(patch: string): string[] {
  const files = new Set<string>();
  // `+++ b/<file>` names the file; for a deleted file it is /dev/null and `--- a/<file>` does.
  // git-style patches and npm 12's plain unified diffs both have these lines.
  let removed: string | null = null;
  for (const line of patch.split(/\r?\n/)) {
    const from = /^--- (?:a\/)?(.+?)\t?$/.exec(line);
    if (from) {
      removed = from[1] === '/dev/null' ? null : from[1]!;
      continue;
    }
    const to = /^\+\+\+ (?:b\/)?(.+?)\t?$/.exec(line);
    if (to) {
      const file = to[1] === '/dev/null' ? removed : to[1]!;
      if (file) {
        files.add(file.trim().replace(/^node_modules\/(?:@[^/]+\/)?[^/]+\//, ''));
      }
    }
  }
  return [...files].sort();
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
function registeredPatches(root: string, packageName: string, version: string): Registration[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
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
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'resolutions']) {
    for (const value of Object.values<unknown>(pkg[field] ?? {})) {
      if (typeof value === 'string' && value.startsWith(`patch:${packageName}@`)) {
        // `patch:<name>@<spec>#~/.yarn/patches/<file>.patch`, where `~` is the project root.
        const source = value.slice(value.lastIndexOf('#') + 1).split('::')[0]!;
        found.push({ spec: null, file: path.resolve(root, source.replace(/^~\//, '')) });
      }
    }
  }
  const registered = found.filter((entry) => fs.existsSync(entry.file));
  // patch-package keeps no registration, only the file name. A leftover file must not win over a
  // patch the package manager registered, so it counts only when there is none.
  const patchPackageFile = path.join(
    root,
    'patches',
    `${packageName.replace(/\//g, '+')}+${version}.patch`
  );
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

/** The one registered patch file of this package at this version. */
export function findPatchFile(root: string, packageName: string, version: string): string {
  const all = registeredPatches(root, packageName, version);
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

export function planUpstream(
  projectRoot: string,
  packageName: string,
  { repro }: { repro: string | null }
): UpstreamPlan {
  const packageManager = detectPackageManager(projectRoot);
  const { version, manifest } = resolveInstalledPackage(projectRoot, packageName, [
    projectRoot,
    packageManager.root,
  ]);
  if (!isExpoRepoPackage(manifest)) {
    throw new CommandError(
      'PATCH_NOT_UPSTREAM',
      `${packageName} does not come from expo/expo (its package.json "repository" says otherwise), so there is no Expo pull request to plan.`
    );
  }
  const patchFile = findPatchFile(packageManager.root, packageName, version);

  const directory = repositoryDirectory(manifest, packageName);
  const patchText = fs.readFileSync(patchFile, 'utf8');
  const changed = filesOfPatch(patchText);
  const files = changed.map((file) => mapUpstreamFile(file, directory));
  const platforms = nativePlatformsOfFiles(changed).map((p) =>
    p === 'ios' ? '[iOS]' : '[Android]'
  );
  const base = upstreamBase(manifest);

  const missing: string[] = [];
  const unported = files.filter((file) => file.portTo);
  if (unported.length) {
    missing.push(
      `Port the compiled-output changes to source: ${unported
        .map((file) => `${file.file} → ${file.portTo}`)
        .join('; ')}.`
    );
  }
  const reproUrl = repro ? assertReproUrl(repro) : null;
  if (!reproUrl) {
    missing.push(
      'A minimal repro in a public GitHub repository. Make it as the repro guide says, then pass its URL with --repro <url>.'
    );
  }
  const gh = findExecutableOnPath('gh') !== null;
  const sdk = expoSdkOf(projectRoot, packageManager.root);

  const applyCommand = buildApplyCommand(
    patchText,
    patchFile,
    packageName,
    directory,
    unported.length > 0
  );

  return {
    package: packageName,
    version,
    repository: 'expo/expo',
    patchFile,
    base,
    files,
    platforms,
    repro: reproUrl,
    reproGuide: buildReproGuide({ packageName, version, sdk, gh }),
    gh,
    missing,
    applyCommand,
    steps: buildSteps({
      packageName,
      version,
      directory,
      base,
      applyCommand,
      unported,
      repro: reproUrl,
      gh,
    }),
    guides: UPSTREAM_GUIDES,
    prTemplate: UPSTREAM_PR_TEMPLATE,
    issueTemplate: UPSTREAM_ISSUE_TEMPLATE,
  };
}

/**
 * `git apply` for the saved patch, run from the root of an `expo/expo` clone.
 *
 * bun, pnpm and yarn write paths from the package root (`a/ios/…`); patch-package writes them from
 * the project (`a/node_modules/<pkg>/ios/…`), so its prefix is stripped by the extra segments.
 * Compiled output is left out: no `build/` directory is in the repository. `git apply` 2.54 does not
 * match a top-level `build/` with the nested pattern, so that one has a pattern of its own.
 */
export function buildApplyCommand(
  patchText: string,
  patchFile: string,
  packageName: string,
  directory: string,
  hasBuild: boolean
): string {
  const fromProject = /^diff --git a\/node_modules\//m.test(patchText);
  const strip = fromProject ? 2 + packageName.split('/').length : 1;
  const args = [
    'git apply',
    ...(strip !== 1 ? [`-p${strip}`] : []),
    quoteArgument(`--directory=${directory}`),
  ];
  if (hasBuild) {
    args.push(
      quoteArgument(`--exclude=${directory}/build/**`),
      quoteArgument(`--exclude=${directory}/**/build/**`)
    );
  }
  args.push(quoteArgument(patchFile));
  return args.join(' ');
}

/** The Expo SDK of the project, from its installed `expo` (the major version is the SDK). */
function expoSdkOf(projectRoot: string, workspaceRoot: string): number | null {
  try {
    const { version } = resolveInstalledPackage(projectRoot, 'expo', [projectRoot, workspaceRoot]);
    const major = Number.parseInt(version, 10);
    return Number.isFinite(major) ? major : null;
  } catch {
    return null;
  }
}

/**
 * How to make the repro. A minimal reproducible example is minimal (only what shows the bug),
 * complete (it runs from a fresh clone) and reproducible (it shows the bug every time). `expo/expo`
 * bug reports ask for a link to a repository like that, made from a new blank app.
 */
function buildReproGuide({
  packageName,
  version,
  sdk,
  gh,
}: {
  packageName: string;
  version: string;
  sdk: number | null;
  gh: boolean;
}): string[] {
  return [
    `Read ${UPSTREAM_ISSUE_TEMPLATE}. The repro is what its "Minimal reproducible example" field asks for, and the README fills its other fields.`,
    `Name it for the bug, not for the package alone: the package and what fails, in a few words, e.g. "expo-image-crash-on-rotate". The name is the repository name too.`,
    `Start from a new app on the same SDK: "npx create-expo-app@latest <name> --template ${
      sdk ? `blank@sdk-${sdk}` : 'blank'
    }". Do not copy the user's app: it can hold private code, keys and assets.`,
    `Keep it minimal: add only ${packageName}@${version} and the fewest lines of code that show the bug. Then remove one thing at a time, and check that the bug stays. If the bug needs a library that Expo does not maintain, try to show it without that library.`,
    `Do not apply the patch. The repro shows the bug, and the pull request shows the fix.`,
    `Make it complete: everything it needs to run is in the repository. No private packages, no .env files, no keys, and no paths of this machine.`,
    `Make it reproducible: clone it into a new directory, install, run it, and see the bug. Run "npx expo-doctor@latest" in it and fix the errors that it shows.`,
    `Write a README with the fields of the bug report form: ${ISSUE_FIELDS}.`,
    gh
      ? `Upload it to a public repository: "gh repo create <name> --public --source . --push". Ask the user first, because the repository is public.`
      : `Upload it to a public repository. Ask the user first, because the repository is public. gh is not installed, so the user makes an empty public repository at https://github.com/new. Then: "git remote add origin <url>" and "git push -u origin main".`,
    `Run this plan again with "--repro <the repository URL>".`,
  ];
}

function buildSteps({
  packageName,
  version,
  directory,
  base,
  applyCommand,
  unported,
  repro,
  gh,
}: {
  packageName: string;
  version: string;
  directory: string;
  base: string;
  applyCommand: string;
  unported: UpstreamFile[];
  repro: string | null;
  gh: boolean;
}): string[] {
  const branch = `fix/${packageName.replace(/^@/, '').replace(/\//g, '-')}`;
  const steps = [
    `Ask the user first. Show them this plan and the patch, and ask if they want a pull request to expo/expo, an issue with the repro instead, or nothing. A pull request, an issue and the repro repository are public, and the patch can hold code of their app. Stop here unless they say yes.`,
    `Read ${UPSTREAM_GUIDES.join(
      ' and '
    )}, and ${directory}/AGENTS.md if it exists. Follow them in every step below. Where they and this plan differ, they win. For example, they say how to record the change (a changeset), which checks to run, and how to write the commit and the pull request.`,
    repro
      ? `Check the repro: clone ${repro}, run it without the patch, and see the bug. If you do not see it, fix the repro first (see the repro guide).`
      : `Make a minimal repro and upload it to a public GitHub repository, as the repro guide says. Then run this plan again with --repro <url>.`,
    gh
      ? `Get the repository: "gh repo fork expo/expo --clone=false", then clone the fork ("git clone --filter=blob:none" keeps it small) and add expo/expo as the "upstream" remote.`
      : `Get the repository. gh is not installed, so ask the user to fork expo/expo at https://github.com/expo/expo/fork (or to install gh from https://cli.github.com and run "gh auth login"). Then clone the fork ("git clone --filter=blob:none" keeps it small) and add https://github.com/expo/expo.git as the "upstream" remote.`,
    `Start from the version the patch was made against: "git fetch upstream ${
      base === 'main' ? 'main' : base
    }" and "git switch -c ${branch} ${base === 'main' ? 'upstream/main' : base}". ${
      base === 'main'
        ? `The package has no gitHead commit, so this starts at main and the patch can need changes to apply.`
        : `This is the commit ${packageName}@${version} was published from.`
    }`,
    `Apply the patch from the repository root: ${applyCommand}`,
  ];
  if (unported.length) {
    steps.push(
      `Make the compiled-output changes in source, by hand: ${unported
        .map((file) => `${file.file} → ${file.portTo}`)
        .join('; ')}. build/ is not in the repository.`
    );
  }
  steps.push(
    `Move the fix to main: "git rebase upstream/main". If main already fixes the bug, stop and tell the user to upgrade ${packageName} instead.`,
    `Check and record the change as AGENTS.md says (for example "et check-packages ${packageName}" and a changeset).`,
    gh
      ? `Write the body from ${UPSTREAM_PR_TEMPLATE}: keep its headings, fill each section as AGENTS.md says, and put the repro URL and its steps in Test Plan. Push the branch to the fork, then run "gh pr create --draft --repo expo/expo --body-file <file>". For an issue instead: write a body with the fields of ${UPSTREAM_ISSUE_TEMPLATE}, then run "gh issue create --repo expo/expo --title <title> --body-file <file>".`
      : `Write the body from ${UPSTREAM_PR_TEMPLATE}: keep its headings, fill each section as AGENTS.md says, and put the repro URL and its steps in Test Plan. Push the branch to the fork with git. gh is not installed, so give the user the body and this link: https://github.com/expo/expo/compare/main...<fork owner>:${branch}?expand=1. They paste the body and pick "Create draft pull request". For an issue instead, give them ${UPSTREAM_ISSUE_URL} and the text for each field: ${ISSUE_FIELDS}.`
  );
  return steps;
}

export function printUpstreamPlan(plan: UpstreamPlan, { json }: { json: boolean }): void {
  if (json) {
    Log.log(JSON.stringify({ upstream: plan }, null, 2));
    return;
  }
  Log.log(
    [
      `Upstream plan: ${plan.package}@${plan.version} → expo/expo. Nothing was opened or pushed.`,
      ``,
      `Patch:     ${plan.patchFile}`,
      `Base:      ${plan.base}`,
      `Files:`,
      ...plan.files.map((file) => `  ${file.file} → ${file.target ?? `port to ${file.portTo}`}`),
      `Platforms: ${plan.platforms.join(' ') || 'none (JavaScript only)'}`,
      `Repro:     ${plan.repro ?? 'missing'}`,
      `gh:        ${
        plan.gh ? 'installed' : 'not installed (the steps use git and github.com pages)'
      }`,
      ...(plan.missing.length
        ? [
            ``,
            `Missing before a pull request can open:`,
            ...plan.missing.map((item) => `  - ${item}`),
          ]
        : []),
      ``,
      `Steps:`,
      ...plan.steps.map((step, index) => `  ${index + 1}. ${step}`),
      ...(plan.repro
        ? []
        : [``, `Repro guide:`, ...plan.reproGuide.map((item, index) => `  ${index + 1}. ${item}`)]),
      ``,
      `Follow: ${plan.guides.join(', ')}`,
      `Pull request template: ${plan.prTemplate}`,
      `Bug report form: ${plan.issueTemplate}`,
    ].join('\n')
  );
}
