// @ref llp/0035-one-device-per-worktree.rfc.md §Session cleanup
import { isLive, probeCloudSessionAsync } from '../device/cloudSimulator';
import { live, readCloudBindings } from '../deviceBinding/cloud';
import { releaseCloudSessionsAsync } from '../deviceBinding/cloudRelease';
import { deviceUnavailableError } from '../deviceBinding/errors';
import { deviceReport } from '../deviceBinding/records';
import type { ReleasedDevice } from '../deviceBinding';
import { debugEvent } from './events';

export async function stopCloudSessionsAsync(projectRoot: string) {
  const { bindings, unreadable } = readCloudBindings(projectRoot);
  const probe = await probeCloudSessionAsync({
    projectRoot,
    boundIds: live(bindings, new Date()).map(({ device }) => device.id),
  });
  const primary = isLive(probe) ? probe.session : null;
  const ids = new Set([
    ...(primary ? [primary.id] : []),
    ...bindings.map(({ device }) => device.id),
  ]);
  let session = {
    id: primary?.id ?? null,
    stopped: false,
    reason: probe.state === 'unknown' ? probe.reason : null,
    platform: primary?.platform ?? null,
  };
  let deviceError = probe.state === 'unknown' ? probe.reason : null;
  const devices: ReleasedDevice[] = [];
  const { releases, lockError } = await releaseCloudSessionsAsync(
    projectRoot,
    [...ids],
    'dev:stop --eas'
  );
  for (const release of releases) {
    const { id, ok, reason } = release;
    // A release whose lock failed removed nothing and names no binding; the read above still does.
    const binding = release.binding ?? bindings.find(({ device }) => device.id === id);
    const platform = binding?.device.platform ?? (id === primary?.id ? primary.platform : null);
    debugEvent('stop_session', { sessionId: id, ok, platform });
    if (!ok) deviceError ??= reason ?? `Could not stop EAS session ${id}`;
    if (id === primary?.id) session = { id, stopped: ok, reason, platform };
    else if (binding)
      devices.push({ ...deviceReport(binding), released: ok, shutDown: ok, reason });
  }
  deviceError ??= lockError;
  if (unreadable[0]) deviceError ??= deviceUnavailableError('unreadable', unreadable[0]).message;
  return { session, devices, deviceError };
}
