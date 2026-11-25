// @ref llp/0037-patch-command.rfc.md §`patch --upstream-plan`: a brief for the PR to `expo/expo`
// The plan for sending a saved patch to `expo/expo`; it opens nothing. The run exits 0: the steps
// are agent work after the user says yes, and llp/0010 keeps exit 7 for a step only a person can finish.

import fs from 'fs';

import * as Log from '../log';
import { quoteArgument } from '../utils/consent';
import { CommandError } from '../utils/errors';
import { detectPackageManager } from './packageManager';
import { nativePlatformsOfFiles } from './buildFromSource';
import { isExpoRepoPackage, resolveInstalledPackage } from './installed';
import { findPatchFile } from './registry';

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
  /** The Expo SDK of the project: the repro starts from a new app on it. */
  sdk: number | null;
  /** What has to be done before the PR can open. Empty when nothing. */
  missing: string[];
  /** The commands, in a clone of `expo/expo` with an `upstream` remote, that make the fix branch at `base`. */
  startCommands: string[];
  /** The command that applies the saved patch inside a clone of `expo/expo`, from its root. */
  applyCommand: string;
  /** What only this plan knows, in order. The first one is asking the user; the guides say the rest. */
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
export const UPSTREAM_ISSUE_TEMPLATE = `${UPSTREAM_BLOB}/.github/ISSUE_TEMPLATE/0-bug_report.yml`;

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

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/**
 * The path of a `---` or `+++` header, or null for /dev/null. Git puts a path in C quotes when it
 * holds a quote, a backslash or a control character, and also non-ASCII unless core.quotepath is
 * false (`"a/ios/caf\303\251.swift"`). The octal escapes are the bytes of UTF-8.
 */
function headerPath(text: string, prefix: string): string | null {
  if (text === '/dev/null') {
    return null;
  }
  let file = text;
  if (text.length > 1 && text.startsWith('"') && text.endsWith('"')) {
    // With a capture group, split gives the text between escapes and each escape.
    const parts = text.slice(1, -1).split(/(\\(?:[0-7]{3}|.))/);
    file = Buffer.concat(
      parts.map((part, index) => {
        if (index % 2 === 0) {
          return Buffer.from(part, 'utf8');
        }
        const escape = part.slice(1);
        return Buffer.from([
          escape.length === 3 ? parseInt(escape, 8) : (C_ESCAPES[escape] ?? escape.charCodeAt(0)),
        ]);
      })
    ).toString('utf8');
  }
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

/** The files a patch changes, relative to the package root. */
export function filesOfPatch(patch: string): string[] {
  const files = new Set<string>();
  // `+++ b/<file>` names the file; for a deleted file it is /dev/null and `--- a/<file>` does.
  // git-style patches and npm 12's plain unified diffs both have these lines. Inside a hunk, an
  // added `++ b/x` is the line `+++ b/x`, so the hunk's line counts from `@@` say where it ends.
  let removed: string | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of patch.split(/\r?\n/)) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('-')) {
        oldLeft--;
      } else if (line.startsWith('+')) {
        newLeft--;
      } else if (!line.startsWith('\\')) {
        // Context, or an empty line for an empty context line.
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      continue;
    }
    const from = /^--- (.+?)\t?$/.exec(line);
    if (from) {
      removed = headerPath(from[1]!, 'a/');
      continue;
    }
    const to = /^\+\+\+ (.+?)\t?$/.exec(line);
    if (to) {
      const file = to[1] === '/dev/null' ? removed : headerPath(to[1]!, 'b/');
      if (file) {
        files.add(file.trim().replace(/^node_modules\/(?:@[^/]+\/)?[^/]+\//, ''));
      }
    }
  }
  return [...files].sort();
}

export function planUpstream(
  projectRoot: string,
  packageName: string,
  { repro }: { repro: string | null }
): UpstreamPlan {
  const packageManager = detectPackageManager(projectRoot);
  const { version, manifest } = resolveInstalledPackage(
    projectRoot,
    packageName,
    packageManager.root
  );
  if (!isExpoRepoPackage(manifest)) {
    throw new CommandError(
      'PATCH_NOT_UPSTREAM',
      `${packageName} does not come from expo/expo (its package.json "repository" says otherwise), so there is no Expo pull request to plan.`
    );
  }
  const patchFile = findPatchFile(packageManager.root, packageName, version, projectRoot);

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
      'A minimal repro in a public GitHub repository, as the bug report form asks. Pass its URL with --repro <url>.'
    );
  }
  const sdk = expoSdkOf(projectRoot, packageManager.root);
  const start = startCommands(base, upstreamBranch(packageName));

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
    sdk,
    missing,
    startCommands: start,
    applyCommand,
    steps: buildSteps({
      packageName,
      directory,
      sdk,
      start,
      applyCommand,
      unported,
      repro: reproUrl,
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
  // Git C-quotes a path with a quote, a backslash, a control character or (with core.quotepath)
  // non-ASCII: `diff --git "a/node_modules/…"`. The prefix stays literal inside the quotes.
  const fromProject = /^diff --git "?a\/node_modules\//m.test(patchText);
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
    const { version } = resolveInstalledPackage(projectRoot, 'expo', workspaceRoot);
    const major = Number.parseInt(version, 10);
    return Number.isFinite(major) ? major : null;
  } catch {
    return null;
  }
}

/**
 * The commands that make the fix branch at `base`. They always fetch main as well, so
 * `upstream/main` exists for the rebase step: a fetch of a sha alone updates only FETCH_HEAD.
 */
export function startCommands(base: string, branch: string): string[] {
  return base === 'main'
    ? ['git fetch upstream main', `git switch -c ${branch} upstream/main`]
    : [`git fetch upstream main ${base}`, `git switch -c ${branch} ${base}`];
}

/**
 * The fix branch for a package. It goes into a shell line and a URL, so only characters of a
 * published npm name that git accepts in a ref are kept: a scope `/` and anything else become `-`.
 */
export function upstreamBranch(packageName: string): string {
  const name = packageName
    .replace(/^@/, '')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|(?:\.lock|\.)+$/g, '');
  return `fix/${name || 'package'}`;
}

/**
 * Only what this plan knows that the `expo/expo` guides cannot: asking first, the repro on the
 * project's SDK, the base, the apply command, the files to port, and the check against main. How
 * to fork, branch, check, record and write the pull request is in the guides.
 */
function buildSteps({
  packageName,
  directory,
  sdk,
  start,
  applyCommand,
  unported,
  repro,
}: {
  packageName: string;
  directory: string;
  sdk: number | null;
  start: string[];
  applyCommand: string;
  unported: UpstreamFile[];
  repro: string | null;
}): string[] {
  const steps = [
    `Ask the user first: a pull request to expo/expo, an issue with the repro instead, or nothing. Show them this plan and the patch. The pull request, the issue and the repro repository are public, and the patch can hold code of their app. Stop here unless they say yes.`,
    `Read and follow ${UPSTREAM_GUIDES.join(' and ')}, and ${directory}/AGENTS.md if it exists. Where they and this plan differ, they win.`,
    repro
      ? `Clone ${repro}, run it without the patch, and check that it shows the bug.`
      : `Make a minimal repro from a new app ("npx create-expo-app@latest <name> --template ${
          sdk ? `blank@sdk-${sdk}` : 'blank'
        }"), without the patch, as ${UPSTREAM_ISSUE_TEMPLATE} asks. Upload it to a public GitHub repository, then run this plan again with --repro <url>.`,
    `In a clone of your fork of expo/expo, with expo/expo as the "upstream" remote: ${start
      .map((command) => `"${command}"`)
      .join(', then ')}.`,
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
    `"git rebase upstream/main". If main already fixes the bug, stop and tell the user to upgrade ${packageName} instead.`
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
      ``,
      `Follow: ${plan.guides.join(', ')}`,
      `Pull request template: ${plan.prTemplate}`,
      `Bug report form: ${plan.issueTemplate}`,
    ].join('\n')
  );
}
