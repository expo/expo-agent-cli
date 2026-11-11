import fs from 'node:fs';

import { detachedControlFixture } from '../detachedControlFixture';
import { waitForAsync } from '../utils';

it.each(['ios', 'android'] as const)(
  'cooperative stop cancels a responsive %s owner before its server lock exists',
  async (platform) => {
    const f = await detachedControlFixture(platform);
    try {
      const started = f.start();
      expect(await waitForAsync(() => f.marks('entered').length === 1, 15_000)).toBe(true);
      expect(fs.existsSync(f.record(started.id))).toBe(true);
      const stopped = await f.run(['dev:stop', '--json']);
      expect(stopped.exitCode, stopped.all).toBe(0);
      expect(await waitForAsync(() => f.marks('cancelled').length === 1, 5000)).toBe(true);
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
