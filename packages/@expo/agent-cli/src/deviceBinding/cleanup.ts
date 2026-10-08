// @ref llp/0030-one-device-per-worktree.rfc.md §Records
import { firstLine } from '../utils/text';
import { killEmulatorIfOurs } from './android';
import { event } from './events';
import { shutdownSimulatorAsync } from './ios';
import { deviceReport } from './records';
import type { Binding, DeviceTools, ReleasedDevice } from './types';

export type Cleanup = {
  binding: Binding;
  action: 'forget' | 'shutdown' | 'delete' | 'kill' | 'stop-cloud';
  reason: string;
  reaped?: boolean;
  stopRoot?: string;
};
export type CleanupReport = ReleasedDevice & { error?: string };

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
      released: true,
      reason: item.reason,
    };
    try {
      const result = await actAsync(item, tools);
      report.shutDown = result.shutDown ?? (result.ok && item.action !== 'forget');
      if (!result.ok) report.error = result.reason ?? 'device cleanup failed';
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
    }
    console.error(
      `${report.error ? 'Could not release' : item.action === 'delete' ? 'Deleted' : 'Released'} ${report.name} (${item.reason})${report.error ? `: ${report.error}` : '.'}`
    );
    if (item.reaped) event('device_binding_reaped', { reason: item.reason });
    reports.push(report);
  }
  return reports;
}

async function actAsync(
  { binding: { device, projectRoot }, action, stopRoot }: Cleanup,
  tools: DeviceTools
): Promise<{ ok: boolean; reason: string | null; shutDown?: boolean }> {
  if (device.backend === 'cloud' && action === 'stop-cloud')
    return tools.stopCloud(stopRoot ?? projectRoot, device.id);
  if (device.backend === 'local-ios' && action === 'delete')
    return deleteSimulatorAsync(tools, device.udid);
  if (device.backend === 'local-ios' && action === 'shutdown')
    return shutdownSimulatorAsync(tools, device.udid);
  if (device.backend === 'local-android' && device.origin.kind === 'spawned' && action === 'kill') {
    const result = killEmulatorIfOurs(tools, device.origin);
    return { ok: !result.failed, reason: result.reason, shutDown: result.killed };
  }
  return { ok: true, reason: null };
}
