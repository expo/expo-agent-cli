import os from 'node:os';

import type { Binding } from '../deviceBinding';
import { Log } from '../log';
import { CommandError } from '../utils/errors';
import { acquireDetachedRunAsync } from './detachedOwnership';
import type {
  CancelIntent,
  CapturedCleanup,
  DetachedIdentity,
  DevRun,
  EasOpenEvidence,
  MetroEvidence,
  MetroReady,
  OpenSettlement,
  OpenWork,
  RunProgress,
} from './devRunTypes';
import type { StartupRequest } from './startupRequest';

export type { DevRun } from './devRunTypes';

type Opening =
  | { kind: 'skipped' | 'waiting' }
  | { kind: 'pending'; task: Promise<void> }
  | { kind: 'settled'; result: OpenSettlement };
type Serving = {
  active: boolean;
  metro: MetroReady | null;
  opening: Opening;
  work: OpenWork | null;
};

class WorkScope implements DevRun {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  readonly bindings: Binding[] = [];
  private serving: Serving | null = null;
  private finishing = false;
  private intent: CancelIntent | null = null;

  constructor(readonly request: StartupRequest) {}

  get progress(): RunProgress {
    const metro = this.metro;
    const opening = this.serving?.opening;
    if (opening?.kind === 'settled' && opening.result.kind === 'unaccounted')
      return { kind: 'unaccounted', metro, detail: opening.result.detail };
    if (this.signal.aborted || this.finishing || metro.kind === 'exited')
      return { kind: 'stopping', metro };
    if (metro.kind === 'ready' && (opening?.kind === 'skipped' || opening?.kind === 'settled'))
      return { kind: 'running', server: metro.server };
    return { kind: 'starting', metro };
  }

  get easOpenEvidence(): EasOpenEvidence {
    const serving = this.serving;
    if (!serving || serving.work?.kind !== 'eas' || serving.opening.kind === 'waiting')
      return { kind: 'waiting' };
    if (serving.opening.kind === 'pending')
      return { kind: 'pending', metroExited: !serving.active };
    return {
      kind: 'settled',
      accounted: serving.opening.kind !== 'settled' || serving.opening.result.kind === 'settled',
    };
  }

  private get metro(): MetroEvidence {
    const serving = this.serving;
    if (serving?.metro)
      return serving.active
        ? { kind: 'ready', server: serving.metro }
        : { kind: 'exited', server: serving.metro };
    return {
      kind: 'awaiting',
      plannedPort: this.request.port === 'auto' ? null : this.request.port,
    };
  }

  cancel(intent: CancelIntent): void {
    this.intent = {
      signal: this.intent?.signal ?? intent.signal,
      eas: Boolean(this.intent?.eas || intent.eas),
      release: Boolean(this.intent?.release || intent.release),
    };
    if (!this.signal.aborted) this.controller.abort(interruptedError(intent.signal));
  }

  captureBinding(binding: Binding): void {
    if (!this.bindings.some((captured) => captured === binding)) this.bindings.push(binding);
  }

  async serveAsync<T>(
    serve: (onReady: (metro: MetroReady) => void) => Promise<T>,
    open: OpenWork | null
  ): Promise<{ result: T; mayRetry: boolean }> {
    this.signal.throwIfAborted();
    const current: Serving = {
      active: true,
      metro: null,
      opening: { kind: open ? 'waiting' : 'skipped' },
      work: open,
    };
    this.serving = current;
    const stillWanted = () => this.serving === current && current.active && !this.signal.aborted;
    const ready = (metro: MetroReady) => {
      if (!stillWanted() || current.metro) return;
      current.metro = metro;
      if (!open) return;
      const task = Promise.resolve()
        .then(() => open.runAsync({ metro, stillWanted }))
        .then(
          (result) => {
            current.opening = { kind: 'settled', result };
          },
          (error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error);
            Log.warn(`The app open did not settle normally: ${detail}`);
            current.opening = {
              kind: 'settled',
              result: open.kind === 'eas' ? { kind: 'unaccounted', detail } : { kind: 'settled' },
            };
          }
        );
      current.opening = { kind: 'pending', task };
    };
    try {
      const result = await serve(ready);
      return {
        result,
        mayRetry:
          current.metro === null && current.opening.kind !== 'pending' && !this.signal.aborted,
      };
    } finally {
      current.active = false;
      if (current.opening.kind === 'pending') await current.opening.task;
      await open?.finishAsync?.();
    }
  }

  async finishAsync(): Promise<{ metro: MetroEvidence; cleanup: CapturedCleanup }> {
    this.finishing = true;
    return {
      metro: this.metro,
      cleanup: { sessions: [], devices: [] },
    };
  }
}

export async function withDevRunAsync<T>(
  root: string,
  options: { request: StartupRequest; detached: DetachedIdentity | null },
  work: (run: DevRun) => Promise<T>
): Promise<T> {
  const run = new WorkScope(options.request);
  const onInterrupt = () => run.cancel({ signal: 'SIGINT' });
  const onTerminate = () => run.cancel({ signal: 'SIGTERM' });
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  let release: Awaited<ReturnType<typeof acquireDetachedRunAsync>> | undefined;
  try {
    if (options.detached)
      release = await acquireDetachedRunAsync(
        root,
        {
          ...options.detached,
          pid: process.pid,
          request: options.request,
        },
        { inspect: () => run.progress, cancel: (intent) => run.cancel(intent) }
      );
    run.signal.throwIfAborted();
    return await work(run);
  } finally {
    try {
      const terminal = await run.finishAsync();
      const retained = run.progress.kind === 'unaccounted';
      if (retained)
        Log.warn(
          'Startup ownership was retained because submitted work could not be accounted for.'
        );
      release?.({ kind: 'finished', ...terminal, admission: 'released' }, retained);
    } finally {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
    }
  }
}

function interruptedError(signal: 'SIGINT' | 'SIGTERM'): CommandError {
  return Object.assign(
    new CommandError(
      'DEV_INTERRUPTED',
      `The dev run stopped on ${signal}. No later step ran. An EAS build already submitted may still run on EAS; "eas build:cancel" ends it.`
    ),
    { exitCode: 128 + os.constants.signals[signal], signal }
  );
}
