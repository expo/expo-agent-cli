// @ref llp/0037-patch-command.rfc.md §Package-manager backends

import { CommandError } from '../utils/errors';
import { findExecutableOnPath } from '../utils/pathLookup';
import { spawnSubprocessAsync } from '../utils/subprocess';

export interface ToolResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface RunToolOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Return a failed run instead of throwing `PATCH_TOOL_FAILED`. */
  allowFailure?: boolean;
}

/** Run a tool the patch depends on, with its output captured. */
export async function runToolAsync(
  name: string,
  args: string[],
  { cwd, env, allowFailure = false }: RunToolOptions
): Promise<ToolResult> {
  const result = await spawnSubprocessAsync(requireTool(name), args, {
    cwd,
    env,
    output: 'capture',
  });
  if (result.exitCode !== 0 && !allowFailure) {
    throw toolFailure(name, args, result);
  }
  return result;
}

function requireTool(name: string): string {
  const found = findExecutableOnPath(name);
  if (!found) {
    throw new CommandError(
      'PATCH_TOOL_MISSING',
      `${name} is not on PATH, and this project's patches are made with it.`
    );
  }
  return found;
}

export function toolOutput(result: ToolResult): string {
  return `${result.stderr}\n${result.stdout}`.trim();
}

function toolFailure(name: string, args: string[], result: ToolResult): CommandError {
  const error = new CommandError(
    'PATCH_TOOL_FAILED',
    [
      `"${name} ${args.join(' ')}" exited with ${result.exitCode}, so the patch was not saved.`,
      toolOutput(result),
    ].join('\n')
  );
  error.data = { tool: name, exitCode: result.exitCode };
  return error;
}
