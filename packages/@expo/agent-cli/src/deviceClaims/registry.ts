// @ref llp/0028-one-device-per-agent.rfc.md §The registry
// The machine-wide registry: one JSON file per claimed device, and one lock for the decisions
// that read several of them.

import fs from 'fs';
import path from 'path';

import { expoHomeDirectory } from '../passthrough/auth';
import { canonicalizeExistingPath } from '../utils/dir';
import { debugEvent, event } from './events';
import type { DeviceBackend, DeviceClaim } from './types';

/** A lock this old has a dead holder: nothing under it runs for anywhere near this long. */
export const REGISTRY_LOCK_STALE_MS = 60_000;

/** A live holder keeps the lock's mtime fresh, so a slow device creation never looks stale. */
const LOCK_HEARTBEAT_MS = 10_000;

const LOCK_RETRY_MIN_MS = 10;
const LOCK_RETRY_MAX_MS = 250;

export function deviceRegistryDirectory(): string {
  return path.join(expoHomeDirectory(), 'agent-cli', 'devices');
}

export function claimFilePath(backend: DeviceBackend, id: string): string {
  // An adb serial of a network device has a colon, which Windows refuses in a file name.
  return path.join(deviceRegistryDirectory(), `${backend}-${encodeURIComponent(id)}.json`);
}

/** Every well-formed claim in the registry. A file that is not one is ignored, never thrown. */
export function readClaims(): DeviceClaim[] {
  const directory = deviceRegistryDirectory();
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }

  const claims: DeviceClaim[] = [];
  for (const name of names) {
    if (name.startsWith('.') || !name.endsWith('.json')) {
      continue;
    }
    const file = path.join(directory, name);
    const claim = readClaimFile(file);
    if (claim) {
      claims.push(claim);
    }
  }
  return claims;
}

/**
 * Write a new claim.
 *
 * @throws with `EEXIST` when the device is claimed already, so a claim is never overwritten.
 */
export function writeClaim(claim: DeviceClaim): void {
  fs.mkdirSync(deviceRegistryDirectory(), { recursive: true });
  fs.writeFileSync(claimFilePath(claim.backend, claim.id), serialize(claim), { flag: 'wx' });
  event('device_claim_written', {
    backend: claim.backend,
    id: claim.id,
    projectRoot: claim.projectRoot,
    created: claim.created,
  });
}

/**
 * Refresh `touchedAt` of a claim this worktree still holds.
 *
 * Runs outside the registry lock, because every verb calls it. The replace is a rename, so a
 * reader never sees half a file, which it would read as no claim at all.
 *
 * @returns the touched claim, or null when the claim was released or another worktree holds it.
 */
export function touchClaim(claim: DeviceClaim, now: Date = new Date()): DeviceClaim | null {
  const file = claimFilePath(claim.backend, claim.id);
  const current = readClaimFile(file);
  if (current?.projectRoot !== claim.projectRoot) {
    return null;
  }
  const touched = { ...current, touchedAt: now.toISOString() };
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, serialize(touched));
  fs.renameSync(temporary, file);
  return touched;
}

/**
 * Give up a claim of this worktree.
 *
 * @returns false when there was nothing to release, or when the file names another worktree.
 */
export function releaseClaim(claim: DeviceClaim): boolean {
  const file = claimFilePath(claim.backend, claim.id);
  if (readClaimFile(file)?.projectRoot !== claim.projectRoot) {
    return false;
  }
  fs.rmSync(file, { force: true });
  event('device_claim_released', {
    backend: claim.backend,
    id: claim.id,
    projectRoot: claim.projectRoot,
  });
  return true;
}

/** Give up every claim of a worktree, as `dev:stop` does. The caller shuts down what it may. */
export function releaseProjectClaims(projectRoot: string): DeviceClaim[] {
  const canonical = canonicalizeExistingPath(projectRoot);
  return readClaims().filter((claim) => claim.projectRoot === canonical && releaseClaim(claim));
}

/** Remove a claim file whatever it names. Only for a caller that holds the registry lock. */
export function removeClaimFile(claim: DeviceClaim): void {
  fs.rmSync(claimFilePath(claim.backend, claim.id), { force: true });
}

/**
 * Run `fn` while this process holds the registry lock.
 *
 * `mkdir` is the lock because it is atomic on every platform and fails when the directory exists.
 */
export async function withRegistryLockAsync<T>(
  fn: () => Promise<T>,
  { now = Date.now }: { now?: () => number } = {}
): Promise<T> {
  const lock = path.join(deviceRegistryDirectory(), '.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });

  let delay = LOCK_RETRY_MIN_MS;
  while (!tryMkdir(lock)) {
    const ageMs = lockAgeMs(lock, now());
    if (ageMs != null && ageMs > REGISTRY_LOCK_STALE_MS) {
      fs.rmSync(lock, { recursive: true, force: true });
      event('device_registry_lock_stale_removed', { lock, ageMs });
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
  }

  const heartbeat = setInterval(() => {
    try {
      const seconds = now() / 1000;
      fs.utimesSync(lock, seconds, seconds);
    } catch {
      // The lock is gone; the finally below has nothing left to remove either.
    }
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function tryMkdir(directory: string): boolean {
  try {
    fs.mkdirSync(directory);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

/** Null when the lock vanished between the failed `mkdir` and this read: try again at once. */
function lockAgeMs(lock: string, now: number): number | null {
  try {
    return now - fs.statSync(lock).mtimeMs;
  } catch {
    return null;
  }
}

function serialize(claim: DeviceClaim): string {
  return `${JSON.stringify(claim, null, 2)}\n`;
}

function readClaimFile(file: string): DeviceClaim | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      debugEvent('device_claim_unreadable', { file, reason: (error as Error).message });
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    debugEvent('device_claim_unreadable', { file, reason: (error as Error).message });
    return null;
  }

  const claim = parseClaim(parsed);
  if (!claim) {
    debugEvent('device_claim_unreadable', { file, reason: 'not a device claim' });
  }
  return claim;
}

function parseClaim(value: unknown): DeviceClaim | null {
  if (value == null || typeof value !== 'object') {
    return null;
  }
  const { backend, platform, id, projectRoot, pid, claimedAt, touchedAt, created } =
    value as Record<string, unknown>;
  if (
    (backend !== 'local-ios' && backend !== 'local-android' && backend !== 'eas') ||
    (platform !== 'ios' && platform !== 'android') ||
    typeof id !== 'string' ||
    typeof projectRoot !== 'string' ||
    typeof pid !== 'number' ||
    typeof claimedAt !== 'string' ||
    typeof touchedAt !== 'string' ||
    Number.isNaN(Date.parse(touchedAt)) ||
    typeof created !== 'boolean'
  ) {
    return null;
  }
  return { backend, platform, id, projectRoot, pid, claimedAt, touchedAt, created };
}
