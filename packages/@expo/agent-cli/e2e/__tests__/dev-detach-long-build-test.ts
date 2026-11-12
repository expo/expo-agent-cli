import fs from 'node:fs';
import path from 'node:path';

import { runRecoveryCommand } from '../recoveryCommand';
import { installStubEasAsync, STUB_EAS_SCRIPT, stubEasArgs } from '../stubEas';
import {
  collectOutput,
  executeAgentCliAsync,
  freePortAsync,
  installStubFingerprintAsync,
  killAsync,
  readDevLockAsync,
  readStubExpoInvocations,
  setupFixtureAsync,
  spawnAgentCli,
  waitForAsync,
  waitForExitAsync,
} from '../utils';

it.concurrent.for(['ios', 'android'] as const)(
  'DF1: a default observation timeout leaves one %s build observable and controllable',
  { timeout: 200_000 },
  async (platform, { expect }) => {
    const root = await setupFixtureAsync('dev-client-app');
    await installStubFingerprintAsync(root);
    const release = path.join(root, 'finish-build');
    const building = path.join(root, 'build-process');
    const script = fs.readFileSync(STUB_EAS_SCRIPT, 'utf8').replace(
      'setTimeout(finishBuild, delayMs);',
      `fs.writeFileSync(${JSON.stringify(building)}, String(process.pid));
      const barrier = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(release)})) return;
        clearInterval(barrier);
        finishBuild();
      }, 50);`
    );
    await installStubEasAsync(root, { script });
    const appFile = path.join(root, 'app.json');
    const app = JSON.parse(fs.readFileSync(appFile, 'utf8'));
    app.expo.scheme = 'df1-devclient';
    fs.writeFileSync(appFile, JSON.stringify(app));
    const port = await freePortAsync();
    const env = {
      AGENT_CLI_DETACH_TIMEOUT_MS: undefined,
      STUB_EAS_BUILD_DELAY_MS: '1',
      STUB_EXPO_LISTEN: '1',
      STUB_EXPO_DELAY_MS: '300000',
      STUB_EXPO_DEV_SERVER_PORT: String(port),
      STUB_EXPO_TUNNEL_HOST: 'df1.tunnel.example',
      STUB_EXPO_TUNNEL_DELAY_MS: '200',
      STUB_SIM_SESSIONS: '0',
    };
    const args = [
      'dev',
      `--${platform}`,
      '--eas',
      '--port',
      String(port),
      '--detach',
      '--wait-ready',
      '--json',
    ];
    const run = (argv: string[]) => executeAgentCliAsync(root, argv, { env, reject: false });
    const startedAt = Date.now();
    const parent = spawnAgentCli(root, args, { env });
    const parentResult = waitForExitAsync(parent, collectOutput(parent));
    let ownerPid: number | undefined;
    try {
      expect(await waitForAsync(() => fs.existsSync(building), 20_000)).toBe(true);
      const timeout = await parentResult;
      expect(timeout.exitCode, timeout.all).toBe(22);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(119_000);
      const { error } = JSON.parse(timeout.stdout);
      ownerPid = error.data.pid;
      expect(error.data.logFile).toEqual(expect.any(String));
      expect(process.kill(ownerPid!, 0)).toBe(true);
      expect(stubEasArgs(root).filter((argv) => argv[0] === 'build')).toHaveLength(1);

      const status = await run(['status', '--json']);
      expect(status.exitCode, status.all).toBe(0);
      const report = JSON.parse(status.stdout);
      expect.soft(report.next.recovery).toMatchObject({
        kind: 'observe',
        attempt: { pid: ownerPid, logFile: error.data.logFile },
      });
      expect.soft(report.next.command).toBe('npx @expo/agent-cli dev:logs');
      const logs = await runRecoveryCommand(root, `${error.suggestedCommand} --json`, env);
      expect(logs.exitCode, logs.all).toBe(0);
      expect(JSON.parse(logs.stdout)).toMatchObject({ logFile: error.data.logFile });
      expect(JSON.parse(logs.stdout).lines.join('\n')).toContain('Waiting for build to complete');

      const matching = await run(args);
      expect.soft(matching.exitCode, matching.all).toBe(22);
      expect.soft(JSON.parse(matching.stdout).error).toMatchObject({
        code: 'DEV_START_IN_PROGRESS',
        data: { pid: ownerPid, logFile: error.data.logFile },
      });
      const changed = await run([...args, '--no-open']);
      expect(changed.exitCode, changed.all).toBe(20);
      expect.soft(JSON.parse(changed.stdout).error.suggestedCommand).toContain('dev:stop');
      expect(stubEasArgs(root).filter((argv) => argv[0] === 'build')).toHaveLength(1);
      expect(readStubExpoInvocations(root).filter(({ args }) => args[0] === 'start')).toEqual([]);

      fs.writeFileSync(release, '');
      expect(
        await waitForAsync(() => stubEasArgs(root).some((argv) => argv[0] === 'simulator'), 20_000)
      ).toBe(true);
      const stopped = await run(['dev:stop', '--eas', '--json']);
      expect(stopped.exitCode, stopped.all).toBe(0);
      expect(await readDevLockAsync(root)).toBeNull();
      expect(stubEasArgs(root).filter((argv) => argv[0] === 'build')).toHaveLength(1);
    } finally {
      fs.writeFileSync(release, '');
      await run(['dev:stop', '--eas', '--json']);
      if (ownerPid) {
        try {
          process.kill(ownerPid, 'SIGKILL');
        } catch {}
      }
      await killAsync(parent, 'SIGKILL');
      await parentResult;
    }
  }
);
