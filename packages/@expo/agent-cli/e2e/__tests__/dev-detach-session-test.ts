import fs from 'node:fs';
import path from 'node:path';

import { detachedSessionFixture } from '../detachedSessionFixture';
import { expoHomeOf, waitForAsync } from '../utils';
import { writeCloudBindingAsync } from '../stubEas';

it.skipIf(process.platform === 'win32').each(['ios', 'android'] as const)(
  'direct SIGTERM drains the submitted %s receipt reader and preserves its late session',
  async (platform) => {
    const f = await detachedSessionFixture(platform);
    try {
      await f.entered('start');
      f.child.kill('SIGTERM');
      expect(await waitForAsync(f.metroDown, 3000)).toBe(true);
      expect(f.child.exitCode).toBeNull();
      expect(f.child.signalCode).toBeNull();
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

it.each(['ios', 'android'] as const)(
  'repeated stop captures a late %s receipt and retains admission through its cleanup',
  async (platform) => {
    const f = await detachedSessionFixture(platform);
    try {
      await f.entered('start');
      for (const flags of [[], ['--eas']]) {
        const pending = await f.stop(flags);
        expect(pending.exitCode, pending.all).toBe(22);
        expect(JSON.parse(pending.stdout).admission).toBe('retained');
      }
      expect(fs.existsSync(f.record)).toBe(true);
      expect(fs.existsSync(f.mark('start-signalled'))).toBe(false);
      f.release('start');
      await f.entered('stop');
      expect(fs.existsSync(f.record)).toBe(true);
      const stillPending = await f.stop(['--eas']);
      expect(stillPending.exitCode, stillPending.all).toBe(22);
      f.release('stop');
      await f.result;
      expect(fs.existsSync(f.record)).toBe(false);
      expect(fs.existsSync(f.binding)).toBe(false);
      expect(f.commands().filter(([verb]) => verb === 'simulator:stop')).toEqual([
        ['simulator:stop', '--id', `receipt-${platform}`, '--non-interactive'],
      ]);
    } finally {
      await f.cleanup();
    }
  }
);

it.each(['ios', 'android'] as const)(
  'a late %s receipt never replaces or stops a newer binding',
  async (platform) => {
    const f = await detachedSessionFixture(platform);
    const lock = path.join(expoHomeOf(f.root), 'agent-cli', 'bindings', '.lock');
    let held = false;
    const unlock = () => {
      if (held) {
        fs.rmSync(lock, { recursive: true });
        held = false;
      }
    };
    try {
      await f.entered('start');
      const pending = await f.stop(['--eas']);
      expect(pending.exitCode, pending.all).toBe(22);
      fs.mkdirSync(lock, { recursive: true });
      held = true;
      fs.writeFileSync(path.join(lock, `pid-${process.pid}-aabbccdd`), '');
      await writeCloudBindingAsync(expoHomeOf(f.root), fs.realpathSync(f.root), {
        id: 'replacement',
        platform,
      });
      const replacement = fs.readFileSync(f.binding, 'utf8');
      f.release('start');
      expect(
        await waitForAsync(() => fs.existsSync(path.join(f.root, 'stub-eas-sessions.json')), 5000)
      ).toBe(true);
      unlock();
      await f.entered('stop');
      expect(fs.readFileSync(f.binding, 'utf8')).toBe(replacement);
      f.release('stop');
      await f.result;
      expect(fs.readFileSync(f.binding, 'utf8')).toBe(replacement);
      expect(
        f
          .commands()
          .filter(([verb]) => verb === 'simulator:stop')
          .flat()
      ).not.toContain('replacement');
      expect(fs.existsSync(f.record)).toBe(false);
    } finally {
      unlock();
      await f.cleanup();
    }
  }
);

it('retains ownership evidence when submitted work returns no session receipt', async () => {
  const f = await detachedSessionFixture('ios');
  try {
    await f.entered('start');
    const pending = await f.stop(['--eas']);
    expect(pending.exitCode, pending.all).toBe(22);
    fs.writeFileSync(f.mark('no-receipt'), '');
    f.release('start');
    await f.result;
    expect(fs.existsSync(f.record)).toBe(true);
    expect(fs.existsSync(f.binding)).toBe(false);
    expect(f.commands().filter(([verb]) => verb === 'simulator:stop')).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});
