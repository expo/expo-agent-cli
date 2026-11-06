import { deviceIdOf, deviceNameOf, type Binding } from '../../deviceBinding';
import type { SmokeStartResult } from '../contract';

/**
 * The command line `--start` runs `@expo/agent-cli dev` with, before the platform flag is added.
 *
 * **`--no-open` is load-bearing.** `dev` opens the app itself once its dev server is up
 * (llp/0026) — and this command must be the one that opens, because its phases carry the budgets
 * and the verdicts a gate reports on. Two opens racing each other would also be two apps' worth of
 * device state for one report.
 *
 * Exported for the test table, because the flag's absence is invisible in a diff and expensive live.
 *
 * @ref llp/0026-dev-owns-the-open.rfc.md
 */
export const START_DEV_SERVER_ARGV: readonly string[] = ['--detach', '--wait-ready', '--no-open'];

/**
 * The device the detached `dev` of the start phase bound, from the worktree's binding file before
 * and after the start. The child acquires and the parent only reads its result. A device whose
 * binding was live and up, or whose check did not answer, before the start is `existing`: the run
 * keeps it.
 *
 * @ref llp/0035-one-device-per-worktree.rfc.md §Lifecycle smoke
 */
export function deviceBoundByStart(
  before: Binding | null,
  after: Binding | null,
  beforeUp: boolean
): SmokeStartResult['bound'] {
  if (after == null) {
    return undefined;
  }
  const id = deviceIdOf(after.device);
  const reused = before != null && deviceIdOf(before.device) === id;
  const fresh = after.device.backend === 'local-android' ? 'spawned' : 'created';
  return {
    id,
    name: deviceNameOf(after.device),
    action: !reused ? fresh : beforeUp ? 'existing' : 'reused',
  };
}

/**
 * The port `--start` asks the dev server for, out of the dev server this run was pointed at.
 *
 * A caller that passed `--port 8210` named the dev server it means, and `--start` has to start it
 * *there* — a dev server on 8081 would be a run that answered a question about a different port
 * than the one it was asked about. Only for a loopback URL: `--port` says where a dev server on
 * **this** machine listens, and there is nothing this command can start on another host.
 *
 * @param devServerUrl the `--dev-server-url`/`--port` value, or null when the caller named none.
 */
export function startPortArgs(devServerUrl: string | null): string[] {
  if (devServerUrl == null) {
    return [];
  }
  let parsed: URL;
  try {
    parsed = new URL(devServerUrl);
  } catch {
    return [];
  }
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname);
  return loopback && parsed.port ? ['--port', parsed.port] : [];
}
