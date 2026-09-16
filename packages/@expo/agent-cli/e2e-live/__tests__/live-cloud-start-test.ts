import { startCloudSessionAsync } from '../cloudSession';

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const success = (id: string) => ({ exitCode: 0, stdout: JSON.stringify({ id }), stderr: '' });
const failure = { exitCode: 1, stdout: '', stderr: `Session created (id: ${firstId})` };
const timeout = (id = firstId) =>
  Object.assign(new Error('simulator startup timed out'), {
    killed: true,
    signal: 'SIGTERM',
    code: null,
    stdout: '',
    stderr: `Session created (id: ${id})`,
  });

describe('Starting a cloud session', () => {
  const start = vi.fn();
  const stop = vi.fn();
  const onSession = vi.fn();
  const run = () => startCloudSessionAsync({ start, stop, onSession });

  beforeEach(() => {
    vi.resetAllMocks();
    stop.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('should retain a successful session for final cleanup without retrying', async () => {
    start.mockResolvedValue(success(firstId));
    await expect(run()).resolves.toEqual(success(firstId));
    expect(onSession.mock.calls).toEqual([[firstId]]);
    expect(stop).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it.each(['timeout', 'nonzero exit'])(
    'should stop a %s session before starting its replacement',
    async (kind) => {
      if (kind === 'timeout') start.mockRejectedValueOnce(timeout());
      else start.mockResolvedValueOnce(failure);
      let releaseStop!: () => void;
      stop.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseStop = () => resolve({ exitCode: 0, stdout: '', stderr: '' });
          })
      );
      start.mockResolvedValueOnce(success(secondId));
      const pending = run();
      await vi.waitFor(() => expect(stop).toHaveBeenCalledWith(firstId));
      expect(start).toHaveBeenCalledTimes(1);
      releaseStop();
      await expect(pending).resolves.toEqual(success(secondId));
      expect(start.mock.calls).toEqual([[1], [2]]);
      expect(onSession.mock.calls).toEqual([[firstId], [null], [secondId]]);
    }
  );

  it('should preserve the second timed-out session for cleanup and stop retrying', async () => {
    const lastError = timeout(secondId);
    start.mockRejectedValueOnce(timeout()).mockRejectedValueOnce(lastError);
    await expect(run()).rejects.toBe(lastError);
    expect(start).toHaveBeenCalledTimes(2);
    expect(stop.mock.calls).toEqual([[firstId]]);
    expect(onSession).toHaveBeenLastCalledWith(secondId);
  });

  it('should preserve the session and refuse another start when cleanup fails', async () => {
    start.mockRejectedValueOnce(timeout());
    stop.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'stop failed' });
    await expect(run()).rejects.toThrow('Could not stop simulator session');
    expect(start).toHaveBeenCalledTimes(1);
    expect(onSession.mock.calls).toEqual([[firstId]]);
  });

  it('should propagate cleanup exceptions without starting another session', async () => {
    start.mockResolvedValueOnce(failure);
    stop.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(run()).rejects.toThrow('network unavailable');
    expect(start).toHaveBeenCalledTimes(1);
    expect(onSession.mock.calls).toEqual([[firstId]]);
  });

  it.each(['timeout', 'nonzero exit'])(
    'should not retry a %s without an identifiable session',
    async (kind) => {
      if (kind === 'timeout') start.mockRejectedValueOnce(timeout(''));
      else start.mockResolvedValueOnce({ ...failure, stderr: 'authentication failed' });
      await expect(run()).rejects.toThrow();
      expect(start).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
    }
  );

  it('should not classify an output-buffer failure as a startup timeout', async () => {
    const error = Object.assign(timeout(), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
    start.mockRejectedValueOnce(error);
    await expect(run()).rejects.toBe(error);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(onSession).toHaveBeenLastCalledWith(firstId);
  });

  it('should propagate a spawn failure without retrying', async () => {
    const error = Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
    start.mockRejectedValueOnce(error);
    await expect(run()).rejects.toBe(error);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });
});
