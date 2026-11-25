import { randomUUID } from 'crypto';
import { stripVTControlCharacters } from 'node:util';

import * as Log from '../log';
import { spawnCaptureAsync, type SpawnCaptureOptions } from '../utils/spawnCapture';

// Foreign records can be present in a diagnostic, but cannot identify this run's session.
const lifecycleLine = /^EAS_SIMULATOR_LIFECYCLE [0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12} /i;

export type SessionCleanup = 'stopped' | 'unknown';

export function sessionToRelease(session: {
  started: boolean;
  sessionId: string | null;
  cleanup?: SessionCleanup;
}): string | null {
  return session.started && session.cleanup !== 'stopped' ? session.sessionId : null;
}

/** Capture the final result while reporting an allocation that may precede it by minutes. */
export async function captureSessionStartAsync(
  command: string,
  args: string[],
  options: Pick<SpawnCaptureOptions, 'cwd' | 'timeoutMs'>
) {
  // Only this invocation's records can claim ownership of a billed session.
  const nonce = randomUUID();
  const prefix = `EAS_SIMULATOR_LIFECYCLE ${nonce} `;
  const lifecycle: { supported: boolean; id?: string; cleanup?: SessionCleanup } = {
    supported: false,
  };
  const result = await spawnCaptureAsync(command, args, {
    ...options,
    env: { ...process.env, EAS_SIMULATOR_LIFECYCLE: nonce },
    onStderrLine(line) {
      if (!line.startsWith(prefix)) return;
      let record: unknown;
      try {
        record = JSON.parse(line.slice(prefix.length));
      } catch {
        return;
      }
      if (!record || typeof record !== 'object' || !('event' in record)) return;
      if (record.event === 'start') {
        lifecycle.supported = true;
        return;
      }
      if (!lifecycle.supported) return;
      if (!('id' in record) || typeof record.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(record.id))
        return;
      if (record.event === 'allocated' && lifecycle.id == null) {
        lifecycle.id = record.id;
        Log.progress(`Allocated EAS Simulator session ${record.id}. Waiting for readiness.`);
      } else if (
        record.event === 'cleanup' &&
        record.id === lifecycle.id &&
        'outcome' in record &&
        (record.outcome === 'stopped' || record.outcome === 'unknown')
      ) {
        lifecycle.cleanup = record.outcome;
      }
    },
  });
  // A progress record can precede the failure message on stderr. Keep it out of error selection.
  const stderr = result.stderr
    .split('\n')
    .filter((line) => !lifecycleLine.test(line))
    .join('\n');
  const output = `${result.stdout}\n${stderr}`;
  const sessionId = lifecycle.supported ? (lifecycle.id ?? null) : readSessionId(output);
  const sessionUrl = lifecycle.supported
    ? readAllocatedSessionUrl(output, sessionId)
    : readSessionUrl(output);
  return {
    ...result,
    stderr,
    sessionId,
    sessionUrl,
    cleanup: lifecycle.cleanup,
    missingAllocation: lifecycle.supported && !sessionId,
  };
}

/**
 * The session id out of what `eas simulator` printed.
 *
 * `Simulator session created (id: <id>)` is printed as soon as the session exists — before the
 * wait for readiness, so a start that then fails still names the session it billed
 * [observed — eas-cli 23.2 `simulator/index.ts`; expo-ci, 2026-09-06]. The `--json` form is read
 * too, for a caller that passed it.
 */
export function readSessionId(output: string): string | null {
  // `(id: <id>)` with `--json`, and `(id: <id>, saved to .env.eas-simulator)` without it — the
  // form this CLI runs, which the first regex here did not read [observed — live, expo-ci,
  // 2026-09-08: "Opened the app on EAS Simulator session (id unknown)" beside the session's URL].
  const created = /Simulator session created\s*\(id:\s*([^\s,)]+)/.exec(output);
  if (created) {
    return created[1]!;
  }
  // The session page names it too, and is printed on the same line.
  const fromUrl = /simulator-sessions\/([^\s/)]+)/.exec(output);
  if (fromUrl) {
    return fromUrl[1]!;
  }
  const start = output.indexOf('{');
  if (start >= 0) {
    try {
      const parsed = JSON.parse(output.slice(start)) as { id?: unknown };
      if (typeof parsed.id === 'string' && parsed.id) {
        return parsed.id;
      }
    } catch {
      // Not JSON, or not the JSON of a session — the line above is the answer then.
    }
  }
  return null;
}

/** The session's page on expo.dev out of what `eas simulator` printed, or null. */
export function readSessionUrl(output: string): string | null {
  return /https:\/\/expo\.dev\/\S*simulator-sessions\/[^\s)]+/.exec(output)?.[0] ?? null;
}

/** A diagnostic may link to another session before the creation receipt. */
function readAllocatedSessionUrl(output: string, sessionId: string | null): string | null {
  if (!sessionId) return null;
  const urls = stripVTControlCharacters(output).matchAll(/https:\/\/expo\.dev\/[^\s)]+/g);
  for (const [candidate] of urls) {
    const url = new URL(candidate);
    if (url.pathname.endsWith(`/simulator-sessions/${sessionId}`)) return url.origin + url.pathname;
  }
  return null;
}
