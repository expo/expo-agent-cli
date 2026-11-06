import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';

import { EXIT_OUTCOME_TIMEOUT } from '../exitCodes';
import { CommandError } from '../utils/errors';
import { CALLER_ARGV_ENV } from './deviceOption';
import { DETACHED_ATTEMPT_ENV } from './detachedRun';
import { event } from './events';
import { openDetachedLogSync } from './logFile';

export interface DetachedCandidate {
  logFile: string;
  pid: number;
  childGone: AbortController;
  hasExited: () => boolean;
  exit: () => { code: number | null; signal: NodeJS.Signals | null } | null;
}

/** Spawn and observe only this candidate; a competing owner is never adopted. */
export function spawnDetachedCandidate(
  root: string,
  invocation: { command: string; args: string[] },
  callerArgv: string[],
  onSpawn?: (child: ChildProcess) => void
): DetachedCandidate {
  const id = randomUUID();
  const { logFile, fd } = openDetachedLogSync(root, id);
  event('detach_spawn', { logFile, argv: invocation.args });
  let child;
  try {
    child = spawn(invocation.command, invocation.args, {
      cwd: root,
      detached: true,
      stdio: ['ignore', fd, fd],
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
  onSpawn?.(child);
  child.unref();
  const childGone = new AbortController();
  let ended: ReturnType<DetachedCandidate['exit']> = null;
  const exit = (code: number | null, signal: NodeJS.Signals | null) => {
    ended = { code, signal };
    childGone.abort();
  };
  child.once('exit', exit);
  child.once('error', () => exit(null, null));
  return {
    logFile,
    pid: child.pid ?? 0,
    childGone,
    hasExited: () => ended != null,
    exit: () => ended,
  };
}

export function detachedStartupTimeout(run: DetachedCandidate): CommandError {
  return Object.assign(
    new CommandError(
      'DEV_START_IN_PROGRESS',
      `The detached run (pid ${run.pid}) has not published a server yet. It may still be starting.\nLog: ${run.logFile}\nRead that log while startup continues, then use status after the server appears. This timeout did not stop the child; another dev start will refuse while it owns startup.`
    ),
    { exitCode: EXIT_OUTCOME_TIMEOUT, data: { pid: run.pid, logFile: run.logFile } }
  );
}
