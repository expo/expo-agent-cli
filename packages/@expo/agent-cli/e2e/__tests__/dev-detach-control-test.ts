import fs from 'node:fs';
import path from 'node:path';

import { isProcessAlive } from '../../src/dev/processLiveness';
import { detachedControlFixture } from '../detachedControlFixture';
import { expoHomeOf, readStubExpoInvocations, waitForAsync } from '../utils';
import {
  STUB_EAS_LOG_NAME,
  cloudBindingFile,
  installStubEasAsync,
  stubEasArgs,
  stubEasCommands,
  writeCloudBindingAsync,
  writeCloudSessionFileAsync,
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
  'cooperative stop cancels %s EAS session discovery before Metro starts',
  async (platform) => {
    const f = await detachedControlFixture(platform, { open: true });
    const barrier = path.join(f.root, 'session-list-barrier');
    fs.mkdirSync(barrier);
    const release = path.join(barrier, 'release');
    const entered = path.join(barrier, 'entered');
    const cancelled = path.join(barrier, 'cancelled');
    const packageFile = path.join(f.root, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    manifest.devDependencies = { ...manifest.devDependencies, 'eas-cli': '*' };
    fs.writeFileSync(packageFile, JSON.stringify(manifest));
    await installStubEasAsync(f.root, {
      script: `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(f.root, STUB_EAS_LOG_NAME))}, JSON.stringify({ args }) + '\\n');
if (args[0] === 'simulator:list') {
  process.on('SIGTERM', () => {
    fs.writeFileSync(${JSON.stringify(cancelled)}, '');
    process.exit(0);
  });
  fs.writeFileSync(${JSON.stringify(entered)}, String(process.pid));
  const poll = setInterval(() => {
    if (fs.existsSync(${JSON.stringify(release)})) {
      clearInterval(poll);
      console.log(JSON.stringify({ sessions: [], pageInfo: { hasNextPage: false, endCursor: null } }));
    }
  }, 20);
} else if (args[0] === 'simulator:availability') {
  console.log(JSON.stringify({ available: true }));
} else {
  process.exitCode = 1;
}
`,
    });
    await writeCloudSessionFileAsync(f.root, 'prior-session');
    fs.writeFileSync(path.join(f.barrier, 'release'), '');
    let probePid: number | undefined;
    try {
      const owner = f.start();
      expect(
        await waitForAsync(
          () => fs.existsSync(entered) && Number(fs.readFileSync(entered, 'utf8')) > 0,
          15_000
        )
      ).toBe(true);
      expect(fs.existsSync(f.record(owner.id))).toBe(true);
      const pid = Number(fs.readFileSync(entered, 'utf8'));
      probePid = pid;
      const stopped = await f.run(['dev:stop', '--json']);
      expect(stopped.exitCode, stopped.all).toBe(0);
      expect(JSON.parse(stopped.stdout)).toMatchObject({
        stopped: false,
        reason: 'not-running',
        admission: 'released',
      });
      const ended = await owner.result;
      expect(ended.exitCode).toBe(143);
      expect(JSON.parse(ended.stdout).error.code).toBe('DEV_INTERRUPTED');
      expect(fs.existsSync(f.record(owner.id))).toBe(false);
      expect(fs.existsSync(path.join(f.root, '.expo', 'agent-cli-last-dev.json'))).toBe(false);
      if (process.platform !== 'win32') {
        expect(await waitForAsync(() => fs.existsSync(cancelled), 5_000)).toBe(true);
      }
      expect(await waitForAsync(() => !isProcessAlive(pid), 5_000)).toBe(true);
      expect(stubEasCommands(f.root)).toEqual(['simulator:list']);
      expect(readStubExpoInvocations(f.root).map(({ args }) => args)).toEqual([
        ['config', '--json'],
      ]);
    } finally {
      fs.writeFileSync(release, '');
      try {
        const pid = probePid;
        if (pid && !(await waitForAsync(() => !isProcessAlive(pid), 5_000))) {
          process.kill(pid, 'SIGKILL');
        }
      } finally {
        await f.cleanup();
      }
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
      const report = JSON.parse(stopped.stdout);
      expect(report.admission).toBe('released');
      expect(report.session).toMatchObject({ id: 'prior-session', platform, stopped: true });
      expect(report.devices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ backend: 'cloud', id: 'prior-session', released: true }),
          expect.objectContaining({ backend: 'local-android', id: 'captured-usb', released: true }),
        ])
      );
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
