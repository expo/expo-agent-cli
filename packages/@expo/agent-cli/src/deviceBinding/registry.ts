// @ref llp/0030-one-device-per-worktree.rfc.md §Records
// @ref llp/0030-one-device-per-worktree.rfc.md §Lock
// The registry directory, its binding files, and the one machine-wide lock every write runs under.

import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { digestOf } from '../devLock/address';
import { canonicalizeExistingPath } from '../utils/dir';
import { getExpoHomeDirectory } from '../utils/expoHome';
import { registryLockedError } from './errors';
import { event } from './events';
import {
  parseBinding,
  type Binding,
  type BindingBackend,
  type DevicePlatform,
  type DeviceTools,
} from './types';

const LOCK_POLL_MS = 100;
const LOCK_NAME = '.lock';
const MARKER = /^pid-(\d+)-[0-9a-f]+$/;

export function registryDirectory(): string {
  return path.join(getExpoHomeDirectory(), 'agent-cli', 'bindings');
}

export function digestForRoot(projectRoot: string): string {
  return digestOf(canonicalizeExistingPath(projectRoot));
}

export function bindingPathFor(
  projectRoot: string,
  platform: DevicePlatform,
  backend: BindingBackend
): string {
  return path.join(
    registryDirectory(),
    `${digestForRoot(projectRoot)}-${platform}-${backend}.json`
  );
}

export type BindingRead =
  | { kind: 'none' }
  | { kind: 'unreadable' }
  | { kind: 'binding'; binding: Binding };

export function readBindingFile(file: string): BindingRead {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'none' };
    }
    return { kind: 'unreadable' };
  }
  try {
    const binding = parseBinding(JSON.parse(text));
    return binding ? { kind: 'binding', binding } : { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
  }
}

/** Only for a caller under the lock. */
export function writeBindingFile(file: string, binding: Binding): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(binding, null, 2)}\n`);
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** Only for a caller under the lock. */
export function removeBindingFile(file: string): void {
  fs.rmSync(file, { force: true });
}

/**
 * Run `work` while this process holds the registry lock.
 *
 * A temp dir holding one `pid-<pid>-<nonce>` marker is renamed to `.lock`, so a lock never exists
 * without a pid. No nesting.
 */
export async function withRegistryLockAsync<T>(
  work: () => Promise<T>,
  { waitMs, tools }: { waitMs: number; tools: Pick<DeviceTools, 'isPidAlive'> }
): Promise<T> {
  const directory = registryDirectory();
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, LOCK_NAME);
  const marker = `pid-${process.pid}-${randomBytes(4).toString('hex')}`;
  const temp = fs.mkdtempSync(path.join(directory, '.lock-'));
  fs.writeFileSync(path.join(temp, marker), '');

  const deadline = Date.now() + waitMs;
  try {
    while (!tryRename(temp, lock)) {
      removeDeadLock(lock, tools);
      if (Date.now() >= deadline) {
        throw registryLockedError(describeLock(lock));
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  } catch (error) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw error;
  }

  try {
    return await work();
  } finally {
    rmIgnoring(path.join(lock, marker), ['ENOENT']);
    rmdirIgnoring(lock, ['ENOENT', 'ENOTEMPTY']);
  }
}

function tryRename(from: string, to: string): boolean {
  try {
    fs.renameSync(from, to);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM' || code === 'EACCES') {
      return false;
    }
    throw error;
  }
}

function lockHolder(lock: string): { pid: number; marker: string } | null {
  let names: string[];
  try {
    names = fs.readdirSync(lock);
  } catch {
    return null;
  }
  for (const name of names) {
    const match = MARKER.exec(name);
    if (match) {
      return { pid: Number(match[1]), marker: path.join(lock, name) };
    }
  }
  return null;
}

function removeDeadLock(lock: string, tools: Pick<DeviceTools, 'isPidAlive'>): void {
  if (!fs.existsSync(lock)) {
    return;
  }
  const holder = lockHolder(lock);
  if (holder == null) {
    rmdirIgnoring(lock, ['ENOENT', 'ENOTEMPTY']);
    return;
  }
  if (tools.isPidAlive(holder.pid)) {
    return;
  }
  rmIgnoring(holder.marker, ['ENOENT']);
  if (rmdirIgnoring(lock, ['ENOENT', 'ENOTEMPTY'])) {
    event('device_registry_lock_removed', { lock, pid: holder.pid });
  }
}

function describeLock(lock: string): {
  pid: number | null;
  ageMs: number | null;
  command: string | null;
} {
  const holder = lockHolder(lock);
  if (holder == null) {
    return { pid: null, ageMs: null, command: null };
  }
  let ageMs: number | null = null;
  try {
    ageMs = Date.now() - fs.statSync(holder.marker).mtimeMs;
  } catch {
    // The holder gave up between the two reads.
  }
  return { pid: holder.pid, ageMs, command: commandOf(holder.pid) };
}

function commandOf(pid: number): string | null {
  if (process.platform === 'win32') {
    return null;
  }
  try {
    const result = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
    });
    return (result?.status === 0 && result.stdout?.trim()) || null;
  } catch {
    return null;
  }
}

function rmIgnoring(file: string, codes: string[]): void {
  try {
    fs.unlinkSync(file);
  } catch (error: unknown) {
    if (!codes.includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw error;
    }
  }
}

function rmdirIgnoring(directory: string, codes: string[]): boolean {
  try {
    fs.rmdirSync(directory);
    return true;
  } catch (error: unknown) {
    if (!codes.includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw error;
    }
    return false;
  }
}
