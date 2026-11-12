import fs from 'node:fs';

import { detachedSessionFixture } from '../detachedSessionFixture';
import { waitForAsync } from '../utils';

it.skipIf(process.platform === 'win32').each(['ios', 'android'] as const)(
  'direct SIGTERM drains the submitted %s receipt reader and preserves its late session',
  async (platform) => {
    const f = await detachedSessionFixture(platform);
    try {
      await f.entered('start');
      f.child.kill('SIGTERM');
      expect(
        await waitForAsync(async () => {
          const owner = await f.observe();
          return owner.kind === 'live' && owner.progress.kind === 'stopping';
        }, 3000)
      ).toBe(true);
      expect(fs.existsSync(f.record)).toBe(true);
      expect(fs.existsSync(f.mark('start-signalled'))).toBe(false);
      f.release('start');
      await f.result;
      expect(fs.existsSync(f.record)).toBe(false);
      expect(JSON.parse(fs.readFileSync(f.binding, 'utf8')).device.id).toBe(`receipt-${platform}`);
      expect(f.commands().filter(([verb]) => verb === 'simulator:stop')).toHaveLength(0);
    } finally {
      await f.cleanup();
    }
  }
);
