// @ref llp/0036-detached-run-ownership.rfc.md
import fs from 'node:fs';
import path from 'node:path';

import { detachedBarrierFixture } from '../detachedBarrierFixture';
import { executeAgentCliAsync, waitForAsync } from '../utils';

it.skipIf(process.platform === 'win32').each(['ios', 'android'] as const)(
  'another TMPDIR cannot discard a live %s owner, but can recover its interrupted run',
  async (platform) => {
    const f = await detachedBarrierFixture(platform);
    // A nested macOS TMPDIR can make the dev-lock fallback exceed the Unix socket limit.
    // Keep this POSIX-only fixture short while still giving the reader a distinct TMPDIR.
    const readerTmp = fs.mkdtempSync('/tmp/agent-cli-reader-');
    const env = { TMPDIR: readerTmp };
    try {
      const first = f.start();
      expect(await waitForAsync(() => f.marks('blocked').length === 1, 15_000)).toBe(true);
      const ownerPid = Number(f.marks('blocked')[0]!.slice('blocked-'.length));
      const stopped = await executeAgentCliAsync(f.root, ['dev:stop', '--json'], {
        reject: false,
      });
      const detail = JSON.parse(stopped.stdout).detail;
      const id = /Detached run ([\da-f-]{36})/.exec(detail)?.[1];
      expect(id, stopped.all).toBeTruthy();
      const discardArgs = ['dev:stop', '--discard-run', id!, '--json'];
      const discard = await executeAgentCliAsync(f.root, discardArgs, { env, reject: false });
      expect(discard.exitCode, discard.all).toBe(20);
      expect(JSON.parse(discard.stdout).error.code).toBe('DEV_START_BUSY');

      const status = await executeAgentCliAsync(f.root, ['status', '--json'], { env });
      expect(JSON.parse(status.stdout).next.recovery).toMatchObject({
        kind: 'observe',
        attempt: { id, pid: ownerPid },
      });
      expect(JSON.parse(status.stdout).next.command).not.toContain('--discard-run');
      const contender = await f.start(env).result;
      expect(contender.exitCode, contender.all).toBe(20);
      expect(JSON.parse(contender.stdout).error.code).toBe('DEV_START_BUSY');
      expect(f.marks('blocked')).toHaveLength(1);

      // No subprocess has started: killing the held owner leaves only interrupted evidence.
      process.kill(ownerPid, 'SIGKILL');
      await first.result;
      const recovery = await executeAgentCliAsync(f.root, discardArgs, { env });
      expect(JSON.parse(recovery.stdout).discardedRun).toBe(id);
      f.release();
      const restarted = await f.start(env).result;
      expect(restarted.exitCode, restarted.all).toBe(0);
    } finally {
      try {
        // The restarted server published its dev lock under the reader's TMPDIR too.
        await executeAgentCliAsync(f.root, ['dev:stop', '--json'], { env, reject: false });
      } finally {
        await f.cleanup();
        fs.rmSync(readerTmp, { recursive: true, force: true });
      }
    }
  }
);

it.each(['missing', 'relative', 'wrong-attempt', 'unreadable'] as const)(
  'an unknown ownership endpoint (%s) never grants discard authority',
  async (fault) => {
    const f = await detachedBarrierFixture();
    let marker: string | undefined;
    let saved: string | undefined;
    try {
      const first = f.start();
      expect(await waitForAsync(() => f.marks('blocked').length === 1, 15_000)).toBe(true);
      const directory = path.join(f.root, '.expo', 'dev', 'detached-run');
      marker = path.join(directory, fs.readdirSync(directory)[0]!);
      saved = fs.readFileSync(marker, 'utf8');
      const record = JSON.parse(saved);
      const id = record.id;
      if (fault === 'missing') delete record.endpoint;
      if (fault === 'relative') record.endpoint = 'missing.sock';
      if (fault === 'wrong-attempt') record.endpoint += '-other';
      fs.writeFileSync(marker, fault === 'unreadable' ? '{' : JSON.stringify(record));
      const discard = await executeAgentCliAsync(
        f.root,
        ['dev:stop', '--discard-run', id, '--json'],
        { reject: false }
      );
      expect(discard.exitCode, discard.all).toBe(20);
      const error = JSON.parse(discard.stdout).error;
      expect(error.code).toBe('DEV_START_UNCERTAIN');
      expect(error.suggestedCommand).toBeNull();
      expect(fs.existsSync(marker)).toBe(true);
      process.kill(Number(f.marks('blocked')[0]!.slice('blocked-'.length)), 'SIGKILL');
      await first.result;
      const afterDeath = await executeAgentCliAsync(
        f.root,
        ['dev:stop', '--discard-run', id, '--json'],
        { reject: false }
      );
      expect(afterDeath.exitCode, afterDeath.all).toBe(20);
      expect(JSON.parse(afterDeath.stdout).error.code).toBe('DEV_START_UNCERTAIN');
      expect(fs.existsSync(marker)).toBe(true);
    } finally {
      if (marker && saved) fs.writeFileSync(marker, saved);
      await f.cleanup();
    }
  }
);
