// @ref llp/0037-patch-command.rfc.md §`patch --upstream-plan`: a brief for the PR to `expo/expo`
// The plan for sending a saved patch to `expo/expo`, and nothing more: this CLI never forks, pushes
// or opens anything. The hard part of an upstream fix is moving it to `main` and testing it in the
// monorepo, which an agent does with `git` and `gh` and this CLI cannot do for it. What only this
// CLI knows is the mapping — the commit the package came from, where each patched file lives in the
// repository, which hunks are compiled output — so the plan is those facts and the steps. How to
// contribute (checks, changesets, the PR body) is the repository's own AGENTS.md, CONTRIBUTING.md and
// PR template: the plan links them instead of copying rules that change there.
//
// Opening a pull request publishes the diff, which can hold code of the user's app, so the run stops
// with the needs-human code and the first step is to ask the user.

import fs from 'fs';
import path from 'path';

import * as Log from '../log';
import { CommandError } from '../utils/errors';
import { detectPackageManager } from '../utils/packageManager';
import { findExecutableOnPath } from '../utils/pathLookup';
import { filesOfPatch } from './backends';
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

/** A repro is a repository people can clone: `expo/expo` bug reports ask for a link to one. */
const GITHUB_REPO_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\/.*)?$/;

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
 * Map a file of the published package to `expo/expo`.
 *
 * Native files and `src/` are the same files in the repository. `build/` is compiled from `src/`, and
 * a PR that changes `build/` alone is not a fix anyone can merge, so it names the source to port to.
 */
export function mapUpstreamFile(file: string, directory: string): UpstreamFile {
  if (file.startsWith('build/')) {
    const source = file.replace(/^build\//, 'src/').replace(/\.d\.ts$|\.js$/, '.ts');
    return { file, target: null, portTo: `${directory}/${source} (or .tsx)` };
  }
  return { file, target: `${directory}/${file}`, portTo: null };
}

/** Find the saved patch of a package among the files the package managers write. */
export function findPatchFile(root: string, packageName: string): string | null {
  const flat = packageName.replace(/\//g, '+');
  const prefixes = [
    `${packageName.replace(/\//g, '__')}@`, // pnpm, bun (scoped names are flattened)
    `${packageName}@`,
    `${flat}+`, // patch-package
    `${packageName.replace(/^@/, '').replace(/\//g, '-')}-npm-`, // yarn berry
  ];
  for (const dir of ['patches', path.join('.yarn', 'patches')]) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) {
      continue;
    }
    const match = fs
      .readdirSync(full)
      .find(
        (name) => name.endsWith('.patch') && prefixes.some((prefix) => name.startsWith(prefix))
      );
    if (match) {
      return path.join(full, match);
    }
  }
  return null;
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
  const patchFile = findPatchFile(packageManager.root, packageName);
  if (!patchFile) {
    throw new CommandError(
      'PATCH_NOT_FOUND',
      `No saved patch for ${packageName} was found in patches/ or .yarn/patches/. Save one first with "patch ${packageName}".`
    );
  }

  const directory =
    typeof manifest.repository === 'object' && typeof manifest.repository.directory === 'string'
      ? manifest.repository.directory.replace(/\/$/, '')
      : `packages/${packageName}`;
  const patchText = fs.readFileSync(patchFile, 'utf8');
  const changed = filesOfPatch(patchText);
  const files = changed.map((file) => mapUpstreamFile(file, directory));
  const platforms = nativePlatformsOfFiles(changed).map((p) =>
    p === 'ios' ? '[iOS]' : '[Android]'
  );
  const base = typeof manifest.gitHead === 'string' ? manifest.gitHead : 'main';

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
 * Compiled output is left out: `build/` is not in the repository (expo/expo CONTRIBUTING.md).
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
  const args = ['git apply', ...(strip !== 1 ? [`-p${strip}`] : []), `--directory=${directory}`];
  if (hasBuild) {
    args.push(`--exclude='${directory}/build/*'`);
  }
  args.push(quote(patchFile));
  return args.join(' ');
}

function quote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
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
        ? `The package has no gitHead, so this starts at main and the patch can need changes to apply.`
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
