import { describe, expect, it } from 'vitest';

import { runProcess } from '../process';

describe(runProcess, () => {
  it('should collect stdout, stderr, and a nonzero exit independently', async () => {
    const r = await runProcess(
      process.execPath,
      ['-e', 'console.log("out"); console.error("err"); process.exit(7)'],
      { cwd: process.cwd() }
    );
    expect(r).toMatchObject({
      exitCode: 7,
      stdout: 'out\n',
      stderr: 'err\n',
      timedOut: false,
    });
  });

  it('should preserve UTF-8 characters split between subprocess chunks', async () => {
    const r = await runProcess(
      process.execPath,
      [
        '-e',
        'process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9])), 20)',
      ],
      { cwd: process.cwd() }
    );
    expect(r.stdout).toBe('é');
  });

  it('should terminate an unresponsive child on deadline', async () => {
    const r = await runProcess(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
      cwd: process.cwd(),
      signal: AbortSignal.timeout(100),
    });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
  });

  it('should reject a missing executable rather than treating it as a task outcome', async () => {
    await expect(
      runProcess('/no-such-eval-executable', [], { cwd: process.cwd() })
    ).rejects.toThrow();
  });
});
