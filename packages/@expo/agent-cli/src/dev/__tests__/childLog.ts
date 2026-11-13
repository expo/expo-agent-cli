import * as Log from '../../log';
import { logCmdError, type CommandError } from '../../utils/errors';

/**
 * The log a detached child writes for `error`, line by line, as `logCmdError` prints it. The
 * calling test mocks `../../log`.
 */
export function childLogOf(error: CommandError): string[] {
  vi.mocked(Log.exception).mockClear();
  vi.mocked(Log.warn).mockClear();
  process.env.__EXPO_AGENT_CLI_DETACHED = '1';
  try {
    void logCmdError(error);
  } finally {
    delete process.env.__EXPO_AGENT_CLI_DETACHED;
  }
  return [
    ...vi.mocked(Log.exception).mock.calls.map(([printed]) => String(printed)),
    ...vi.mocked(Log.warn).mock.calls.map((args) => args.join(' ')),
  ];
}
