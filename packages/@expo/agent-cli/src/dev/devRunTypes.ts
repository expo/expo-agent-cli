import type { Binding, ReleasedDevice } from '../deviceBinding';
import type { NativePlatform } from '../plan/types';
import type { StartupRequest } from './startupRequest';

export type MetroReady = Readonly<{ url: string; port: number }>;
export type MetroEvidence =
  | { kind: 'awaiting'; plannedPort: number | null }
  | { kind: 'ready'; server: MetroReady }
  | { kind: 'exited'; server: MetroReady | null };
export type RunProgress =
  | { kind: 'starting'; metro: Exclude<MetroEvidence, { kind: 'exited' }> }
  | { kind: 'running'; server: MetroReady }
  | { kind: 'stopping'; metro: MetroEvidence }
  | { kind: 'unaccounted'; metro: MetroEvidence; detail: string }
  | { kind: 'unknown' };
export type SessionReference = Readonly<{
  id: string;
  platform: NativePlatform;
  origin: 'started' | 'reused';
}>;
export type OpenSettlement =
  | { kind: 'settled'; session?: SessionReference }
  | { kind: 'unaccounted'; detail: string; session?: SessionReference };
export type OpenWork = Readonly<{
  kind: 'local' | 'eas';
  runAsync(input: { metro: MetroReady; stillWanted: () => boolean }): Promise<OpenSettlement>;
  finishAsync?(): Promise<void>;
}>;
export type EasOpenEvidence =
  | { kind: 'waiting' }
  | { kind: 'pending'; metroExited: boolean }
  | { kind: 'settled'; accounted: boolean };
export type AttemptReference = Readonly<{ id: string; pid: number | null; logFile: string | null }>;
export type LiveAttempt = AttemptReference &
  Readonly<{
    pid: number;
    logFile: string;
    request: StartupRequest | null;
  }>;
export type DetachedObservation =
  | { kind: 'none' }
  | { kind: 'live'; attempt: LiveAttempt; progress: RunProgress }
  | { kind: 'interrupted'; attempt: AttemptReference }
  | { kind: 'uncertain'; attempt: AttemptReference | null; detail: string };
export type CancelIntent = Readonly<{
  signal: 'SIGINT' | 'SIGTERM';
  eas?: boolean;
  release?: boolean;
}>;
export type CapturedCleanup = {
  sessions: {
    session: SessionReference;
    outcome: 'preserved' | 'stopped' | 'unknown';
    detail?: string;
  }[];
  devices: ReleasedDevice[];
};
export type CapturedStopOutcome =
  | { kind: 'finished'; metro: MetroEvidence; cleanup: CapturedCleanup; admission: 'released' }
  | { kind: 'pending'; last: RunProgress; acknowledged: boolean }
  | { kind: 'interrupted'; attempt: AttemptReference }
  | { kind: 'uncertain'; detail: string };
export type DetachedIdentity = Readonly<{ id: string; logFile: string }>;
export interface DevRun {
  readonly signal: AbortSignal;
  readonly request: StartupRequest;
  readonly progress: RunProgress;
  readonly easOpenEvidence: EasOpenEvidence;
  cancel(intent: CancelIntent): void;
  captureBinding(binding: Binding): void;
  serveAsync<T>(
    serve: (onReady: (metro: MetroReady) => void) => Promise<T>,
    open: OpenWork | null
  ): Promise<{ result: T; mayRetry: boolean }>;
}
