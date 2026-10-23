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

import { unwrapGuardedExec } from '../src/device/cloudCommand';
import { digestForRoot } from '../src/deviceBinding/registry';
import { installStubEasRunnerAsync, linkFixtureToEasAsync } from './utils';

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
  executedSessionId?: string;
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
    linked = true,
  }: { linked?: boolean; script?: string; names?: ('npx' | 'bunx')[]; logFile?: string } = {}
): Promise<{ binDir: string; scriptPath: string }> {
  // A normal EAS fixture is linked; tests of first-run setup explicitly opt out.
  if (linked && fs.existsSync(path.join(projectRoot, 'app.json'))) {
    await linkFixtureToEasAsync(projectRoot);
  }
  const binDir = path.join(projectRoot, '.stub-bin');
  await fs.promises.mkdir(binDir, { recursive: true });
  const scriptPath = path.join(binDir, 'eas-stub.js');
  if (script == null) {
    await fs.promises.copyFile(STUB_EAS_SCRIPT, scriptPath);
  } else {
    await fs.promises.writeFile(scriptPath, script);
  }
  await installStubEasRunnerAsync(binDir, scriptPath, {
    names,
    logFile,
    agentDeviceController: true,
  });
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

/** Logical EAS commands and controller verbs; raw guard invocations remain available above. */
export function stubEasArgs(projectRoot: string): string[][] {
  // The guard launch is transport detail. Its controller's invocation is the operation tests mean.
  return readStubEasInvocations(projectRoot)
    .filter(({ args }) => args[0] === '__controller' || !unwrapGuardedExec(args))
    .map(({ args }) => {
      if (args[0] === '__controller') {
        return ['simulator:exec', 'npx', 'agent-device@latest', ...args.slice(1)];
      }
      return args;
    });
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
 * The text is the real command's [observed — eas-cli 25.0.0 `simulator/env.js`
 * `writeSimulatorEnvAsync`, `commands/simulator/index.js` 354-358], token included, because
 * `simulator:exec` loads this file to reach the controller.
 */
export async function writeCloudSessionFileAsync(
  projectRoot: string,
  sessionId: string
): Promise<void> {
  await fs.promises.writeFile(
    path.join(projectRoot, '.env.eas-simulator'),
    '# Do not commit this file.\n# Do not modify these values manually. They are managed by eas-cli.\n# It holds configuration only for the current simulator session.\n\n' +
      `AGENT_DEVICE_DAEMON_BASE_URL='https://stub-daemon.example'\nAGENT_DEVICE_DAEMON_AUTH_TOKEN='stub-token'\nEAS_SIMULATOR_SESSION_ID='${sessionId}'\n`
  );
}

/** The cloud binding file of `projectRoot` on `platform` under `expoHome`. */
export function cloudBindingFile(expoHome: string, projectRoot: string, platform = 'ios'): string {
  return path.join(
    expoHome,
    'agent-cli',
    'bindings',
    `${digestForRoot(projectRoot)}-${platform}-cloud.json`
  );
}

/** Bind an EAS Simulator session to `projectRoot`, as `acquireCloudBindingAsync` writes it. */
export async function writeCloudBindingAsync(
  expoHome: string,
  projectRoot: string,
  {
    id,
    platform = 'ios',
    origin = 'started',
    expiresAt = new Date(Date.now() + 3600000).toISOString(),
  }: { id: string; platform?: 'ios' | 'android'; origin?: 'started' | 'dotenv'; expiresAt?: string }
): Promise<void> {
  const file = cloudBindingFile(expoHome, projectRoot, platform);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(
    file,
    JSON.stringify({
      version: 1,
      projectRoot,
      device: { backend: 'cloud', platform, id, origin },
      boundAt: new Date().toISOString(),
      expiresAt,
    })
  );
}
