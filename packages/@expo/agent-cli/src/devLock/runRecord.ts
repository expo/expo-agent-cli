// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
// The trace a lock holder leaves when it dies without its cleanup.
//
// The lock is a socket so that nothing claims a process is alive after it is gone. This file
// claims the opposite: the lock holder writes it once its dev server reported a port and removes
// it with the lock, so it outlives its run only when the run died with no cleanup (a SIGKILL). Readers take it as evidence of a death, never
// of a life, and only when the pid it names is gone.

import fs from 'fs';
import path from 'path';

/** The holder of a lock, the port its dev server serves on, and the process that listens there. */
export interface DevRunRecord {
  pid: number;
  port: number;
  /** The pid listening on {@link port} once the dev server reported it: a port can be taken again. */
  serverPid: number;
}

const FILE = 'agent-cli-dev-run.json';

function recordPath(projectRoot: string): string {
  return path.join(projectRoot, '.expo', FILE);
}

/** Only a lock holder writes it (`DevServerLockHandle.noteServerPid`). Best effort: a run never fails on it. */
export function writeDevRunRecord(projectRoot: string, record: DevRunRecord): void {
  try {
    // Nonrecursive: a late write must not bring back a deleted checkout.
    try {
      fs.mkdirSync(path.join(projectRoot, '.expo'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return;
    }
    fs.writeFileSync(recordPath(projectRoot), JSON.stringify({ version: 1, ...record }) + '\n');
  } catch {
    // Without it a killed run's dev server is treated as anyone's, which is the safe side.
  }
}

export function readDevRunRecord(projectRoot: string): DevRunRecord | null {
  try {
    const value = JSON.parse(fs.readFileSync(recordPath(projectRoot), 'utf8'));
    const valid =
      value?.version === 1 &&
      Number.isInteger(value.pid) &&
      value.pid > 0 &&
      Number.isInteger(value.port) &&
      value.port >= 1 &&
      value.port <= 65535 &&
      Number.isInteger(value.serverPid) &&
      value.serverPid > 0;
    return valid ? { pid: value.pid, port: value.port, serverPid: value.serverPid } : null;
  } catch {
    return null;
  }
}

/** Remove the record when it is still `pid`'s: a later run may have written its own. */
export function clearDevRunRecord(projectRoot: string, pid: number): void {
  if (readDevRunRecord(projectRoot)?.pid !== pid) {
    return;
  }
  try {
    fs.unlinkSync(recordPath(projectRoot));
  } catch {
    // Already gone.
  }
}
