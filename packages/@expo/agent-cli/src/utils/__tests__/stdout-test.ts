import { Console } from 'node:console';

import { withStdoutRedirectedAsync } from '../stdout';
import type { MockInstance } from 'vitest';

describe(withStdoutRedirectedAsync, () => {
  let stderrSpy: MockInstance;
  let stdoutSpy: MockInstance;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should redirect console and direct writes while preserving the result', async () => {
    const originalWrite = process.stdout.write;
    // Vitest captures the global console. Bind a real Node console to the process streams.
    const console = new Console(process.stdout, process.stderr);

    await expect(
      withStdoutRedirectedAsync(async () => {
        console.log('one', 'two');
        process.stdout.write('three\n');
        return 'result';
      })
    ).resolves.toBe('result');

    expect(stderrSpy.mock.calls.map(([chunk]) => chunk)).toEqual(['one two\n', 'three\n']);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(process.stdout.write).toBe(originalWrite);
  });

  it('should restore stdout when the work throws', async () => {
    const originalWrite = process.stdout.write;

    await expect(
      withStdoutRedirectedAsync(async () => {
        throw new Error('nope');
      })
    ).rejects.toThrow('nope');

    expect(process.stdout.write).toBe(originalWrite);
    process.stdout.write('after failure\n');
    expect(stdoutSpy).toHaveBeenCalledWith('after failure\n');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('should keep an outer redirect active after nested work finishes', async () => {
    const originalWrite = process.stdout.write;

    await withStdoutRedirectedAsync(async () => {
      process.stdout.write('before\n');
      await withStdoutRedirectedAsync(async () => {
        process.stdout.write('inside\n');
      });
      process.stdout.write('after\n');
    });

    expect(stderrSpy.mock.calls.map(([chunk]) => chunk)).toEqual([
      'before\n',
      'inside\n',
      'after\n',
    ]);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(process.stdout.write).toBe(originalWrite);
  });
});
