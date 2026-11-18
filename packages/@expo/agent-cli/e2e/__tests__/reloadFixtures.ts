// Shared by the runtime:reload e2e files.
import fs from 'node:fs';
import path from 'node:path';

import { installStubBinAsync } from '../utils';

export const EXPO_GO_TARGET = {
  id: '1',
  appId: 'host.exp.Exponent',
  webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=1&page=1',
};

/** A stub `xcrun` that reports no booted device, for the runs where no rung may act. */
export async function installNoDeviceXcrunAsync(projectRoot: string): Promise<void> {
  const scriptPath = path.join(projectRoot, '.stub-bin', 'xcrun-empty.js');
  await fs.promises.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.promises.writeFile(
    scriptPath,
    [
      `if (process.argv[3] === 'list') {`,
      `  process.stdout.write(JSON.stringify({ devices: {} }));`,
      `}`,
      `process.exit(0);`,
    ].join('\n')
  );
  await installStubBinAsync(path.join(projectRoot, '.stub-bin'), 'xcrun', scriptPath);
}
