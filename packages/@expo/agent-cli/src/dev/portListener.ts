// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
// Who is listening on a TCP port, asked of the operating system.
//
// Only `dev:stop` needs this, and only for the case the dev-server lock cannot answer: a port that
// something is on with no lock behind it. The answer is used to *name* that process in a report,
// and — with `--force` and a second, independent proof — to signal it.
//
// Deliberately best-effort. `lsof` is not installed everywhere, `netstat` prints differently
// across Windows versions, and neither is worth a hard dependency for a report line. A lookup that
// cannot run answers null, and the caller says "a process this machine would not name" rather than
// inventing one.

import fs from 'node:fs';
import path from 'node:path';

import { spawnCaptureAsync } from '../utils/spawnCapture';
import { isPortBindableAsync } from './portCollision';

/** How long the lookup may take before it is abandoned, in milliseconds. */
const LOOKUP_TIMEOUT_MS = 2000;

export interface PortListener {
  pid: number;
  /** The process's command, as the platform tool reported it. Empty when it reported none. */
  command: string;
}

/**
 * The process listening on a TCP port, or null when it cannot be established. With more than one,
 * the first `lsof` or `netstat` lists.
 *
 * Never throws: a machine with no `lsof` is the ordinary case on a minimal container, and the
 * command that asks has a report to print either way.
 */
export async function findPortListenerAsync(port: number): Promise<PortListener | null> {
  return (await findPortListenersAsync(port))[0] ?? null;
}

/**
 * Every process listening on a TCP port, each once; empty when none or when it cannot be
 * established. Two can hold one port: a server on `[::1]` and another on `127.0.0.1` [observed —
 * macOS], so a proof about one process asks for all of them.
 */
export async function findPortListenersAsync(port: number): Promise<PortListener[]> {
  try {
    return process.platform === 'win32'
      ? await findWindowsListenersAsync(port)
      : await findPosixListenersAsync(port);
  } catch {
    // "Never throws" is the contract, and it has to hold for the spawn itself as well as for its
    // result: a machine that cannot start `lsof` at all is the same answer as one with no `lsof`.
    return [];
  }
}

/**
 * Whether *something* holds this port, without asking who.
 *
 * The lookup above is best effort, and a null from it means two very different things: the port is
 * quiet, or the port is busy and this machine would not say by whom. `dev:stop` used to report the
 * first for both — "nothing is listening on port 8195" about a port a `python3 -m http.server` was
 * on [observed — friction run 7, F72]. A bind attempt settles it without naming anyone: a port that
 * cannot be bound is a port in use.
 *
 * Only the loopback interface, which is the same interface every other check in `dev:stop` uses.
 *
 * @ref llp/0021-honest-reports.rfc.md §How they show up
 */
export async function isPortInUseAsync(port: number): Promise<boolean> {
  return !(await isPortBindableAsync(port));
}

/** `lsof -nP -iTCP:<port> -sTCP:LISTEN -FpcR` — one field per line, which is the parseable form. */
async function findPosixListenersAsync(port: number): Promise<PortListener[]> {
  const { stdout, exitCode, spawnError } = await spawnCaptureAsync(
    'lsof',
    ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'],
    { timeoutMs: LOOKUP_TIMEOUT_MS }
  );
  if (spawnError || exitCode !== 0) {
    return [];
  }
  const listeners = parseLsofFields(stdout);
  return process.platform === 'linux' ? listeners.map(withExecutableName) : listeners;
}

/**
 * Linux `lsof` names a process by its main thread, and Node 24 names that thread `MainThread`
 * [observed — tier0-e2e on ubuntu-24.04, Node 24]. The executable in `/proc/<pid>/cmdline` names
 * the process itself, so a dev server reads as `node` again.
 */
function withExecutableName(listener: PortListener): PortListener {
  try {
    const executable = fs.readFileSync(`/proc/${listener.pid}/cmdline`, 'utf8').split('\0')[0];
    return executable ? { ...listener, command: path.posix.basename(executable) } : listener;
  } catch {
    return listener;
  }
}

/**
 * Read `lsof -F` output: one record per line, the first character naming the field.
 *
 * The field form is used rather than the columns because the columns are whitespace-aligned and a
 * command name with a space in it silently shifts every column after it.
 */
export function parseLsofFields(stdout: string): PortListener[] {
  const listeners = new Map<number, PortListener>();
  let current: PortListener | undefined;
  for (const line of stdout.split('\n')) {
    const field = line[0];
    const value = line.slice(1).trim();
    if (field === 'p') {
      // Each process starts a new record; a pid listed again is the same listener.
      const pid = Number(value);
      current = undefined;
      if (Number.isInteger(pid) && pid > 0) {
        current = listeners.get(pid) ?? { pid, command: '' };
        listeners.set(pid, current);
      }
    } else if (field === 'c' && current) {
      current.command = value;
    }
  }
  return [...listeners.values()];
}

/** `netstat -ano` for the pids, then `tasklist` for what each pid is. */
async function findWindowsListenersAsync(port: number): Promise<PortListener[]> {
  const netstat = await spawnCaptureAsync('netstat', ['-ano'], { timeoutMs: LOOKUP_TIMEOUT_MS });
  if (netstat.spawnError || netstat.exitCode !== 0) {
    return [];
  }
  return await Promise.all(
    parseNetstatListeners(netstat.stdout, port).map(async (pid) => {
      const tasklist = await spawnCaptureAsync(
        'tasklist',
        ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        { timeoutMs: LOOKUP_TIMEOUT_MS }
      );
      const command = tasklist.spawnError
        ? ''
        : (tasklist.stdout.split(',')[0] ?? '').replace(/"/g, '');
      return { pid, command: command.trim() };
    })
  );
}

/** Read the PIDs of the LISTENING rows for a port out of `netstat -ano`, each once. */
export function parseNetstatListeners(stdout: string, port: number): number[] {
  const pids: number[] = [];
  for (const line of stdout.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || !/^LISTENING$/i.test(columns[3] ?? '')) {
      continue;
    }
    // `127.0.0.1:8081` and `[::]:8081` both end in `:<port>`, and nothing else in the row does.
    if (!(columns[1] ?? '').endsWith(`:${port}`)) {
      continue;
    }
    const pid = Number(columns[4]);
    if (Number.isInteger(pid) && pid > 0 && !pids.includes(pid)) {
      pids.push(pid);
    }
  }
  return pids;
}
