import fs from 'node:fs';
import path from 'node:path';

import { detachedBarrierFixture } from '../detachedBarrierFixture';
import {
  collectOutput,
  executeAgentCliAsync,
  killAsync,
  readStubExpoInvocations,
  spawnAgentCli,
  waitForAsync,
  waitForExitAsync,
} from '../utils';

it.each(['ios', 'android'] as const)(
  'concurrent %s parents preserve the elected startup result and its log',
  async (platform) => {
    const f = await detachedBarrierFixture(platform);
    const packageFile = path.join(f.root, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    pkg.expo = {
      ...pkg.expo,
      'agent-cli': { buildBackend: 'eas', deviceBackend: 'eas', target: 'dev-build' },
    };
    fs.writeFileSync(packageFile, JSON.stringify(pkg));
    const config = path.join(f.root, 'preflight.json');
    fs.writeFileSync(config, JSON.stringify({ name: 'test', slug: 'test' }));
    const env = { ...f.env, STUB_EXPO_CONFIG_JSON: config, DETACH_TEST_CONFIG_FILE: config };
    const args = ['dev', `--${platform}`, '--port', String(f.port), '--detach', '--json'];
    const logsDirectory = path.join(f.root, '.expo', 'dev', 'logs');
    const logs = () => fs.readdirSync(logsDirectory).filter((name) => name.endsWith('.log'));
    const parents: ReturnType<typeof spawnAgentCli>[] = [];
    const start = (extraArgs: string[], extraEnv: Record<string, string> = {}) => {
      const child = spawnAgentCli(f.root, [...args, ...extraArgs], {
        env: { ...env, ...extraEnv },
      });
      parents.push(child);
      return waitForExitAsync(child, collectOutput(child));
    };
    f.release();
    try {
      const delayed = start(['--clear', '--max-workers', '2'], {
        DETACH_TEST_BOOT_BARRIER: '1',
      });
      expect(await waitForAsync(() => f.marks('child').length === 1, 15_000)).toBe(true);
      // Both parents pass admission before publication. Only the first child waits at bootstrap.
      const owner = start(['-c', '--max-workers=02', '--wait-ready']);
      expect(await waitForAsync(() => f.marks('config').length === 1, 15_000)).toBe(true);
      expect(f.marks('child')).toHaveLength(2);
      expect(logs()).toHaveLength(2);
      const directory = path.join(f.root, '.expo', 'dev', 'detached-run');
      const marker = fs.readdirSync(directory).find((name) => name.startsWith('owner-'))!;
      const attempt = JSON.parse(fs.readFileSync(path.join(directory, marker), 'utf8'));
      fs.writeFileSync(path.join(f.barrier, 'release-boot'), '');

      const refused = await delayed;
      expect(refused.exitCode, refused.all).toBe(22);
      expect(JSON.parse(refused.stdout).error).toMatchObject({
        code: 'DEV_START_IN_PROGRESS',
        suggestedCommand: 'npx @expo/agent-cli dev:logs',
        data: {
          pid: attempt.pid,
          logFile: attempt.logFile,
          attemptId: attempt.id,
          recovery: { kind: 'observe', attempt: { id: attempt.id } },
        },
      });
      expect(logs()).toEqual([path.basename(attempt.logFile)]);

      const matching = await start(['--reset-cache', '--max-workers=2', '--no-followups']);
      expect(matching.exitCode, matching.all).toBe(22);
      expect(JSON.parse(matching.stdout).error.data).toMatchObject({
        pid: attempt.pid,
        logFile: attempt.logFile,
        recovery: { kind: 'observe' },
      });
      const changed = await start(['--clear', '--max-workers=2', '--no-open']);
      expect(changed.exitCode, changed.all).toBe(20);
      expect(JSON.parse(changed.stdout).error).toMatchObject({
        code: 'DEV_START_BUSY',
        data: { pid: attempt.pid, logFile: attempt.logFile },
      });
      expect(JSON.parse(changed.stdout).error.suggestedCommand).toContain('dev:stop');
      // A configured target participates in the parent request even without a target flag.
      pkg.expo['agent-cli'].target = 'expo-go';
      fs.writeFileSync(packageFile, JSON.stringify(pkg));
      const configuredChange = await start(['--clear', '--max-workers=2']);
      expect(configuredChange.exitCode, configuredChange.all).toBe(20);
      expect(JSON.parse(configuredChange.stdout).error.code).toBe('DEV_START_BUSY');
      expect(f.marks('child')).toHaveLength(2);
      expect(f.marks('config')).toHaveLength(1);
      expect(logs()).toEqual([path.basename(attempt.logFile)]);

      fs.writeFileSync(path.join(f.barrier, 'release-config'), '');
      const failed = await owner;
      expect(failed.exitCode, failed.all).toBe(7);
      expect(JSON.parse(failed.stdout).error.code).toBe('EAS_PROJECT_NOT_LINKED');
      expect(fs.readFileSync(attempt.logFile, 'utf8')).toContain('EAS_PROJECT_NOT_LINKED');
      const selected = await executeAgentCliAsync(f.root, ['dev:logs', '--json']);
      expect(JSON.parse(selected.stdout).logFile).toBe(attempt.logFile);
      expect(readStubExpoInvocations(f.root).filter(({ args }) => args[0] === 'start')).toEqual([]);
    } finally {
      fs.writeFileSync(path.join(f.barrier, 'release-boot'), '');
      fs.writeFileSync(path.join(f.barrier, 'release-config'), '');
      await Promise.all(parents.map((child) => killAsync(child, 'SIGKILL')));
      await f.cleanup();
    }
  }
);

it.each(['ios', 'android'] as const)(
  'an inconclusive %s candidate exit retains its private log',
  async (platform) => {
    const f = await detachedBarrierFixture(platform);
    try {
      const parent = f.start({ DETACH_TEST_BOOT_BARRIER: '1' });
      expect(await waitForAsync(() => f.marks('child').length === 1, 15_000)).toBe(true);
      const childPid = Number(f.marks('child')[0]!.slice('child-'.length));
      const directory = path.join(f.root, '.expo', 'dev', 'logs');
      const files = fs.readdirSync(directory).filter((file) => file.endsWith('.log'));
      expect(files).toHaveLength(1);
      process.kill(childPid, 'SIGKILL');
      const result = await parent.result;
      expect(result.exitCode, result.all).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe('DEV_DETACH_FAILED');
      expect(fs.existsSync(path.join(directory, files[0]!))).toBe(true);
      expect(readStubExpoInvocations(f.root)).toEqual([]);
    } finally {
      fs.writeFileSync(path.join(f.barrier, 'release-boot'), '');
      await f.cleanup();
    }
  }
);
