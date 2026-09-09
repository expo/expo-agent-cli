// The shared stub `eas`: how a test puts it on `PATH`, and how it reads what the CLI asked of it.
//
// @ref llp/0015-backend-selection-and-config.rfc.md §Resolving the EAS CLI — nothing under test
// resolves a file called `eas`; every EAS-backed command runs the package through `npx`/`bunx`, so
// what is installed is a stub *runner* that hands the argv to `stubs/eas.js`.
//
// The script is **copied** into the project's `.stub-bin` rather than referenced in place, so a
// test that needs a one-off answer can overwrite the copy without touching the shared file.
import fs from 'node:fs';
import path from 'node:path';

import { installStubEasRunnerAsync } from './utils';

/** Where the stub `eas` records what it was asked to do, one JSON line per run, under the cwd. */
export const STUB_EAS_LOG_NAME = 'stub-eas-invocations.jsonl';

/** The shared stub script. Its environment knobs are documented at the top of the file. */
export const STUB_EAS_SCRIPT = path.resolve(__dirname, 'stubs', 'eas.js');

/** One recorded invocation of the stub `eas`. */
export interface StubEasInvocation {
  args: string[];
  cwd: string;
  /** `CI` as the CLI under test passed it on, or null when it did not set one. */
  ci: string | null;
}

/**
 * Put the stub `eas` on the project's `PATH`, behind a stub package runner.
 *
 * @param script a script to install instead of the shared one, for a test about a binary that is
 * not the EAS CLI at all. Given as source text; it is written to the same path.
 * @param names which runners to install. Both, when a test is about which one is chosen.
 * @returns the `.stub-bin` directory the shims went into, and the path of the installed script.
 */
export async function installStubEasAsync(
  projectRoot: string,
  {
    script,
    names,
    logFile,
  }: { script?: string; names?: ('npx' | 'bunx')[]; logFile?: string } = {}
): Promise<{ binDir: string; scriptPath: string }> {
  const binDir = path.join(projectRoot, '.stub-bin');
  await fs.promises.mkdir(binDir, { recursive: true });
  const scriptPath = path.join(binDir, 'eas-stub.js');
  if (script == null) {
    await fs.promises.copyFile(STUB_EAS_SCRIPT, scriptPath);
  } else {
    await fs.promises.writeFile(scriptPath, script);
  }
  await installStubEasRunnerAsync(binDir, scriptPath, { names, logFile });
  return { binDir, scriptPath };
}

/** Every invocation the stub `eas` recorded under `projectRoot`, in the order they happened. */
export function readStubEasInvocations(projectRoot: string): StubEasInvocation[] {
  const logPath = path.join(projectRoot, STUB_EAS_LOG_NAME);
  if (!fs.existsSync(logPath)) {
    return [];
  }
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StubEasInvocation);
}

/** The argv of every recorded stub `eas` invocation, in order. */
export function stubEasArgs(projectRoot: string): string[][] {
  return readStubEasInvocations(projectRoot).map((invocation) => invocation.args);
}

/** The first word of every recorded stub `eas` invocation — the verbs, in order. */
export function stubEasCommands(projectRoot: string): string[] {
  return stubEasArgs(projectRoot).map((args) => args[0]!);
}

/** Forget what the stub `eas` recorded so far, for a test that counts from here. */
export function resetStubEasInvocations(projectRoot: string): void {
  fs.rmSync(path.join(projectRoot, STUB_EAS_LOG_NAME), { force: true });
}

/**
 * Write the dotenv `eas-cli` manages, which is how a project names its EAS Simulator session.
 *
 * The shape is the real command's [observed — eas-cli 23.2 `simulator/env.ts`], token included,
 * because `simulator:exec` loads this file to reach the controller.
 */
export async function writeCloudSessionFileAsync(
  projectRoot: string,
  sessionId: string
): Promise<void> {
  await fs.promises.writeFile(
    path.join(projectRoot, '.env.eas-simulator'),
    `# managed by eas-cli\nAGENT_DEVICE_DAEMON_BASE_URL=https://stub-daemon.example\nAGENT_DEVICE_DAEMON_AUTH_TOKEN=stub-token\nEAS_SIMULATOR_SESSION_ID=${sessionId}\n`
  );
}
