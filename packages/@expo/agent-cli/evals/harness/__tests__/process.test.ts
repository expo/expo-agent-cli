import { expect, it } from 'vitest';
import { runProcess } from '../process';

it('collects stdout, stderr, and a nonzero exit independently', async () => {
  const r = await runProcess(
    process.execPath,
    ['-e', 'console.log("out"); console.error("err"); process.exit(7)'],
    { cwd: process.cwd() }
  );
  expect(r).toMatchObject({ exitCode: 7, stdout: 'out\n', stderr: 'err\n', timedOut: false });
});
it('terminates an unresponsive child on deadline', async () => {
  const r = await runProcess(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
    cwd: process.cwd(),
    signal: AbortSignal.timeout(100),
  });
  expect(r.timedOut).toBe(true);
  expect(r.exitCode).not.toBe(0);
});
it('rejects a missing executable rather than treating it as a task outcome', async () => {
  await expect(
    runProcess('/no-such-eval-executable', [], { cwd: process.cwd() })
  ).rejects.toThrow();
});
