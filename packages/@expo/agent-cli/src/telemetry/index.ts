import { boolish } from 'getenv';

import type { CommandTelemetry } from './types';

/**
 * @ref llp/0028-command-telemetry.rfc.md
 * The command never waits for telemetry. Even detection and identity reads belong to the worker.
 * Hand off immediately so long-running commands and explicit process.exit paths are covered
 * without adding signal handlers or changing the CLI's shutdown behavior.
 */
export function recordCommand(command: string, version: string): void {
  try {
    if (boolish('EXPO_NO_TELEMETRY', false) || boolish('EXPO_OFFLINE', false)) {
      return;
    }

    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    const path = require('node:path') as typeof import('node:path');
    const record: CommandTelemetry = { command, version, timestamp: new Date().toISOString() };
    // ncc emits the CLI in build/cli and the independent worker in build/telemetry.
    // Only this small record is passed, never raw argv or command output.
    const child = spawn(
      process.execPath,
      [path.join(__dirname, '..', 'telemetry', 'index.js'), JSON.stringify(record)],
      { detached: true, windowsHide: true, shell: false, stdio: 'ignore' }
    );
    child.on('error', () => {});
    child.unref();
  } catch {
    // Observability must not change command output, exit status, or availability.
  }
}
