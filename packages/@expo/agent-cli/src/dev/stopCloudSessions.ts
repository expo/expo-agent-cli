// @ref llp/0035-one-device-per-worktree.rfc.md §Session cleanup
import { isLive, probeCloudSessionAsync } from '../device/cloudSimulator';
import { live, readCloudBindings } from '../deviceBinding/cloud';
import { releaseCloudSessionsAsync } from '../deviceBinding/cloudRelease';
import { deviceUnavailableError } from '../deviceBinding/errors';
import { deviceReport } from '../deviceBinding/records';
import type { ReleasedDevice } from '../deviceBinding';
import { debugEvent } from './events';
import type { StartupSession } from '../utils/startupTasks';

export async function captureCloudSessionsAsync(projectRoot: string) {
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
  return { bindings, unreadable, probe, primary, ids: [...ids] };
}

export async function stopCloudSessionsAsync(
  projectRoot: string,
  captured?: Awaited<ReturnType<typeof captureCloudSessionsAsync>>,
  owned: StartupSession[] = []
) {
  const {
    bindings,
    unreadable,
    probe,
    primary: initial,
    ids,
  } = captured ?? (await captureCloudSessionsAsync(projectRoot));
  const primary = initial ?? owned.at(-1) ?? null;
  let session = {
    id: primary?.id ?? null,
    stopped: false,
    reason: probe.state === 'unknown' || probe.state === 'unavailable' ? probe.reason : null,
    platform: primary?.platform ?? null,
  };
  let deviceError: string | null = null;
  const devices: ReleasedDevice[] = [];
  const { releases, lockError } = await releaseCloudSessionsAsync(
    projectRoot,
    [...new Set([...ids, ...owned.map(({ id }) => id)])],
    'dev:stop --eas'
  );
  for (const release of releases) {
    const { id, ok, reason } = release;
    // A release whose lock failed removed nothing and names no binding; the read above still does.
    const binding = release.binding ?? bindings.find(({ device }) => device.id === id);
    const platform =
      binding?.device.platform ??
      owned.find((session) => session.id === id)?.platform ??
      (id === primary?.id ? primary.platform : null);
    debugEvent('stop_session', { sessionId: id, ok, platform });
    if (!ok) deviceError ??= reason ?? `Could not stop EAS session ${id}`;
    if (id === primary?.id) session = { id, stopped: ok, reason, platform };
    else if (binding || platform)
      devices.push({
        ...(binding
          ? deviceReport(binding)
          : { id, platform: platform!, backend: 'cloud' as const, name: id }),
        // A lock that was not taken removed nothing: the stop worked and the binding stays.
        released: ok && lockError ? null : ok,
        shutDown: ok,
        reason: ok && lockError ? lockError : reason,
      });
  }
  deviceError ??= lockError;
  if (unreadable[0]) deviceError ??= deviceUnavailableError('unreadable', unreadable[0]).message;
  return { session, devices, deviceError };
}
