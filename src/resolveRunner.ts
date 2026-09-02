export type Runner = {
  command: string;
  args: string[];
};

export type RunnerHints = {
  userAgent?: string;
  execPath?: string;
  bunRuntime?: boolean;
};

const BIN = 'expo-agent-cli';

/**
 * Pin `@expo/agent-cli` at or below this package's version.
 *
 * bunx/npx consume `expo-agent-cli@2.0.0` before the bin starts, so the only
 * pin that survives is this tarball's version. `<=` keeps that pin when the
 * versions match, and still resolves when this alias shipped a patch that
 * `@expo/agent-cli` does not have yet (1.0.2 here, 1.0.0 there).
 */
export function canonicalSpec(cliVersion: string): string {
  return `@expo/agent-cli@<=${cliVersion}`;
}

export function resolveRunner(hints: RunnerHints, cliVersion: string, argv: string[]): Runner {
  const spec = canonicalSpec(cliVersion);

  switch (detectManager(hints)) {
    case 'bun':
      return { command: 'bunx', args: ['--package', spec, BIN, ...argv] };
    case 'pnpm':
      return { command: 'pnpm', args: ['--package', spec, 'dlx', BIN, ...argv] };
    case 'yarn':
      return { command: 'yarn', args: ['dlx', '--package', spec, BIN, ...argv] };
    default:
      return resolveNpxRunner(cliVersion, argv);
  }
}

export function resolveNpxRunner(cliVersion: string, argv: string[]): Runner {
  return {
    command: 'npx',
    args: ['--yes', `--package=${canonicalSpec(cliVersion)}`, '--', BIN, ...argv],
  };
}

function detectManager(hints: RunnerHints): 'bun' | 'pnpm' | 'yarn' | 'npm' {
  if (hints.bunRuntime) {
    return 'bun';
  }

  const ua = (hints.userAgent ?? '').toLowerCase();
  if (ua.startsWith('bun/')) {
    return 'bun';
  }
  if (ua.startsWith('pnpm/')) {
    return 'pnpm';
  }
  if (ua.startsWith('yarn/')) {
    const major = Number(ua.match(/^yarn\/(\d+)/)?.[1]);
    return Number.isFinite(major) && major >= 2 ? 'yarn' : 'npm';
  }
  if (ua.startsWith('npm/')) {
    return 'npm';
  }

  const execPath = hints.execPath ?? '';
  if (/(^|[\\/])bun(\.exe)?$/i.test(execPath)) {
    return 'bun';
  }
  if (/(^|[\\/])pnpm(\.cjs|\.cmd|\.exe)?$/i.test(execPath)) {
    return 'pnpm';
  }
  return 'npm';
}
