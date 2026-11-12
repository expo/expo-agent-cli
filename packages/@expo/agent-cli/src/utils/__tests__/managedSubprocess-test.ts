import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runInheritedAsync } from '../inheritedRun';
import { spawnSubprocessAsync } from '../subprocess';

vi.unmock('fs');
vi.unmock('node:fs');
vi.unmock('child_process');
vi.unmock('node:child_process');

it.each(['capture', 'inherit'] as const)(
  'cancels an already running %s child through its handle',
  async (output) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-child-'));
    const entered = path.join(root, 'entered');
    const survived = path.join(root, 'survived');
    const abort = new AbortController();
    const script = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(entered)},String(process.pid));
    setTimeout(()=>{ fs.writeFileSync(${JSON.stringify(survived)},''); },500);
    setTimeout(()=>process.exit(0),700);`;
    let pid: number | undefined;
    try {
      const work =
        output === 'capture'
          ? spawnSubprocessAsync(process.execPath, ['-e', script], {
              signal: abort.signal,
              cwd: root,
            })
          : runInheritedAsync(process.execPath, ['-e', script], {
              signal: abort.signal,
              cwd: root,
            });
      const deadline = Date.now() + 2000;
      while (!fs.existsSync(entered) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fs.existsSync(entered)).toBe(true);
      pid = Number(fs.readFileSync(entered, 'utf8'));
      abort.abort(new Error('requested cancellation'));
      await work;
      expect(fs.existsSync(survived)).toBe(false);
    } finally {
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
