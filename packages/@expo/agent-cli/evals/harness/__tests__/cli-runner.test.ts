import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Cleanup } from '@expo/agent-eval-vitest';
import { cliRunner, setupProject } from '../cli';
import { chat } from '../ollama';

vi.mock('../ollama', () => ({
  identifyModel: async () => ({
    model: 'test-model',
    digest: 'test-digest',
    ollamaVersion: 'test',
  }),
  chat: vi.fn(),
}));

it('retains real command evidence when the agent exhausts its budget', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-runner-test-'));
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-runner-evidence-'));
  const cleanups: Cleanup[] = [];
  const signal = AbortSignal.timeout(15_000);
  try {
    const fixture = await setupProject({ fixture: 'e2e/fixtures/go-app' }).prepareAsync({
      root,
      artifactsDir,
      signal,
      condition: 'without-skill',
      onCleanup: (cleanup) => {
        cleanups.push(cleanup);
      },
      runAsync: async () => {
        throw new Error('Unexpected setup subprocess');
      },
    });
    vi.mocked(chat).mockImplementation(async (_messages, _signal, record) => {
      record({}, { prompt_eval_count: 10, eval_count: 2 });
      return {
        content: '{"run":["--help"]}',
        request: {} as never,
        response: {},
        usage: { inputTokens: 10, outputTokens: 2 },
      };
    });
    const execution = await cliRunner({ root, artifactsDir, signal, prompt: 'Inspect the app' });
    expect(execution.endReason).toBe('budget-exhausted');
    expect(execution.toolCalls).toHaveLength(6);
    expect(execution.toolCalls![0]).toMatchObject({
      input: { argv: ['--help'] },
      result: { exitCode: 0 },
    });
    expect(fixture.output().commands).toHaveLength(6);
    expect(execution.metadata).toMatchObject({ inputTokens: 60, outputTokens: 12 });
    for (const artifact of execution.artifacts)
      expect(fs.existsSync(path.join(artifactsDir, artifact))).toBe(true);

    vi.mocked(chat).mockRejectedValueOnce(new Error('transport unavailable'));
    await expect(
      cliRunner({ root, artifactsDir, signal, prompt: 'Inspect the app' })
    ).rejects.toThrow('transport unavailable');
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  }
}, 20_000);
