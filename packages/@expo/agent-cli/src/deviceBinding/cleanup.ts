// @ref llp/0035-one-device-per-worktree.rfc.md §Records
import { firstLine } from '../utils/text';
import { killEmulatorIfOurs } from './android';
import { event } from './events';
import { shutdownSimulatorAsync } from './ios';
import { deviceReport } from './records';
import { restoreBindingIfGoneAsync } from './release';
import type { Binding, DeviceTools, ReleasedDevice } from './types';

export type Cleanup = {
  binding: Binding;
  action: 'forget' | 'shutdown' | 'delete' | 'kill' | 'stop-cloud';
  reason: string;
  reaped?: boolean;
  stopRoot?: string;
  /** The binding file the section removed; a failed device action writes the binding back to it. */
  removedFile?: string;
};
export type CleanupReport = ReleasedDevice & {
  error?: string;
  /** Present for cross-worktree reaping; device cleanup does not inspect or stop Metro. */
  projectRoot?: string;
  devServerCleanup?: 'not-checked';
};

export async function deleteSimulatorAsync(tools: DeviceTools, udid: string) {
  const result = await tools.simctl(['delete', udid], { timeoutMs: 60_000 });
  const ok =
    !result.spawnError &&
    (result.exitCode === 0 || /Invalid device|not found/i.test(result.stderr));
  return {
    ok,
    reason: ok
      ? null
      : (result.spawnError?.message ??
        `simctl delete ${udid} exited ${result.exitCode}: ${firstLine(result.stderr)}`),
  };
}

/** All actions run, even when one fails or acquisition refused after queuing them. */
export async function runCleanupAsync(
  actions: Cleanup[],
  tools: DeviceTools
): Promise<CleanupReport[]> {
  const reports: CleanupReport[] = [];
  for (const item of actions) {
    const report: CleanupReport = {
      ...deviceReport(item.binding),
      reason: item.reason,
      ...(item.reaped
        ? { projectRoot: item.binding.projectRoot, devServerCleanup: 'not-checked' as const }
        : {}),
    };
    let gone: string | null = null;
    try {
      const result = await actAsync(item, tools);
      report.released = result.ok;
      report.shutDown = result.shutDown ?? (result.ok && item.action !== 'forget');
      if (!result.ok) report.error = result.reason ?? 'device cleanup failed';
      gone = result.gone ?? null;
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
    }
    if (report.error && item.removedFile) {
      try {
        await restoreBindingIfGoneAsync(item.removedFile, item.binding, tools);
      } catch (error) {
        report.error += `; the binding was not written back: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const reason = gone ? 'device-gone' : item.reason;
    report.reason = reason;
    const detail = report.error ?? gone;
    console.error(
      `${report.error ? 'Could not release' : item.action === 'delete' ? 'Deleted' : 'Released'} ${report.name} (${reason})${detail ? `: ${detail}` : '.'}`
    );
    // The How line rides on the error dev:stop prints, not on the progress line above.
    const step = report.error ? manualStep(item) : null;
    if (step) report.error = `${report.error}\nHow: run "${step}".`;
    if (item.reaped && item.reason === 'deleted-worktree') {
      console.error(
        `Dev-server cleanup was not checked for deleted worktree ${item.binding.projectRoot}; a CLI or Metro process may still be running.`
      );
    }
    if (item.reaped) event('device_binding_reaped', { reason });
    reports.push(report);
  }
  return reports;
}

/** The command that does by hand what a failed device action did not. */
function manualStep({ binding: { device }, action }: Cleanup): string | null {
  if (device.backend === 'local-ios' && (action === 'delete' || action === 'shutdown'))
    return `xcrun simctl ${action} ${device.udid}`;
  if (device.backend === 'local-android' && device.origin.kind === 'spawned' && action === 'kill')
    return `kill ${device.origin.emulatorPid}`;
  return null;
}

async function actAsync(
  { binding: { device, projectRoot }, action, stopRoot }: Cleanup,
  tools: DeviceTools
): Promise<{
  ok: boolean;
  reason: string | null;
  shutDown?: boolean;
  /** Why a `kill` signalled nothing: the instance had already exited. */
  gone?: string | null;
}> {
  if (device.backend === 'cloud' && action === 'stop-cloud')
    return tools.stopCloud(stopRoot ?? projectRoot, device.id);
  if (device.backend === 'local-ios' && action === 'delete')
    return deleteSimulatorAsync(tools, device.udid);
  if (device.backend === 'local-ios' && action === 'shutdown')
    return shutdownSimulatorAsync(tools, device.udid);
  if (device.backend === 'local-android' && device.origin.kind === 'spawned' && action === 'kill') {
    const result = killEmulatorIfOurs(tools, device.origin);
    if (result.failed) return { ok: false, reason: result.reason, shutDown: false };
    return { ok: true, reason: null, shutDown: result.killed, gone: result.reason };
  }
  return { ok: true, reason: null };
}
