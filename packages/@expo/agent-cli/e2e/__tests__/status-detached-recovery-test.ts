import fs from 'node:fs';
import path from 'node:path';

import { detachedRunFixture } from '../detachedRunFixture';
import { readDevLockAsync } from '../utils';
import { androidBindingFixture, bindingFixture } from './installedAppStubs';

it.each(['ios', 'android'] as const)(
  'status restarts an owned but unresponsive server with a live %s binding',
  async (platform) => {
    const f = await detachedRunFixture();
    const muted = path.join(f.root, 'mute-status');
    const script = path.join(f.root, 'node_modules', 'expo', 'bin', 'cli');
    fs.writeFileSync(
      script,
      fs
        .readFileSync(script, 'utf8')
        .replace(
          "if (route === '/json/list') {",
          `if (fs.existsSync(${JSON.stringify(muted)})) { response.writeHead(503); response.end('unavailable'); return; }\n    if (route === '/json/list') {`
        )
    );
    try {
      const started = await f.run([
        'dev',
        `--${platform}`,
        '--go',
        '--local',
        '--no-open',
        '--port',
        String(f.port),
        '--detach',
        '--wait-ready',
        '--json',
      ]);
      expect(started.exitCode, started.all).toBe(0);
      const owner = JSON.parse(started.stdout);
      if (platform === 'ios') await bindingFixture(f.root, 'E2E-RECOVERY');
      else await androidBindingFixture(f.root, 'emulator-5554');
      fs.writeFileSync(muted, '');
      const status = await f.run(['status', '--json']);
      expect(status.exitCode, status.all).toBe(0);
      const report = JSON.parse(status.stdout);
      expect(report.devServer.running).toBe(false);
      const command = report.next.command as string;
      expect(command).toContain(`dev:stop && npx @expo/agent-cli dev --${platform}`);
      expect(command).toContain(`--port ${f.port}`);
      fs.rmSync(muted);
      // These fixture requests contain no quoted arguments; execute the emitted argv in order.
      for (const step of command.split(' && ')) {
        const result = await f.run([...step.split(' ').slice(2), '--json']);
        expect(result.exitCode, result.all).toBe(0);
      }
      const replacement = await readDevLockAsync(f.root);
      expect(replacement?.port).toBe(f.port);
      expect(replacement?.pid).not.toBe(owner.pid);
    } finally {
      fs.rmSync(muted, { force: true });
      await f.cleanup();
    }
  }
);
