// @ref llp/0034-eas-session-binding.plan.md §PR 5
import { probeCloudSessionAsync } from '../device/cloudSimulator';
import { stopEasSessionAsync } from '../device/eas';
import { ownCloudBindings, releaseCloudBindingAsync } from '../deviceBinding/cloud';
import { deviceReport } from '../deviceBinding/records';
import type { ReleasedDevice } from '../deviceBinding';
import { debugEvent } from './events';

export async function stopCloudSessionsAsync(projectRoot: string) {
  const bindings = ownCloudBindings(projectRoot, true);
  const probe = await probeCloudSessionAsync({ projectRoot });
  const primary = probe.state === 'active' || probe.state === 'queued' ? probe.sessionId : null;
  const ids = new Set([
    ...(primary ? [primary] : []),
    ...bindings.flatMap(({ device }) => (device.backend === 'cloud' ? [device.id] : [])),
  ]);
  let session = {
    id: primary,
    stopped: false,
    reason: probe.state === 'unknown' ? probe.reason : null,
  };
  let deviceError =
    probe.state === 'unknown' ? (probe.reason ?? 'EAS session discovery failed') : null;
  const devices: ReleasedDevice[] = [];
  for (const id of ids) {
    const binding = bindings.find(({ device }) => device.backend === 'cloud' && device.id === id);
    const result = await stopEasSessionAsync(projectRoot, id);
    debugEvent('stop_session', {
      sessionId: id,
      ok: result.ok,
      platform: binding?.device.platform ?? probe.platform,
    });
    if (result.ok) await releaseCloudBindingAsync(projectRoot, id);
    else deviceError ??= result.reason ?? `Could not stop EAS session ${id}`;
    if (id === primary) session = { id, stopped: result.ok, reason: result.reason };
    else if (binding)
      devices.push({
        ...deviceReport(binding),
        released: result.ok,
        shutDown: result.ok,
        reason: result.reason,
      });
  }
  return { session, devices, deviceError };
}
