// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
// The detached child owns startup. Its observer may exit without releasing this claim.
import fs from 'fs';
import path from 'path';

import { readDevServerLockAsync } from '../devLock';
import { EXIT_OUTCOME_FAILED } from '../exitCodes';
import { CommandError } from '../utils/errors';
import { canonicalizeExistingPath } from '../utils/dir';
import { publishDetachedLog } from './logFile';
import { easOpenPlatform, type DevOptions } from './resolveOptions';
import { devServerRunningStopAsync } from './runningDevServer';

export const DETACHED_ATTEMPT_ENV = '__EXPO_AGENT_CLI_DETACHED_ATTEMPT';
interface Owner {
  id: string;
  pid: number;
  logFile: string;
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

/** Capture before Windows taskkill; invoke only after its tree stop succeeds and the lock is gone. */
export function prepareDetachedTreeStop(root: string, pid: number): () => void {
  const directory = path.join(canonicalizeExistingPath(root), '.expo', 'dev', 'detached-run');
  let found: ReturnType<typeof readOwner>;
  try {
    found = readOwner(directory);
  } catch {
    return () => {};
  }
  if (found?.owner.pid !== pid) return () => {};
  const id = found.owner.id;
  return () => {
    if (alive(pid)) return;
    try {
      // Unique marker names cannot remove a replacement owner's evidence.
      fs.rmSync(path.join(directory, `next-${id}.json`), { force: true });
      fs.rmSync(path.join(directory, `owner-${id}.json`), { force: true });
      removeEmpty(directory);
    } catch {
      // An unreadable or unremovable claim stays conservative on the next start.
    }
  };
}

function acquire(root: string, own: Owner): { release: () => void; execute: () => void } {
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
      if (alive(found.owner.pid))
        throw Object.assign(
          new CommandError(
            'DEV_START_BUSY',
            `Another detached run (pid ${found.owner.pid}) owns startup. No new work was started.\nRead its log: ${found.owner.logFile}\nWait for startup, then use status or stop the server before starting again.`
          ),
          {
            exitCode: EXIT_OUTCOME_FAILED,
            data: { pid: found.owner.pid, logFile: found.owner.logFile },
          }
        );
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

export async function withDetachedRunAsync(
  root: string,
  options: DevOptions,
  work: () => Promise<number>
): Promise<number> {
  const id = process.env[DETACHED_ATTEMPT_ENV];
  delete process.env[DETACHED_ATTEMPT_ENV];
  if (!id || !/^[\da-f-]{36}$/.test(id)) throw blocked('Missing detached startup identity.');
  const logFile = path.join(root, '.expo', 'dev', 'logs', `dev-detached-${id}.log`);
  const claim = acquire(root, { id, pid: process.pid, logFile, phase: 'claimed' });
  try {
    const running = await readDevServerLockAsync(root);
    if (running)
      throw await devServerRunningStopAsync(root, running, options.platform, {
        eas: easOpenPlatform(options) != null,
      });
    publishDetachedLog(root, logFile);
    claim.execute();
    return await work();
  } finally {
    claim.release();
  }
}
