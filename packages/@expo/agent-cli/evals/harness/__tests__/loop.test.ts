import { describe, expect, it, vi } from 'vitest';

import { runLoop, type Message } from '../loop';

const commandResult = { exitCode: 0, stdout: 'linked', stderr: '', timedOut: false };

/** A loop with a scripted model and a CLI that always succeeds unless a test says otherwise. */
const loopOptions = () => ({
  prompt: 'Sync skills',
  help: 'skills:sync',
  signal: AbortSignal.timeout(5000),
  chat: vi.fn<(messages: Message[]) => Promise<string>>(),
  execute: vi.fn().mockResolvedValue(commandResult),
  record: vi.fn(),
  maxTurns: 3,
});

/** The messages the model saw on its second turn. */
const secondTurnMessages = (options: ReturnType<typeof loopOptions>) =>
  options.chat.mock.calls[1][0];

describe(runLoop, () => {
  it('should execute the model-selected argv and feed the real result back before completion', async () => {
    const options = loopOptions();
    options.chat
      .mockResolvedValueOnce('{"run":["skills:sync","--agent","codex"]}')
      .mockResolvedValueOnce('{"done":true,"summary":"synced"}');
    const outcome = await runLoop(options);
    expect(options.execute).toHaveBeenCalledWith(['skills:sync', '--agent', 'codex']);
    expect(secondTurnMessages(options).at(-1)!.content).toContain('linked');
    expect(outcome.commands).toHaveLength(1);
    expect(outcome.summary).toBe('synced');
  });

  it('should compact structured output without dropping fields and record the original result', async () => {
    const options = loopOptions();
    const report = { project: { sdk: '57', compatible: true }, reasons: [] };
    const stdout = JSON.stringify(report, null, 2);
    options.execute.mockResolvedValue({ ...commandResult, stdout });
    options.chat
      .mockResolvedValueOnce('{"run":["status","--json"]}')
      .mockResolvedValueOnce('{"done":true}');
    await runLoop(options);
    const feedback = JSON.parse(secondTurnMessages(options).at(-1)!.content);
    expect(feedback.stdout).toBe(JSON.stringify(report));
    expect(options.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool_result',
        content: expect.objectContaining({ stdout }),
      })
    );
  });

  it('should execute a native batch in order and return every result before the next model turn', async () => {
    const options = loopOptions();
    options.chat
      .mockResolvedValueOnce('{"runs":[["agents:setup","--help"],["skills:list","--json"]]}')
      .mockResolvedValueOnce('{"done":true}');
    const outcome = await runLoop(options);
    expect(outcome.commands.map((command) => command.argv)).toEqual([
      ['agents:setup', '--help'],
      ['skills:list', '--json'],
    ]);
    expect(options.execute).toHaveBeenNthCalledWith(1, ['agents:setup', '--help']);
    expect(options.execute).toHaveBeenNthCalledWith(2, ['skills:list', '--json']);
    const lastTwoResults = secondTurnMessages(options).slice(-2);
    expect(lastTwoResults.map((message) => JSON.parse(message.content).exitCode)).toEqual([0, 0]);
  });

  it('should allow recovery after a command failure and retain both results', async () => {
    const options = loopOptions();
    options.execute
      .mockResolvedValueOnce({ ...commandResult, exitCode: 1 })
      .mockResolvedValueOnce(commandResult);
    options.chat
      .mockResolvedValueOnce('{"run":["typo"]}')
      .mockResolvedValueOnce('{"run":["skills:sync"]}')
      .mockResolvedValueOnce('{"done":true}');
    const outcome = await runLoop(options);
    expect(outcome.commands.map((command) => command.exitCode)).toEqual([1, 0]);
  });

  it('should ask for a corrected native tool call after malformed arguments', async () => {
    const options = loopOptions();
    options.chat
      .mockResolvedValueOnce('{"run":[]}')
      .mockResolvedValueOnce('{"run":["skills:sync"]}')
      .mockResolvedValueOnce('{"done":true}');
    await runLoop(options);
    expect(secondTurnMessages(options).at(-1)!.content).toContain('run_cli');
    expect(options.execute).toHaveBeenCalledTimes(1);
  });

  it('should reject an invalid batch without partially executing it', async () => {
    const options = loopOptions();
    options.chat
      .mockResolvedValueOnce('{"runs":[["skills:sync"],[]]}')
      .mockResolvedValueOnce('{"run":["skills:list"]}')
      .mockResolvedValueOnce('{"done":true}');
    await runLoop(options);
    expect(options.execute).toHaveBeenCalledExactlyOnceWith(['skills:list']);
    const lastTwoReplies = secondTurnMessages(options).slice(-2);
    expect(lastTwoReplies.every((message) => message.content.includes('No commands ran'))).toBe(
      true
    );
  });

  it('should record malformed responses and never execute ambiguous or empty actions', async () => {
    const options = loopOptions();
    options.chat
      .mockResolvedValueOnce('{"run":[]}')
      .mockResolvedValueOnce('{"run":["start"],"done":true}')
      .mockResolvedValueOnce('not JSON');
    await expect(runLoop(options)).rejects.toThrow('turn budget');
    expect(options.execute).not.toHaveBeenCalled();
    expect(options.record).toHaveBeenCalled();
  });

  it('should not score a no-op or a loop that exhausts its budget as success', async () => {
    const options = loopOptions();
    options.chat.mockResolvedValue('{"done":true}');
    await expect(runLoop(options)).rejects.toThrow('without calling');
    options.chat.mockResolvedValue('{"run":["--help"]}');
    await expect(runLoop(options)).rejects.toThrow('turn budget');
  });

  it('should bound total CLI calls even when the model batches them', async () => {
    const options = loopOptions();
    const sevenHelpCalls = Array.from({ length: 7 }, () => ['--help']);
    options.chat.mockResolvedValue(JSON.stringify({ runs: sevenHelpCalls }));
    await expect(runLoop(options)).rejects.toThrow('CLI call budget');
    expect(options.execute).toHaveBeenCalledTimes(7);
  });

  it('should propagate inference failures and command timeouts', async () => {
    const options = loopOptions();
    options.chat.mockRejectedValueOnce(new Error('offline'));
    await expect(runLoop(options)).rejects.toThrow('offline');
    options.chat.mockResolvedValue('{"run":["start"]}');
    options.execute.mockResolvedValue({ ...commandResult, timedOut: true });
    await expect(runLoop(options)).rejects.toThrow('timed out');
  });
});
