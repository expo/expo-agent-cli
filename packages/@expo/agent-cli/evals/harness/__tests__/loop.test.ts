import { describe, expect, it, vi } from 'vitest';
import { runLoop } from '../loop';

const result = { exitCode: 0, stdout: 'linked', stderr: '', timedOut: false };
const options = () => ({
  prompt: 'Sync skills',
  help: 'skills:sync',
  signal: AbortSignal.timeout(5000),
  chat: vi.fn(),
  execute: vi.fn().mockResolvedValue(result),
  record: vi.fn(),
  maxTurns: 3,
});

describe('agent command loop', () => {
  it('executes the model-selected argv and feeds the real result back before completion', async () => {
    const o = options();
    o.chat
      .mockResolvedValueOnce('{"run":["skills:sync","--agent","codex"]}')
      .mockResolvedValueOnce('{"done":true,"summary":"synced"}');
    const outcome = await runLoop(o);
    expect(o.execute).toHaveBeenCalledWith(['skills:sync', '--agent', 'codex']);
    expect(o.chat.mock.calls[1][0].at(-1).content).toContain('linked');
    expect(outcome.commands).toHaveLength(1);
    expect(outcome.summary).toBe('synced');
  });
  it('does not score a no-op or a loop that exhausts its budget as success', async () => {
    const o = options();
    o.chat.mockResolvedValue('{"done":true}');
    await expect(runLoop(o)).rejects.toThrow('without calling');
    o.chat.mockResolvedValue('{"run":["--help"]}');
    await expect(runLoop(o)).rejects.toThrow('turn budget');
  });
  it('allows recovery after a command failure and retains both results', async () => {
    const o = options();
    o.execute.mockResolvedValueOnce({ ...result, exitCode: 1 }).mockResolvedValueOnce(result);
    o.chat
      .mockResolvedValueOnce('{"run":["typo"]}')
      .mockResolvedValueOnce('{"run":["skills:sync"]}')
      .mockResolvedValueOnce('{"done":true}');
    expect((await runLoop(o)).commands.map((c) => c.exitCode)).toEqual([1, 0]);
  });
  it('records malformed responses and never executes ambiguous or empty actions', async () => {
    const o = options();
    o.chat
      .mockResolvedValueOnce('{"run":[]}')
      .mockResolvedValueOnce('{"run":["start"],"done":true}')
      .mockResolvedValueOnce('not JSON');
    await expect(runLoop(o)).rejects.toThrow('turn budget');
    expect(o.execute).not.toHaveBeenCalled();
    expect(o.record).toHaveBeenCalled();
  });
  it('propagates inference failures and command timeouts', async () => {
    const o = options();
    o.chat.mockRejectedValueOnce(new Error('offline'));
    await expect(runLoop(o)).rejects.toThrow('offline');
    o.chat.mockResolvedValue('{"run":["start"]}');
    o.execute.mockResolvedValue({ ...result, timedOut: true });
    await expect(runLoop(o)).rejects.toThrow('timed out');
  });
});

it('asks for a corrected native tool call after malformed arguments', async () => {
  const o = options();
  o.chat
    .mockResolvedValueOnce('{"run":[]}')
    .mockResolvedValueOnce('{"run":["skills:sync"]}')
    .mockResolvedValueOnce('{"done":true}');
  await runLoop(o);
  expect(o.chat.mock.calls[1][0].at(-1).content).toContain('run_cli');
  expect(o.execute).toHaveBeenCalledTimes(1);
});

it('compacts structured output without dropping fields and records the original result', async () => {
  const o = options();
  const report = { project: { sdk: '57', compatible: true }, reasons: [] };
  const stdout = JSON.stringify(report, null, 2);
  o.execute.mockResolvedValue({ ...result, stdout });
  o.chat
    .mockResolvedValueOnce('{"run":["status","--json"]}')
    .mockResolvedValueOnce('{"done":true}');
  await runLoop(o);
  const feedback = JSON.parse(o.chat.mock.calls[1][0].at(-1).content);
  expect(feedback.stdout).toBe(JSON.stringify(report));
  expect(o.record).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'tool_result',
      content: expect.objectContaining({ stdout }),
    })
  );
});
