// @ref llp/0022-live-tier.plan.md §live-cloud

type CommandResult = { exitCode: number; stdout: string; stderr: string };

function sessionIdFromOutput(stdout: string, stderr: string): string | null {
  try {
    const id = JSON.parse(stdout)?.id;
    if (typeof id === 'string' && id) {
      return id;
    }
  } catch {}
  return `${stdout}\n${stderr}`.match(/id: ([0-9a-f-]{36})/i)?.[1] ?? null;
}

/** Retry one failed boot only after its billed session has been stopped. */
export async function startCloudSessionAsync({
  start,
  stop,
  onSession,
}: {
  start: (attempt: number) => Promise<CommandResult>;
  stop: (id: string) => Promise<CommandResult>;
  onSession: (id: string | null) => void;
}): Promise<CommandResult> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let result: CommandResult;
    try {
      result = await start(attempt);
    } catch (error: any) {
      const id = sessionIdFromOutput(String(error?.stdout ?? ''), String(error?.stderr ?? ''));
      onSession(id);
      // execFile rejects on its deadline instead of returning a nonzero exit code. Other
      // exceptions (spawn failures, output overflow, etc.) are not simulator readiness misses.
      if (
        attempt === 2 ||
        !id ||
        !error?.killed ||
        error?.signal !== 'SIGTERM' ||
        error?.code != null
      ) {
        throw error;
      }
      await stopBeforeRetry(id);
      continue;
    }
    const id = sessionIdFromOutput(result.stdout, result.stderr);
    onSession(id);
    if (result.exitCode === 0) {
      return result;
    }
    if (attempt === 2 || !id) {
      throw new Error(
        `eas simulator failed (exit ${result.exitCode}): ${result.stderr.slice(-2000)}`
      );
    }
    await stopBeforeRetry(id);
  }
  throw new Error('eas simulator never produced a start result');

  async function stopBeforeRetry(id: string): Promise<void> {
    const stopped = await stop(id);
    if (stopped.exitCode !== 0) {
      throw new Error(`Could not stop simulator session ${id} before retry: ${stopped.stderr}`);
    }
    onSession(null);
  }
}
