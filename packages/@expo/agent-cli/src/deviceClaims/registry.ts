// @ref llp/0030-one-device-per-agent.rfc.md §The registry
// The machine-wide registry: one JSON file per claimed device, and one lock for the decisions
// that read several of them.

import { AsyncLocalStorage } from 'async_hooks';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { getExpoHomeDirectory } from '../utils/expoHome';
import { canonicalizeExistingPath } from '../utils/dir';
import { CommandError } from '../utils/errors';
import { debugEvent, event } from './events';
import { CLAIM_GRACE_MS } from './liveness';
import type { DeviceBackend, DeviceClaim } from './types';

/** A lock this old has a dead holder: nothing under it runs for anywhere near this long. */
export const REGISTRY_LOCK_STALE_MS = 60_000;

/** A live holder keeps the lock's mtime fresh, so a slow device creation never looks stale. */
const LOCK_HEARTBEAT_MS = 10_000;

/** A claim file this old that does not parse is a crash mid-write, not a write in flight. */
const UNREADABLE_CLAIM_MS = 60_000;

const LOCK_OWNER_FILE = 'owner';

const LOCK_RETRY_MIN_MS = 10;
const LOCK_RETRY_MAX_MS = 250;

/** The lock this call chain holds, so each change made under it can check it still holds it. */
const heldLock = new AsyncLocalStorage<{ owner: string; token: string }>();

export function deviceRegistryDirectory(): string {
  return path.join(getExpoHomeDirectory(), 'agent-cli', 'devices');
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
 * Write a new claim. Its `touchedAt` becomes the file's mtime.
 *
 * @throws with `EEXIST` when the device is claimed already, so a claim is never overwritten.
 */
export function writeClaim(claim: DeviceClaim): void {
  assertRegistryLockHeld();
  fs.mkdirSync(deviceRegistryDirectory(), { recursive: true });
  const file = claimFilePath(claim.backend, claim.id);
  fs.writeFileSync(file, serialize(claim), { flag: 'wx' });
  const touchedAt = new Date(claim.touchedAt);
  fs.utimesSync(file, touchedAt, touchedAt);
  event('device_claim_written', {
    backend: claim.backend,
    id: claim.id,
    projectRoot: claim.projectRoot,
    created: claim.created,
  });
}

/**
 * Refresh the touch of a claim this worktree still holds: the mtime of its file.
 *
 * A claim touched within half the grace period is live, and no allocation can judge it stale, so
 * it is only read again. An older claim is touched under the registry lock, so the touch never
 * lands between an allocation's stale check and its removal of the claim. The touch never removes
 * or rewrites the file, so every reader sees the claim throughout.
 *
 * @returns the claim as it is now, or null when the claim was released, another claim replaced it,
 * this process lost the registry lock, or the file system refused. Never throws.
 */
export async function touchClaimAsync(
  claim: DeviceClaim,
  now: Date = new Date()
): Promise<DeviceClaim | null> {
  const file = claimFilePath(claim.backend, claim.id);
  const held = (): DeviceClaim | null => {
    const current = readClaimFile(file);
    return current != null && isSameClaim(current, claim) ? current : null;
  };
  const current = held();
  if (current == null) {
    return null;
  }
  const sinceTouchMs = now.getTime() - Date.parse(current.touchedAt);
  if (sinceTouchMs >= 0 && sinceTouchMs < CLAIM_GRACE_MS / 2) {
    return current;
  }
  try {
    return await withRegistryLockAsync(async () => {
      if (held() == null) {
        return null;
      }
      assertRegistryLockHeld();
      fs.utimesSync(file, now, now);
      return held();
    });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      debugEvent('device_claim_touch_failed', {
        backend: claim.backend,
        id: claim.id,
        reason: (error as Error).message,
      });
    }
    return null;
  }
}

/**
 * Record in a claim this worktree still holds that this CLI booted its device.
 *
 * Under the registry lock, so no allocation replaces the claim between the check and the write.
 * The write renames a new file over the claim, so a reader never finds the claim missing. A claim
 * that records the boot already is only read: the field never goes back to false.
 *
 * @returns the claim as recorded, or null when the claim was released, another claim replaced it,
 * or the file system refused. Never throws.
 */
export async function markClaimBootedAsync(claim: DeviceClaim): Promise<DeviceClaim | null> {
  const file = claimFilePath(claim.backend, claim.id);
  if (claim.booted) {
    const current = readClaimFile(file);
    return current != null && isSameClaim(current, claim) ? current : null;
  }
  try {
    return await withRegistryLockAsync(async () => {
      const current = readClaimFile(file);
      if (current == null || !isSameClaim(current, claim)) {
        return null;
      }
      replaceClaim({ ...current, booted: true });
      return readClaimFile(file);
    });
  } catch (error: unknown) {
    debugEvent('device_claim_touch_failed', {
      backend: claim.backend,
      id: claim.id,
      reason: (error as Error).message,
    });
    return null;
  }
}

/**
 * Write a claim over the file of its device, with a fresh touch. A new file is renamed over the old
 * one, so a reader never finds the claim missing. Only for a caller that holds the registry lock.
 */
export function replaceClaim(claim: DeviceClaim): void {
  assertRegistryLockHeld();
  const file = claimFilePath(claim.backend, claim.id);
  const next = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  );
  try {
    fs.writeFileSync(next, serialize(claim));
    fs.renameSync(next, file);
  } finally {
    fs.rmSync(next, { force: true });
  }
}

/** The claim file of one device as it is now, or null when there is none or it does not parse. */
export function readClaim(backend: DeviceBackend, id: string): DeviceClaim | null {
  return readClaimFile(claimFilePath(backend, id));
}

/** Two reads of one device's file name the same claim: the same worktree claimed it at the same time. */
export function isSameClaim(left: DeviceClaim, right: DeviceClaim): boolean {
  return left.projectRoot === right.projectRoot && left.claimedAt === right.claimedAt;
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
  assertRegistryLockHeld();
  fs.rmSync(file, { force: true });
  event('device_claim_released', {
    backend: claim.backend,
    id: claim.id,
    projectRoot: claim.projectRoot,
  });
  return true;
}

/**
 * Settle every claim of a worktree under the registry lock, as `dev:stop` does.
 *
 * `settle` runs first for each claim, and may shut the device down; the claim is released after it
 * when it answers `release: true`. The lock spans both, so no other worktree can take a device
 * that is still up between its shutdown and its release.
 */
export async function releaseProjectClaimsAsync<R extends { release: boolean }>(
  projectRoot: string,
  settle: (claim: DeviceClaim) => Promise<R>
): Promise<(R & { claim: DeviceClaim })[]> {
  const canonical = canonicalizeExistingPath(projectRoot);
  return await withRegistryLockAsync(async () => {
    const settled: (R & { claim: DeviceClaim })[] = [];
    for (const claim of readClaims().filter((each) => each.projectRoot === canonical)) {
      const outcome = await settle(claim);
      if (outcome.release) {
        releaseClaim(claim);
      }
      settled.push({ ...outcome, claim });
    }
    return settled;
  });
}

/**
 * Remove every claim file that does not parse and is older than a minute. Only for a caller that
 * holds the registry lock.
 *
 * `writeClaim` is not atomic, so a crash mid-write leaves such a file, and its `wx` would keep
 * the device unclaimable forever.
 */
export function pruneUnreadableClaims(now: number = Date.now()): void {
  const directory = deviceRegistryDirectory();
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith('.') || !name.endsWith('.json')) {
      continue;
    }
    const file = path.join(directory, name);
    try {
      const ageMs = now - fs.statSync(file).mtimeMs;
      if (ageMs <= UNREADABLE_CLAIM_MS || parsesAsJson(fs.readFileSync(file, 'utf8'))) {
        continue;
      }
      fs.rmSync(file, { force: true });
      event('device_claim_unreadable_removed', { file, ageMs });
    } catch {
      // Gone already, or unreadable for a reason a later run can report.
    }
  }
}

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Remove a claim file whatever it names. Only for a caller that holds the registry lock. */
export function removeClaimFile(claim: DeviceClaim): void {
  assertRegistryLockHeld();
  fs.rmSync(claimFilePath(claim.backend, claim.id), { force: true });
}

/**
 * Run `fn` while this process holds the registry lock.
 *
 * `mkdir` is the lock because it is atomic on every platform and fails when the directory exists.
 * The holder writes a token into it, so a holder whose stale lock was taken over never removes the
 * lock of the holder after it.
 */
export async function withRegistryLockAsync<T>(
  fn: () => Promise<T>,
  { now = Date.now }: { now?: () => number } = {}
): Promise<T> {
  const lock = path.join(deviceRegistryDirectory(), '.lock');
  const owner = path.join(lock, LOCK_OWNER_FILE);
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });

  let delay = LOCK_RETRY_MIN_MS;
  while (!tryMkdir(lock)) {
    if (takeOverStaleLock(lock, now())) {
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
  }
  fs.writeFileSync(owner, token);

  let lost = false;
  const loseLock = (reason: string) => {
    if (!lost) {
      lost = true;
      debugEvent('device_registry_lock_lost', { lock, reason });
    }
  };
  const heartbeat = setInterval(() => {
    if (lost) {
      return;
    }
    try {
      if (fs.readFileSync(owner, 'utf8') !== token) {
        loseLock('another holder took the lock over');
        return;
      }
      const seconds = now() / 1000;
      fs.utimesSync(lock, seconds, seconds);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        loseLock('the lock was removed');
      }
    }
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref();

  try {
    return await heldLock.run({ owner, token }, fn);
  } finally {
    clearInterval(heartbeat);
    if (readLockOwner(owner) === token) {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }
}

/**
 * Throw when this call chain runs under the registry lock and another process took the lock over.
 * A pause longer than the stale age (a laptop asleep, a stopped process) makes a live holder look
 * dead, so every change made under the lock checks this first and a holder that lost the lock
 * changes nothing.
 */
export function assertRegistryLockHeld(): void {
  const held = heldLock.getStore();
  if (held != null && readLockOwner(held.owner) !== held.token) {
    throw new CommandError(
      'DEVICE_REGISTRY_LOCK_LOST',
      'Another process took over the device registry lock while this process held it, so this process changed no claim. Run the command again.'
    );
  }
}

function readLockOwner(owner: string): string | null {
  try {
    return fs.readFileSync(owner, 'utf8');
  } catch {
    return null;
  }
}

function lockAgeMs(directory: string, now: number): number | null {
  try {
    return now - fs.statSync(directory).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Remove the lock when it is older than the limit, so its holder is taken as dead.
 *
 * Only the waiter that holds the takeover guard may judge and remove the lock. Without it, a
 * waiter that saw the stale lock late would remove the fresh lock a faster waiter made in its
 * place. The lock is renamed aside before it is removed, so it vanishes in one step.
 *
 * @returns true when the caller may try `mkdir` again at once.
 */
function takeOverStaleLock(lock: string, now: number): boolean {
  const lockAge = lockAgeMs(lock, now);
  if (lockAge == null) {
    return true;
  }
  if (lockAge <= REGISTRY_LOCK_STALE_MS) {
    return false;
  }
  const guard = `${lock}.takeover`;
  if (!tryMkdir(guard)) {
    // A guard is held for one stat and one rename; one this old has a dead holder.
    const guardAge = lockAgeMs(guard, now);
    if (guardAge != null && guardAge > REGISTRY_LOCK_STALE_MS) {
      fs.rmSync(guard, { recursive: true, force: true });
      return true;
    }
    return false;
  }
  try {
    const ageMs = lockAgeMs(lock, now);
    if (ageMs == null || ageMs <= REGISTRY_LOCK_STALE_MS) {
      return true;
    }
    const aside = `${lock}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      fs.renameSync(lock, aside);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return true;
      }
      throw error;
    }
    fs.rmSync(aside, { recursive: true, force: true });
    event('device_registry_lock_stale_removed', { lock, ageMs });
    return true;
  } finally {
    fs.rmSync(guard, { recursive: true, force: true });
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

/** The file never holds `touchedAt`: its mtime is the touch. */
function serialize({ touchedAt: _touchedAt, ...stored }: DeviceClaim): string {
  return `${JSON.stringify(stored, null, 2)}\n`;
}

function readClaimFile(file: string): DeviceClaim | null {
  let text: string;
  let touchedAt: string;
  try {
    // One descriptor for both, so the touch is the touch of these bytes.
    const descriptor = fs.openSync(file, 'r');
    try {
      text = fs.readFileSync(descriptor, 'utf8');
      touchedAt = fs.fstatSync(descriptor).mtime.toISOString();
    } finally {
      fs.closeSync(descriptor);
    }
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

  const claim = parseClaim(parsed, touchedAt);
  if (!claim) {
    debugEvent('device_claim_unreadable', { file, reason: 'not a device claim' });
  }
  return claim;
}

function parseClaim(value: unknown, touchedAt: string): DeviceClaim | null {
  if (value == null || typeof value !== 'object') {
    return null;
  }
  const { backend, platform, id, projectRoot, pid, claimedAt, created, booted, reaping } =
    value as Record<string, unknown>;
  if (
    (backend !== 'local-ios' && backend !== 'local-android' && backend !== 'eas') ||
    (platform !== 'ios' && platform !== 'android') ||
    typeof id !== 'string' ||
    typeof projectRoot !== 'string' ||
    typeof pid !== 'number' ||
    typeof claimedAt !== 'string' ||
    typeof created !== 'boolean' ||
    (booted !== undefined && typeof booted !== 'boolean')
  ) {
    return null;
  }
  // A claim written before `booted` existed says nothing about a boot, so it claims none.
  return {
    backend,
    platform,
    id,
    projectRoot,
    pid,
    claimedAt,
    touchedAt,
    created,
    booted: booted ?? false,
    ...(reaping === true && { reaping }),
  };
}
