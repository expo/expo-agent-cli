// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';

import { rerunDevCommand } from '../plan/rerun';
import { PROGRAM_PREFIX } from '../programName';
import { settingsBuildBackend } from '../settings';
import { EMPTY_SETTINGS } from '../settings/types';
import { CommandError } from '../utils/errors';
import {
  createStartupScope,
  withStartupTasksAsync,
  type StartupSession,
  type OwnedStopAction,
} from '../utils/startupTasks';
import {
  detachedLogPath,
  publishDetachedLogSync,
  openDetachedLogSync,
  captureDetachedLog,
} from './logFile';
import { readDevServerLockAsync } from '../devLock/client';
import type { DetachedChildVerdict } from './childVerdict';
import type { DevOptions } from './resolveOptions';
import type { DevStopOptions } from './resolveStopOptions';
import { isProcessAlive } from './processLiveness';

export const DETACHED_ATTEMPT_ENV = '__EXPO_AGENT_CLI_DETACHED_ATTEMPT';
export const DETACHED_SETTINGS_ENV = '__EXPO_AGENT_CLI_DETACHED_SETTINGS';
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
export interface DetachedAttemptRef {
  id: string;
  projectRoot: string;
  directory: string;
  logFile: string;
  request: string;
  pid: number;
  port: number | null;
  control: { port: number; token: string };
}
export interface DetachedObservation {
  phase: 'starting' | 'uncertain';
  pid: number | null;
  port: number | null;
  logFile: string | null;
  claimDirectory: string;
  detail: string;
}
export type DetachedAttempt = {
  ref: DetachedAttemptRef | null;
  observation: DetachedObservation;
};
const owners = new AsyncLocalStorage<DetachedAttemptRef>();
export const currentDetachedAttemptId = () => owners.getStore()?.id;
const claimRoot = (root: string) => path.join(root, '.expo', 'dev', 'detached-claim');

export function detachedRequest(options: DevOptions): string {
  const settings = options.settings ?? EMPTY_SETTINGS;
  return JSON.stringify([
    options.platform,
    options.deviceBackend,
    options.buildBackend ??
      (options.platform === 'ios' || options.platform === 'android'
        ? settingsBuildBackend(settings, options.platform)
        : null),
    options.runTarget ?? settings.target,
    options.port,
    options.device ?? null,
    options.open,
    options.agentSkills,
    options.fingerprintCache,
    options.expoArgs.filter((arg) => arg !== '--go' && arg !== '--dev-client'),
  ]);
}

export async function readDetachedRunningLockAsync(root: string, options: DevOptions) {
  const attempt = await readDetachedAttemptAsync(root);
  const lock = await readDevServerLockAsync(root);
  if (attempt && (!lock || !attempt.ref || lock.detachedAttemptId !== attempt.ref.id)) {
    throw detachedAttemptError(attempt, options);
  }
  return lock;
}

export async function inspectDetachedStopAsync(
  root: string,
  options: DevStopOptions,
  expected?: DetachedAttemptRef
) {
  const attempt = await readDetachedAttemptAsync(root);
  const lock = await readDevServerLockAsync(root);
  if (lock?.detachedAttemptId && lock.detachedAttemptId !== attempt?.ref?.id) {
    throw stopUncertainError();
  }
  const matching =
    attempt?.ref && lock?.detachedAttemptId === attempt.ref.id && lock.pid === attempt.ref.pid;
  const knownPort = matching ? lock.port : attempt?.ref?.port;
  const authorized = !expected || (!options.eas && attempt?.ref?.id === expected.id);
  if (
    authorized &&
    attempt &&
    (!attempt.ref ||
      (options.port != null && options.port !== knownPort) ||
      options.signal !== 'SIGTERM' ||
      (!matching && !supportsStartupCancellation(options)))
  ) {
    const error = detachedAttemptError(attempt);
    error.exitCode = 20;
    error.message +=
      '\nNothing was stopped. Owned stops require the default SIGTERM option. Before lock publication they also require the known port and no --force or --release.';
    throw error;
  }
  return { attempt, lock, authorized };
}

export const supportsStartupCancellation = (options: DevStopOptions) =>
  !options.force && !options.release && options.signal === 'SIGTERM';

export async function requestOwnedStopAsync(ref: DetachedAttemptRef, options: DevStopOptions) {
  if (options.signal !== 'SIGTERM') throw stopUncertainError();
  const controller = new AbortController();
  let released = false;
  const deadline = Date.now() + options.timeoutMs;
  let timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const dispose = () => {
    clearTimeout(timer);
    controller.abort();
  };
  try {
    const response = await fetch(`http://127.0.0.1:${ref.control.port}/stop`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: ref.control.token,
        'x-detached-attempt': ref.id,
        'x-detached-port': String(options.port),
        'x-detached-policy': options.force || options.release ? 'locked-only' : 'default',
        'x-detached-eas': String(options.eas),
      },
      signal: controller.signal,
    });
    if (
      response.headers.get('x-detached-attempt') !== ref.id ||
      !UUID.test(response.headers.get('x-detached-grant') ?? '') ||
      !(
        (response.status === 202 && response.headers.get('x-detached-stop') === 'cancel-startup') ||
        (response.status === 200 && response.headers.get('x-detached-stop') === 'stop-run')
      )
    )
      throw new Error();
    const extendCompletionDeadline = (until: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), Math.max(0, until - Date.now()));
    };
    extendCompletionDeadline(deadline);
    const completion = response
      .json()
      .then(
        (value): StartupSession[] | null => {
          const body = value as { id?: unknown; drained?: unknown; sessions?: unknown };
          if (
            body?.id !== ref.id ||
            body.drained !== true ||
            !Array.isArray(body.sessions) ||
            !body.sessions.every(
              (session: StartupSession) =>
                typeof session?.id === 'string' &&
                session.id.length > 0 &&
                ['ios', 'android'].includes(session.platform)
            )
          )
            return null;
          return body.sessions;
        },
        () => null
      )
      .finally(() => clearTimeout(timer));
    return {
      action: response.headers.get('x-detached-stop') as OwnedStopAction,
      extendCompletionDeadline,
      completion,
      dispose,
      async releaseAsync() {
        dispose();
        if (options.eas || released) return;
        try {
          const acknowledgment = await fetch(`http://127.0.0.1:${ref.control.port}/release`, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(options.timeoutMs),
            headers: {
              Authorization: ref.control.token,
              'x-detached-attempt': ref.id,
              'x-detached-grant': response.headers.get('x-detached-grant')!,
            },
          });
          if (acknowledgment.status !== 204) throw stopUncertainError();
        } catch {
          if (isProcessAlive(ref.pid)) throw stopUncertainError();
        }
        released = true;
      },
    };
  } catch {
    dispose();
    throw stopUncertainError();
  }
}

export function stopUncertainError() {
  const error = new CommandError(
    'DEV_DETACHED_STOP_UNCERTAIN',
    'The captured detached startup could not confirm exclusive stop authority. Nothing else was stopped. Inspect dev:logs.'
  );
  error.exitCode = 20;
  return error;
}

export function prepareDetachedCandidate(
  root: string,
  options: DevOptions,
  onElected?: (ref: DetachedAttemptRef) => void
) {
  const id = randomUUID();
  const log = openDetachedLogSync(root, id);
  captureDetachedLog(log.logFile);
  let elected = false;
  return {
    ...log,
    env: { [DETACHED_ATTEMPT_ENV]: id, [DETACHED_SETTINGS_ENV]: JSON.stringify(options.settings) },
    async readLockAsync() {
      if (!elected) {
        const owner = await readDetachedAttemptAsync(root);
        if (owner?.ref?.id === id) {
          elected = true;
          onElected?.(owner.ref);
        }
      }
      const lock = await readDevServerLockAsync(root);
      return lock?.detachedAttemptId === id ? lock : null;
    },
    async observeFailedStartAsync(exited: boolean, verdict: DetachedChildVerdict | null) {
      const attempt = await readDetachedAttemptAsync(root);
      if (verdict?.code === 'DEV_DETACHED_START_RUNNING' && attempt)
        throw detachedAttemptError(attempt, options);
      if (!exited && !verdict && attempt?.ref?.id === id) throw detachedAttemptError(attempt);
    },
  };
}

export async function readDetachedAttemptAsync(root: string): Promise<DetachedAttempt | null> {
  const directory = claimRoot(root);
  let ref: DetachedAttemptRef | null = null;
  try {
    const names = fs.readdirSync(directory);
    if (fs.lstatSync(directory).isSymbolicLink() || names.length !== 1 || !UUID.test(names[0]!))
      throw new Error();
    const child = path.join(directory, names[0]!);
    if (!fs.lstatSync(child).isDirectory() || fs.lstatSync(child).isSymbolicLink())
      throw new Error();
    const record = JSON.parse(fs.readFileSync(path.join(child, 'owner.json'), 'utf8'));
    if (
      record.id !== names[0] ||
      record.projectRoot !== root ||
      record.directory !== child ||
      record.logFile !== path.join(root, '.expo', 'dev', 'logs', `dev-detached-${record.id}.log`) ||
      typeof record.request !== 'string' ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      !(
        record.port === null ||
        (Number.isInteger(record.port) && record.port > 0 && record.port <= 65535)
      ) ||
      !Number.isInteger(record.control?.port) ||
      record.control.port < 1 ||
      record.control.port > 65535 ||
      !UUID.test(record.control.token)
    )
      throw new Error();
    ref = record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !fs.existsSync(directory))
      return null;
  }
  const live = ref != null && (await answersAsync(ref));
  return {
    ref: live ? ref : null,
    observation: {
      phase: live ? 'starting' : 'uncertain',
      pid: ref?.pid ?? null,
      port: ref?.port ?? null,
      logFile: ref?.logFile ?? detachedLogPath(root),
      claimDirectory: directory,
      detail: live
        ? 'The detached startup still owns this worktree.'
        : `Ownership cannot be verified. Quiesce all callers and in-flight cleanup, resolve every surviving process, then move ${directory} aside. Keep the log; moving the claim does not stop a listener.`,
    },
  };
}

async function answersAsync(ref: DetachedAttemptRef): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${ref.control.port}`, {
      redirect: 'error',
      method: 'HEAD',
      headers: { Authorization: ref.control.token },
      signal: AbortSignal.timeout(2000),
    });
    return response.status === 200 && response.headers.get('x-detached-attempt') === ref.id;
  } catch {
    return false;
  }
}

export function detachedAttemptError(attempt: DetachedAttempt, options?: DevOptions): CommandError {
  const changed = options != null && attempt.ref?.request !== detachedRequest(options);
  const command =
    changed && attempt.ref
      ? `${PROGRAM_PREFIX} dev:stop && ${rerunDevCommand(options!.platform, options!.callerArgv)}`
      : `${PROGRAM_PREFIX} dev:logs`;
  const error = new CommandError(
    'DEV_DETACHED_START_RUNNING',
    `${attempt.observation.detail}${changed && attempt.ref ? ' The requested startup differs from its request.' : ''}\nHow: run "${command}".`
  );
  error.exitCode = attempt.ref && !changed ? 22 : 20;
  error.data = { ...attempt.observation };
  error.suggestedCommand = command;
  return error;
}

export async function withDetachedOwnerAsync<T>(
  root: string,
  options: DevOptions,
  run: () => Promise<T>
): Promise<T> {
  const id = process.env[DETACHED_ATTEMPT_ENV];
  delete process.env[DETACHED_ATTEMPT_ENV];
  if (!id || !UUID.test(id))
    throw new CommandError(
      'DEV_DETACH_FAILED',
      'The detached candidate identity is missing or malformed.'
    );
  const directory = claimRoot(root);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  try {
    fs.mkdirSync(directory);
  } catch {
    const attempt = await readDetachedAttemptAsync(root);
    if (attempt) throw detachedAttemptError(attempt, options);
    throw new CommandError(
      'DEV_DETACH_FAILED',
      `Could not acquire detached ownership at ${directory}.`
    );
  }
  const token = randomUUID();
  const startup = createStartupScope();
  const control = createControlServer(id, token, startup, options.port);
  const { server } = control;
  let ref: DetachedAttemptRef | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const candidate: DetachedAttemptRef = {
      id,
      projectRoot: root,
      directory: path.join(directory, id),
      logFile: path.join(root, '.expo', 'dev', 'logs', `dev-detached-${id}.log`),
      request: detachedRequest(options),
      pid: process.pid,
      port: options.port,
      control: { port: (server.address() as AddressInfo).port, token },
    };
    fs.mkdirSync(candidate.directory);
    fs.writeFileSync(path.join(candidate.directory, 'owner.json'), JSON.stringify(candidate), {
      flag: 'wx',
      mode: 0o600,
    });
    ref = candidate;
    publishDetachedLogSync(root, candidate.logFile);
    return await owners.run(candidate, () => withStartupTasksAsync(run, startup));
  } finally {
    const mayRetire = await control.closeAsync();
    if (ref && mayRetire) retireDetachedAttempt(ref);
  }
}

function createControlServer(
  id: string,
  token: string,
  startup: ReturnType<typeof createStartupScope>,
  configuredPort: number | null
) {
  const responses = new Set<Promise<void>>();
  let grant: { nonce: string; retainClaim: boolean } | undefined;
  let closing = false;
  const server = http.createServer((request, response) => {
    const post = request.method === 'POST' && request.headers['x-detached-attempt'] === id;
    const cancel = post && request.url === '/cancel';
    const stop = post && request.url === '/stop';
    const release = post && request.url === '/release';
    if (
      request.headers.authorization !== token ||
      (!cancel && !stop && !release && !(request.method === 'HEAD' && request.url === '/'))
    ) {
      response.writeHead(401, { Connection: 'close' }).end();
      return;
    }
    if (closing) {
      response.writeHead(409).end();
      return;
    }
    if (release) {
      const matches =
        grant && !grant.retainClaim && grant.nonce === request.headers['x-detached-grant'];
      if (matches) grant = undefined;
      response.writeHead(matches ? 204 : 409).end();
      return;
    }
    if (!cancel && !stop) {
      response.writeHead(200, { 'x-detached-attempt': id }).end();
      return;
    }
    const portHeader = request.headers['x-detached-port'];
    const port = portHeader === 'null' ? null : Number(portHeader);
    const policy = request.headers['x-detached-policy'];
    const valid = cancel
      ? request.headers['x-detached-cancel'] === 'true'
      : (port === null || (Number.isInteger(port) && port > 0 && port <= 65535)) &&
        (policy === 'default' || policy === 'locked-only') &&
        ['true', 'false'].includes(String(request.headers['x-detached-eas']));
    const action =
      !grant && valid
        ? startup.stopAction(cancel ? null : port, configuredPort, policy === 'locked-only', cancel)
        : null;
    if (!action) {
      response.writeHead(409).end();
      return;
    }
    grant = { nonce: randomUUID(), retainClaim: request.headers['x-detached-eas'] === 'true' };
    startup.requestStop(action);
    response.writeHead(action === 'cancel-startup' ? 202 : 200, {
      Connection: 'close',
      'x-detached-attempt': id,
      'x-detached-grant': grant.nonce,
      'x-detached-stop': action,
    });
    response.flushHeaders();
    const reply = async () => {
      const drained = await startup.drained;
      if (response.destroyed) return;
      await new Promise<void>((resolve) => {
        response.once('finish', resolve);
        response.once('close', resolve);
        response.end(
          drained === 'drained'
            ? JSON.stringify({ id, drained: true, sessions: [...startup.sessions.values()] })
            : ''
        );
      });
    };
    const replied = reply();
    responses.add(replied);
    void replied.then(() => responses.delete(replied));
  });
  return {
    server,
    async closeAsync() {
      closing = true;
      startup.finishIfNeverStarted();
      const drained = await startup.drained;
      while (responses.size) await Promise.allSettled(responses);
      server.close();
      server.closeAllConnections();
      return drained === 'drained' && !grant?.retainClaim;
    },
  };
}

export function retireDetachedAttempt(ref: DetachedAttemptRef): boolean {
  const root = claimRoot(ref.projectRoot);
  if (!UUID.test(ref.id) || ref.directory !== path.join(root, ref.id)) return false;
  try {
    try {
      fs.unlinkSync(path.join(ref.directory, 'owner.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    fs.rmdirSync(ref.directory);
    fs.rmdirSync(root);
    return true;
  } catch {
    return false;
  }
}
