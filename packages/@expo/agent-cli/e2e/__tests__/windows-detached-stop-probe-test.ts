import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detachEnv } from '../detachUtils';
import {
  executeAgentCliAsync,
  readDevLockAsync,
  readJsonLines,
  setupFixtureAsync,
  stubExpoEnv,
  waitForAsync,
} from '../utils';

type ProcessRecord = {
  type: 'process';
  role: 'start-cli' | 'detached-wrapper' | 'expo-cmd' | 'expo-stub' | 'stop-cli';
  pid: number | null;
  parentPid: number;
};

type Trace =
  | ProcessRecord
  | { type: 'stub-exit' | 'shim-exit'; pid: number; code: number | null }
  | { type: 'taskkill-spawn' | 'taskkill-error' | 'taskkill-close'; argv: string[] };

const artifactRoot = process.env.AGENT_CLI_STOP_PROBE_ARTIFACT_DIR;
const preload = fileURLToPath(new URL('../windows-stop-trace.cjs', import.meta.url)).replaceAll(
  '\\',
  '/'
);
const port = 8395;

function readTrace(directory: string): Trace[] {
  return fs
    .readdirSync(directory)
    .flatMap((file) => readJsonLines<Trace>(path.join(directory, file)));
}

function knownPids(trace: Trace[]) {
  return trace.filter(
    (event): event is ProcessRecord & { pid: number } =>
      event.type === 'process' &&
      event.pid != null &&
      Number.isSafeInteger(event.pid) &&
      event.pid > 0
  );
}

function liveness(pid: number): string {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ESRCH' ? 'gone' : (code ?? 'unknown');
  }
}

function samplePids(trace: Trace[]) {
  return knownPids(trace).map(({ role, pid, parentPid }) => ({
    role,
    pid,
    parentPid,
    liveness: liveness(pid),
  }));
}

function portState() {
  return new Promise<string>((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    const finish = (state: string) => {
      socket.destroy();
      resolve(state);
    };
    socket.once('connect', () => finish('listening'));
    socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code ?? 'unknown'));
    socket.setTimeout(500, () => finish('timeout'));
  });
}

function parseReport(stdout: string) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

it.skipIf(process.platform !== 'win32').each(Array.from({ length: 20 }, (_, i) => i + 1))(
  'is stopped by dev:stop, which takes the whole tree with it (attempt %i)',
  async (iteration) => {
    if (!artifactRoot) throw new Error('AGENT_CLI_STOP_PROBE_ARTIFACT_DIR is required');
    fs.mkdirSync(artifactRoot, { recursive: true });
    const traceDirectory = fs.mkdtempSync(path.join(artifactRoot, 'attempt-' + iteration + '-'));

    const projectRoot = await setupFixtureAsync('go-app');
    const probeEnv = {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--require="' + preload + '"']
        .filter(Boolean)
        .join(' '),
      AGENT_CLI_STOP_PROBE_TRACE: traceDirectory,
    };
    const caseStartedAt = Date.now();
    let started: Awaited<ReturnType<typeof executeAgentCliAsync>> | undefined;
    let stopped: Awaited<ReturnType<typeof executeAgentCliAsync>> | undefined;
    let startedReport;
    let stoppedReport;
    let before;
    let immediatelyAfter;
    let after;
    let stopDurationMs;
    let trace: Trace[] = [];

    try {
      started = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--detach', '--json'], {
        env: { ...detachEnv(projectRoot, port), ...probeEnv },
        reject: false,
      });
      startedReport = parseReport(started.stdout);
      const [beforeLock, beforePort] = await Promise.all([
        readDevLockAsync(projectRoot),
        portState(),
      ]);
      before = { lock: beforeLock, port: beforePort, pids: samplePids(readTrace(traceDirectory)) };
      if (started.exitCode === 0) {
        const stopStartedAt = Date.now();
        stopped = await executeAgentCliAsync(projectRoot, ['dev:stop', '--json'], {
          env: { ...stubExpoEnv(projectRoot), ...probeEnv },
          reject: false,
        });
        stopDurationMs = Date.now() - stopStartedAt;
        stoppedReport = parseReport(stopped.stdout);
      }
    } finally {
      trace = readTrace(traceDirectory);
      immediatelyAfter = samplePids(trace);
      await waitForAsync(
        () => samplePids(readTrace(traceDirectory)).every(({ liveness }) => liveness === 'gone'),
        5000
      );
      const [afterLock, afterPort] = await Promise.all([
        readDevLockAsync(projectRoot),
        portState(),
      ]);
      trace = readTrace(traceDirectory);
      after = { lock: afterLock, port: afterPort, pids: samplePids(trace) };
      const caseDurationMs = Date.now() - caseStartedAt;
      const cleanup = [];
      for (const { role, pid, liveness: observed } of after.pids) {
        if (role === 'start-cli' || role === 'stop-cli') continue;
        if (observed !== 'alive' || liveness(pid) !== 'alive') continue;
        try {
          process.kill(pid, 'SIGKILL');
          cleanup.push({ role, pid, killed: true });
        } catch (error) {
          cleanup.push({ role, pid, killed: false, error: String(error) });
        }
      }

      const record = {
        iteration,
        caseDurationMs,
        stopDurationMs,
        started,
        stopped,
        startedReport,
        stoppedReport,
        originalSignalAssertionPassed: stoppedReport?.signal === 'SIGTERM',
        before,
        immediatelyAfter,
        after,
        trace,
        cleanup,
      };
      const line = JSON.stringify(record);
      fs.appendFileSync(path.join(artifactRoot, 'attempts.jsonl'), line + '\n');
      console.log('WINDOWS_STOP_PROBE ' + line);
    }

    const pid = startedReport?.pid;
    expect.soft(started?.exitCode).toBe(0);
    expect.soft(stopped?.exitCode).toBe(0);
    expect
      .soft(stoppedReport)
      .toMatchObject({ stopped: true, pid, port, lockHeld: true, signal: 'SIGTERM' });
    expect.soft(before?.lock?.pid).toBe(pid);
    expect
      .soft(before?.pids)
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'start-cli', liveness: 'gone' }),
          expect.objectContaining({ role: 'detached-wrapper', pid, liveness: 'alive' }),
          expect.objectContaining({ role: 'expo-stub', liveness: 'alive' }),
        ])
      );
    expect.soft(trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'taskkill-close',
          argv: ['/PID', String(pid), '/T', '/F'],
        }),
      ])
    );
    expect.soft(after.pids.every((process) => process.liveness === 'gone')).toBe(true);
    expect.soft(after.lock).toBeNull();
    expect.soft(before?.port).toBe('ECONNREFUSED');
    expect.soft(after.port).toBe('ECONNREFUSED');
  }
);
