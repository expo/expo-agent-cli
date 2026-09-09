// @ref llp/0002-testing-and-evals.plan.md
import { spawn } from 'node:child_process';

export type ProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

/** No shell interpretation. On cancellation, kill the process group, including CLI children. */
export function runProcess(
  bin: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }
): Promise<ProcessResult> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let overflow = false;
    const kill = () => {
      if (!child.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    };
    const abort = () => {
      timedOut = true;
      kill();
    };
    const collect = (text: string, chunk: Buffer) => {
      if (text.length + chunk.length > 4 * 1024 * 1024) {
        overflow = true;
        kill();
      }
      return (text + chunk.toString()).slice(0, 4 * 1024 * 1024);
    };
    child.stdout.on('data', (chunk) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = collect(stderr, chunk);
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.once('error', (error) => {
      options.signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('close', (code) => {
      options.signal?.removeEventListener('abort', abort);
      if (overflow) reject(new Error('Subprocess output exceeded 4 MiB'));
      else resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
    });
  });
}
