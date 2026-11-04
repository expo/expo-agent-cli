import type { EnsureEasSessionReport } from '../../dev/easSession';
import { deviceNameOf, type BoundDevice } from '../../deviceBinding';
import { CommandError } from '../../utils/errors';
import { firstLine } from '../../utils/text';
import type { SmokeSessionResult } from '../phases';

/** The boot line's "because": a spawned instance's AVD, and nothing for an explicit serial. */
export function choiceOf(device: BoundDevice): string | null {
  if (device.backend !== 'local-android') {
    return deviceNameOf(device);
  }
  return device.origin.kind === 'spawned' ? device.origin.avd : null;
}

/** The phase result of a session start; a refusal gives its What and How, not only its first line. */
export function smokeSessionResult(
  result: Pick<EnsureEasSessionReport, 'ok' | 'sessionId' | 'started' | 'reason' | 'refusal'>
): SmokeSessionResult {
  return {
    ok: result.ok,
    sessionId: result.sessionId,
    started: result.started,
    reason: result.refusal ? whatAndHow(result.refusal.message) : result.reason,
  };
}

/** A refusal's What and its How line, as one phase reason; the Why in between is dropped. */
export function whatAndHow(message: string): string {
  const lines = message.split('\n').filter((line) => line.trim());
  const how = lines.find((line) => line.startsWith('How:'));
  return how && how !== lines[0] ? `${lines[0]} ${how}` : (lines[0] ?? message);
}

/** A debugger failure as one phase reason: a refusal keeps its Why, because that names what was skipped. */
export function debuggerFailureReason(error: unknown): string {
  if (error instanceof CommandError) {
    return error.message
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('How:'))
      .join(' ');
  }
  return error instanceof Error ? firstLine(error.message) : String(error);
}
