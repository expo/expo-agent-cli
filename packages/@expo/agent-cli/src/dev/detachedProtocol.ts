import net from 'node:net';

import type { CancelIntent, CapturedStopOutcome, MetroEvidence, RunProgress } from './devRunTypes';

type Finished = Extract<CapturedStopOutcome, { kind: 'finished' }>;
const VERSION = 1;
const FRAME_LIMIT = 16_384;
const READ_MS = 2000;
const TERMINAL_MS = 10_000;

export type AttemptControl = {
  inspect(): RunProgress;
  cancel(intent: CancelIntent): void;
};

export async function listenAttemptAsync(address: string, id: string, control: AttemptControl) {
  const waiting = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.setTimeout(READ_MS, () => socket.destroy());
    socket.once('close', () => waiting.delete(socket));
    readFrame(socket, (frame) => {
      if (frame?.version !== VERSION || frame?.id !== id) {
        socket.end();
        return;
      }
      if (frame.kind === 'inspect') {
        socket.end(encode(id, { kind: 'progress', progress: control.inspect() }));
        return;
      }
      if (frame.kind !== 'cancel' || !isIntent(frame.intent)) {
        socket.end();
        return;
      }
      control.cancel(frame.intent);
      socket.write(encode(id, { kind: 'ack', progress: control.inspect() }));
      waiting.add(socket);
      socket.setTimeout(TERMINAL_MS, () => socket.end());
    });
  });
  server.maxConnections = 16;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, resolve);
  });
  server.unref();
  return {
    close(outcome?: Finished) {
      for (const socket of waiting) {
        if (outcome) socket.write(encode(id, { kind: 'finished', outcome }));
        socket.end();
      }
      waiting.clear();
      server.close();
    },
  };
}

export type Exchange = {
  connection: 'live' | 'absent' | 'uncertain';
  progress: RunProgress;
  acknowledged: boolean;
  finished?: Finished;
};

export function exchangeAttemptAsync(
  address: string,
  id: string,
  intent?: CancelIntent,
  deadline = Date.now() + READ_MS
): Promise<Exchange> {
  return new Promise((resolve) => {
    const answer: Exchange = {
      connection: 'uncertain',
      progress: { kind: 'unknown' },
      acknowledged: false,
    };
    const socket = net.connect(address);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(
      finish,
      Math.max(1, Math.min(deadline - Date.now(), intent ? TERMINAL_MS : READ_MS))
    );
    socket.once('connect', () => {
      answer.connection = 'live';
      socket.write(encode(id, intent ? { kind: 'cancel', intent } : { kind: 'inspect' }));
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (answer.connection !== 'live' && ['ENOENT', 'ECONNREFUSED'].includes(error.code ?? ''))
        answer.connection = 'absent';
      finish();
    });
    socket.once('close', finish);
    readFrame(
      socket,
      (frame) => {
        if (frame?.version !== VERSION || frame?.id !== id) return finish();
        if (frame.kind === 'finished') {
          const finished = parseFinished(frame.outcome);
          if (intent && finished) answer.finished = finished;
          finish();
          return;
        }
        const progress = parseProgress(frame.progress);
        if (!progress || (frame.kind !== 'progress' && frame.kind !== 'ack')) return finish();
        answer.progress = progress;
        answer.acknowledged = frame.kind === 'ack';
        if (!intent || !answer.acknowledged) finish();
      },
      true
    );
  });
}

function encode(id: string, data: object): string {
  return `${JSON.stringify({ version: VERSION, id, ...data })}\n`;
}

function readFrame(
  socket: net.Socket,
  receive: (frame: Record<string, unknown> | null) => void,
  multiple = false
) {
  let pending = '';
  socket.setEncoding('utf8');
  const read = (chunk: string) => {
    pending += chunk;
    if (Buffer.byteLength(pending) > FRAME_LIMIT) return socket.destroy();
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) return;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        value = null;
      }
      receive(record(value) ? value : null);
      if (!multiple) {
        socket.off('data', read);
        return;
      }
    }
  };
  socket.on('data', read);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIntent(value: unknown): value is CancelIntent {
  return (
    record(value) &&
    ['SIGINT', 'SIGTERM'].includes(String(value.signal)) &&
    ['eas', 'release'].every((key) => value[key] === undefined || typeof value[key] === 'boolean')
  );
}

function parseMetro(value: unknown): MetroEvidence | null {
  if (!record(value)) return null;
  const ready = (server: unknown) =>
    record(server) &&
    typeof server.url === 'string' &&
    Number.isInteger(server.port) &&
    Number(server.port) > 0 &&
    Number(server.port) <= 65535;
  if (
    (value.kind === 'awaiting' &&
      (value.plannedPort === null ||
        (Number.isInteger(value.plannedPort) &&
          Number(value.plannedPort) > 0 &&
          Number(value.plannedPort) <= 65535))) ||
    (value.kind === 'ready' && ready(value.server)) ||
    (value.kind === 'exited' && (value.server === null || ready(value.server)))
  )
    return value as MetroEvidence;
  return null;
}

function parseProgress(value: unknown): RunProgress | null {
  if (!record(value)) return null;
  if (value.kind === 'unknown') return { kind: 'unknown' };
  if (value.kind === 'running') {
    const metro = parseMetro({ kind: 'ready', server: value.server });
    return metro?.kind === 'ready' ? { kind: 'running', server: metro.server } : null;
  }
  const metro = parseMetro(value.metro);
  if (!metro) return null;
  if (value.kind === 'starting' && metro.kind !== 'exited') return { kind: 'starting', metro };
  if (value.kind === 'stopping') return { kind: 'stopping', metro };
  if (value.kind === 'unaccounted' && typeof value.detail === 'string')
    return { kind: 'unaccounted', metro, detail: value.detail };
  return null;
}

function parseFinished(value: unknown): Finished | null {
  if (
    !record(value) ||
    value.kind !== 'finished' ||
    value.admission !== 'released' ||
    !parseMetro(value.metro) ||
    !record(value.cleanup) ||
    !Array.isArray(value.cleanup.sessions) ||
    !Array.isArray(value.cleanup.devices)
  )
    return null;
  const sessions = value.cleanup.sessions.every(
    (entry: unknown) =>
      record(entry) &&
      record(entry.session) &&
      typeof entry.session.id === 'string' &&
      ['ios', 'android'].includes(String(entry.session.platform)) &&
      ['started', 'reused'].includes(String(entry.session.origin)) &&
      ['stopped', 'preserved', 'unknown'].includes(String(entry.outcome)) &&
      (entry.detail === undefined || typeof entry.detail === 'string')
  );
  const devices = value.cleanup.devices.every(
    (entry: unknown) =>
      record(entry) &&
      ['local-ios', 'local-android', 'cloud'].includes(String(entry.backend)) &&
      ['ios', 'android'].includes(String(entry.platform)) &&
      typeof entry.id === 'string' &&
      typeof entry.name === 'string' &&
      (entry.released === null || typeof entry.released === 'boolean') &&
      typeof entry.shutDown === 'boolean' &&
      (entry.reason === null || typeof entry.reason === 'string')
  );
  return sessions && devices ? (value as Finished) : null;
}
