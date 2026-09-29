// @ref llp/0028-command-telemetry.rfc.md
import { boolish } from 'getenv';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

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

function getExpoHomeDirectory(): string {
  return (
    process.env.__UNSAFE_EXPO_HOME_DIRECTORY ||
    path.join(
      homedir(),
      boolish('EXPO_STAGING', false)
        ? '.expo-staging'
        : boolish('EXPO_LOCAL', false)
          ? '.expo-local'
          : '.expo'
    )
  );
}

async function getOwnAnonymousIdAsync(home: string): Promise<string> {
  const filename = path.join(home, 'agent-cli-telemetry-id');
  const existing = await readAnonymousIdAsync(filename);
  if (existing) return existing;

  const anonymousId = randomUUID();
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    await fs.writeFile(temporary, anonymousId, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    // Publish only a complete UUID. Unlike rename, link cannot overwrite another worker's ID.
    // If this worker is terminated during writing, the persistent path remains untouched.
    await fs.link(temporary, filename);
    return anonymousId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const winner = await readAnonymousIdAsync(filename);
      if (winner) return winner;
    }
    return anonymousId;
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

async function readAnonymousIdAsync(filename: string): Promise<string | undefined> {
  try {
    const value = (await fs.readFile(filename, 'utf8')).trim();
    return isUuid(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
  );
}
