import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import {
  collectOutput,
  executeAgentCliAsync,
  fixturesDir,
  killAsync,
  setupFixtureAsync,
  spawnAgentCli,
  waitForExitAsync,
} from './utils';

export async function detachedBarrierFixture() {
  const root = await setupFixtureAsync('go-app');
  const barrier = path.join(root, '.barrier');
  fs.mkdirSync(barrier);
  const socket = net.createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const env = {
    NODE_OPTIONS: `--require "${path.join(fixturesDir, 'detach-barrier.cjs').replaceAll('\\', '/')}"`,
    DETACH_TEST_BARRIER: barrier,
    STUB_EXPO_LISTEN: '1',
    STUB_EXPO_DELAY_MS: '60000',
    STUB_EXPO_DEV_SERVER_PORT: String(port),
  };
  const parents: ReturnType<typeof spawnAgentCli>[] = [];
  const marks = (name: string) =>
    fs.readdirSync(barrier).filter((file) => file.startsWith(`${name}-`));
  function start(extraEnv: Record<string, string> = {}, extraArgs: string[] = [], cwd = root) {
    const child = spawnAgentCli(
      cwd,
      [
        'dev',
        '--ios',
        '--go',
        '--local',
        '--no-open',
        '--detach',
        '--wait-ready',
        '--json',
        ...extraArgs,
      ],
      { env: { ...env, ...extraEnv } }
    );
    parents.push(child);
    return { child, result: waitForExitAsync(child, collectOutput(child)) };
  }
  const release = () => fs.writeFileSync(path.join(barrier, 'release'), '');
  async function cleanup() {
    release();
    await executeAgentCliAsync(root, ['dev:stop', '--json'], { reject: false });
    await Promise.all(parents.map((child) => killAsync(child, 'SIGKILL')));
    for (const file of marks('child')) {
      const pid = Number(file.slice('child-'.length));
      try {
        process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
      } catch {}
    }
  }
  return { root, env, port, start, marks, release, cleanup, barrier };
}
