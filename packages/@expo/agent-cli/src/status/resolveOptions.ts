// @ref llp/0004-smart-start-and-project-state.rfc.md §Status
// Argument resolution for the flags `status` grew when it absorbed `@expo/agent-cli impact`. Pure: values
// in, options out, `CommandError` for anything a caller can get wrong, so every combination is
// unit-testable without a project.

import { IMPACT_CLASS_ORDER, type ImpactClass } from '../impact/types';
import { PROGRAM_PREFIX } from '../programName';
import { CommandError } from '../utils/errors';

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
 * `--build` requires `--explain` and says so rather than quietly implying it. The flag makes a
 * network call to fetch a fingerprint EAS computed on its own servers, and `--explain` is the one
 * word in this command's surface that means "you may spend a subprocess and a round trip". A flag
 * that turned that on by itself would put the cost back where the design took it out of.
 *
 * @throws {CommandError} `BAD_ARGS` for an empty value, or for `--build` without `--explain`.
 */
export function resolveBuildId(value: unknown, { explain }: { explain: boolean }): string | null {
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
        `How: find the id with "npx eas build:list --limit 5 --json --non-interactive", then pass it as "--explain --build <id>".`,
      ].join('\n')
    );
  }
  if (!explain) {
    const error = new CommandError(
      'BAD_ARGS',
      [
        `--build needs --explain.`,
        `Why: comparing against an EAS build fetches a fingerprint from the service, and --explain is what says this run may make a network call. The default report is built from what is already on this machine, and a flag that spent a round trip without being asked would take that promise away.`,
        `How: run "${PROGRAM_PREFIX} status --explain --build ${buildId}".`,
      ].join('\n')
    );
    error.suggestedCommand = `${PROGRAM_PREFIX} status --explain --build ${buildId}`;
    throw error;
  }
  return buildId;
}

/**
 * The simulator or device `--device` named.
 *
 * Two jobs, and the second is why it needs `--explain`: it narrows which device is read, and it is
 * the consent to probe a physical iPhone. That probe *launches the app*, and `status` promises to
 * start nothing, so it can only ever happen because somebody named a device and asked for the deep
 * dive with its longer budget.
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
        `How: run "${PROGRAM_PREFIX} status --explain --device \\"iPhone 17 Pro\\"", or leave the flag out to read every device this machine has.`,
      ].join('\n')
    );
  }
  if (!explain) {
    const error = new CommandError(
      'BAD_ARGS',
      [
        `--device needs --explain.`,
        `Why: selecting a device requires the longer check budget enabled by --explain; the default check has a 2-second budget.`,
        `How: run "${PROGRAM_PREFIX} status --explain --device "${device.replace(/["\\$`]/g, '\\$&')}"".`,
      ].join('\n')
    );
    error.suggestedCommand = `${PROGRAM_PREFIX} status --explain --device "${device.replace(/["\\$`]/g, '\\$&')}"`;
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
 * @throws {CommandError} `BAD_ARGS` for a non-positive or out-of-range value, or without `--explain`.
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
        `Why: it is how long a physical iPhone gets to report its fingerprint, and a value outside that range is either no wait at all or longer than a device is ever going to take.`,
        `How: run "${PROGRAM_PREFIX} status --explain --device \"Ada's iPhone\" --device-timeout 45".`,
      ].join('\n')
    );
  }
  if (!explain) {
    const error = new CommandError(
      'BAD_ARGS',
      [
        `--device-timeout needs --explain.`,
        `Why: it bounds the physical-device probe, and a default report reads no device at all.`,
        `How: run "${PROGRAM_PREFIX} status --explain --device-timeout ${seconds}".`,
      ].join('\n')
    );
    error.suggestedCommand = `${PROGRAM_PREFIX} status --explain --device-timeout ${seconds}`;
    throw error;
  }
  return seconds * 1000;
}
