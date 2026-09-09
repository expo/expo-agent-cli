import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';

export function killGroup(pid, signal = 'SIGTERM') {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

/**
 * @typedef {{exitCode: number | null, signal: string | null, timedOut: boolean,
 * spawnError: string | null, pid: number | null}} ProcessResult
 */
/** POSIX-only, file-backed capture preserves partial output without an unbounded pipe buffer.
 * @param {string} bin
 * @param {string[]} args
 * @param {{cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, stdoutPath: string, stderrPath: string}} options
 * @returns {Promise<ProcessResult>}
 */
export async function captureProcess(bin, args, { cwd, env, signal, stdoutPath, stderrPath }) {
  if (signal?.aborted)
    return {
      exitCode: null,
      signal: null,
      timedOut: true,
      spawnError: 'Aborted before spawn',
      pid: null,
    };
  const out = openSync(stdoutPath, 'w');
  let err;
  try {
    err = openSync(stderrPath, 'w');
  } catch (error) {
    closeSync(out);
    throw error;
  }
  let child;
  try {
    child = spawn(bin, args, { cwd, env, detached: true, stdio: ['ignore', out, err] });
  } finally {
    closeSync(out);
    closeSync(err);
  }
  return new Promise((resolve) => {
    let timedOut = false;
    let spawnError = null;
    let escalation;
    const abort = () => {
      timedOut = true;
      killGroup(child.pid);
      escalation = setTimeout(() => killGroup(child.pid, 'SIGKILL'), 1000);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', (error) => {
      spawnError = error.message;
    });
    child.once('close', (exitCode, exitSignal) => {
      signal?.removeEventListener('abort', abort);
      clearTimeout(escalation);
      // TERM may have killed only the parent; descendants must not survive an abort.
      if (timedOut) killGroup(child.pid, 'SIGKILL');
      resolve({ exitCode, signal: exitSignal, timedOut, spawnError, pid: child.pid ?? null });
    });
  });
}
