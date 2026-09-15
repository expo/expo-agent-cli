// @ref llp/0004-smart-start-and-project-state.rfc.md §Status
// Argument resolution for the flags `status` grew when it absorbed `@expo/agent-cli impact`. Pure: values
// in, options out, `CommandError` for anything a caller can get wrong, so every combination is
// unit-testable without a project.

import { IMPACT_CLASS_ORDER, type ImpactClass } from '../impact/types';
import { PROGRAM_PREFIX } from '../programName';
import { CommandError } from '../utils/errors';
import { easCommandPrefix } from '../utils/easCli';

/**
 * The class `--assert` names, or null when the flag was not given.
 *
 * @throws {CommandError} `BAD_ARGS` when the value is not one of the three classes.
 */
export function resolveAssertClass(value: unknown): ImpactClass | null {
  if (value == null) {
    return null;
  }
  if (typeof value === 'string' && (IMPACT_CLASS_ORDER as string[]).includes(value)) {
    return value as ImpactClass;
  }
  throw new CommandError(
    'BAD_ARGS',
    [
      `--assert ${String(value)} is not one of the classes this reports.`,
      `Why: --assert is a gate on the class in the report, so it has to name one of them: it passes when the real class is at most the one named.`,
      `How: pass one of ${IMPACT_CLASS_ORDER.join(', ')}, weakest first. "--assert js-only" is the strictest gate.`,
    ].join('\n')
  );
}

/**
 * The EAS build `--build` names, or null.
 *
 * The flag fetches the fingerprint EAS computed for that one build — a network call the default
 * report does not make on its own — and it is made because the caller named the build. It used to
 * require `--explain` as the word for "you may spend a round trip"; there is no such word now, and
 * naming a build is the ask.
 *
 * @throws {CommandError} `BAD_ARGS` for an empty value.
 */
export function resolveBuildId(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  const buildId = typeof value === 'string' ? value.trim() : '';
  if (!buildId) {
    throw new CommandError(
      'BAD_ARGS',
      [
        `--build needs the id of an EAS build.`,
        `Why: it compares this working tree against the fingerprint EAS computed for one specific build, which is server ground truth and needs no local record.`,
        `How: find the id with "${easCommandPrefix()} build:list --limit 5 --json --non-interactive", then run "${PROGRAM_PREFIX} status --build <id>".`,
      ].join('\n')
    );
  }
  return buildId;
}

/**
 * The simulator, emulator or device `--device` named, for the `installed` section.
 *
 * @throws {CommandError} `BAD_ARGS` for an empty value, or for `--device` without `--explain`.
 */
export function resolveDeviceFlag(
  value: unknown,
  { explain }: { explain: boolean }
): string | null {
  if (value == null) {
    return null;
  }
  const device = typeof value === 'string' ? value.trim() : '';
  if (!device) {
    throw new CommandError(
      'BAD_ARGS',
      [
        `--device needs a simulator name, a device name, a UDID or an adb serial.`,
        `Why: it names which device the installed-app check reads, and an empty value names none.`,
        `How: run "${PROGRAM_PREFIX} status --explain --device <name>", or leave the flag out to read every device this machine has.`,
      ].join('\n')
    );
  }
  if (!explain) {
    const error = new CommandError(
      'BAD_ARGS',
      [
        `--device needs --explain.`,
        `Why: it narrows the installed-app check, which is part of the deep dive. The default report reads no device.`,
        `How: run ${PROGRAM_PREFIX} status --explain --device "${device}".`,
      ].join('\n')
    );
    error.suggestedCommand = `${PROGRAM_PREFIX} status --explain --device "${device}"`;
    throw error;
  }
  return device;
}

/** Bounds on `--device-timeout`, in seconds. A phone that has not answered in five minutes is gone. */
const MIN_DEVICE_TIMEOUT_SECONDS = 1;
const MAX_DEVICE_TIMEOUT_SECONDS = 300;

/**
 * How long a physical iPhone gets to report its fingerprint, in milliseconds. Null uses the default.
 *
 * A cold launch of a dev client on an older phone can outrun the default, and the timeout reports
 * `no-response`, which reads as a network or permission problem rather than as "it was slow".
 *
 * @throws {CommandError} `BAD_ARGS` for a value outside the range, or without `--explain`.
 */
export function resolveDeviceTimeoutFlag(
  value: unknown,
  { explain }: { explain: boolean }
): number | null {
  if (value == null) {
    return null;
  }
  const raw = typeof value === 'string' ? value.trim() : '';
  const seconds = Number(raw);
  if (
    !raw ||
    !Number.isInteger(seconds) ||
    seconds < MIN_DEVICE_TIMEOUT_SECONDS ||
    seconds > MAX_DEVICE_TIMEOUT_SECONDS
  ) {
    throw new CommandError(
      'BAD_ARGS',
      [
        `--device-timeout needs a whole number of seconds between ${MIN_DEVICE_TIMEOUT_SECONDS} and ${MAX_DEVICE_TIMEOUT_SECONDS}.`,
        `Why: it is how long a physical iPhone gets to report its fingerprint once the app was launched on it.`,
        `How: run "${PROGRAM_PREFIX} status --explain --device <phone> --device-timeout 45".`,
      ].join('\n')
    );
  }
  if (!explain) {
    // No "Try:" line: the phone's name is the one thing this CLI cannot fill in for the reader.
    throw new CommandError(
      'BAD_ARGS',
      [
        `--device-timeout needs --explain.`,
        `Why: it bounds the physical-iPhone probe, which is part of the deep dive and only runs for a phone --device names.`,
        `How: run "${PROGRAM_PREFIX} status --explain --device <phone> --device-timeout ${seconds}".`,
      ].join('\n')
    );
  }
  return seconds * 1000;
}
