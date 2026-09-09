// @ref llp/0002-testing-and-evals.plan.md
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

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
  if (process.platform === 'win32')
    throw new Error('Agent eval subprocesses require POSIX process groups (Linux or macOS)');
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
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const exceedsLimit = (bytes: number) => {
      if (bytes <= 4 * 1024 * 1024) return false;
      overflow = true;
      kill();
      return true;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (!exceedsLimit(stdoutBytes)) stdout += stdoutDecoder.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (!exceedsLimit(stderrBytes)) stderr += stderrDecoder.write(chunk);
    });
    child.stdout.on('end', () => {
      stdout += stdoutDecoder.end();
    });
    child.stderr.on('end', () => {
      stderr += stderrDecoder.end();
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
