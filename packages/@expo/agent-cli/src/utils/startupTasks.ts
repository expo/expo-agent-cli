// @ref llp/0036-owned-detached-stop.rfc.md
import { AsyncLocalStorage } from 'async_hooks';
import type { ChildProcess } from 'child_process';

import { CommandError } from './errors';
import { createTreeKillEvidence, killProcessTree } from './processGroup';

export type StartupDrain = 'drained' | 'uncertain';

export interface RunCancellation {
  signal?: AbortSignal;
  stopSignal?: AbortSignal;
}

export type OwnedStopAction = 'cancel-startup' | 'stop-run';

export type StartupSession = { id: string; platform: 'ios' | 'android' };

export function createStartupScope() {
  const controller = new AbortController();
  const runStop = new AbortController();
  let lockedPort: (() => number | null) | undefined;
  let stoppedChild: ChildProcess | undefined;
  let stopDeadline: number | undefined;
  const stopBudget = () =>
    stopDeadline == null ? undefined : Math.max(1, stopDeadline - Date.now());
  const pending = new Set<Promise<unknown>>();
  const children = new Set<ChildProcess>();
  const treeKills = createTreeKillEvidence();
  let locked = false;
  let phase: 'created' | 'running' | 'settled' = 'created';
  let settle!: (result: StartupDrain) => void;
  const drained = new Promise<StartupDrain>((resolve) => (settle = resolve));
  const finish = () => {
    phase = 'settled';
    settle(treeKills.failed ? 'uncertain' : 'drained');
  };
  const abort = (message: string) => {
    if (locked || controller.signal.aborted) return;
    controller.abort(interruptionError(message));
    for (const child of children) killProcessTree(child, 'SIGKILL', stopBudget());
  };
  const assertActive = () => {
    if (treeKills.failed) abort('Detached startup could not stop its managed subprocess tree.');
    controller.signal.throwIfAborted();
  };
  return {
    controller,
    runStop,
    treeKills,
    get canFinish() {
      return (
        !runStop.signal.aborted ||
        (!!stoppedChild && !children.has(stoppedChild) && !treeKills.failed)
      );
    },
    registerLockedPort(currentPort: () => number | null) {
      lockedPort = currentPort;
      return () => {
        lockedPort = undefined;
      };
    },
    stopAction(
      port: number | null,
      configuredPort: number | null,
      lockedOnly: boolean,
      legacy: boolean
    ): OwnedStopAction | null {
      if ((locked && legacy) || (!locked && lockedOnly)) return null;
      if (port != null && port !== (locked ? lockedPort?.() : configuredPort)) return null;
      return locked ? 'stop-run' : 'cancel-startup';
    },
    requestStop(action: OwnedStopAction, timeoutMs?: number) {
      stopDeadline ??= timeoutMs == null ? undefined : Date.now() + timeoutMs;
      if (action === 'cancel-startup') {
        abort(
          'Detached startup was stopped. An already submitted EAS build continues on EAS; "eas build:cancel" ends it.'
        );
      } else {
        runStop.abort(
          interruptionError('The detached dev run was stopped. No later step will run.')
        );
      }
    },
    stopChild(child: ChildProcess) {
      stoppedChild = killProcessTree(child, 'SIGKILL', stopBudget()) ? child : undefined;
    },
    assertActive,
    pending,
    children,
    sessions: new Map<string, StartupSession>(),
    drained,
    begin() {
      if (phase !== 'created') throw new Error('Startup scope already started or settled.');
      phase = 'running';
    },
    finish,
    finishIfNeverStarted() {
      if (phase === 'created') finish();
    },
    abort,
    handoff() {
      if (treeKills.failed) abort('Detached startup could not stop its managed subprocess tree.');
      if (controller.signal.aborted) return false;
      treeKills.handoff();
      locked = true;
      return true;
    },
    canOpen() {
      if (!locked) abort('Detached startup could not publish a stoppable dev-server lock.');
      return locked && !runStop.signal.aborted;
    },
  };
}

function interruptionError(message: string): CommandError {
  const error = new CommandError('DEV_INTERRUPTED', message);
  error.exitCode = 20;
  return error;
}

const tasks = new AsyncLocalStorage<ReturnType<typeof createStartupScope>>();

export function startupSignal(signal?: AbortSignal): AbortSignal | undefined {
  const startup = tasks.getStore()?.controller.signal;
  return startup && signal ? AbortSignal.any([startup, signal]) : (startup ?? signal);
}

export function recordStartupSession(
  id: string | null,
  platform: StartupSession['platform']
): void {
  if (id) tasks.getStore()?.sessions.set(id, { id, platform });
}

export function assertStartupActive(): void {
  tasks.getStore()?.assertActive();
}

export const ownedRunStopSignal = () => tasks.getStore()?.runStop.signal;
export const registerLockedStop = (currentPort: () => number | null) =>
  tasks.getStore()?.registerLockedPort(currentPort) ?? (() => {});
export const canFinishStartup = () => tasks.getStore()?.canFinish ?? true;
export function bindOwnedChildStop(child: ChildProcess, signal?: AbortSignal): () => void {
  const scope = tasks.getStore();
  const stop = () => {
    if (scope) scope.stopChild(child);
    else killProcessTree(child, 'SIGKILL');
  };
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  return () => signal?.removeEventListener('abort', stop);
}

export const handoffStartup = () => tasks.getStore()?.handoff() ?? true;
export const canOpenStartup = () => tasks.getStore()?.canOpen() ?? true;
export const failStartupLock = () =>
  tasks.getStore()?.abort('Detached startup could not publish a stoppable dev-server lock.');

export function trackStartupTask<T>(work: Promise<T>): Promise<T> {
  const pending = tasks.getStore()?.pending;
  pending?.add(work);
  const remove = () => pending?.delete(work);
  void work.then(remove, remove);
  return work;
}

export function trackStartupChild(child: ChildProcess): void {
  const scope = tasks.getStore();
  if (!scope) return;
  scope.treeKills.track(child);
  scope.children.add(child);
  trackStartupTask(
    new Promise<void>((resolve) => {
      const closed = () => {
        scope.children.delete(child);
        resolve();
      };
      child.once('close', closed);
      child.once('error', () => {
        if (child.pid == null) closed();
      });
    })
  );
  if (scope.controller.signal.aborted || (!scope.treeKills.handedOff && scope.treeKills.failed))
    killProcessTree(child, 'SIGKILL');
}

export async function withStartupTasksAsync<T>(
  run: () => Promise<T>,
  scope = createStartupScope()
): Promise<T> {
  scope.begin();
  return tasks.run(scope, async () => {
    try {
      return await run();
    } finally {
      while (scope.pending.size) await Promise.allSettled(scope.pending);
      scope.finish();
      assertStartupActive();
    }
  });
}
