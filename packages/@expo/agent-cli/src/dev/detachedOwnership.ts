// @ref llp/0036-detached-run-ownership.rfc.md
import fs from 'node:fs';
import path from 'node:path';

import { lockAddressFor } from '../devLock/address';
import { canonicalizeExistingPath } from '../utils/dir';
import type { CommandError } from '../utils/errors';
import { exchangeAttemptAsync, listenAttemptAsync, type AttemptControl } from './detachedProtocol';
import { classifyDetachedStart, detachedStartError, ownershipError } from './detachedStart';
import type {
  AttemptReference,
  CapturedStopOutcome,
  CancelIntent,
  DetachedObservation,
  LiveAttempt,
} from './devRunTypes';
import { parseStartupRequest, type StartupRequest } from './startupRequest';

export {
  discardRunCommand,
  ownershipError,
  classifyDetachedStart,
  detachedStartError,
} from './detachedStart';
export type {
  DetachedObservation,
  LiveAttempt,
  CapturedStopOutcome,
  AttemptReference,
} from './devRunTypes';
export const ATTEMPT_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
interface Owner {
  id: string;
  pid: number;
  logFile: string;
  request?: StartupRequest;
}
type Evidence = {
  attempt: AttemptReference;
  endpoint: string | null;
  request: StartupRequest | null;
  valid: boolean;
};
const targets = new WeakMap<LiveAttempt, { root: string; endpoint: string }>();
const directoryOf = (root: string) =>
  path.join(canonicalizeExistingPath(root), '.expo', 'dev', 'detached-run');
const endpointOf = (root: string, id: string) => lockAddressFor(root, { name: `detached-${id}` });

function validatedEndpoint(root: string, id: string, value: unknown): string | null {
  if (typeof value !== 'string' || value.includes('\0')) return null;
  const expected = endpointOf(root, id);
  return (
    expected.kind === 'pipe'
      ? value === expected.address
      : path.isAbsolute(value) && path.basename(value) === path.basename(expected.address)
  )
    ? value
    : null;
}

function removeEmpty(directory: string): void {
  try {
    const names = fs.readdirSync(directory);
    const metadata = path.join(directory, '.DS_Store');
    if (names.length === 1 && names[0] === '.DS_Store' && fs.lstatSync(metadata).isFile())
      fs.unlinkSync(metadata);
    fs.rmdirSync(directory);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw error;
  }
}

function removeAttempt(root: string, id: string): void {
  const directory = directoryOf(root);
  try {
    fs.unlinkSync(path.join(directory, `owner-${id}.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  removeEmpty(directory);
}

function readEvidence(root: string): Evidence | DetachedObservation {
  const directory = directoryOf(root);
  try {
    if (!fs.lstatSync(directory).isDirectory())
      return uncertain(`Unexpected startup ownership at ${directory}.`);
    const names = fs
      .readdirSync(directory)
      .filter((name) => name !== '.DS_Store' || !fs.lstatSync(path.join(directory, name)).isFile());
    if (!names.length) return { kind: 'none' };
    const id = names[0]!.slice('owner-'.length, -'.json'.length);
    if (names.length !== 1 || names[0] !== `owner-${id}.json` || !ATTEMPT_ID.test(id))
      return uncertain(
        `Unexpected startup ownership evidence at ${directory}; no new work was started.`
      );
    const attempt: AttemptReference = { id, pid: null, logFile: null };
    const marker = path.join(directory, names[0]!);
    if (!fs.lstatSync(marker).isFile())
      return uncertain('The startup owner marker is not a regular file.', attempt);
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(fs.readFileSync(marker, 'utf8'));
    } catch {
      return uncertain('The startup owner marker is unreadable.', attempt);
    }
    const endpoint = validatedEndpoint(root, id, value?.endpoint);
    const pid =
      Number.isSafeInteger(value?.pid) && Number(value?.pid) > 0 ? Number(value.pid) : null;
    const logFile = typeof value?.logFile === 'string' ? value.logFile : null;
    const request = parseStartupRequest(value?.request);
    return {
      attempt: { id, pid, logFile },
      endpoint,
      request,
      valid:
        value?.id === id &&
        pid !== null &&
        logFile !== null &&
        (value.request === undefined || request !== null),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
    return uncertain(`Cannot read startup ownership at ${directory}.`);
  }
}

function uncertain(detail: string, attempt: AttemptReference | null = null): DetachedObservation {
  return { kind: 'uncertain', attempt, detail };
}

export async function observeDetachedRunAsync(
  root: string,
  { deadline }: { deadline?: number } = {}
): Promise<DetachedObservation> {
  const evidence = readEvidence(root);
  if ('kind' in evidence) return evidence;
  const { attempt, endpoint, request, valid } = evidence;
  if (!endpoint)
    return uncertain('The recorded startup endpoint is unknown; ownership was retained.', attempt);
  const exchange = await exchangeAttemptAsync(endpoint, attempt.id, undefined, deadline);
  if (exchange.connection === 'absent') return { kind: 'interrupted', attempt };
  if (exchange.connection === 'uncertain' || !valid)
    return uncertain(
      'Startup ownership or endpoint liveness is uncertain; ownership was retained.',
      attempt
    );
  const live: LiveAttempt = {
    id: attempt.id,
    pid: attempt.pid!,
    logFile: attempt.logFile!,
    request,
  };
  targets.set(live, { root, endpoint });
  return { kind: 'live', attempt: live, progress: exchange.progress };
}

export async function cancelDetachedRunAsync(
  attempt: LiveAttempt,
  options: CancelIntent & { deadline: number }
): Promise<CapturedStopOutcome> {
  const target = targets.get(attempt);
  if (!target)
    return { kind: 'uncertain', detail: 'No captured live endpoint identifies this attempt.' };
  const { deadline, ...intent } = options;
  let result = await exchangeAttemptAsync(target.endpoint, attempt.id, intent, deadline);
  while (!result.finished && result.acknowledged && Date.now() < deadline) {
    const next = await exchangeAttemptAsync(target.endpoint, attempt.id, intent, deadline);
    result = { ...next, acknowledged: result.acknowledged || next.acknowledged };
    if (next.connection !== 'live') break;
  }
  if (result.finished) return result.finished;
  if (result.connection === 'absent') {
    const evidence = readEvidence(target.root);
    if ('attempt' in evidence && evidence.attempt?.id === attempt.id)
      return { kind: 'interrupted', attempt };
    return {
      kind: 'uncertain',
      detail: 'The captured endpoint ended without a terminal cleanup response.',
    };
  }
  if (result.connection === 'uncertain')
    return { kind: 'uncertain', detail: 'The captured endpoint did not establish cancellation.' };
  return { kind: 'pending', last: result.progress, acknowledged: result.acknowledged };
}

export async function readDetachedRunWarning(root: string): Promise<CommandError | null> {
  const refusal = classifyDetachedStart(await observeDetachedRunAsync(root));
  return refusal ? detachedStartError(refusal) : null;
}

export async function acquireDetachedRunAsync(
  root: string,
  owner: Owner,
  control: AttemptControl = { inspect: () => ({ kind: 'unknown' }), cancel: () => {} }
): Promise<
  (outcome?: Extract<CapturedStopOutcome, { kind: 'finished' }>, retain?: boolean) => void
> {
  const directory = directoryOf(root);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const endpoint = endpointOf(root, owner.id).address;
  const server = await listenAttemptAsync(endpoint, owner.id, control);
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
        return (outcome, retain = false) => {
          try {
            if (!retain) removeAttempt(root, owner.id);
          } finally {
            server.close(retain ? undefined : outcome);
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
      const refusal = classifyDetachedStart(await observeDetachedRunAsync(root), owner.request);
      if (refusal) throw detachedStartError(refusal);
      removeEmpty(directory);
    }
    throw ownershipError('Startup ownership kept changing; retry after competing starts settle.');
  } finally {
    if (!published) server.close();
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  }
}
