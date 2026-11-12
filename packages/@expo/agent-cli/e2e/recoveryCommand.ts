import { spawn } from 'node:child_process';
import path from 'node:path';

import { PROGRAM_PREFIX } from '../src/programName';
import {
  bin,
  collectOutput,
  expoHomeOf,
  installStubBinAsync,
  killAsync,
  stubExpoEnv,
  waitForExitAsync,
} from './utils';

export async function runRecoveryCommand(
  root: string,
  command: string,
  env: Record<string, string | undefined> = {}
) {
  await installStubBinAsync(path.join(root, '.stub-bin'), 'agent-cli-under-test', bin);
  const child = spawn(command.replaceAll(PROGRAM_PREFIX, 'agent-cli-under-test'), {
    cwd: root,
    shell:
      process.platform === 'win32'
        ? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
        : true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CI: '1',
      EXPO_NO_TELEMETRY: '1',
      AGENT_CLI_NO_DEVICE: '1',
      AGENT_CLI_NO_DOCS_SYNC: '1',
      __UNSAFE_EXPO_HOME_DIRECTORY: expoHomeOf(root),
      ...stubExpoEnv(root),
      ...env,
    },
  });
  const output = collectOutput(child);
  const timer = setTimeout(() => void killAsync(child, 'SIGKILL'), 45_000);
  try {
    return await waitForExitAsync(child, output);
  } finally {
    clearTimeout(timer);
  }
}
