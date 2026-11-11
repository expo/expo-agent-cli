import { rerunDevCommand } from '../plan/rerun';
import type { DeviceBackend, PlanPlatform } from '../plan/types';
import type { StartupRequest } from './startupRequest';

export function recoveryRequestFor(
  platform: PlanPlatform,
  saved: StartupRequest | null,
  {
    deviceBackend = 'local',
    build = 'auto',
    port,
  }: {
    deviceBackend?: DeviceBackend;
    build?: StartupRequest['build'];
    port?: number | null;
  } = {}
): StartupRequest {
  const request =
    saved?.platform === platform
      ? saved
      : {
          platform,
          build,
          deviceBackend,
          target: 'auto' as const,
          port: 'auto' as const,
          device: 'auto',
          open: true,
          fingerprintCache: true,
          agentSkills: true,
          expo: { host: 'auto' as const, flags: {}, opaqueTail: [] },
        };
  return port === undefined ? request : { ...request, port: port ?? 'auto' };
}

export function recoveryStartCommand(request: StartupRequest): string {
  const { expo } = request;
  const flags = Object.entries(expo.flags).flatMap(([flag, value]) =>
    value === true
      ? [flag]
      : [
          typeof value === 'boolean' ? `${flag}=${value}` : flag,
          ...(typeof value === 'boolean' ? [] : [String(value)]),
        ]
  );
  return rerunDevCommand(
    request.platform,
    [
      ...(request.deviceBackend === 'eas'
        ? ['--eas']
        : request.build === 'local'
          ? ['--local']
          : []),
      ...(request.target === 'auto'
        ? []
        : [request.target === 'expo-go' ? '--go' : '--dev-client']),
      ...(request.port === 'auto' ? [] : ['--port', String(request.port)]),
      ...(request.open ? [] : ['--no-open']),
      ...(request.fingerprintCache ? [] : ['--no-fingerprint-cache']),
      ...(request.agentSkills ? [] : ['--no-agent-skills']),
      ...(expo.host === 'auto' ? [] : [`--${expo.host}`]),
      ...flags,
      ...expo.opaqueTail,
    ],
    request.deviceBackend === 'local' && request.device !== 'auto' ? request.device : undefined
  );
}
