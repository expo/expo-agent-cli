import os from 'node:os';

import { deviceIdOf, releaseWorktreeDevicesAsync, type Binding } from '../deviceBinding';
import type { CloudBinding } from '../deviceBinding/cloud';
import { releaseCapturedSessionAsync } from '../deviceBinding/cloudRelease';
import { deviceReport, ownBindingFiles } from '../deviceBinding/records';
import { readBindingFile } from '../deviceBinding/registry';
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
  SessionReference,
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
  private cleanupFailure: string | null = null;
  private unreadable: { backend: string; file: string }[] = [];

  constructor(
    readonly request: StartupRequest,
    private readonly root: string,
    private readonly keepSessions: boolean
  ) {}

  get progress(): RunProgress {
    const metro = this.metro;
    const opening = this.serving?.opening;
    if (this.cleanupFailure) return { kind: 'unaccounted', metro, detail: this.cleanupFailure };
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
    const at = this.bindings.findIndex(
      (captured) =>
        captured.device.backend === binding.device.backend &&
        deviceIdOf(captured.device) === deviceIdOf(binding.device)
    );
    if (at === -1) this.bindings.push(binding);
    else this.bindings[at] = binding;
  }

  captureInitialBindings(): void {
    for (const entry of ownBindingFiles(this.root)) {
      const read = readBindingFile(entry.file);
      if (read.kind === 'binding') this.captureBinding(read.binding);
      else if (read.kind === 'unreadable') this.unreadable.push(entry);
    }
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
            if (result.binding) this.captureBinding(result.binding);
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
      if (current.opening.kind === 'pending') {
        if (open?.kind === 'eas') Log.progress('Finishing EAS session work before exiting.');
        await current.opening.task;
      }
    }
  }

  async finishAsync(): Promise<{
    metro: Exclude<MetroEvidence, { kind: 'ready' }>;
    cleanup: CapturedCleanup;
  }> {
    this.finishing = true;
    const metro = this.metro;
    if (metro.kind === 'ready') throw new Error('The serving operation has not settled.');
    const sessions = new Map<string, { session: SessionReference; binding?: CloudBinding }>();
    for (const binding of this.bindings) {
      if (binding.device.backend === 'cloud')
        sessions.set(binding.device.id, {
          session: { id: binding.device.id, platform: binding.device.platform, origin: 'reused' },
          binding: { ...binding, device: binding.device },
        });
    }
    const open = this.serving?.opening;
    if (open?.kind === 'settled' && open.result.session) {
      const { session } = open.result;
      sessions.set(session.id, { ...sessions.get(session.id), session });
    }
    const sessionResults = new Map<string, CapturedCleanup['sessions'][number]>();
    const deviceResults = new Map<Binding, CapturedCleanup['devices'][number]>();
    let eas: boolean, local: boolean;
    do {
      eas = Boolean(this.intent?.eas);
      local = Boolean(this.intent?.release);
      for (const captured of sessions.values()) {
        const { session } = captured;
        const previous = sessionResults.get(session.id);
        if (previous && previous.outcome !== 'preserved') continue;
        const shouldStop = eas || (!this.keepSessions && session.origin === 'started');
        if (!shouldStop) {
          if (!previous && session.origin === 'started')
            Log.progress(`Kept EAS Simulator session ${session.id}; dev:stop --eas stops it.`);
          sessionResults.set(session.id, { session, outcome: 'preserved' });
          continue;
        }
        const result = await releaseCapturedSessionAsync(this.root, {
          ...session,
          binding: captured.binding,
        });
        sessionResults.set(session.id, { session, ...result });
        if (result.outcome === 'stopped')
          Log.progress(
            `Stopped EAS Simulator session ${session.id}${session.origin === 'started' ? ', created by this run' : ''}.`
          );
        else if (result.detail) Log.warn(`EAS Simulator session ${session.id}: ${result.detail}`);
        if (result.outcome === 'unknown')
          this.cleanupFailure = result.detail ?? 'Session cleanup could not be confirmed.';
      }
      for (const binding of this.bindings) {
        if (binding.device.backend === 'cloud') continue;
        const previous = deviceResults.get(binding);
        if (previous && previous.released !== null) continue;
        if (!local) {
          deviceResults.set(binding, {
            ...deviceReport(binding),
            released: null,
            reason: 'Kept by this run; --release releases it.',
          });
          continue;
        }
        try {
          const [released] = await releaseWorktreeDevicesAsync(this.root, {
            platform: binding.device.platform,
            expected: binding,
          });
          const result = released ?? {
            ...deviceReport(binding),
            released: null,
            reason: 'The captured device binding changed before cleanup.',
          };
          deviceResults.set(binding, result);
          if (result.released === false)
            this.cleanupFailure = result.reason ?? 'Device cleanup could not be confirmed.';
        } catch (error) {
          this.cleanupFailure = error instanceof Error ? error.message : String(error);
          deviceResults.set(binding, {
            ...deviceReport(binding),
            released: false,
            reason: this.cleanupFailure,
          });
        }
      }
      const unreadable = this.unreadable.find(({ backend }) => (backend === 'cloud' ? eas : local));
      if (unreadable)
        this.cleanupFailure = `The captured binding at ${unreadable.file} cannot be read.`;
    } while (eas !== Boolean(this.intent?.eas) || local !== Boolean(this.intent?.release));
    return {
      metro,
      cleanup: { sessions: [...sessionResults.values()], devices: [...deviceResults.values()] },
    };
  }
}

export async function withDevRunAsync<T>(
  root: string,
  options: { request: StartupRequest; detached: DetachedIdentity | null },
  work: (run: DevRun) => Promise<T>
): Promise<T> {
  const run = new WorkScope(options.request, root, options.detached !== null);
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
    run.captureInitialBindings();
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
