// @ref llp/0005-runtime-loop-tools.rfc.md §Stopping the app
//
// `dev:stop` on Windows ends the dev server's tree with `taskkill /T /F`. A member of that tree
// that ends on its own while taskkill works through it (the detached wrapper exits when its expo
// child dies) makes taskkill exit non-zero, though the pid it was given is gone. The stop must
// still say that it signalled that pid.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isProcessAlive } from '../../src/dev/processLiveness';
import { signalProcessAsync } from '../../src/dev/processStop';

/** Each member ends when its child ends and when its parent's pipe closes. */
const TREE_MEMBER = `
const { spawn } = require('node:child_process');
const depth = Number(process.argv[2]);
if (process.argv[3] !== 'root') {
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
}
setInterval(() => {}, 1e6);
if (depth === 0) {
  process.stdout.write('ready\\n');
} else {
  const child = spawn(process.execPath, [__filename, String(depth - 1)], {
    stdio: ['pipe', 'inherit', 'ignore'],
  });
  child.on('exit', () => process.exit(0));
}
`;

async function startTreeAsync(script: string): Promise<number> {
  const root = spawn(process.execPath, [script, '3', 'root'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    root.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('ready')) resolve();
    });
    root.on('exit', () => reject(new Error('the tree ended before it was ready')));
  });
  return root.pid!;
}

describe.runIf(process.platform === 'win32')('signalProcessAsync on Windows', () => {
  it('reports the signal delivered when the pid it was given is gone after taskkill', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-stop-'));
    const script = path.join(dir, 'member.cjs');
    fs.writeFileSync(script, TREE_MEMBER);

    const results = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      const pid = await startTreeAsync(script);
      const sent = await signalProcessAsync(pid, 'SIGTERM');
      results.push({ attempt, ...sent, alive: isProcessAlive(pid) });
    }

    expect(results.filter((result) => !result.delivered || result.alive)).toEqual([]);
  });
});
