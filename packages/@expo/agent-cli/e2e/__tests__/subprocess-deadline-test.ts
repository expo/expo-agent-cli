import { spawnCaptureBufferAsync } from '../../src/utils/spawnCapture';
import { withSubprocessDeadlineAsync } from '../../src/utils/subprocessDeadline';

it('stops a hanging process and refuses a fallback after the read deadline', async () => {
  let first: ReturnType<typeof spawnCaptureBufferAsync> | undefined;
  let fallback: Promise<unknown> | undefined;
  await expect(
    withSubprocessDeadlineAsync(300, 'read expired', async () => {
      first = spawnCaptureBufferAsync(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
      await first;
      fallback = spawnCaptureBufferAsync(process.execPath, [
        '-e',
        'process.stdout.write("fallback")',
      ]);
      await fallback;
    })
  ).rejects.toThrow('read expired');
  expect((await first!).exitCode).not.toBe(0);
  // The first child's close handler resumes the continuation before this assertion.
  await expect(fallback!).rejects.toThrow('read expired');
});
