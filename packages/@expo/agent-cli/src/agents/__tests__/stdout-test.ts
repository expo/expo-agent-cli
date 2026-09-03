import { withStdoutRedirectedAsync } from '../stdout';
import type { MockInstance } from 'vitest';

describe(withStdoutRedirectedAsync, () => {
  let stderrSpy: MockInstance;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should send the text output of the work to stderr', async () => {
    const original = console.log;

    await expect(
      withStdoutRedirectedAsync(async () => {
        console.log('one', 'two');
        return 'result';
      })
    ).resolves.toBe('result');

    expect(stderrSpy).toHaveBeenCalledWith('one two\n');
    expect(console.log).toBe(original);
  });

  it('should restore console.log when the work throws', async () => {
    const original = console.log;

    await expect(
      withStdoutRedirectedAsync(async () => {
        throw new Error('nope');
      })
    ).rejects.toThrow('nope');

    expect(console.log).toBe(original);
  });
});
