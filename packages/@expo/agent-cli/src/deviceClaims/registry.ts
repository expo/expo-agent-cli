// @ref llp/0030-one-device-per-agent.rfc.md §The registry
// The machine-wide registry: one JSON file per claimed device, and one lock for the decisions
// that read several of them.

import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { getExpoHomeDirectory } from '../utils/expoHome';
import { canonicalizeExistingPath } from '../utils/dir';
import { debugEvent, event } from './events';
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
 * reader never sees half a file, which it would read as no claim at all. It is a compare-and-swap:
 * the file must name this claim (its worktree and its `claimedAt`) before the rename and after it.
 *
 * @returns the touched claim, or null when the claim was released, another claim replaced it, or
 * the file system refused. Never throws.
 */
export function touchClaim(
  claim: DeviceClaim,
  now: Date = new Date(),
  patch: Pick<Partial<DeviceClaim>, 'booted'> = {}
): DeviceClaim | null {
  const file = claimFilePath(claim.backend, claim.id);
  try {
    const current = readClaimFile(file);
    if (current == null || !isSameClaim(current, claim)) {
      return null;
    }
    const touched = { ...current, ...patch, touchedAt: now.toISOString() };
    const temporary = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
    );
    fs.writeFileSync(temporary, serialize(touched));
    fs.renameSync(temporary, file);
    const after = readClaimFile(file);
    return after != null && isSameClaim(after, claim) ? touched : null;
  } catch (error: unknown) {
    debugEvent('device_claim_touch_failed', {
      backend: claim.backend,
      id: claim.id,
      reason: (error as Error).message,
    });
    return null;
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
    return await fn();
  } finally {
    clearInterval(heartbeat);
    if (readLockOwner(owner) === token) {
      fs.rmSync(lock, { recursive: true, force: true });
    }
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
  const { backend, platform, id, projectRoot, pid, claimedAt, touchedAt, created, booted } =
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
  };
}
