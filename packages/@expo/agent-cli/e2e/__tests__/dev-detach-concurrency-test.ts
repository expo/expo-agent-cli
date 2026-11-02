import { detachedBarrierFixture as fixture } from '../detachedBarrierFixture';
import fs from 'node:fs';
import path from 'node:path';

import { executeAgentCliAsync, readStubExpoInvocations, waitForAsync } from '../utils';

it.each([
  { name: 'same options', argv: [], alias: false },
  { name: 'different port', argv: ['--port', '8396'], alias: false },
  { name: 'worktree alias', argv: [], alias: true },
])(
  'a concurrent detached start refuses without replacing the owner: $name',
  async ({ argv, alias }) => {
    const f = await fixture();
    try {
      const first = f.start();
      expect(await waitForAsync(() => f.marks('blocked').length === 1, 15_000)).toBe(true);
      const ownerPid = Number(f.marks('blocked')[0]!.slice('blocked-'.length));
      const cwd = alias ? path.join(f.root, '.alias') : f.root;
      if (alias) fs.symlinkSync(f.root, cwd, 'junction');
      const second = await f.start({}, argv, cwd).result;
      expect(second.exitCode, second.all).toBe(20);
      const refusal = JSON.parse(second.stdout).error;
      expect(refusal).toMatchObject({ code: 'DEV_START_BUSY', data: { pid: ownerPid } });
      expect(fs.existsSync(refusal.data.logFile)).toBe(true);
      expect(f.marks('blocked')).toHaveLength(1);
      expect(readStubExpoInvocations(f.root)).toHaveLength(0);
      f.release();
      const started = await first.result;
      expect(started.exitCode, started.all).toBe(0);
      const a = JSON.parse(started.stdout);
      expect(a).toMatchObject({ pid: ownerPid, logFile: refusal.data.logFile });
      expect(
        readStubExpoInvocations(f.root).filter((call) => call.args[0] === 'start')
      ).toHaveLength(1);
      const logs = await executeAgentCliAsync(f.root, ['dev:logs', '--json']);
      expect(JSON.parse(logs.stdout)).toMatchObject({ logFile: a.logFile });
      expect(JSON.parse(logs.stdout).lines.join('\n')).toContain(`pid ${a.pid}`);
      const status = await executeAgentCliAsync(f.root, ['status', '--json']);
      expect(JSON.parse(status.stdout).devServer).toMatchObject({ running: true, url: a.url });
      const stopped = await executeAgentCliAsync(f.root, ['dev:stop', '--json']);
      expect(JSON.parse(stopped.stdout)).toMatchObject({ stopped: true, pid: a.pid });
    } finally {
      await f.cleanup();
    }
  }
);
