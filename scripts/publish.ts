import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGET_PACKAGE = '@expo/agent-cli';
const ALIAS_PACKAGE = 'expo-agent-cli';
const WORKFLOW_FILE = 'publish.yml';
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(?:\+[0-9A-Za-z.]+)?$/;
const TAG_PATTERN = /^[A-Za-z0-9._-]+$/;

export const USAGE = `Usage: bun scripts/publish.ts [version] [--tag <dist-tag>] [--dry-run]

Bump ${ALIAS_PACKAGE} to [version] and dispatch ${WORKFLOW_FILE}.
When version is omitted, use ${TARGET_PACKAGE} on the given dist-tag.

Options:
  --tag <name>  npm dist-tag (default: latest)
  --dry-run     print actions without writing, pushing, or dispatching
  -h, --help    show this help`;

export type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type PublishIo = {
  cwd: string;
  argv: string[];
  log: (message: string) => void;
  error: (message: string) => void;
  exit: (code: number) => void;
  readFile: (filePath: string) => string;
  writeFile: (filePath: string, contents: string) => void;
  run: (command: string, args: string[]) => CommandResult;
};

export type PublishArgs = {
  version?: string;
  tag: string;
  dryRun: boolean;
  help: boolean;
};

export function parseArgs(argv: string[]): PublishArgs {
  let version: string | undefined;
  let tag = 'latest';
  let dryRun = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--tag') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) {
        throw new Error('publish: --tag needs a value');
      }
      tag = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('--tag=')) {
      tag = arg.slice('--tag='.length);
      if (!tag) {
        throw new Error('publish: --tag needs a value');
      }
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`publish: unknown option ${arg}`);
    }
    if (version) {
      throw new Error(`publish: unexpected extra argument ${arg}`);
    }
    version = arg;
  }

  return { version, tag, dryRun, help };
}

export function applyVersion(packageJson: string, version: string): string {
  const parsed = JSON.parse(packageJson) as { version?: string };
  parsed.version = version;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function defaultIo(): PublishIo {
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return {
    cwd,
    argv: process.argv.slice(2),
    log: (message) => console.log(message),
    error: (message) => console.error(message),
    exit: (code) => process.exit(code),
    readFile: (filePath) => fs.readFileSync(filePath, 'utf8'),
    writeFile: (filePath, contents) => fs.writeFileSync(filePath, contents),
    run: (command, args) => runCommand(command, args, cwd),
  };
}

function runCommand(command: string, args: string[], cwd: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    const notFound = (result.error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      status: 1,
      stdout: '',
      stderr: notFound ? `cannot find ${command}` : result.error.message,
    };
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function commandOutput(
  io: PublishIo,
  command: string,
  args: string[],
  errorMessage: string
): string {
  const result = io.run(command, args);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(detail ? `${errorMessage} (${detail})` : errorMessage);
  }
  return result.stdout.trim();
}

function readCurrentVersion(packageJson: string): string {
  let parsed: { version?: unknown };
  try {
    parsed = JSON.parse(packageJson) as { version?: unknown };
  } catch {
    throw new Error('publish: package.json is not valid json');
  }
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error('publish: missing version in package.json');
  }
  return parsed.version;
}

function resolveVersion(io: PublishIo, args: PublishArgs): string {
  if (args.version) {
    return args.version;
  }
  return commandOutput(
    io,
    'npm',
    ['view', `${TARGET_PACKAGE}@${args.tag}`, 'version'],
    `publish: cannot read ${TARGET_PACKAGE}@${args.tag} version`
  );
}

function assertNotPublished(io: PublishIo, version: string): void {
  const result = io.run('npm', ['view', `${ALIAS_PACKAGE}@${version}`, 'version']);
  if (result.status === 0 && result.stdout.trim() === version) {
    throw new Error(`publish: ${ALIAS_PACKAGE}@${version} is already on npm`);
  }
}

function assertGitReady(io: PublishIo): string {
  const branch = commandOutput(
    io,
    'git',
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    'publish: cannot read git branch'
  );
  if (branch === 'HEAD') {
    throw new Error('publish: detached HEAD');
  }

  const status = commandOutput(
    io,
    'git',
    ['status', '--porcelain'],
    'publish: cannot read git status'
  );
  if (status.length > 0) {
    throw new Error('publish: working tree is not clean');
  }

  return branch;
}

function bumpAndPush(
  io: PublishIo,
  packageJsonPath: string,
  packageJson: string,
  version: string,
  branch: string,
  dryRun: boolean
): void {
  const nextPackageJson = applyVersion(packageJson, version);
  if (dryRun) {
    io.log(`Would update package.json to ${version}`);
    io.log(`Would commit and push to origin/${branch}`);
    return;
  }

  io.writeFile(packageJsonPath, nextPackageJson);
  commandOutput(io, 'git', ['add', 'package.json'], 'publish: git add failed');
  commandOutput(
    io,
    'git',
    ['commit', '-m', `Publish ${ALIAS_PACKAGE}@${version}`],
    'publish: git commit failed'
  );
  commandOutput(io, 'git', ['push'], 'publish: git push failed');
  io.log(`Pushed ${ALIAS_PACKAGE}@${version} to origin/${branch}`);
}

function dispatchWorkflow(io: PublishIo, branch: string, tag: string, dryRun: boolean): void {
  if (dryRun) {
    io.log(`Would dispatch ${WORKFLOW_FILE} on ${branch} (tag ${tag})`);
    return;
  }

  commandOutput(
    io,
    'gh',
    ['workflow', 'run', WORKFLOW_FILE, '--ref', branch, '--field', `tag=${tag}`],
    'publish: failed to dispatch workflow'
  );
  io.log(`Dispatched ${WORKFLOW_FILE} on ${branch} (tag ${tag})`);
}

export function publish(io: Partial<PublishIo> = {}): void {
  const resolved = { ...defaultIo(), ...io };

  try {
    const args = parseArgs(resolved.argv);
    if (args.help) {
      resolved.log(USAGE);
      resolved.exit(0);
      return;
    }
    if (!TAG_PATTERN.test(args.tag)) {
      throw new Error(`publish: invalid dist-tag ${args.tag}`);
    }

    const packageJsonPath = path.join(resolved.cwd, 'package.json');
    let packageJson: string;
    try {
      packageJson = resolved.readFile(packageJsonPath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`publish: cannot read ${packageJsonPath} (${reason})`);
    }

    const currentVersion = readCurrentVersion(packageJson);
    const version = resolveVersion(resolved, args);
    if (!VERSION_PATTERN.test(version)) {
      throw new Error(`publish: invalid version ${version}`);
    }

    assertNotPublished(resolved, version);
    const branch = assertGitReady(resolved);

    resolved.log(`Publishing ${ALIAS_PACKAGE}@${version} with tag ${args.tag}`);
    if (currentVersion === version) {
      resolved.log(`package.json is already ${version}`);
    } else {
      bumpAndPush(resolved, packageJsonPath, packageJson, version, branch, args.dryRun);
    }
    dispatchWorkflow(resolved, branch, args.tag, args.dryRun);
    resolved.exit(0);
  } catch (error) {
    resolved.error(error instanceof Error ? error.message : String(error));
    resolved.exit(1);
  }
}

if (import.meta.main) {
  publish();
}
