// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
// The detached child owns startup. Its observer may exit without releasing this claim.
import fs from 'fs';
import path from 'path';

import { readDevServerLockAsync } from '../devLock';
import { EXIT_OUTCOME_FAILED } from '../exitCodes';
import { CommandError } from '../utils/errors';
import { canonicalizeExistingPath } from '../utils/dir';
import { detachedLogPath, pinDetachedLog, publishDetachedLog } from './logFile';

export const DETACHED_ATTEMPT_ENV = '__EXPO_AGENT_CLI_DETACHED_ATTEMPT';
export interface DetachedRun {
  id: string;
  pid: number;
  logFile: string;
}
export interface DetachedNotice {
  detachedRun?: DetachedRun;
  startupError?: { code: string; message: string; exitCode?: number };
}
interface Owner extends DetachedRun {
  phase: 'claimed' | 'executing';
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function blocked(message: string): CommandError {
  return Object.assign(
    new CommandError(
      'DEV_START_UNCERTAIN',
      `${message}\nNo new run was started. Inspect the detached log and any surviving build or Metro before recovering this run.`
    ),
    { exitCode: EXIT_OUTCOME_FAILED }
  );
}

function readOwner(directory: string): { marker: string; owner: Owner } | null {
  const names = fs.readdirSync(directory);
  if (names.length === 0) return null;
  const owners = names.filter((name) => /^owner-[\da-f-]+\.json$/.test(name));
  if (owners.length !== 1) {
    throw blocked(`Cannot establish startup ownership at ${directory}.`);
  }
  const marker = path.join(directory, owners[0]!);
  const owner = JSON.parse(fs.readFileSync(marker, 'utf8')) as Owner;
  if (
    !owner ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    owners[0] !== `owner-${owner.id}.json` ||
    typeof owner.logFile !== 'string' ||
    !['claimed', 'executing'].includes(owner.phase)
  ) {
    throw blocked(`Unreadable startup owner at ${directory}.`);
  }
  if (names.some((name) => name !== owners[0] && name !== `next-${owner.id}.json`)) {
    throw blocked(`Unexpected files in startup ownership at ${directory}.`);
  }
  // A crash during the atomic phase update is not proof that work never began.
  if (names.length > 1) owner.phase = 'executing';
  return { marker, owner };
}

function removeEmpty(directory: string): void {
  try {
    fs.rmdirSync(directory);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw error;
  }
}

function acquire(
  root: string,
  own: Owner
): { owner: Owner; release: () => void; execute: () => void } {
  const directory = path.join(canonicalizeExistingPath(root), '.expo', 'dev');
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, 'detached-run');
  const temp = fs.mkdtempSync(path.join(directory, '.detached-claim-'));
  const name = `owner-${own.id}.json`;
  fs.writeFileSync(path.join(temp, name), JSON.stringify(own));
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        fs.renameSync(temp, lock);
        const marker = path.join(lock, name);
        return {
          owner: own,
          release: () => {
            fs.rmSync(marker, { force: true });
            removeEmpty(lock);
          },
          execute: () => {
            const next = path.join(lock, `next-${own.id}.json`);
            fs.writeFileSync(next, JSON.stringify({ ...own, phase: 'executing' }));
            fs.renameSync(next, marker);
          },
        };
      } catch (error) {
        if (
          !['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(
            (error as NodeJS.ErrnoException).code ?? ''
          )
        )
          throw error;
      }
      let found: ReturnType<typeof readOwner>;
      try {
        found = readOwner(lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw blocked(`Cannot read the startup claim at ${lock}.`);
      }
      if (!found) {
        removeEmpty(lock);
        continue;
      }
      if (alive(found.owner.pid)) return { owner: found.owner, release() {}, execute() {} };
      // Re-read after proving death: the process may have begun work before it died.
      let current: ReturnType<typeof readOwner>;
      try {
        current = readOwner(lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw blocked(`Cannot recheck startup ownership at ${lock}.`);
      }
      if (!current || current.owner.id !== found.owner.id) continue;
      if (current.owner.phase !== 'claimed')
        throw blocked(
          `Detached run ${current.owner.id} (pid ${current.owner.pid}) ended without releasing ownership; subprocesses may survive. Log: ${current.owner.logFile}`
        );
      fs.rmSync(current.marker, { force: true });
      removeEmpty(lock);
    }
    throw blocked(
      `Startup ownership kept changing at ${lock}. Retry after the competing starts settle.`
    );
  } finally {
    // Only this candidate's private, never-published directory.
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function notify(message: DetachedNotice): void {
  if (process.connected && process.send) process.send(message, () => {});
  process.channel?.unref();
}

export async function withDetachedRunAsync(
  root: string,
  work: () => Promise<number>
): Promise<number> {
  const id = process.env[DETACHED_ATTEMPT_ENV];
  delete process.env[DETACHED_ATTEMPT_ENV];
  if (!id || !/^[\da-f-]{36}$/.test(id)) throw blocked('Missing detached startup identity.');
  const logFile = path.join(root, '.expo', 'dev', 'logs', `dev-detached-${id}.log`);
  let claim: ReturnType<typeof acquire>;
  try {
    claim = acquire(root, { id, pid: process.pid, logFile, phase: 'claimed' });
  } catch (error) {
    if (error instanceof CommandError)
      notify({
        startupError: { code: error.code, message: error.message, exitCode: error.exitCode },
      });
    throw error;
  }
  if (claim.owner.id !== id) {
    notify({ detachedRun: claim.owner });
    return 0;
  }
  try {
    const running = await readDevServerLockAsync(root);
    if (running) {
      notify({ detachedRun: { id, pid: running.pid, logFile: detachedLogPath(root) } });
      return 0;
    }
    pinDetachedLog(root, logFile);
    publishDetachedLog(root, logFile);
    notify({ detachedRun: claim.owner });
    claim.execute();
    return await work();
  } finally {
    claim.release();
  }
}
