// @ref llp/0035-one-device-per-worktree.rfc.md §Output and errors
// Every refusal of the device registry, with its exit code and its How line.

import { EXIT_NEEDS_HUMAN, EXIT_OUTCOME_FAILED, EXIT_OUTCOME_TIMEOUT } from '../exitCodes';
import { PROGRAM_PREFIX } from '../programName';
import { CommandError } from '../utils/errors';
import type { BoundSerial } from './choose';
import type { DevicePlatform, InspectCause, InspectState } from './types';

/** Re-exported so a binding module types a refusal without its own edge to the error module. */
export type { CommandError };

/** The one command that binds a device to this worktree. */
export function deviceCommand(
  platform: DevicePlatform,
  { eas = false }: { eas?: boolean } = {}
): string {
  return `${PROGRAM_PREFIX} dev --${platform}${eas ? ' --eas' : ''} --detach --wait-ready`;
}

export type UnavailableReason =
  | 'unreadable'
  | 'no-ios-runtime'
  | 'no-avd'
  | 'no-free-port'
  | 'not-reusable'
  | 'create-timeout'
  | 'spawn-failed'
  | 'boot-failed'
  | 'binding-changed';

const RERUN = 'run the command again';

/** The refusal of a read verb: no device is bound, or the bound one cannot be driven now. */
export function noBoundDeviceError(
  state: Exclude<InspectState, 'recorded' | 'up'>,
  {
    platform,
    cause,
    path,
    eas,
  }: { platform: DevicePlatform; cause?: InspectCause; path?: string; eas?: boolean }
): CommandError {
  const command = deviceCommand(platform, { eas });
  if (state === 'unreadable') {
    return refusal('NO_BOUND_DEVICE', 'unreadable', EXIT_NEEDS_HUMAN, [
      `The binding file ${path} does not parse; a newer CLI may have written it.`,
      `How: run "rm -f '${path}'", then "${command}". If this project's server is running, stop it first with "${PROGRAM_PREFIX} dev:stop".`,
    ]);
  }
  if (state === 'unknown') {
    return refusal('NO_BOUND_DEVICE', 'unknown', EXIT_OUTCOME_TIMEOUT, [
      `The ${platform} device check timed out, so nothing is known about the bound device.`,
      `How: ${RERUN}.`,
    ]);
  }
  const what =
    state === 'none'
      ? `No ${platform} device is bound to this worktree.`
      : state === 'not-up'
        ? `The bound ${platform} device is not up.`
        : cause === 'expired'
          ? `The lease on the bound ${platform} device expired.`
          : `The bound ${platform} device is gone.`;
  const error = refusal('NO_BOUND_DEVICE', state, EXIT_OUTCOME_FAILED, [
    what,
    `Why: every verb drives the device "${PROGRAM_PREFIX} dev" bound to this worktree, and never the first booted one, so two worktrees never share a device.`,
    `How: run "${command}", then this command again. If this project's server is running, stop it first with "${PROGRAM_PREFIX} dev:stop".`,
  ]);
  // This synchronous error knows the binding, not whether a server is still starting.
  error.suggestedCommand = `${PROGRAM_PREFIX} status`;
  return error;
}

/** The refusal of `dev` or `smoke`: no device could be bound. */
export function deviceUnavailableError(
  reason: UnavailableReason,
  {
    platform,
    path,
    detail,
    boundBy = [],
  }: { platform: DevicePlatform; path?: string; detail?: string; boundBy?: BoundSerial[] }
): CommandError {
  switch (reason) {
    case 'unreadable':
      return refusal('DEVICE_UNAVAILABLE', reason, EXIT_NEEDS_HUMAN, [
        `The binding file ${path} does not parse; a newer CLI may have written it.`,
        `How: run "rm -f '${path}'", then this command again.`,
      ]);
    case 'no-ios-runtime':
      return refusal('DEVICE_UNAVAILABLE', reason, EXIT_NEEDS_HUMAN, [
        'No iOS runtime with an iPhone is installed, so no simulator can be created.',
        'How: run "xcodebuild -downloadPlatform iOS", then this command again.',
      ]);
    case 'no-avd':
      return refusal('DEVICE_UNAVAILABLE', reason, EXIT_NEEDS_HUMAN, [
        'No Android virtual device exists, so no emulator instance can be started.',
        "How: create one in Android Studio's Device Manager, then run this command again.",
      ]);
    case 'no-free-port': {
      const error = refusal('DEVICE_UNAVAILABLE', reason, EXIT_OUTCOME_FAILED, [
        `Every emulator console port from 5554 to 5584 is taken: ${portHolders(boundBy)}.`,
        `How: run "${PROGRAM_PREFIX} dev:stop --release" in one of the listed worktrees, then run this command again.`,
      ]);
      error.data = { reason, boundBy };
      return error;
    }
    case 'spawn-failed':
      return refusal('DEVICE_UNAVAILABLE', reason, EXIT_OUTCOME_TIMEOUT, [
        `The emulator could not be started${detail ? `: ${detail}` : '.'}`,
        `How: ${RERUN}.`,
      ]);
    case 'not-reusable':
      return notReusableError(platform);
    case 'create-timeout':
      return refusal('DEVICE_UNAVAILABLE', reason, EXIT_OUTCOME_TIMEOUT, [
        'The device tool did not answer in time.',
        `How: ${RERUN}.`,
      ]);
    case 'binding-changed':
      return refusal('DEVICE_UNAVAILABLE', reason, EXIT_OUTCOME_TIMEOUT, [
        `This worktree's ${platform} binding changed during all three device inventory attempts.`,
        `How: ${RERUN}.`,
      ]);
    case 'boot-failed':
      return refusal('DEVICE_UNAVAILABLE', reason, EXIT_OUTCOME_FAILED, [
        `The bound ${platform} device did not boot${detail ? `: ${detail}` : '.'}`,
        `How: ${RERUN}.`,
      ]);
  }
}

/** A running dev server allows only a reuse; `devices` names the bound one and the one `--device` asks for. */
export function notReusableError(
  platform: DevicePlatform,
  devices?: { bound: string; named: string }
): CommandError {
  const error = refusal('DEVICE_UNAVAILABLE', 'not-reusable', EXIT_OUTCOME_FAILED, [
    ...(devices
      ? [`The running dev server uses ${devices.bound}; --device names ${devices.named}.`]
      : [
          `A dev server is running and this worktree has no ${platform} device to reuse.`,
          'Why: a device created now would carry no app, because the running server already installed nothing on it.',
        ]),
    `How: run "${PROGRAM_PREFIX} dev:stop", then this command again.`,
  ]);
  error.suggestedCommand = `${PROGRAM_PREFIX} dev:stop`;
  return error;
}

const CHOICE_REFUSALS = [
  'explicit-not-found',
  'explicit-not-ready',
  'explicit-bound',
  'own-explicit-over-owned',
  'not-reusable',
];

/** A refusal of the choice itself, which `dev --plan --device` prints; any other error fails the plan as it fails the run. */
export function isExplicitChoiceRefusal(error: unknown): error is CommandError {
  return error instanceof CommandError && CHOICE_REFUSALS.includes(error.data?.reason as string);
}

function portHolders(boundBy: BoundSerial[]): string {
  return (
    boundBy.map(({ id, root }) => `${id} (${root ?? 'not ours'})`).join(', ') ||
    'no serial is listed'
  );
}

/** The refusal of a write that could not take the registry lock in time. */
export function registryLockedError({
  pid,
  ageMs,
  command,
}: {
  pid: number | null;
  ageMs: number | null;
  command: string | null;
}): CommandError {
  const holder = pid == null ? 'another process' : `pid ${pid}${command ? ` (${command})` : ''}`;
  const age = ageMs == null ? 'a while' : `${Math.round(ageMs / 1000)} s`;
  const error = refusal('DEVICE_REGISTRY_LOCKED', 'locked', EXIT_OUTCOME_TIMEOUT, [
    `${holder} has held the device registry for ${age}.`,
    `How: ${RERUN}${pid == null ? '' : `, or "kill ${pid}" when it repeats`}.`,
  ]);
  return error;
}

function refusal(code: string, reason: string, exitCode: number, lines: string[]): CommandError {
  const error = new CommandError(code, lines.join('\n'));
  error.exitCode = exitCode;
  error.data = { reason };
  return error;
}

export type CloudBindingFault = 'expired' | 'ended';

/** A recorded EAS session that a read verb cannot drive. */
export function cloudBindingError(
  platform: DevicePlatform,
  fault: CloudBindingFault
): CommandError {
  const command = deviceCommand(platform, { eas: true });
  const error = new CommandError(
    'NO_BOUND_DEVICE',
    [
      `The bound ${platform} EAS session is ${fault}.`,
      `How: run "${command}" to bind a session again. If this project's server is running, stop it first with "${PROGRAM_PREFIX} dev:stop"; plain stop preserves its sessions.`,
    ].join('\n')
  );
  error.exitCode = EXIT_OUTCOME_FAILED;
  error.data = { reason: 'gone' };
  error.suggestedCommand = `${PROGRAM_PREFIX} status`;
  return error;
}

/** The EAS session this worktree drives is listed and pending. The platform is null when unknown. */
export function cloudSessionQueuedError({
  id,
  platform,
  status,
}: {
  id: string;
  platform: DevicePlatform | null;
  status: string | null;
}): CommandError {
  const error = new CommandError(
    'NO_BOUND_DEVICE',
    [
      `The ${platform ? `${platform} ` : ''}EAS session ${id} is not up yet${status ? ` (status ${status})` : ''}.`,
      'How: retry in a minute.',
    ].join('\n')
  );
  error.exitCode = EXIT_OUTCOME_FAILED;
  error.data = { reason: 'not-up' };
  return error;
}
