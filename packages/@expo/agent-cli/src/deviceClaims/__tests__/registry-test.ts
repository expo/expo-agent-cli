// @ref llp/0028-one-device-per-agent.rfc.md §The registry
import fs from 'fs';
import { vol } from 'memfs';
import path from 'path';

import { debugEvent, event } from '../events';
import {
  claimFilePath,
  deviceRegistryDirectory,
  readClaims,
  pruneUnreadableClaims,
  REGISTRY_LOCK_STALE_MS,
  releaseClaim,
  releaseProjectClaims,
  touchClaim,
  withRegistryLockAsync,
  writeClaim,
} from '../registry';
import type { DeviceClaim } from '../types';

// Without this, `expoHomeDirectory` reads the real home here, not the suite-wide `/home`.
vi.mock('os', async (importOriginal) => {
  const os = { ...(await importOriginal<typeof import('os')>()), homedir: () => '/home' };
  return { ...os, default: os };
});
vi.mock('../events', () => ({
  event: vi.fn(),
  debugEvent: Object.assign(vi.fn(), { error: vi.fn((error) => error) }),
}));

const REGISTRY = path.join('/home', '.expo', 'agent-cli', 'devices');

function claim(overrides: Partial<DeviceClaim> = {}): DeviceClaim {
  return {
    backend: 'local-ios',
    platform: 'ios',
    id: 'UDID-1',
    projectRoot: '/work/here',
    pid: 1234,
    claimedAt: '2026-09-30T10:00:00.000Z',
    touchedAt: '2026-09-30T10:00:00.000Z',
    created: false,
    ...overrides,
  };
}

afterEach(() => {
  vol.reset();
  vi.unstubAllEnvs();
});

describe('the registry directory', () => {
  it(`lives in ~/.expo`, () => {
    expect(deviceRegistryDirectory()).toBe(REGISTRY);
  });

  it(`follows the Expo home the rest of the CLI family reads`, () => {
    vi.stubEnv('__UNSAFE_EXPO_HOME_DIRECTORY', '/elsewhere');
    expect(deviceRegistryDirectory()).toBe(path.join('/elsewhere', 'agent-cli', 'devices'));

    vi.stubEnv('__UNSAFE_EXPO_HOME_DIRECTORY', '');
    vi.stubEnv('EXPO_STAGING', '1');
    expect(deviceRegistryDirectory()).toBe(
      path.join('/home', '.expo-staging', 'agent-cli', 'devices')
    );
  });

  it(`holds one file per device, named by backend and id`, () => {
    expect(claimFilePath('local-android', 'emulator-5554')).toBe(
      path.join(REGISTRY, 'local-android-emulator-5554.json')
    );
  });

  it(`keeps an id that is not a valid file name inside one file name`, () => {
    // A network adb serial has a colon, which Windows refuses in a file name.
    expect(path.basename(claimFilePath('local-android', '192.168.1.5:5555'))).toBe(
      'local-android-192.168.1.5%3A5555.json'
    );
  });
});

describe('writeClaim and readClaims', () => {
  it(`reads back what was written`, () => {
    writeClaim(claim());
    writeClaim(claim({ backend: 'local-android', platform: 'android', id: 'emulator-5554' }));

    expect(readClaims()).toEqual(
      expect.arrayContaining([
        claim(),
        claim({ backend: 'local-android', platform: 'android', id: 'emulator-5554' }),
      ])
    );
    expect(readClaims()).toHaveLength(2);
  });

  it(`reads no claims when the registry does not exist yet`, () => {
    expect(readClaims()).toEqual([]);
  });

  it(`refuses to overwrite the claim of a device that is already claimed`, () => {
    writeClaim(claim());

    expect(() => writeClaim(claim({ projectRoot: '/work/other' }))).toThrow(/EEXIST/);
    expect(readClaims()).toEqual([claim()]);
  });

  it(`ignores a file that is not a claim, and reports it on the debug stream`, () => {
    writeClaim(claim());
    vol.writeFileSync(path.join(REGISTRY, 'local-ios-broken.json'), '{"backend":');
    vol.writeFileSync(
      path.join(REGISTRY, 'local-ios-partial.json'),
      JSON.stringify({ backend: 'local-ios', id: 'X' })
    );

    expect(readClaims()).toEqual([claim()]);
    expect(debugEvent).toHaveBeenCalledWith(
      'device_claim_unreadable',
      expect.objectContaining({ file: path.join(REGISTRY, 'local-ios-broken.json') })
    );
    expect(debugEvent).toHaveBeenCalledWith(
      'device_claim_unreadable',
      expect.objectContaining({ file: path.join(REGISTRY, 'local-ios-partial.json') })
    );
  });

  it(`ignores what is not a claim file: the lock, and a touch in flight`, () => {
    writeClaim(claim());
    vol.mkdirSync(path.join(REGISTRY, '.lock'));
    vol.writeFileSync(path.join(REGISTRY, '.local-ios-UDID-1.json.99.tmp'), '{');

    expect(readClaims()).toEqual([claim()]);
  });
});

describe('touchClaim', () => {
  it(`refreshes touchedAt and nothing else`, () => {
    writeClaim(claim());
    const now = new Date('2026-09-30T11:00:00.000Z');

    expect(touchClaim(claim(), now)).toEqual(claim({ touchedAt: now.toISOString() }));
    expect(readClaims()).toEqual([claim({ touchedAt: now.toISOString() })]);
  });

  it(`does not touch a claim that another worktree took over`, () => {
    writeClaim(claim({ projectRoot: '/work/other' }));

    expect(touchClaim(claim(), new Date())).toBeNull();
    expect(readClaims()).toEqual([claim({ projectRoot: '/work/other' })]);
  });

  it(`does not bring back a claim that was released`, () => {
    expect(touchClaim(claim(), new Date())).toBeNull();
    expect(readClaims()).toEqual([]);
  });

  it(`does not touch the worktree's newer claim on the same device`, () => {
    const newer = claim({ claimedAt: '2026-09-30T10:30:00.000Z' });
    writeClaim(newer);

    expect(touchClaim(claim(), new Date())).toBeNull();
    expect(readClaims()).toEqual([newer]);
  });

  it(`reports no touch when another worktree took the claim over as it wrote`, () => {
    writeClaim(claim());
    const rename = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      rename(from, to);
      vol.writeFileSync(
        claimFilePath('local-ios', 'UDID-1'),
        JSON.stringify(claim({ projectRoot: '/work/other', claimedAt: '2026-09-30T11:00:00.000Z' }))
      );
    });

    try {
      expect(touchClaim(claim(), new Date())).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it(`reports no touch, and never throws, when the file system refuses`, () => {
    writeClaim(claim());
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });

    try {
      expect(touchClaim(claim(), new Date())).toBeNull();
    } finally {
      spy.mockRestore();
    }
    expect(debugEvent).toHaveBeenCalledWith(
      'device_claim_touch_failed',
      expect.objectContaining({ id: 'UDID-1' })
    );
  });
});

describe('releaseClaim', () => {
  it(`removes the claim`, () => {
    writeClaim(claim());

    expect(releaseClaim(claim())).toBe(true);
    expect(readClaims()).toEqual([]);
  });

  it(`leaves the claim of another worktree in place`, () => {
    writeClaim(claim({ projectRoot: '/work/other' }));

    expect(releaseClaim(claim())).toBe(false);
    expect(readClaims()).toHaveLength(1);
  });

  it(`is a no-op for a claim that does not exist`, () => {
    expect(releaseClaim(claim())).toBe(false);
  });
});

describe('releaseProjectClaims', () => {
  it(`releases every claim of the worktree and returns them, and no other`, () => {
    vol.mkdirSync('/work/here', { recursive: true });
    const ios = claim({ projectRoot: path.resolve('/work/here') });
    const android = claim({
      backend: 'local-android',
      platform: 'android',
      id: 'emulator-5554',
      projectRoot: path.resolve('/work/here'),
    });
    const foreign = claim({ id: 'UDID-2', projectRoot: '/work/other' });
    for (const each of [ios, android, foreign]) {
      writeClaim(each);
    }

    expect(releaseProjectClaims('/work/here')).toEqual(expect.arrayContaining([ios, android]));
    expect(readClaims()).toEqual([foreign]);
  });
});

describe('withRegistryLockAsync', () => {
  const lockDir = path.join(REGISTRY, '.lock');

  it(`holds the lock while the function runs, and removes it afterwards`, async () => {
    const result = await withRegistryLockAsync(async () => {
      expect(vol.existsSync(lockDir)).toBe(true);
      return 'done';
    });

    expect(result).toBe('done');
    expect(vol.existsSync(lockDir)).toBe(false);
  });

  it(`removes the lock when the function throws`, async () => {
    await expect(
      withRegistryLockAsync(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(vol.existsSync(lockDir)).toBe(false);
  });

  it(`runs one holder at a time`, async () => {
    const order: string[] = [];
    const hold = (name: string) =>
      withRegistryLockAsync(async () => {
        order.push(`${name}:in`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push(`${name}:out`);
      });

    await Promise.all([hold('a'), hold('b'), hold('c')]);

    expect(order).toHaveLength(6);
    for (let index = 0; index < order.length; index += 2) {
      expect(order[index]?.replace(':in', '')).toBe(order[index + 1]?.replace(':out', ''));
    }
  });

  it(`waits for a lock that is not stale yet`, async () => {
    vol.mkdirSync(lockDir, { recursive: true });
    setTimeout(() => vol.rmdirSync(lockDir), 50);

    const started = Date.now();
    await withRegistryLockAsync(async () => {});

    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });

  it(`removes a lock older than the limit, because its holder is dead`, async () => {
    vol.mkdirSync(lockDir, { recursive: true });
    const old = (Date.now() - REGISTRY_LOCK_STALE_MS - 1000) / 1000;
    vol.utimesSync(lockDir, old, old);

    expect(await withRegistryLockAsync(async () => 'taken')).toBe('taken');
    expect(event).toHaveBeenCalledWith(
      'device_registry_lock_stale_removed',
      expect.objectContaining({ lock: lockDir })
    );
  });

  it(`leaves a stale lock to the waiter that holds the takeover guard`, async () => {
    vol.mkdirSync(lockDir, { recursive: true });
    const old = (Date.now() - REGISTRY_LOCK_STALE_MS - 1000) / 1000;
    vol.utimesSync(lockDir, old, old);
    vol.mkdirSync(`${lockDir}.takeover`);
    let foreignLockKept = false;
    setTimeout(() => {
      // The other waiter removes the stale lock, takes the lock and lets go of the guard.
      vol.rmSync(lockDir, { recursive: true });
      vol.mkdirSync(lockDir);
      vol.writeFileSync(path.join(lockDir, 'owner'), 'other-holder');
      vol.rmdirSync(`${lockDir}.takeover`);
    }, 30);
    setTimeout(() => {
      foreignLockKept = String(vol.readFileSync(path.join(lockDir, 'owner'))) === 'other-holder';
      vol.rmSync(lockDir, { recursive: true });
    }, 120);

    let ownerSeenInside: string | null = null;
    await withRegistryLockAsync(async () => {
      ownerSeenInside = String(vol.readFileSync(path.join(lockDir, 'owner')));
    });

    expect(foreignLockKept).toBe(true);
    expect(ownerSeenInside).toMatch(new RegExp(`^${process.pid}-`));
  });

  it(`removes a takeover guard whose holder died`, async () => {
    const old = (Date.now() - REGISTRY_LOCK_STALE_MS - 1000) / 1000;
    for (const directory of [lockDir, `${lockDir}.takeover`]) {
      vol.mkdirSync(directory, { recursive: true });
      vol.utimesSync(directory, old, old);
    }

    expect(await withRegistryLockAsync(async () => 'taken')).toBe('taken');
    expect(vol.existsSync(`${lockDir}.takeover`)).toBe(false);
  });

  it(`leaves the lock of a new holder in place when its own lock was taken over`, async () => {
    await withRegistryLockAsync(async () => {
      fs.renameSync(lockDir, `${lockDir}.stale-taker`);
      vol.mkdirSync(lockDir);
      vol.writeFileSync(path.join(lockDir, 'owner'), 'taker');
    });

    expect(String(vol.readFileSync(path.join(lockDir, 'owner')))).toBe('taker');
  });

  it(`notices on the heartbeat that its lock is gone`, async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await withRegistryLockAsync(async () => {
        vol.rmSync(lockDir, { recursive: true });
        vi.advanceTimersByTime(10_000);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(debugEvent).toHaveBeenCalledWith(
      'device_registry_lock_lost',
      expect.objectContaining({ lock: lockDir })
    );
  });

  it(`notices on the heartbeat that another holder took its lock over`, async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await withRegistryLockAsync(async () => {
        vol.writeFileSync(path.join(lockDir, 'owner'), 'taker');
        vi.advanceTimersByTime(10_000);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(debugEvent).toHaveBeenCalledWith(
      'device_registry_lock_lost',
      expect.objectContaining({ lock: lockDir })
    );
    expect(String(vol.readFileSync(path.join(lockDir, 'owner')))).toBe('taker');
  });
});

describe('withRegistryLockAsync across processes', () => {
  it(`admits one process at a time when several take over the same stale lock`, async () => {
    const fsReal = await vi.importActual<typeof import('fs')>('node:fs');
    const osReal = await vi.importActual<typeof import('os')>('node:os');
    const { spawn, spawnSync } =
      await vi.importActual<typeof import('child_process')>('node:child_process');
    if (spawnSync('bun', ['--version']).status !== 0) {
      return;
    }
    const home = fsReal.mkdtempSync(path.join(osReal.tmpdir(), 'agent-cli-lock-race-'));
    try {
      const lock = path.join(home, 'agent-cli', 'devices', '.lock');
      fsReal.mkdirSync(lock, { recursive: true });
      const old = (Date.now() - REGISTRY_LOCK_STALE_MS - 1000) / 1000;
      fsReal.utimesSync(lock, old, old);
      const log = path.join(home, 'log');
      const startAt = String(Date.now() + 1500);
      const script = path.join(__dirname, 'fixtures', 'lockRace.ts');

      const exits = await Promise.all(
        Array.from(
          { length: 6 },
          () =>
            new Promise<number | null>((resolve) => {
              const child = spawn('bun', [script, log, startAt], {
                env: { ...process.env, __UNSAFE_EXPO_HOME_DIRECTORY: home },
                stdio: 'inherit',
              });
              child.on('exit', resolve);
            })
        )
      );

      expect(exits).toEqual([0, 0, 0, 0, 0, 0]);
      const lines = fsReal.readFileSync(log, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(12);
      for (let index = 0; index < lines.length; index += 2) {
        const [enter, pid] = lines[index]!.split(' ');
        expect(enter).toBe('in');
        expect(lines[index + 1]).toBe(`out ${pid}`);
      }
    } finally {
      fsReal.rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('pruneUnreadableClaims', () => {
  const NOW = Date.now();

  function writeRaw(name: string, text: string, ageMs: number): string {
    vol.mkdirSync(REGISTRY, { recursive: true });
    const file = path.join(REGISTRY, name);
    vol.writeFileSync(file, text);
    const seconds = (NOW - ageMs) / 1000;
    vol.utimesSync(file, seconds, seconds);
    return file;
  }

  it(`removes a claim file that does not parse once it is older than a minute`, () => {
    const file = writeRaw('local-ios-UDID-9.json', '{"backend":', 61_000);

    pruneUnreadableClaims(NOW);

    expect(vol.existsSync(file)).toBe(false);
    expect(event).toHaveBeenCalledWith(
      'device_claim_unreadable_removed',
      expect.objectContaining({ file })
    );
  });

  it(`keeps a claim file that does not parse yet, because it may be half written`, () => {
    const file = writeRaw('local-ios-UDID-9.json', '{"backend":', 5_000);

    pruneUnreadableClaims(NOW);

    expect(vol.existsSync(file)).toBe(true);
  });

  it(`keeps a claim file that parses, whatever its shape and age`, () => {
    const file = writeRaw('local-ios-UDID-9.json', '{"backend":"local-ios"}', 3_600_000);
    writeClaim(claim());

    pruneUnreadableClaims(NOW);

    expect(vol.existsSync(file)).toBe(true);
    expect(readClaims()).toEqual([claim()]);
  });
});
