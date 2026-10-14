import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSubprocessAsync } from '../../src/utils/subprocess';
import { runInheritedAsync } from '../../src/utils/inheritedRun';
import { getTemporaryPath } from '../utils';
const require = createRequire(import.meta.url);
const logger = require.resolve('2g');
const producer = path.resolve(__dirname, '../stubs/event-producer.js');

it.each(['capture', 'tee', 'inherit'] as const)(
  'observes real 2g events live with %s streams and an explicit event log',
  async (output) => {
    const root = getTemporaryPath();
    fs.mkdirSync(root, { recursive: true });
    const gate = path.join(root, 'exit');
    const log = path.join(root, 'events.jsonl');
    const seen: Record<string, unknown>[] = [];
    const result = await spawnSubprocessAsync(process.execPath, [producer, logger, gate], {
      output,
      env: { LOG_EVENTS: log },
      timeoutMs: 10000,
      onEvent(event) {
        seen.push(event);
        fs.writeFileSync(gate, '');
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).not.toBe(true);
    expect(seen.some((e) => e._e === 'run:install')).toBe(true);
    expect(fs.readFileSync(log, 'utf8')).toContain('run:install');
    if (output !== 'inherit') {
      expect(result.stdout).toContain('stdout preserved');
      expect(result.stderr).toContain('stderr preserved');
    }
  }
);

it('preserves inherited stdin and tolerates observer rejection', async () => {
  const root = getTemporaryPath();
  fs.mkdirSync(root, { recursive: true });
  const gate = path.join(root, 'exit');
  const code = await runInheritedAsync(process.execPath, [producer, logger, gate], {
    cwd: root,
    onEvent() {
      fs.writeFileSync(gate, '');
      throw new Error('observer failed');
    },
  });
  expect(code).toBe(0);
});

it('cleans up after a spawn failure', async () => {
  const before = process.listenerCount('SIGTERM');
  const result = await spawnSubprocessAsync('/no-such-event-producer', [], {
    onEvent() {
      throw new Error('unexpected event');
    },
  });
  expect(result.spawnError).toBeDefined();
  expect(process.listenerCount('SIGTERM')).toBe(before);
});

it('observes an instrumented child and forwards to the parent-owned log after LOG_EVENTS is consumed', async () => {
  const { installEventLogger, flushEventLogger } = await import('2g');
  const root = getTemporaryPath();
  fs.mkdirSync(root, { recursive: true });
  const gate = path.join(root, 'exit');
  const log = path.join(root, 'parent.jsonl');
  installEventLogger(log);
  const seen: Record<string, unknown>[] = [];
  const result = await spawnSubprocessAsync(process.execPath, [producer, logger, gate], {
    timeoutMs: 10000,
    onEvent(event) {
      seen.push(event);
      fs.writeFileSync(gate, '');
    },
  });
  await flushEventLogger();
  expect(result.exitCode).toBe(0);
  expect(seen.find((e) => e._e === 'run:install')?._w).toBeUndefined();
  expect(fs.readFileSync(log, 'utf8')).toContain('run:install');
});
