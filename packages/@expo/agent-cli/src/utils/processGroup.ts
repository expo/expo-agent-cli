// @ref llp/0015-backend-selection-and-config.rfc.md §Resolving the EAS CLI
// Stopping a subprocess **and everything it started**.
//
// The reason this module exists is one line of wave 18: every EAS-backed spawn now goes through a
// package runner (`src/utils/easCli.ts`), so the process this CLI holds a handle to is `npx`, and
// the program that does the work is *its* child. `child.kill()` signals the handle. The grandchild
// survives it, keeps the inherited stdout pipe open — and `'close'` never fires, because it waits
// for EOF on the pipes as well as for the exit. So a deadline that used to stop a tool became a
// deadline that hangs the command it was protecting [observed — 2026-08-27, `deploy`'s prompt-guard
// e2e sat for the whole 45 s test timeout instead of ~1 s].
//
// Every timeout, every prompt guard and every forwarded Ctrl-C is affected, which is why the fix is
// here rather than at one call site.

import { spawnSync, type ChildProcess } from 'child_process';

import { windowsTaskkillCommand } from './windowsShim';

type TreeKillEvidence = { failed: boolean; handedOff: boolean };
const startupTrees = new WeakMap<ChildProcess, TreeKillEvidence>();

export function createTreeKillEvidence() {
  const evidence: TreeKillEvidence = { failed: false, handedOff: false };
  return {
    track(child: ChildProcess) {
      startupTrees.set(child, evidence);
    },
    handoff() {
      evidence.handedOff = true;
    },
    get failed() {
      return evidence.failed;
    },
  };
}

/**
 * Whether a spawn should be put in a process group of its own.
 *
 * POSIX only. `detached` is what creates the group, and a group is what can be signalled as a unit.
 * Windows has no process-group equivalent; {@link killProcessTree} uses `taskkill /T /F` there.
 *
 * Safe for every caller here because **stdin is never attached** (llp/0006 §Surface improvements
 * parity): a detached child is not in the terminal's foreground group, so it could not read a
 * terminal even if it tried, and it never tries. Terminal signals do not reach it either, which is
 * why the callers forward them explicitly — and now forward them to the whole group.
 */
export const USE_PROCESS_GROUP = process.platform !== 'win32';

/** Signal the managed group/tree, retaining a failed pre-lock attempt before direct fallback. */
export function killProcessTree(child: ChildProcess, signal?: NodeJS.Signals): void {
  const evidence = startupTrees.get(child);
  const prelock = evidence && !evidence.handedOff;
  const requested = prelock ? 'SIGKILL' : (signal ?? 'SIGTERM');
  if (USE_PROCESS_GROUP && child.pid != null) {
    try {
      process.kill(-child.pid, requested);
      return;
    } catch (error) {
      if (prelock && (error as NodeJS.ErrnoException).code !== 'ESRCH') evidence.failed = true;
    }
  }
  if (process.platform === 'win32' && child.pid != null) {
    try {
      const killed = spawnSync(windowsTaskkillCommand(), ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      if (killed?.status === 0 && !killed.error && !killed.signal) return;
    } catch {}
    if (prelock) evidence.failed = true;
  }
  try {
    child.kill(requested);
  } catch {}
}
