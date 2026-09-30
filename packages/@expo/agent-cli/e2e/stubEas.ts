// The shared stub `eas`: how a test puts it on `PATH`, and how it reads what the CLI asked of it.
//
// @ref llp/0015-backend-selection-and-config.rfc.md §Resolving the EAS CLI — nothing under test
// resolves a file called `eas`; every EAS-backed command runs the package through `npx`/`bunx`, so
// what is installed is a stub *runner* that hands the argv to `stubs/eas.js`.
//
// The script is **copied** into the project's `.stub-bin` rather than referenced in place, so a
// test that needs a one-off answer can overwrite the copy without touching the shared file.
import fs from 'node:fs';
import os from 'node:os';
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
    linked = true,
  }: { linked?: boolean; script?: string; names?: ('npx' | 'bunx')[]; logFile?: string } = {}
): Promise<{ binDir: string; scriptPath: string }> {
  // A normal EAS fixture is linked; tests of first-run setup explicitly opt out.
  const appFile = path.join(projectRoot, 'app.json');
  if (linked && fs.existsSync(appFile)) {
    const app = JSON.parse(await fs.promises.readFile(appFile, 'utf8'));
    const config = app.expo ?? app;
    config.extra = {
      ...config.extra,
      eas: {
        ...config.extra?.eas,
        projectId: config.extra?.eas?.projectId ?? 'f52a76f7-9fc7-4b59-becd-6d84e9f129d7',
      },
    };
    await fs.promises.writeFile(appFile, JSON.stringify(app));
  }
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

/**
 * Point the device-claim registry of every CLI this file spawns at a directory of its own.
 *
 * Without it, each `dev --eas` of an e2e run writes an `eas` claim into the real `~/.expo` of the
 * machine. Call it once at the top of a file. Each test gets an empty registry.
 *
 * @ref llp/0028-one-device-per-agent.rfc.md §The registry
 */
export function isolateExpoHome(): void {
  let home: string | null = null;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-expo-home-'));
    process.env.__UNSAFE_EXPO_HOME_DIRECTORY = home;
  });
  afterEach(() => {
    delete process.env.__UNSAFE_EXPO_HOME_DIRECTORY;
    if (home) {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

/** One claim file of the isolated registry, as the CLI wrote it. */
export interface StubDeviceClaim {
  backend: string;
  platform: string;
  id: string;
  projectRoot: string;
  created: boolean;
}

function claimsDirectory(): string {
  return path.join(process.env.__UNSAFE_EXPO_HOME_DIRECTORY!, 'agent-cli', 'devices');
}

/** Every claim in the isolated registry, in file-name order. */
export function readDeviceClaims(): StubDeviceClaim[] {
  if (!fs.existsSync(claimsDirectory())) {
    return [];
  }
  return fs
    .readdirSync(claimsDirectory())
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(claimsDirectory(), name), 'utf8')));
}

/** Write the `eas` claim that a start from `projectRoot` would have left, without running one. */
export function writeEasClaimFile(
  projectRoot: string,
  { id, platform = 'ios' }: { id: string; platform?: 'ios' | 'android' }
): void {
  const now = new Date().toISOString();
  fs.mkdirSync(claimsDirectory(), { recursive: true });
  fs.writeFileSync(
    path.join(claimsDirectory(), `eas-${encodeURIComponent(id)}.json`),
    JSON.stringify({
      backend: 'eas',
      platform,
      id,
      projectRoot: fs.realpathSync(projectRoot),
      pid: process.pid,
      claimedAt: now,
      touchedAt: now,
      created: true,
    })
  );
}

/** Seed the service the stub `eas` answers for (STUB_SIM_STORE) with sessions nobody here started. */
export function seedStubSessions(
  storeDir: string,
  sessions: { id: string; platform?: string; status?: string }[]
): void {
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, 'stub-eas-sessions.json'),
    JSON.stringify(
      sessions.map(({ id, platform = 'IOS', status = 'IN_PROGRESS' }) => ({
        id,
        name: 'someone else',
        type: 'agent-device',
        status,
        platform,
        createdAt: '2026-09-30T12:00:00.000Z',
      }))
    )
  );
}
