import type { DeviceBackend, PlanPlatform } from '../plan/types';
import { settingsBuildBackend } from '../settings/parse';
import {
  EMPTY_SETTINGS,
  type AgentCliSettings,
  type BuildBackend,
  type RunTarget,
} from '../settings/types';
import type { DevOptions } from './resolveOptions';

export type StartupRequest = Readonly<{
  platform: PlanPlatform;
  build: BuildBackend | 'auto';
  deviceBackend: DeviceBackend;
  target: RunTarget | 'auto';
  port: number | 'auto';
  device: string | 'auto';
  open: boolean;
  fingerprintCache: boolean;
  agentSkills: boolean;
  expo: Readonly<{
    host: 'lan' | 'localhost' | 'tunnel' | 'auto';
    flags: Readonly<Record<string, boolean | string | number>>;
    opaqueTail: readonly string[];
  }>;
}>;

const ALIASES: Record<string, string> = {
  '-c': '--clear',
  '--reset-cache': '--clear',
  '-m': '--minify',
  '-d': '--dev-client',
  '-g': '--go',
  '-w': '--web',
};
const VALUES = new Set(['--max-workers', '--private-key-path', '--scheme', '--host']);
const BOOLEANS = new Set(['--clear', '--no-dev', '--minify', '--https', '--offline']);
const SELECTORS = new Set(['--dev-client', '--go', '--web']);

export function startupRequestFrom(
  options: DevOptions,
  settings: AgentCliSettings = EMPTY_SETTINGS
): StartupRequest {
  const build =
    options.buildBackend ??
    (options.platform === 'ios' || options.platform === 'android'
      ? settingsBuildBackend(settings, options.platform)
      : null);
  return Object.freeze({
    platform: options.platform,
    build: build ?? 'auto',
    deviceBackend: options.deviceBackend,
    target: options.runTarget ?? settings.target ?? 'auto',
    port: options.port ?? 'auto',
    device: options.device ?? 'auto',
    open: options.open,
    fingerprintCache: options.fingerprintCache,
    agentSkills: options.agentSkills,
    expo: normalizeExpoArgs(options.expoArgs),
  });
}

function normalizeExpoArgs(args: readonly string[]): StartupRequest['expo'] {
  let host: StartupRequest['expo']['host'] = 'auto';
  const flags: Record<string, boolean | string | number> = {};
  const opaqueTail: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === '--') {
      opaqueTail.push(...args.slice(index));
      break;
    }
    const equal = argument.indexOf('=');
    const name = equal < 0 ? argument : argument.slice(0, equal);
    const flag = ALIASES[name] ?? name;
    const inline = equal < 0 ? undefined : argument.slice(equal + 1);
    if (SELECTORS.has(flag) && inline === undefined) continue;
    if (['--tunnel', '--lan', '--localhost'].includes(flag) && inline === undefined) {
      host = flag.slice(2) as StartupRequest['expo']['host'];
    } else if (VALUES.has(flag)) {
      const value = inline ?? args[++index];
      if (flag === '--host' && ['lan', 'localhost', 'tunnel'].includes(value ?? '')) {
        host = value as StartupRequest['expo']['host'];
      } else if (value !== undefined) {
        flags[flag] = flag === '--max-workers' && /^\d+$/.test(value) ? Number(value) : value;
      } else {
        opaqueTail.push(argument);
      }
    } else if (BOOLEANS.has(flag) && inline === undefined) {
      flags[flag] = true;
    } else {
      opaqueTail.push(argument);
    }
  }
  return Object.freeze({
    host,
    flags: Object.freeze(
      Object.fromEntries(Object.entries(flags).sort(([a], [b]) => a.localeCompare(b)))
    ),
    opaqueTail: Object.freeze(opaqueTail),
  });
}

export function equivalentStartupRequest(a: StartupRequest, b: StartupRequest): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function parseStartupRequest(value: unknown): StartupRequest | null {
  if (!isRecord(value) || !isRecord(value.expo) || !isRecord(value.expo.flags)) return null;
  if (
    !['ios', 'android', 'web'].includes(String(value.platform)) ||
    !['local', 'eas', 'auto'].includes(String(value.build)) ||
    !['local', 'eas'].includes(String(value.deviceBackend)) ||
    !['expo-go', 'dev-build', 'auto'].includes(String(value.target)) ||
    !(
      value.port === 'auto' ||
      (Number.isInteger(value.port) && Number(value.port) > 0 && Number(value.port) <= 65535)
    ) ||
    typeof value.device !== 'string' ||
    !value.device ||
    ['open', 'fingerprintCache', 'agentSkills'].some((key) => typeof value[key] !== 'boolean') ||
    !['lan', 'localhost', 'tunnel', 'auto'].includes(String(value.expo.host)) ||
    Object.entries(value.expo.flags).some(
      ([key, flag]) =>
        (!BOOLEANS.has(key) && !VALUES.has(key)) ||
        !['boolean', 'string', 'number'].includes(typeof flag) ||
        (typeof flag === 'number' && !Number.isFinite(flag))
    ) ||
    !Array.isArray(value.expo.opaqueTail) ||
    value.expo.opaqueTail.some((arg) => typeof arg !== 'string')
  )
    return null;
  const request = value as unknown as StartupRequest;
  return Object.freeze({
    platform: request.platform,
    build: request.build,
    deviceBackend: request.deviceBackend,
    target: request.target,
    port: request.port,
    device: request.device,
    open: request.open,
    fingerprintCache: request.fingerprintCache,
    agentSkills: request.agentSkills,
    expo: Object.freeze({
      host: request.expo.host,
      flags: Object.freeze(
        Object.fromEntries(
          Object.entries(request.expo.flags).sort(([a], [b]) => a.localeCompare(b))
        )
      ),
      opaqueTail: Object.freeze([...request.expo.opaqueTail]),
    }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
