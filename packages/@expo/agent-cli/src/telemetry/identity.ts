// @ref llp/0028-command-telemetry.rfc.md
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

import { getExpoHomeDirectory } from '../utils/expoHome';

type TelemetryIdentity = { anonymousId: string; userHash?: string };

/** Read shared Expo identity without rewriting the file containing login credentials. */
export async function getTelemetryIdentityAsync(): Promise<TelemetryIdentity> {
  let userHash: string | undefined;
  let home: string;
  try {
    home = getExpoHomeDirectory();
  } catch {
    return { anonymousId: randomUUID() };
  }

  try {
    const state = JSON.parse(await fs.readFile(path.join(home, 'state.json'), 'utf8'));
    if (!process.env.EXPO_TOKEN && typeof state?.auth?.userId === 'string' && state.auth.userId) {
      userHash = createHash('sha256').update(state.auth.userId).digest('hex');
    }
    if (isUuid(state?.uuid)) {
      return { anonymousId: state.uuid, ...(userHash ? { userHash } : {}) };
    }
  } catch {
    // Missing or unreadable Expo settings must not prevent anonymous telemetry.
  }

  return {
    anonymousId: await getOwnAnonymousIdAsync(home),
    ...(userHash ? { userHash } : {}),
  };
}

async function getOwnAnonymousIdAsync(home: string): Promise<string> {
  const filename = path.join(home, 'agent-cli-telemetry-id');
  const anonymousId = randomUUID();
  let temporary: string | undefined;
  try {
    const existing = await readAnonymousIdAsync(filename);
    if (existing) return existing;

    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    temporary = `${filename}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, anonymousId, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const published = await publishAnonymousIdAsync(filename, temporary, anonymousId);
    if (published) return published;
    return await repairAnonymousIdAsync(filename, temporary, anonymousId);
  } catch {
    // Unreadable settings and failed writes must not prevent anonymous telemetry.
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => {});
  }
  return anonymousId;
}

async function publishAnonymousIdAsync(
  filename: string,
  temporary: string,
  anonymousId: string
): Promise<string | null | undefined> {
  try {
    // Publish only a complete UUID. Unlike rename, link cannot overwrite another worker's ID.
    // If this worker is terminated during writing, the persistent path remains untouched.
    await fs.link(temporary, filename);
    return anonymousId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return readAnonymousIdAsync(filename);
    }
    throw error;
  }
}

async function repairAnonymousIdAsync(
  filename: string,
  temporary: string,
  anonymousId: string
): Promise<string> {
  const lock = `${filename}.lock`;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const winner = await readAnonymousIdAsync(filename);
      if (winner) return winner;
      await setTimeout(25);
      continue;
    }

    try {
      // Serialize repairs and reread under the lock so a stale observation of corrupt data
      // cannot cause another worker's completed repair to be deleted.
      const existing = await readAnonymousIdAsync(filename);
      if (existing) return existing;
      if (existing === null) await fs.unlink(filename);
      // A normal initializer may publish while the corrupt path is absent. Keep its ID.
      return (await publishAnonymousIdAsync(filename, temporary, anonymousId)) ?? anonymousId;
    } finally {
      await fs.rmdir(lock).catch(() => {});
    }
  }
  // Never steal a lock: a worker killed before unlinking can leave one behind. Fall back
  // per invocation rather than risk deleting a live worker's repaired identity.
  return (await readAnonymousIdAsync(filename)) ?? anonymousId;
}

/** Null means readable but corrupt; undefined means missing. Other read failures propagate. */
async function readAnonymousIdAsync(filename: string): Promise<string | null | undefined> {
  try {
    const value = (await fs.readFile(filename, 'utf8')).trim();
    return isUuid(value) ? value : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
  );
}
