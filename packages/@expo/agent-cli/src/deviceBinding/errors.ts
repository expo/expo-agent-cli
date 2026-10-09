// @ref llp/0030-one-device-per-worktree.rfc.md §Output and errors
// Every refusal of the device registry, with its exit code and its How line.

import { EXIT_NEEDS_HUMAN, EXIT_OUTCOME_FAILED, EXIT_OUTCOME_TIMEOUT } from '../exitCodes';
import { PROGRAM_PREFIX } from '../programName';
import { CommandError } from '../utils/errors';
import type { DevicePlatform, InspectCause, InspectState } from './types';

/** The one command that binds a device to this worktree. */
export function deviceCommand(platform: DevicePlatform): string {
  return `${PROGRAM_PREFIX} dev --${platform} --detach --wait-ready`;
}

export type UnavailableReason =
  | 'unreadable'
  | 'no-ios-runtime'
  | 'not-reusable'
  | 'create-timeout'
  | 'boot-failed';

const RERUN = 'run the command again';

/** The refusal of a read verb: no device is bound, or the bound one cannot be driven now. */
export function noBoundDeviceError(
  state: Exclude<InspectState, 'recorded' | 'up'>,
  { platform, cause, path }: { platform: DevicePlatform; cause?: InspectCause; path?: string }
): CommandError {
  const command = deviceCommand(platform);
  if (state === 'unreadable') {
    return refusal('NO_BOUND_DEVICE', 'unreadable', EXIT_NEEDS_HUMAN, [
      `The binding file ${path} does not parse; a newer CLI may have written it.`,
      `How: run "rm -f '${path}'", then "${command}".`,
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
    `How: run "${command}", then this command again.`,
  ]);
  error.suggestedCommand = command;
  return error;
}

/** The refusal of `dev` or `smoke`: no device could be bound. */
export function deviceUnavailableError(
  reason: UnavailableReason,
  { platform, path, detail }: { platform: DevicePlatform; path?: string; detail?: string }
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
    case 'not-reusable': {
      const error = refusal('DEVICE_UNAVAILABLE', reason, EXIT_OUTCOME_FAILED, [
        `A dev server is running and this worktree has no ${platform} device to reuse.`,
        'Why: a device created now would carry no app, because the running server already installed nothing on it.',
        `How: run "${PROGRAM_PREFIX} dev:stop", then this command again.`,
      ]);
      error.suggestedCommand = `${PROGRAM_PREFIX} dev:stop`;
      return error;
    }
    case 'create-timeout':
      return refusal('DEVICE_UNAVAILABLE', reason, EXIT_OUTCOME_TIMEOUT, [
        'The device tool did not answer in time.',
        `How: ${RERUN}.`,
      ]);
    case 'boot-failed':
      return refusal('DEVICE_UNAVAILABLE', reason, EXIT_OUTCOME_FAILED, [
        `The bound ${platform} device did not boot${detail ? `: ${detail}` : '.'}`,
        `How: ${RERUN}.`,
      ]);
  }
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
