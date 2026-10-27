import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';

import { EXIT_OUTCOME_FAILED, EXIT_OUTCOME_TIMEOUT } from '../exitCodes';
import { CommandError } from '../utils/errors';
import { CALLER_ARGV_ENV } from './deviceOption';
import { DETACHED_ATTEMPT_ENV, type DetachedRun, type DetachedNotice } from './detachedRun';
import { event } from './events';
import { openDetachedLogSync, pinDetachedLog } from './logFile';
import { isProcessAlive } from './processLiveness';

export interface DetachedCandidate {
  logFile: string;
  pid: number;
  adopted: boolean;
  childGone: AbortController;
  hasExited: () => boolean;
  exit: () => { code: number | null; signal: NodeJS.Signals | null } | null;
}

/** Spawn a candidate, then follow the child that actually acquired this worktree's run. */
export async function spawnDetachedCandidateAsync(
  root: string,
  invocation: { command: string; args: string[] },
  callerArgv: string[],
  deadline: number
): Promise<DetachedCandidate> {
  const id = randomUUID();
  const { logFile, fd } = openDetachedLogSync(root, id);
  event('detach_spawn', { logFile, argv: invocation.args });
  let child;
  try {
    child = spawn(invocation.command, invocation.args, {
      cwd: root,
      detached: true,
      stdio: ['ignore', fd, fd, 'ipc'],
      env: {
        ...process.env,
        __EXPO_AGENT_CLI_INTERNAL_INVOCATION: '1',
        __EXPO_AGENT_CLI_DETACHED: '1',
        [DETACHED_ATTEMPT_ENV]: id,
        [CALLER_ARGV_ENV]: JSON.stringify(callerArgv),
      },
    });
  } finally {
    fs.closeSync(fd);
  }
  child.unref();
  const childGone = new AbortController();
  let ended: ReturnType<DetachedCandidate['exit']> = null;
  let selected: DetachedRun | null = null;
  let startupError: DetachedNotice['startupError'];
  let finishSelection = () => {};
  const selection = new Promise<void>((resolve) => {
    finishSelection = resolve;
  });
  child.on('message', (message: DetachedNotice) => {
    selected = message.detachedRun ?? null;
    startupError = message.startupError;
    if (selected || startupError) finishSelection();
  });
  const exit = (code: number | null, signal: NodeJS.Signals | null) => {
    ended = { code, signal };
    if (!selected || selected.pid === child.pid) childGone.abort();
    finishSelection();
  };
  child.once('exit', exit);
  child.once('error', () => exit(null, null));
  const timer = setTimeout(finishSelection, Math.max(0, deadline - Date.now()));
  try {
    await selection;
  } finally {
    clearTimeout(timer);
    if (child.connected) child.disconnect();
  }
  if (startupError)
    throw Object.assign(new CommandError(startupError.code, startupError.message), {
      exitCode: startupError.exitCode,
    });
  // A refusal before election is read from this candidate's own log by the existing error path.
  const owner: DetachedRun = selected ?? { id, pid: child.pid ?? 0, logFile };
  pinDetachedLog(root, owner.logFile);
  return {
    logFile: owner.logFile,
    pid: owner.pid,
    adopted: owner.pid !== child.pid,
    childGone,
    hasExited: () => (owner.pid === child.pid ? ended != null : !isProcessAlive(owner.pid)),
    exit: () => (owner.pid === child.pid ? ended : null),
  };
}

export function detachedStartupTimeout(run: DetachedCandidate): CommandError {
  return Object.assign(
    new CommandError(
      'DEV_START_IN_PROGRESS',
      `The detached run (pid ${run.pid}) has not published a server yet. It may still be starting.\nLog: ${run.logFile}\nRepeat the same dev command to follow it; this timeout did not stop it or start another run.`
    ),
    { exitCode: EXIT_OUTCOME_TIMEOUT, data: { pid: run.pid, logFile: run.logFile } }
  );
}

export function assertSelectedServer(run: DetachedCandidate, pid: number): void {
  if (pid !== run.pid)
    throw Object.assign(
      new CommandError(
        'DEV_START_CHANGED',
        'The server belongs to a different run than the one this command followed. Retry to inspect the current run.'
      ),
      { exitCode: EXIT_OUTCOME_FAILED }
    );
}
