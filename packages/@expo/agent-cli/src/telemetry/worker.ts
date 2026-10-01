// @ref llp/0028-command-telemetry.rfc.md
import { sendCommandTelemetryAsync, TELEMETRY_TIMEOUT_MS } from './send';
import type { CommandTelemetry } from './types';

// This standalone best-effort worker owns no command output or child processes. Exit
// explicitly so stalled filesystem operations or HTTP sockets cannot keep it alive.
const deadline = setTimeout(() => process.exit(0), TELEMETRY_TIMEOUT_MS);

void (async () => {
  try {
    const data: unknown = JSON.parse(process.argv[2] ?? '');
    if (isCommandTelemetry(data)) await sendCommandTelemetryAsync(data);
  } catch {
    // Invalid input and unavailable telemetry are silent, successful worker exits.
  } finally {
    clearTimeout(deadline);
    process.exit(0);
  }
})();

function isCommandTelemetry(value: unknown): value is CommandTelemetry {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<CommandTelemetry>;
  return (
    typeof data.command === 'string' &&
    /^[a-z][a-z0-9:-]*$/.test(data.command) &&
    typeof data.version === 'string' &&
    data.version.length > 0 &&
    data.version.length < 100 &&
    typeof data.timestamp === 'string' &&
    Number.isFinite(Date.parse(data.timestamp))
  );
}
