import fs from 'node:fs';
import path from 'node:path';

import { detachedControlFixture } from '../detachedControlFixture';
import { expoHomeOf, waitForAsync } from '../utils';
import {
  cloudBindingFile,
  installStubEasAsync,
  stubEasArgs,
  writeCloudBindingAsync,
} from '../stubEas';

it.each(['ios', 'android'] as const)(
  'cooperative stop cancels a responsive %s owner before its server lock exists',
  async (platform) => {
    const f = await detachedControlFixture(platform);
    try {
      const started = f.start();
      expect(await waitForAsync(() => f.marks('entered').length === 1, 15_000)).toBe(true);
      const configPid = Number(f.marks('entered')[0]!.slice('entered-'.length));
      expect(fs.existsSync(f.record(started.id))).toBe(true);
      const stopped = await f.run(['dev:stop', '--json']);
      expect(stopped.exitCode, stopped.all).toBe(0);
      expect(JSON.parse(stopped.stdout)).toMatchObject({
        stopped: false,
        reason: 'not-running',
        admission: 'released',
      });
      expect(
        await waitForAsync(() => {
          try {
            process.kill(configPid, 0);
            return false;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ESRCH';
          }
        }, 5000)
      ).toBe(true);
      expect(await waitForAsync(() => !fs.existsSync(f.record(started.id)), 5000)).toBe(true);
      expect(f.marks('entered')).toHaveLength(1);
      expect((await started.result).exitCode).not.toBe(0);
    } finally {
      await f.cleanup();
    }
  }
);

it.each(['ios', 'android'] as const)(
  'matching %s election contenders observe startup while changed requests refuse it',
  async (platform) => {
    const f = await detachedControlFixture(platform);
    try {
      const owner = f.start();
      expect(await waitForAsync(() => f.marks('entered').length === 1, 15_000)).toBe(true);
      const matching = await f.start(['--no-followups']).result;
      expect(matching.exitCode, matching.all).toBe(22);
      const refusal = JSON.parse(matching.stdout).error;
      expect(refusal.code).toBe('DEV_START_IN_PROGRESS');
      expect(refusal.data.pid).toBe(owner.child.pid);
      expect(refusal.data.logFile).toContain(owner.id);
      const changed = await f.start(['--clear']).result;
      expect(changed.exitCode, changed.all).toBe(20);
      expect(JSON.parse(changed.stdout).error.code).toBe('DEV_START_BUSY');
      expect(f.marks('entered')).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  }
);

it.each(['ios', 'android'] as const)(
  'preflight %s cancellation cleans up captured existing resources before releasing admission',
  async (platform) => {
    const f = await detachedControlFixture(platform);
    try {
      await installStubEasAsync(f.root);
      const root = fs.realpathSync(f.root);
      await writeCloudBindingAsync(expoHomeOf(f.root), root, { id: 'prior-session', platform });
      const local = cloudBindingFile(expoHomeOf(f.root), root, 'android').replace(
        '-cloud.json',
        '-local-android.json'
      );
      const boundAt = new Date().toISOString();
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(
        local,
        JSON.stringify({
          version: 1,
          projectRoot: root,
          boundAt,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          device: {
            backend: 'local-android',
            platform: 'android',
            serial: 'captured-usb',
            origin: { kind: 'explicit' },
          },
        })
      );
      const owner = f.start();
      expect(await waitForAsync(() => f.marks('entered').length === 1, 15000)).toBe(true);
      const stopped = await f.run(['dev:stop', '--eas', '--release', '--json']);
      expect(stopped.exitCode, stopped.all).toBe(0);
      expect(JSON.parse(stopped.stdout).admission).toBe('released');
      expect(fs.existsSync(f.record(owner.id))).toBe(false);
      expect(fs.existsSync(cloudBindingFile(expoHomeOf(f.root), root, platform))).toBe(false);
      expect(stubEasArgs(f.root).filter(([verb]) => verb === 'simulator:stop')).toEqual([
        ['simulator:stop', '--id', 'prior-session', '--non-interactive'],
      ]);
      const remaining = JSON.parse(fs.readFileSync(local, 'utf8'));
      expect(remaining.boundAt).toBe(boundAt);
      expect(Date.parse(remaining.expiresAt)).toBeLessThanOrEqual(Date.now());
      await owner.result;
    } finally {
      await f.cleanup();
    }
  }
);
