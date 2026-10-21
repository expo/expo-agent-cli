// @ref llp/0035-one-device-per-worktree.rfc.md §Session guard — validate the environment EAS actually loaded.
import { resolveSpawnTarget } from '../utils/windowsShim';
export const CLOUD_SESSION_MISMATCH = 'AGENT_CLI_CLOUD_SESSION_MISMATCH';
export const CLOUD_SESSION_GUARD_EXIT = 20;

// Runs inside simulator:exec, after EAS loaded the ID and connection credentials together.
// The child inherits that exact environment even if the worktree dotenv is replaced meanwhile.
// Keep the static program on one line: cmd.exe treats literal newlines as command boundaries
// when this argument is forwarded through npx.cmd on Windows.
export const CLOUD_SESSION_GUARD = `
const { spawnSync } = require('node:child_process');
const [expected, targetBase64] = process.argv.slice(1);
const target = JSON.parse(Buffer.from(targetBase64, 'base64').toString('utf8'));
if (process.env.EAS_SIMULATOR_SESSION_ID !== expected) {
  console.error('${CLOUD_SESSION_MISMATCH}', process.env.EAS_SIMULATOR_SESSION_ID ?? ''); process.exit(${CLOUD_SESSION_GUARD_EXIT});
}
const result = spawnSync(target.command, target.args, { stdio: 'inherit', env: process.env, shell: target.shell });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
`.replace(/\r?\n/g, ' ');

/** The id EAS loaded when the guard refused (null: the file named none); null when this is not a guard refusal. */
export function guardRefusal(result: {
  exitCode: number | null;
  stderr: string;
}): { loadedId: string | null } | null {
  if (result.exitCode !== CLOUD_SESSION_GUARD_EXIT) return null;
  const match = new RegExp(`^${CLOUD_SESSION_MISMATCH}(?: (\\S+))?[ \\t]*\\r?$`, 'm').exec(
    result.stderr
  );
  return match ? { loadedId: match[1] ?? null } : null;
}

export function guardedCloudArgs(args: string[], sessionId: string): string[] {
  if (!sessionId)
    throw new Error('guardedCloudArgs needs a session id, which is a bug in this CLI');
  const target = resolveSpawnTarget(args[1]!, args.slice(2));
  return [
    args[0]!,
    process.execPath,
    '-e',
    CLOUD_SESSION_GUARD,
    '--',
    sessionId,
    // This target already contains cmd.exe escapes on Windows. Carry it as data through the
    // outer npx.cmd invocation so that shell cannot consume escapes meant for the inner spawn.
    Buffer.from(JSON.stringify(target), 'utf8').toString('base64'),
  ];
}

/**
 * The controller target inside a guarded `simulator:exec` argv, or null when `argv` holds none.
 * The argv may start with an EAS runner prefix. The guard program is the `-e` argument and the
 * base64 target is last. `e2e/stubs/eas.js` holds a plain-JS copy of this rule, and
 * `src/device/__tests__/cloudCommand-test.ts` pins both.
 */
export function unwrapGuardedExec(argv: string[]): { command: string; args: string[] } | null {
  const exec = argv.indexOf('simulator:exec');
  if (exec < 0 || argv[exec + 2] !== '-e') return null;
  return JSON.parse(Buffer.from(argv.at(-1)!, 'base64').toString('utf8'));
}
