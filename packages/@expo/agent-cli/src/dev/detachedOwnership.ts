// @ref llp/0036-detached-run-ownership.rfc.md
// Publication elects the owner; its private, payload-free endpoint establishes liveness.
import fs from 'fs';
import net from 'net';
import path from 'path';

import { lockAddressFor } from '../devLock/address';
import { EXIT_OUTCOME_FAILED } from '../exitCodes';
import { PROGRAM_PREFIX } from '../programName';
import { canonicalizeExistingPath } from '../utils/dir';
import { CommandError } from '../utils/errors';

export const ATTEMPT_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
interface Owner {
  id: string;
  pid: number;
  logFile: string;
}
const directoryOf = (root: string) =>
  path.join(canonicalizeExistingPath(root), '.expo', 'dev', 'detached-run');
const endpointOf = (root: string, id: string) => lockAddressFor(root, { name: `detached-${id}` });
export const discardRunCommand = (id: string) => `${PROGRAM_PREFIX} dev:stop --discard-run ${id}`;

/** The record locates the owner; a reader's TMPDIR cannot relocate it. */
function validatedEndpoint(root: string, id: string, value: unknown): string | null {
  if (typeof value !== 'string' || value.includes('\0')) return null;
  const expected = endpointOf(root, id);
  const matches =
    expected.kind === 'pipe'
      ? value === expected.address
      : path.isAbsolute(value) && path.basename(value) === path.basename(expected.address);
  return matches ? value : null;
}

export function ownershipError(message: string, code = 'DEV_START_UNCERTAIN'): CommandError {
  return Object.assign(new CommandError(code, message), { exitCode: EXIT_OUTCOME_FAILED });
}

function removeEmpty(directory: string): void {
  try {
    fs.rmdirSync(directory);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw error;
  }
}

function removeAttempt(root: string, id: string): boolean {
  const directory = directoryOf(root);
  let removed = false;
  try {
    fs.unlinkSync(path.join(directory, `owner-${id}.json`));
    removed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  removeEmpty(directory);
  return removed;
}

/** The filename gives explicit discard a bounded target even when its contents are malformed. */
function readOwner(root: string): Owner | null {
  const directory = directoryOf(root);
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw ownershipError(`Cannot read startup ownership at ${directory}.`);
  }
  if (names.length === 0) return null;
  const id = names[0]!.slice('owner-'.length, -'.json'.length);
  if (names.length !== 1 || names[0] !== `owner-${id}.json` || !ATTEMPT_ID.test(id))
    throw ownershipError(
      `Unexpected startup ownership evidence at ${directory}; no new work was started.`
    );
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(directory, names[0]!), 'utf8'));
    if (
      owner?.id !== id ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.logFile !== 'string' ||
      !validatedEndpoint(root, id, owner.endpoint)
    )
      throw new Error();
    return owner as Owner;
  } catch {
    throw Object.assign(
      ownershipError(
        `Unreadable startup ownership for attempt ${id}. Explicitly discard its record with "${discardRunCommand(id)}"; no processes will be stopped.`
      ),
      {
        attemptId: id,
        suggestedCommand: discardRunCommand(id),
      }
    );
  }
}

/** Only missing/refused endpoints prove absence. No payload, PID check, or age heuristic. */
async function probe(root: string, id: string): Promise<'live' | 'absent' | 'uncertain'> {
  let address: string | null;
  try {
    const marker = path.join(directoryOf(root), `owner-${id}.json`);
    address = validatedEndpoint(root, id, JSON.parse(fs.readFileSync(marker, 'utf8'))?.endpoint);
  } catch {
    return 'uncertain';
  }
  if (!address) return 'uncertain';
  return new Promise((resolve) => {
    const socket = net.connect(address);
    let settled = false;
    const finish = (state: 'live' | 'absent' | 'uncertain') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(state);
    };
    const timer = setTimeout(() => finish('uncertain'), 2000);
    socket.once('connect', () => finish('live'));
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish(['ENOENT', 'ECONNREFUSED'].includes(error.code ?? '') ? 'absent' : 'uncertain')
    );
    socket.once('close', () => finish('uncertain'));
  });
}

export async function readDetachedRunWarning(root: string): Promise<CommandError | null> {
  let owner: Owner | null;
  try {
    owner = readOwner(root);
  } catch (error) {
    const warning = error as CommandError;
    if (
      typeof warning.attemptId === 'string' &&
      (await probe(root, warning.attemptId)) !== 'absent'
    ) {
      return ownershipError(
        `Startup ownership for attempt ${warning.attemptId} is unreadable and its owner may still be live. Read its log and check status again; the record was retained.`
      );
    }
    return warning;
  }
  if (!owner) return null;
  const state = await probe(root, owner.id);
  const details = `Detached run ${owner.id} (pid ${owner.pid}). Log: ${owner.logFile}.`;
  if (state === 'live')
    return Object.assign(
      ownershipError(
        `${details} Another detached run holds startup ownership. No new work was started. Read its log, then check status or stop it before starting again.`,
        'DEV_START_BUSY'
      ),
      { data: { pid: owner.pid, logFile: owner.logFile } }
    );
  if (state === 'uncertain')
    return ownershipError(`${details} Endpoint liveness is uncertain; ownership was retained.`);
  return Object.assign(
    ownershipError(
      `${details} The owner ended without releasing ownership; subprocesses may survive. Discard only this record with "${discardRunCommand(owner.id)}". This does not stop processes or EAS sessions.`
    ),
    { suggestedCommand: discardRunCommand(owner.id) }
  );
}

export async function discardDetachedRunAsync(root: string, id: string): Promise<boolean> {
  if (!ATTEMPT_ID.test(id))
    throw new CommandError('BAD_ARGS', '--discard-run requires an attempt ID.');
  // Publication follows listen. Capture an existing marker before probing, otherwise a caller
  // could observe absence before listen and remove a live record published during that probe.
  try {
    fs.lstatSync(path.join(directoryOf(root), `owner-${id}.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw ownershipError(
      `Cannot read startup ownership for attempt ${id}; its record was retained.`
    );
  }
  const state = await probe(root, id);
  if (state !== 'absent')
    throw ownershipError(
      `Attempt ${id} has a ${state === 'live' ? 'live' : 'possibly live'} owner; its record was retained.`,
      state === 'live' ? 'DEV_START_BUSY' : 'DEV_START_UNCERTAIN'
    );
  // Discard owns the marker only, not a socket path supplied by another process.
  return removeAttempt(root, id);
}

/** Capture only from a live lock's PID; the caller must confirm its Windows tree stop. */
export function captureDetachedRun(
  root: string,
  pid: number
): { id: string; release: () => void } | null {
  try {
    const owner = readOwner(root);
    return owner?.pid === pid
      ? {
          id: owner.id,
          release: () => {
            removeAttempt(root, owner.id);
          },
        }
      : null;
  } catch {
    return null;
  }
}

export async function acquireDetachedRunAsync(root: string, owner: Owner): Promise<() => void> {
  const directory = directoryOf(root);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const endpoint = endpointOf(root, owner.id).address;
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  server.unref();
  let temporary: string | undefined;
  let published = false;
  try {
    temporary = fs.mkdtempSync(path.join(path.dirname(directory), '.detached-claim-'));
    fs.writeFileSync(
      path.join(temporary, `owner-${owner.id}.json`),
      JSON.stringify({ ...owner, endpoint })
    );
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        fs.renameSync(temporary, directory);
        published = true;
        return () => {
          try {
            removeAttempt(root, owner.id);
          } finally {
            server.close();
          }
        };
      } catch (error) {
        if (
          !['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(
            (error as NodeJS.ErrnoException).code ?? ''
          )
        )
          throw error;
      }
      const refusal = await readDetachedRunWarning(root);
      if (refusal) throw refusal;
      removeEmpty(directory);
    }
    throw ownershipError('Startup ownership kept changing; retry after competing starts settle.');
  } finally {
    if (!published) server.close();
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  }
}
