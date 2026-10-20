// @ref llp/0015-backend-selection-and-config.rfc.md §The device backend
import { CommandError } from '../utils/errors';

/** `--eas` and `--local` name two places for one device, on every command that takes both. */
export function assertOneDeviceBackendFlag(eas: boolean, local: boolean): void {
  if (!eas || !local) {
    return;
  }
  throw new CommandError(
    'BAD_ARGS',
    [
      '--eas and --local name two places for one device, so this run has no device to use.',
      "Why: --eas uses this project's EAS Simulator session, and --local uses only devices on this machine.",
      "How: pass one. Leave both out to follow the project's config.",
    ].join('\n')
  );
}
