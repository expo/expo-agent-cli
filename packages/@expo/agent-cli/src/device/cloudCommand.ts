// @ref llp/0034-eas-session-binding.plan.md §PR 5 — validate the environment EAS actually loaded.
import { resolveSpawnTarget } from '../utils/windowsShim';
import { CommandError } from '../utils/errors';
export const CLOUD_SESSION_MISMATCH = 'AGENT_CLI_CLOUD_SESSION_MISMATCH';

// Runs inside simulator:exec, after EAS loaded the ID and connection credentials together.
// The child inherits that exact environment even if the worktree dotenv is replaced meanwhile.
export const CLOUD_SESSION_GUARD = `
const { spawnSync } = require('node:child_process');
const [expected, targetJson] = process.argv.slice(1);
const target = JSON.parse(targetJson);
if (process.env.EAS_SIMULATOR_SESSION_ID !== expected) {
  console.error('${CLOUD_SESSION_MISMATCH}'); process.exit(20);
}
const result = spawnSync(target.command, target.args, { stdio: 'inherit', env: process.env, shell: target.shell });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
`;

export function guardedCloudArgs(args: string[], sessionId?: string): string[] {
  if (!sessionId)
    throw new CommandError(
      'CLOUD_SESSION_MISMATCH',
      'No EAS session was selected, so no device command ran.'
    );
  const target = resolveSpawnTarget(args[1]!, args.slice(2));
  return [
    args[0]!,
    process.execPath,
    '-e',
    CLOUD_SESSION_GUARD,
    '--',
    sessionId,
    JSON.stringify(target),
  ];
}
