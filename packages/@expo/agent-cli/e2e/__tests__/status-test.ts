// @ref llp/0004-smart-start-and-project-state.rfc.md §Status
//
// `@expo/agent-cli status` is the read-only overview: it prints where the project is and what would
// happen next, and always exits 0. These tests run it through the CLI it is published as, against
// the fixture matrix in `e2e/fixtures/README.md`.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { WebSocketServer } from 'ws';

import {
  installStubEasAsync as installSharedStubEasAsync,
  STUB_EAS_LOG_NAME,
  stubEasCommands,
  writeCloudSessionFileAsync,
} from '../stubEas';
import {
  breakXcodeSelectAsync,
  clearStubFingerprintInvocations,
  documentedJsonKeys,
  executeAgentCliAsync,
  holdDevLockAsync,
  installStubBinAsync,
  installStubEasRunnerAsync,
  installStubFingerprintAsync,
  pathEnvVars,
  readStubExpoInvocations,
  readStubFingerprintInvocations,
  linkFixtureToEasAsync,
  setupFixtureAsync,
  startStubDevServerAsync,
  writeAgentSelectionAsync,
} from '../utils';

/** The shape `status --json` prints, per `src/status/types.ts`. */
type StatusReport = {
  project: {
    root: string;
    name: string | null;
    sdkVersion: string | null;
    native: 'bare' | 'cng';
    nativeDirs: { ios: boolean; android: boolean };
    usesDevClient: boolean;
    hasWeb: boolean;
  } | null;
  expoGo: { compatible: boolean; reasonCount: number } | null;
  freshness: {
    hash: string | null;
    error?: string;
    /** What the impact headline was measured against: the project's record, or `--build <id>`. */
    comparison: {
      kind: 'last-build' | 'eas-build';
      label: string;
      buildId: string | null;
      platform: 'ios' | 'android' | null;
    };
    /** Where `hash` came from, per llp/0023 §The report says where the answer came from. */
    hashSource: {
      source: 'computed' | 'cache' | null;
      revalidatedAgainst: number | null;
      keyKind: string | null;
      computedAt: string | null;
      ageMs: number | null;
      caveats: string[];
    };
    platforms: {
      platform: 'ios' | 'android';
      /** `local` for this machine's own record, `eas` for what EAS has (llp/0021). */
      backend: 'local' | 'eas';
      state: 'fresh' | 'stale' | 'unknown';
      detail: string;
      recordedHash: string | null;
      buildId: string | null;
      buildProfile: string | null;
      impact: {
        class: 'js-only' | 'dev-client-compatible' | 'needs-native-build' | null;
        fingerprintChanged: boolean | null;
        reason: string;
        changedCount: number | null;
        changedSources: { op: string; path: string | null; kind: string }[] | null;
      } | null;
    }[];
    /** How many files changed, by kind. Null when no file-level view was available (llp/0011). */
    changedFiles: { total: number; native: number; js: number; config: number } | null;
    ota: {
      safe: boolean | null;
      runtimeVersion: {
        policy: string | null;
        literal: string | null;
        source: string | null;
        /** Set when the evaluated config came out of `.expo` rather than a subprocess (llp/0023). */
        cache?: {
          computedAt: string;
          ageMs: number;
          revalidatedAgainst: number;
          keyKind: string;
        } | null;
      };
      why: string;
    } | null;
  } | null;
  devServer: {
    url: string;
    running: boolean;
    appsConnected: number;
    source: 'flag' | 'lock' | 'log' | 'default' | 'scan';
    ready: boolean | null;
    projectRootMatched: boolean | null;
    /** The URLs that open the app on a device, encoded the way the launcher parses them (K7c). */
    openUrls: { target: string; label: string; url: string }[];
    reason?: string;
  } | null;
  builds: {
    askedEas: boolean;
    platforms: {
      platform: 'ios' | 'android';
      state: 'found' | 'none' | 'unknown';
      fingerprintHash: string | null;
      buildId: string | null;
      createdAt: string | null;
      buildProfile: string | null;
      buildUrl: string | null;
      source: 'cache' | 'eas' | null;
      /** When EAS was asked, and how old a remembered `none` is (llp/0011 §The build-cache lookup). */
      checkedAt: string | null;
      ageMs: number | null;
      reason: string | null;
    }[];
  } | null;
  device: {
    state: 'present' | 'absent' | 'unknown';
    platform: string | null;
    deviceId: string | null;
    name: string | null;
    devices: { platform: string; deviceId: string; name: string | null }[];
    reason: string | null;
  } | null;
  skills: { agentIds: string[] | null; discovered: number; linked: number } | null;
  auth: {
    loggedIn: boolean | null;
    user: string | null;
    source: 'eas whoami' | 'EXPO_TOKEN' | null;
  } | null;
  next: {
    command: string;
    rule: string;
    target: string;
    steps: { argv: string[] }[];
    why: string | null;
    buildLocation: {
      runsOn: 'local' | 'eas';
      platform: 'ios' | 'android';
      requirement: string;
      selection: { source: string; because: string; why: string; doomed: boolean } | null;
    } | null;
  } | null;
  /** The raw project probe, per `src/project/types.ts`. Covered on its own in `probe-test.ts`. */
  probe: {
    projectRoot: string;
    sdkVersion: string | null;
    nativeDirs: { ios: boolean; android: boolean };
    usesDevClient: boolean;
    hasWeb: boolean;
    expoGo: {
      compatible: boolean;
      reasons: { kind: string; packageName?: string; detail: string }[];
    };
    fingerprint: { hash: string | null; error?: string };
  } | null;
  assertion: {
    asserted: string;
    actual: string | null;
    ok: boolean;
    exitCode: number;
    reason: string;
  } | null;
  errors: Record<string, string>;
  followups: { id: string; command: string; why: string }[];
};

/** The hash the stub `@expo/fingerprint` bin of `dev-client-fresh-app` prints. */
const FIXTURE_FINGERPRINT_HASH = '0f1e2d3c4b5a69788796a5b4c3d2e1f001234567';

/** One debugger target, the shape `expo start` reports for a connected app. */
const CDP_TARGET = {
  id: '1',
  appId: 'host.exp.Exponent',
  title: 'Expo Go',
  type: 'native',
  description: '',
  devtoolsFrontendUrl: '/devtools',
  webSocketDebuggerUrl: 'ws://127.0.0.1/inspector/debug?device=1&page=1',
};

/** Copy a fixture and install both stub bins the status sections may reach for. */
async function setupAsync(fixtureName: string): Promise<string> {
  const projectRoot = await setupFixtureAsync(fixtureName);
  await installStubFingerprintAsync(projectRoot);
  return projectRoot;
}

/** A dev server double that answers the debugger target list, and the port it listens on. */
async function startDevServerDoubleAsync(
  targets: unknown[],
  /**
   * Whether the debugger sockets the targets point at accept a connection.
   *
   * `live` is a connected app; `stale` is a page the dev server still lists with nothing behind it,
   * which is what an app that was force-stopped leaves and what `status` used to count as an app
   * (llp/0005-runtime-loop-tools.rfc.md §Android, F56).
   */
  inspector: 'live' | 'stale' = 'live'
): Promise<{ server: Server; url: string }> {
  let port = 0;
  const server = createServer((request, response) => {
    if (request.url === '/json/list') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      // On this double's own port, the way a real dev server publishes its debugger URLs: a
      // fixture URL with no port is one nothing can connect to.
      response.end(
        JSON.stringify(
          targets.map((target) => ({
            ...(target as Record<string, unknown>),
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/inspector/debug?device=1&page=1`,
          }))
        )
      );
      return;
    }
    response.writeHead(404).end();
  });

  const inspectorServer = inspector === 'live' ? new WebSocketServer({ noServer: true }) : null;
  server.on('upgrade', (request, socket, head) => {
    if (inspectorServer && (request.url ?? '').split('?')[0] === '/inspector/debug') {
      inspectorServer.handleUpgrade(request, socket as never, head, () => {});
      return;
    }
    socket.destroy();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}` };
}

/** A URL nothing listens on: a port that was bound, then released. */
async function getUnusedDevServerUrlAsync(): Promise<string> {
  const { server, url } = await startDevServerDoubleAsync([]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return url;
}

/**
 * Run `status --json` in a prepared project and parse the report.
 *
 * Every call points the dev-server probe at a port nothing listens on, so the report never
 * depends on a Metro instance the developer happens to be running.
 */
async function reportInAsync(
  projectRoot: string,
  args: string[] = [],
  env: Record<string, string> = {}
): Promise<StatusReport> {
  const result = await executeAgentCliAsync(
    projectRoot,
    ['status', '--json', '--dev-server-url', await getUnusedDevServerUrlAsync(), ...args],
    { env }
  );

  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout);
}

/** Run `status --json` in a fixture and parse the report. */
async function reportAsync(fixtureName: string): Promise<StatusReport> {
  return reportInAsync(await setupAsync(fixtureName));
}

/**
 * Point the copied `go-app` at the SDK major this CLI captured an Expo Go dump for.
 *
 * Fixtures ship `expo@54.0.0`, and a miss falls back to the short `bundledNativeModules.json`.
 * These tests are about the dump, so the installed `expo` version has to match it.
 */
const DUMP_SDK_VERSION = '57.0.0';

async function useCapturedGoDumpAsync(projectRoot: string): Promise<void> {
  const expoPkgPath = path.join(projectRoot, 'node_modules', 'expo', 'package.json');
  const expoPkg = JSON.parse(await fs.promises.readFile(expoPkgPath, 'utf8'));
  expoPkg.version = DUMP_SDK_VERSION;
  await fs.promises.writeFile(expoPkgPath, JSON.stringify(expoPkg, null, 2) + '\n');

  const manifestPath = path.join(projectRoot, 'package.json');
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  manifest.dependencies.expo = DUMP_SDK_VERSION;
  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

/** Declare and plant a stub native module the Expo Go check will inspect. */
async function addNativeModuleAsync(projectRoot: string, packageName: string): Promise<void> {
  const manifestPath = path.join(projectRoot, 'package.json');
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  manifest.dependencies[packageName] = '1.0.0';
  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const packageRoot = path.join(projectRoot, 'node_modules', ...packageName.split('/'));
  await fs.promises.mkdir(path.join(packageRoot, 'ios'), { recursive: true });
  await fs.promises.writeFile(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: packageName, version: '1.0.0' })
  );
  await fs.promises.writeFile(path.join(packageRoot, 'expo-module.config.json'), '{}');
  await fs.promises.writeFile(path.join(packageRoot, 'index.js'), '');
  await fs.promises.writeFile(path.join(packageRoot, 'ios', 'Module.swift'), '');
}

async function goAppOnDumpSdkAsync(): Promise<string> {
  const projectRoot = await setupAsync('go-app');
  await useCapturedGoDumpAsync(projectRoot);
  return projectRoot;
}

/** Write the native projects `expo prebuild` generates, plus the template gitignore that covers them. */
async function writePrebuildOutputAsync(projectRoot: string): Promise<void> {
  await fs.promises.writeFile(path.join(projectRoot, '.gitignore'), '/ios\n/android\n');
  await fs.promises.mkdir(path.join(projectRoot, 'ios'), { recursive: true });
  await fs.promises.mkdir(path.join(projectRoot, 'android'), { recursive: true });
  await fs.promises.writeFile(path.join(projectRoot, 'ios', 'Podfile'), '');
  await fs.promises.writeFile(path.join(projectRoot, 'android', 'build.gradle'), '');
}

function git(projectRoot: string, args: string[]): void {
  const result = spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.error) {
    throw new Error(`git ${args.join(' ')} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}

async function initGitRepoAsync(projectRoot: string): Promise<void> {
  git(projectRoot, ['init', '-q']);
}

/**
 * Declare `eas-cli` in the project, which is what makes the EAS CLI answer at all.
 *
 * @ref llp/0015-backend-selection-and-config.rfc.md §Resolving the EAS CLI
 * The EAS CLI is reached through a package runner (wave 18), and the auth preflight declines to
 * spend a package install on reading a local session file — so in a project that declares nothing,
 * `status` asks the project's own `expo whoami` instead. A test whose subject is the *EAS* answer
 * has to be a project that pins the CLI, which is also the shape where that spawn is cheap.
 */
async function pinEasCliAsync(projectRoot: string): Promise<void> {
  const manifestPath = path.join(projectRoot, 'package.json');
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  manifest.devDependencies = { ...manifest.devDependencies, 'eas-cli': '^22.0.0' };
  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

/**
 * Install an `eas` bin that answers `whoami`, on the `PATH` the wrapper searches.
 *
 * The auth section runs a real subprocess, so without a stub the report would say whatever the
 * machine running the suite happens to be signed in as.
 *
 * @param user the account it names, or null for a CLI that refuses because nobody is signed in
 */
async function installStubEasAsync(
  projectRoot: string,
  { user }: { user: string | null }
): Promise<void> {
  const binDir = path.join(projectRoot, '.stub-bin');
  await fs.promises.mkdir(binDir, { recursive: true });
  const stubScript = path.join(binDir, 'eas-stub.js');
  await fs.promises.writeFile(
    stubScript,
    user
      ? `process.stdout.write(${JSON.stringify(`${user}\n`)});\n`
      : `process.stderr.write('Not logged in\\n');\nprocess.exit(1);\n`
  );
  await installStubEasRunnerAsync(binDir, stubScript);
  await pinEasCliAsync(projectRoot);
}

describe('@expo/agent-cli status', () => {
  it('prints usage with `status --help`', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const result = await executeAgentCliAsync(projectRoot, ['status', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.all).toContain('--json');
    expect(result.all).toContain('--dev-server-url');
  });

  it('lists the command in the top level help', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const result = await executeAgentCliAsync(projectRoot, ['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.all).toContain('status');
  });

  describe('go-app — an Expo Go compatible CNG project', () => {
    it('prints one line per section', async () => {
      const projectRoot = await setupAsync('go-app');
      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--dev-server-url',
        await getUnusedDevServerUrlAsync(),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('project');
      expect(result.stdout).toContain('go-app');
      expect(result.stdout).toContain('SDK 54.0.0');
      expect(result.stdout).toContain('CNG');
      expect(result.stdout).toContain('expo go');
      expect(result.stdout).toContain('compatible');
      expect(result.stdout).toContain('freshness');
      expect(result.stdout).toContain('dev server');
      expect(result.stdout).toContain('not running');
      expect(result.stdout).toContain('device');
      expect(result.stdout).toContain('next');
      expect(result.stdout).toContain('expo-go');
    });

    it('reports every section in the JSON report', async () => {
      const report = await reportAsync('go-app');

      expect(Object.keys(report)).toEqual([
        'project',
        'expoGo',
        'freshness',
        'installed',
        'builds',
        'devServer',
        'device',
        'skills',
        'auth',
        'next',
        'assertion',
        'probe',
        'errors',
        'followups',
      ]);
      expect(report.errors).toEqual({});
      expect(report.project).toMatchObject({
        name: 'go-app',
        sdkVersion: '54.0.0',
        native: 'cng',
        usesDevClient: false,
        hasWeb: true,
      });
      expect(report.expoGo).toEqual({ compatible: true, reasonCount: 0 });
      expect(report.next?.rule).toBe('expo-go');
      expect(report.next?.steps[0]!.argv).toEqual(['expo', 'start', '--go']);
    });

    it('reports an unknown freshness when the project has no fingerprint tool', async () => {
      const report = await reportAsync('go-app');

      // No `fingerprint` bin is installed for this fixture, so nothing can be compared.
      expect(report.freshness?.hash).toBeNull();
      // Four entries: backend × platform (llp/0021 §The rules). The two local axes
      // have no fingerprint to compare; the two EAS axes were never asked.
      expect(
        report.freshness?.platforms.map(
          (platform) => `${platform.platform} ${platform.backend} ${platform.state}`
        )
      ).toEqual([
        'ios local unknown',
        'ios eas unknown',
        'android local unknown',
        'android eas unknown',
      ]);
    });

    // @ref llp/0010-agent-conventions.rfc.md §Needs-human protocol
    // Who the CLI family acts as, asked with a stub `eas` so the answer is the fixture's and not
    // the machine's.
    describe('the auth section', () => {
      it('reports the account the EAS CLI named', async () => {
        const projectRoot = await setupAsync('go-app');
        await installStubEasAsync(projectRoot, { user: 'e2e-user' });

        const report = await reportInAsync(projectRoot);

        expect(report.auth).toEqual({
          loggedIn: true,
          user: 'e2e-user',
          source: 'eas whoami',
        });
      });

      it('reports a signed-out machine, and still exits 0', async () => {
        const projectRoot = await setupAsync('go-app');
        await installStubEasAsync(projectRoot, { user: null });

        const result = await executeAgentCliAsync(projectRoot, [
          'status',
          '--dev-server-url',
          await getUnusedDevServerUrlAsync(),
        ]);

        // Status is information: not being signed in is a fact it reports, not a failure.
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('auth');
        expect(result.stdout).toContain('not signed in');
      });
    });

    it('reports that no agent is selected', async () => {
      const report = await reportAsync('go-app');

      expect(report.skills).toEqual({ agentIds: null, discovered: 0, linked: 0 });
    });

    it('reports the agents a previous skills run selected', async () => {
      const projectRoot = await setupAsync('go-app');
      await writeAgentSelectionAsync(projectRoot, ['claude-code']);

      const report = await reportInAsync(projectRoot);

      expect(report.skills?.agentIds).toEqual(['claude-code']);
    });

    it('starts nothing and exits 0', async () => {
      const projectRoot = await setupAsync('go-app');
      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--dev-server-url',
        await getUnusedDevServerUrlAsync(),
      ]);

      expect(result.exitCode).toBe(0);
      // Status is read-only. The one `expo` it runs is `whoami`, and only when the EAS CLI could
      // not answer who this machine is: both CLIs read the same session file, and a report that
      // said "nothing could answer" while `@expo/agent-cli whoami` printed the name was the finding
      // (F65). Nothing else is invoked, and nothing is started.
      expect(readStubExpoInvocations(projectRoot).map((invocation) => invocation.args)).toEqual([
        ['whoami'],
      ]);
    });

    it('emits the status event for a driving agent', async () => {
      const projectRoot = await setupAsync('go-app');
      const eventsFile = path.join(projectRoot, 'events.jsonl');
      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        { env: { LOG_EVENTS: eventsFile } }
      );

      expect(result.exitCode).toBe(0);
      const events = fs
        .readFileSync(eventsFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      // `2g` names the event in the `_e` field of every JSONL line.
      const status = events.find((entry) => entry._e === 'cli:status');
      expect(status).toMatchObject({ rule: 'expo-go', devServerRunning: false });
    });

    // @ref llp/0009-smart-followups.rfc.md §Examples per command — status keeps its own `next`
    // line, so the follow-ups only reach a driving agent through JSON and the event stream.
    it('keeps the follow-ups out of the text report', async () => {
      const projectRoot = await setupAsync('go-app');
      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--dev-server-url',
        await getUnusedDevServerUrlAsync(),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('Suggested next:');
    });

    it('reports an empty follow-up list with --no-followups, keeping the key set', async () => {
      const projectRoot = await setupAsync('go-app');
      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--json',
        '--no-followups',
        '--dev-server-url',
        await getUnusedDevServerUrlAsync(),
      ]);

      expect(result.exitCode).toBe(0);
      const report: StatusReport = JSON.parse(result.stdout);
      expect(report.followups).toEqual([]);
      expect(Object.keys(report)).toContain('followups');
    });

    // @ref llp/0006-agent-native-cli-surface.rfc.md §Output contract — **F144.** The two lists were
    // both here and disagreed: the e2e above pinned `followups` in the payload, and the help block's
    // `keys` line did not name it, so a caller who read the documentation branched on a key set the
    // command does not have. Compared at the process boundary, because that is where the promise is
    // made — a caller reads `--help` and then reads the object.
    it('documents exactly the keys it emits', async () => {
      const projectRoot = await setupFixtureAsync('go-app');
      const devServerUrl = await getUnusedDevServerUrlAsync();

      const help = await executeAgentCliAsync(projectRoot, ['status', '--help']);
      const report = await executeAgentCliAsync(projectRoot, [
        'status',
        '--json',
        '--dev-server-url',
        devServerUrl,
      ]);

      expect(documentedJsonKeys(help.stdout).sort()).toEqual(
        Object.keys(JSON.parse(report.stdout)).sort()
      );
    });
  });

  describe('Expo Go compatibility of a new project', () => {
    it('should report a new go-app as compatible', async () => {
      const report = await reportInAsync(await goAppOnDumpSdkAsync());

      expect(report.expoGo).toEqual({ compatible: true, reasonCount: 0 });
      expect(report.probe?.expoGo.reasons).toEqual([]);
    });

    it('should stay compatible after adding expo-sqlite', async () => {
      const projectRoot = await goAppOnDumpSdkAsync();
      await addNativeModuleAsync(projectRoot, 'expo-sqlite');

      const report = await reportInAsync(projectRoot);

      expect(report.expoGo).toEqual({ compatible: true, reasonCount: 0 });
      expect(report.probe?.expoGo.reasons).toEqual([]);
    });

    it('should stay compatible after adding @shopify/react-native-skia', async () => {
      const projectRoot = await goAppOnDumpSdkAsync();
      await addNativeModuleAsync(projectRoot, 'expo-sqlite');
      await addNativeModuleAsync(projectRoot, '@shopify/react-native-skia');

      const report = await reportInAsync(projectRoot);

      expect(report.expoGo).toEqual({ compatible: true, reasonCount: 0 });
      expect(report.probe?.expoGo.reasons).toEqual([]);
    });

    it('should become incompatible after adding expo-observe', async () => {
      const projectRoot = await goAppOnDumpSdkAsync();
      await addNativeModuleAsync(projectRoot, 'expo-sqlite');
      await addNativeModuleAsync(projectRoot, '@shopify/react-native-skia');
      await addNativeModuleAsync(projectRoot, 'expo-observe');

      const report = await reportInAsync(projectRoot);

      expect(report.expoGo?.compatible).toBe(false);
      expect(report.expoGo!.reasonCount).toBeGreaterThan(0);
      expect(report.probe?.expoGo.reasons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'unbundled-native-module',
            packageName: 'expo-observe',
          }),
        ])
      );
      const packages = (report.probe?.expoGo.reasons ?? []).map((reason) => reason.packageName);
      expect(packages).not.toContain('expo-sqlite');
      expect(packages).not.toContain('@shopify/react-native-skia');
    });
  });

  describe('Expo Go compatibility after prebuild', () => {
    it('should stay CNG and compatible when ios/ and android/ are gitignored', async () => {
      const projectRoot = await goAppOnDumpSdkAsync();
      await writePrebuildOutputAsync(projectRoot);

      const report = await reportInAsync(projectRoot);

      expect(report.project?.native).toBe('cng');
      expect(report.project?.nativeDirs).toEqual({ ios: false, android: false });
      expect(report.expoGo).toEqual({ compatible: true, reasonCount: 0 });
      expect(report.probe?.expoGo.reasons).toEqual([]);
    });

    it('should stay CNG when git check-ignore covers the prebuild output', async () => {
      const projectRoot = await goAppOnDumpSdkAsync();
      await writePrebuildOutputAsync(projectRoot);
      await initGitRepoAsync(projectRoot);

      const report = await reportInAsync(projectRoot);

      expect(report.project?.native).toBe('cng');
      expect(report.project?.nativeDirs).toEqual({ ios: false, android: false });
      expect(report.expoGo).toEqual({ compatible: true, reasonCount: 0 });
    });

    it('should report custom-native-code when prebuild output is tracked', async () => {
      const projectRoot = await goAppOnDumpSdkAsync();
      await writePrebuildOutputAsync(projectRoot);
      await initGitRepoAsync(projectRoot);
      git(projectRoot, ['add', '-f', '--', 'ios', 'android']);

      const report = await reportInAsync(projectRoot);

      expect(report.project?.native).toBe('bare');
      expect(report.project?.nativeDirs).toEqual({ ios: true, android: true });
      expect(report.expoGo?.compatible).toBe(false);
      expect(report.probe?.expoGo.reasons).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'custom-native-code' })])
      );
    });

    it('should report a local module under modules/ as unbundled', async () => {
      const projectRoot = await goAppOnDumpSdkAsync();
      const moduleRoot = path.join(projectRoot, 'modules', 'local-native');
      await fs.promises.mkdir(path.join(moduleRoot, 'ios'), { recursive: true });
      await fs.promises.writeFile(
        path.join(moduleRoot, 'package.json'),
        JSON.stringify({ name: 'local-native', version: '1.0.0' })
      );
      await fs.promises.writeFile(path.join(moduleRoot, 'expo-module.config.json'), '{}');
      await fs.promises.writeFile(path.join(moduleRoot, 'ios', 'Module.swift'), '');

      const report = await reportInAsync(projectRoot);

      expect(report.expoGo?.compatible).toBe(false);
      expect(report.probe?.expoGo.reasons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'unbundled-native-module',
            packageName: 'local-native',
          }),
        ])
      );
    });
  });

  describe('dev-client-fresh-app — a recorded build that still matches', () => {
    it('reports the platform of the recorded build as fresh', async () => {
      const report = await reportAsync('dev-client-fresh-app');

      expect(report.freshness?.hash).toBe(FIXTURE_FINGERPRINT_HASH);
      const ios = report.freshness?.platforms.find(
        (platform) => platform.platform === 'ios' && platform.backend === 'local'
      );
      expect(ios).toMatchObject({ state: 'fresh', recordedHash: FIXTURE_FINGERPRINT_HASH });
    });

    it('reports the Expo Go blocker and the dev client dependency', async () => {
      const report = await reportAsync('dev-client-fresh-app');

      expect(report.project?.usesDevClient).toBe(true);
      expect(report.expoGo?.compatible).toBe(false);
      expect(report.expoGo!.reasonCount).toBeGreaterThan(0);
    });

    it('reports a native fingerprint change as stale', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--json', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        { env: { STUB_FINGERPRINT_HASH: 'aaaabbbbccccddddeeeeffff0000111122223333' } }
      );

      expect(result.exitCode).toBe(0);
      const report: StatusReport = JSON.parse(result.stdout);
      // The local axis of both platforms. The EAS axis was not asked on this run and says so.
      expect(
        report.freshness?.platforms
          .filter((platform) => platform.backend === 'local')
          .every((platform) => platform.state === 'stale')
      ).toBe(true);
    });

    it('reports a failing fingerprint tool as an unknown freshness, still exiting 0', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--json', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        { env: { STUB_FINGERPRINT_EXIT_CODE: '1' } }
      );

      // A broken tool is a section note, never a failed command.
      expect(result.exitCode).toBe(0);
      const report: StatusReport = JSON.parse(result.stdout);
      expect(report.freshness?.hash).toBeNull();
      expect(report.freshness?.error).toBeTruthy();
      expect(report.errors).toEqual({});
    });
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Status
  //
  // What a change costs, on every run. The two things worth asserting end to end are the answer
  // and the *cost*: the headline must arrive without `expo config` or `eas` being spawned at all,
  // which is the whole reason it can be always-on.
  describe('the impact headline', () => {
    /** One autolinked native module, in the shape the sourcer emits. */
    const NATIVE_MODULE = {
      type: 'dir',
      filePath: 'node_modules/react-native-mmkv',
      reasons: ['rncoreAutolinkingIos'],
      hash: 'aabb',
    };
    const APP_CONFIG = {
      type: 'file',
      filePath: 'app.json',
      reasons: ['expoConfig'],
      hash: 'ccdd',
    };

    /**
     * A `fingerprint` bin whose sources the test chooses.
     *
     * The fixture's own stub always prints an empty list, which can only ever produce an empty
     * diff. STUB_FP_SOURCES is what lets these tests move the native surface.
     */
    const STUB_FINGERPRINT = `#!/usr/bin/env node
'use strict';
const hash = process.env.STUB_FINGERPRINT_HASH || ${JSON.stringify(FIXTURE_FINGERPRINT_HASH)};
const sources = JSON.parse(process.env.STUB_FP_SOURCES || '[]');
process.stdout.write(JSON.stringify({ hash, sources }) + '\\n');
`;

    /** Copy the fixture, install the steerable fingerprint stub, and write the v2 build record. */
    async function setupImpactAsync(recorded: unknown): Promise<string> {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      const binDir = path.join(projectRoot, '.stub-bin');
      await fs.promises.mkdir(binDir, { recursive: true });
      const stub = path.join(binDir, 'fingerprint-sources-stub.js');
      await fs.promises.writeFile(stub, STUB_FINGERPRINT);
      for (const dir of [binDir, path.join(projectRoot, 'node_modules', '.bin')]) {
        await installStubBinAsync(dir, 'fingerprint', stub);
      }
      await fs.promises.writeFile(
        path.join(projectRoot, '.expo', 'agent-cli-last-build.json'),
        JSON.stringify(recorded)
      );
      return projectRoot;
    }

    /** The v2 record: the whole fingerprint, which is what makes a diff possible. */
    function v2Record(sources: unknown[]) {
      return {
        ios: { hash: FIXTURE_FINGERPRINT_HASH, sources },
        android: { hash: FIXTURE_FINGERPRINT_HASH, sources },
      };
    }

    function iosImpact(report: StatusReport) {
      return report.freshness!.platforms.find(
        (platform) => platform.platform === 'ios' && platform.backend === 'local'
      )!.impact;
    }

    it('classifies an added native module without spawning anything', async () => {
      const projectRoot = await setupImpactAsync(v2Record([APP_CONFIG]));

      const report = await reportInAsync(projectRoot, [], {
        STUB_FINGERPRINT_HASH: 'ffff1111ffff1111ffff1111ffff1111ffff1111',
        STUB_FP_SOURCES: JSON.stringify([APP_CONFIG, NATIVE_MODULE]),
      });

      expect(iosImpact(report)).toMatchObject({
        class: 'needs-native-build',
        fingerprintChanged: true,
        changedCount: 1,
      });
      expect(iosImpact(report)!.reason).toContain('autolinked native modules changed');
      // The detail is the paid tier's; the headline carries the count and nothing else.
      // The per-source list rides along on every run; it is the diff the headline was read from.
      expect(iosImpact(report)!.changedSources).toEqual([
        expect.objectContaining({ op: 'added', kind: 'native-module' }),
      ]);
      // No `expo config`, because the OTA verdict is the paid tier's too.
      expect(
        readStubExpoInvocations(projectRoot).some((invocation) => invocation.args[0] === 'config')
      ).toBe(false);
    });

    it('classifies an unmoved native surface as js-only', async () => {
      const projectRoot = await setupImpactAsync(v2Record([APP_CONFIG]));

      const report = await reportInAsync(projectRoot, [], {
        STUB_FP_SOURCES: JSON.stringify([APP_CONFIG]),
      });

      expect(iosImpact(report)).toMatchObject({
        class: 'js-only',
        fingerprintChanged: false,
        changedCount: 0,
      });
    });

    it('prints the class and the sentence on an impact line', async () => {
      const projectRoot = await setupImpactAsync(v2Record([APP_CONFIG]));
      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        {
          env: {
            STUB_FINGERPRINT_HASH: 'ffff1111ffff1111ffff1111ffff1111ffff1111',
            STUB_FP_SOURCES: JSON.stringify([APP_CONFIG, NATIVE_MODULE]),
          },
        }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('impact');
      expect(result.stdout).toContain('needs-native-build');
      // Both platforms recorded the same fingerprint, so they agree and the line is printed once.
      expect(result.stdout).toContain('ios, android: needs-native-build');
    });

    // The v1 record is a bare hash string. It can say the surface moved and not what moved, and
    // `status` refuses to name a class it did not establish. See llp/0011 §The classifier reads reasons
    // classifier for why `@expo/agent-cli impact` answers differently for the same project.
    it('refuses to name a class for a record that stored only a hash, and still exits 0', async () => {
      const projectRoot = await setupImpactAsync({ ios: FIXTURE_FINGERPRINT_HASH });
      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        { env: { STUB_FINGERPRINT_HASH: 'ffff1111ffff1111ffff1111ffff1111ffff1111' } }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('impact');

      const report = await reportInAsync(projectRoot, [], {
        STUB_FINGERPRINT_HASH: 'ffff1111ffff1111ffff1111ffff1111ffff1111',
      });
      expect(iosImpact(report)).toMatchObject({ class: null, fingerprintChanged: true });
      expect(iosImpact(report)!.reason).toContain('stored only a hash');
    });

    it('says nothing about impact when there is no fingerprint at all', async () => {
      const report = await reportAsync('go-app');

      expect(report.freshness!.platforms.every((platform) => platform.impact == null)).toBe(true);
    });
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Status
  describe('the change detail: sources, files, and the OTA verdict', () => {
    const NATIVE_MODULE = {
      type: 'dir',
      filePath: 'node_modules/react-native-mmkv',
      reasons: ['rncoreAutolinkingIos'],
      hash: 'aabb',
    };

    const STUB_FINGERPRINT = `#!/usr/bin/env node
'use strict';
process.stdout.write(JSON.stringify({
  hash: process.env.STUB_FINGERPRINT_HASH || ${JSON.stringify(FIXTURE_FINGERPRINT_HASH)},
  sources: JSON.parse(process.env.STUB_FP_SOURCES || '[]'),
}) + '\\n');
`;

    /**
     * A project with a native change since its recorded build, and a `runtimeVersion` to judge it by.
     *
     * `static` writes the runtimeVersion into `app.json`, which `status` reads as a file. `dynamic`
     * adds an `app.config.js` beside it and hands the runtimeVersion to the stub `expo config`
     * instead, which is the one path that spawns (`src/project/evaluatedAppConfig.ts`).
     */
    async function setupExplainAsync(
      runtimeVersion: unknown,
      { config = 'static' }: { config?: 'static' | 'dynamic' } = {}
    ): Promise<{
      projectRoot: string;
      env: Record<string, string>;
    }> {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      const binDir = path.join(projectRoot, '.stub-bin');
      await fs.promises.mkdir(binDir, { recursive: true });
      const stub = path.join(binDir, 'fingerprint-explain-stub.js');
      await fs.promises.writeFile(stub, STUB_FINGERPRINT);
      for (const dir of [binDir, path.join(projectRoot, 'node_modules', '.bin')]) {
        await installStubBinAsync(dir, 'fingerprint', stub);
      }
      await fs.promises.writeFile(
        path.join(projectRoot, '.expo', 'agent-cli-last-build.json'),
        JSON.stringify({ ios: { hash: FIXTURE_FINGERPRINT_HASH, sources: [] } })
      );

      if (config === 'static') {
        const configPath = path.join(projectRoot, 'app.json');
        const app = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
        app.expo.runtimeVersion = runtimeVersion;
        await fs.promises.writeFile(configPath, JSON.stringify(app, null, 2) + '\n');
      } else {
        await fs.promises.writeFile(
          path.join(projectRoot, 'app.config.js'),
          'module.exports = ({ config }) => ({ ...config, runtimeVersion: process.env.RUNTIME_VERSION });\n'
        );
      }

      const payloadPath = path.join(projectRoot, 'stub-expo-config.json');
      await fs.promises.writeFile(
        payloadPath,
        JSON.stringify({ name: 'fresh', slug: 'fresh', runtimeVersion })
      );
      return {
        projectRoot,
        env: {
          STUB_EXPO_CONFIG_JSON: payloadPath,
          STUB_FINGERPRINT_HASH: 'ffff1111ffff1111ffff1111ffff1111ffff1111',
          STUB_FP_SOURCES: JSON.stringify([NATIVE_MODULE]),
        },
      };
    }

    /** The `expo config` spawns the stub recorded. */
    function configSpawns(projectRoot: string) {
      return readStubExpoInvocations(projectRoot).filter(
        (invocation) => invocation.args[0] === 'config'
      );
    }

    it('carries the per-source list and the OTA verdict, and still exits 0', async () => {
      const { projectRoot, env } = await setupExplainAsync({ policy: 'appVersion' });

      const report = await reportInAsync(projectRoot, [], env);

      const ios = report.freshness!.platforms.find(
        (platform) => platform.platform === 'ios' && platform.backend === 'local'
      )!;
      expect(ios.impact!.changedSources).toEqual([
        expect.objectContaining({
          op: 'added',
          path: 'node_modules/react-native-mmkv',
          kind: 'native-module',
        }),
      ]);
      expect(report.freshness!.ota).toMatchObject({
        safe: false,
        runtimeVersion: { policy: 'appVersion', source: 'app.json' },
      });
      expect(report.errors).toEqual({});
    });

    // The policy that makes a native change safe to publish: the runtime version moves with the
    // fingerprint, so an update is only offered to builds that can run it.
    it('reports a fingerprint policy as safe even for a native change', async () => {
      const { projectRoot, env } = await setupExplainAsync({ policy: 'fingerprint' });

      const report = await reportInAsync(projectRoot, [], env);

      expect(report.freshness!.ota).toMatchObject({ safe: true });
    });

    // A static config is the config the app sees, so it is read as a file: spawning the Expo CLI
    // to be told what `app.json` says was a second spent on every run to learn nothing.
    it('reads a static app.json as a file, spawning no expo config', async () => {
      const { projectRoot, env } = await setupExplainAsync({ policy: 'appVersion' });

      await reportInAsync(projectRoot, [], env);
      await reportInAsync(projectRoot, [], env);

      expect(configSpawns(projectRoot)).toHaveLength(0);
    });

    it('prints the changed sources and the ota verdict for a human', async () => {
      const { projectRoot, env } = await setupExplainAsync({ policy: 'appVersion' });
      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        { env }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('changed');
      expect(result.stdout).toContain('ios: 1 source');
      expect(result.stdout).toContain('node_modules/react-native-mmkv');
      expect(result.stdout).toContain('ota');
      expect(result.stdout).toContain('not safe to publish');
    });

    // Eight rows, then a count: a headline with fifty rows attached is not a headline. Platforms
    // whose lists agree print once — the probe hashes both together, so they usually do.
    it('lists eight sources, counts the rest, and prints platforms that agree once', async () => {
      const { projectRoot, env } = await setupExplainAsync({ policy: 'appVersion' });
      await fs.promises.writeFile(
        path.join(projectRoot, '.expo', 'agent-cli-last-build.json'),
        JSON.stringify({
          ios: { hash: FIXTURE_FINGERPRINT_HASH, sources: [] },
          android: { hash: FIXTURE_FINGERPRINT_HASH, sources: [] },
        })
      );
      const sources = Array.from({ length: 10 }, (_, index) => ({
        ...NATIVE_MODULE,
        filePath: `node_modules/native-module-${index}`,
      }));

      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        { env: { ...env, STUB_FP_SOURCES: JSON.stringify(sources) } }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('ios, android: 10 sources');
      expect(result.stdout).toContain('node_modules/native-module-7');
      expect(result.stdout).not.toContain('node_modules/native-module-8');
      expect(result.stdout).toContain('… and 2 more, in --json');
      // Once, not once per platform.
      expect(result.stdout.match(/added\s+node_modules\/native-module-0/g)).toHaveLength(1);
    });

    // The class contributes its single best next command to the follow-ups (llp/0009); the OTA
    // verdict itself is in the report, not a rung.
    it('carries the head of the class ladder in the follow-ups, beside the OTA verdict', async () => {
      const { projectRoot, env } = await setupExplainAsync({ policy: 'appVersion' });

      const report = await reportInAsync(projectRoot, [], env);

      expect(report.freshness!.ota).toMatchObject({ safe: false });
      expect(report.followups.map((followup) => followup.id)).toContain('change-native-build');
    });

    // @ref llp/0011-impact-and-freshness.rfc.md §A fingerprint change is not "OTA-unsafe"
    // A dynamic config has to be evaluated, and only the project's own Expo CLI may do that. The
    // answer is remembered under `.expo` and revalidated against the pinned files, so a loop of
    // `status` runs spawns it once (llp/0023).
    describe('a dynamic app.config.js', () => {
      it('evaluates it with expo config, once', async () => {
        const { projectRoot, env } = await setupExplainAsync(
          { policy: 'appVersion' },
          { config: 'dynamic' }
        );

        const report = await reportInAsync(projectRoot, [], env);
        expect(configSpawns(projectRoot)).toHaveLength(1);
        expect(configSpawns(projectRoot)[0]!.args).toEqual([
          'config',
          '--json',
          '--type',
          'public',
        ]);
        expect(report.freshness!.ota).toMatchObject({
          safe: false,
          runtimeVersion: {
            policy: 'appVersion',
            source: 'expo config --type public',
            cache: null,
          },
        });
      });

      it('remembers the evaluation, and says so with its age', async () => {
        const { projectRoot, env } = await setupExplainAsync(
          { policy: 'appVersion' },
          { config: 'dynamic' }
        );
        await reportInAsync(projectRoot, [], env);

        const report = await reportInAsync(projectRoot, [], env);

        expect(configSpawns(projectRoot)).toHaveLength(1);
        expect(report.freshness!.ota).toMatchObject({
          safe: false,
          runtimeVersion: {
            policy: 'appVersion',
            source: 'expo config --type public',
            cache: { keyKind: 'mtime+size' },
          },
        });
        expect(
          (report.freshness!.ota!.runtimeVersion as { cache: { ageMs: number } }).cache.ageMs
        ).toBeGreaterThanOrEqual(0);

        const result = await executeAgentCliAsync(
          projectRoot,
          ['status', '--dev-server-url', await getUnusedDevServerUrlAsync()],
          { env }
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/expo config --type public, cached \d+[smh] ago/);
      });

      it('evaluates again once app.config.js changes', async () => {
        const { projectRoot, env } = await setupExplainAsync(
          { policy: 'appVersion' },
          { config: 'dynamic' }
        );
        await reportInAsync(projectRoot, [], env);

        await fs.promises.writeFile(
          path.join(projectRoot, 'app.config.js'),
          "module.exports = ({ config }) => ({ ...config, runtimeVersion: { policy: 'fingerprint' } });\n"
        );
        await fs.promises.writeFile(
          env.STUB_EXPO_CONFIG_JSON!,
          JSON.stringify({
            name: 'fresh',
            slug: 'fresh',
            runtimeVersion: { policy: 'fingerprint' },
          })
        );

        const report = await reportInAsync(projectRoot, [], env);

        expect(configSpawns(projectRoot)).toHaveLength(2);
        expect(report.freshness!.ota).toMatchObject({ safe: true });
      });

      it('evaluates again under --no-fingerprint-cache', async () => {
        const { projectRoot, env } = await setupExplainAsync(
          { policy: 'appVersion' },
          { config: 'dynamic' }
        );
        await reportInAsync(projectRoot, [], env);

        const report = await reportInAsync(projectRoot, ['--no-fingerprint-cache'], env);

        expect(configSpawns(projectRoot)).toHaveLength(2);
        expect(report.freshness!.ota!.runtimeVersion).toMatchObject({ cache: null });
      });

      // Section isolation: the report is three costly answers, and one that cannot be had costs one line.
      it('keeps every other fact when the config subprocess fails', async () => {
        const { projectRoot, env } = await setupExplainAsync(
          { policy: 'appVersion' },
          { config: 'dynamic' }
        );
        const result = await executeAgentCliAsync(
          projectRoot,
          ['status', '--json', '--dev-server-url', await getUnusedDevServerUrlAsync()],
          { env: { ...env, STUB_EXPO_EXIT_CODE: '1' } }
        );

        expect(result.exitCode).toBe(0);
        const report: StatusReport = JSON.parse(result.stdout);
        // The static file beside the dynamic one answered, and it names no runtimeVersion — so the
        // verdict is unknown, never "not safe".
        expect(report.freshness!.ota).toMatchObject({
          safe: null,
          runtimeVersion: { source: 'app.json' },
        });
        expect(report.project).not.toBeNull();
      });
    });
  });

  // @ref llp/0005-runtime-loop-tools.rfc.md §navigate — F106
  // @ref llp/0004-smart-start-and-project-state.rfc.md §Status
  //
  // The device section spawns `xcrun simctl` and `adb`, so on a real runner it says whatever that
  // machine has. These tests put both tools under this CLI's control: a stub `xcrun` on the PATH
  // the run searches first, and a stub `adb` under an `ANDROID_HOME` of the test's own, which the
  // resolver looks at before `PATH` (`src/device/adb.ts`). `unknown` is a tool that cannot be run
  // at all, which is a file with no execute bit.
  describe('the device section, with stubbed platform tools', () => {
    const IOS_UDID = '8B2C5D9E-1234-4F5A-9B7C-0D1E2F3A4B5C';

    const BOOTED_SIMCTL = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
          { udid: IOS_UDID, name: 'iPhone 17 Pro', state: 'Booted' },
        ],
      },
    });
    const NO_SIMCTL = JSON.stringify({ devices: {} });
    const ATTACHED_ADB =
      'List of devices attached\nemulator-5554          device product:sdk_gphone64_arm64 model:Pixel_9 device:emu64a transport_id:1\n';
    const NO_ADB = 'List of devices attached\n';

    type ToolState = 'answers' | 'none' | 'not-runnable';

    /**
     * Put `xcrun` and `adb` under the test's control.
     *
     * @returns the environment the run needs: `ANDROID_HOME` for the stub `adb`.
     */
    async function stubDeviceToolsAsync(
      projectRoot: string,
      { ios, android }: { ios: ToolState; android: ToolState }
    ): Promise<Record<string, string>> {
      const binDir = path.join(projectRoot, '.stub-bin');
      await fs.promises.mkdir(binDir, { recursive: true });

      const xcrunScript = path.join(binDir, 'xcrun-stub.js');
      await fs.promises.writeFile(
        xcrunScript,
        `process.stdout.write(${JSON.stringify(ios === 'answers' ? BOOTED_SIMCTL : NO_SIMCTL)} + '\\n');\n`
      );
      await installStubBinAsync(binDir, 'xcrun', xcrunScript);
      if (ios === 'not-runnable') {
        await fs.promises.chmod(path.join(binDir, 'xcrun'), 0o000);
      }

      const sdkRoot = path.join(projectRoot, 'stub-android-sdk');
      const platformTools = path.join(sdkRoot, 'platform-tools');
      const adbScript = path.join(sdkRoot, 'adb-stub.js');
      await fs.promises.mkdir(platformTools, { recursive: true });
      await fs.promises.writeFile(
        adbScript,
        `process.stdout.write(${JSON.stringify(android === 'answers' ? ATTACHED_ADB : NO_ADB)});\n`
      );
      await installStubBinAsync(platformTools, 'adb', adbScript);
      if (android === 'not-runnable') {
        await fs.promises.chmod(path.join(platformTools, 'adb'), 0o000);
      }
      // A tool the PATH search skips is found further along it — the machine's own `xcrun`. For
      // "cannot be run" the search has to end in this directory, so the run gets a PATH of it alone
      // (the CLI and every stub start `node` by its absolute path, so nothing else needs one).
      const pathOverride = ios === 'not-runnable' ? pathEnvVars(binDir) : {};
      return { ANDROID_HOME: sdkRoot, ...pathOverride };
    }

    it('reports an attached Android device, from the adb the SDK root names', async () => {
      const projectRoot = await setupAsync('go-app');
      const env = await stubDeviceToolsAsync(projectRoot, { ios: 'none', android: 'answers' });

      const report = await reportInAsync(projectRoot, [], env);

      expect(report.device).toMatchObject({
        state: 'present',
        platform: 'android',
        deviceId: 'emulator-5554',
        devices: [{ platform: 'android', deviceId: 'emulator-5554' }],
        reason: null,
      });

      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        { env }
      );
      expect(result.stdout).toMatch(/device\s+android emulator-5554/);
    });

    // iOS simulators exist on macOS only, and the probe is not run elsewhere.
    it.skipIf(process.platform !== 'darwin')(
      'reports a booted iOS simulator by name, and every device this machine has (F106)',
      async () => {
        const projectRoot = await setupAsync('go-app');
        const env = await stubDeviceToolsAsync(projectRoot, { ios: 'answers', android: 'answers' });

        const report = await reportInAsync(projectRoot, [], env);

        expect(report.device).toMatchObject({
          state: 'present',
          platform: 'ios',
          deviceId: IOS_UDID,
          name: 'iPhone 17 Pro',
        });
        // Both, in the order the tools were asked — not the first one alone.
        expect(report.device!.devices).toEqual([
          { platform: 'ios', deviceId: IOS_UDID, name: 'iPhone 17 Pro' },
          { platform: 'android', deviceId: 'emulator-5554', name: null },
        ]);

        const result = await executeAgentCliAsync(
          projectRoot,
          ['status', '--dev-server-url', await getUnusedDevServerUrlAsync()],
          { env }
        );
        expect(result.stdout).toContain(`ios iPhone 17 Pro (${IOS_UDID})`);
        expect(result.stdout).toContain('android emulator-5554');
      }
    );

    it('reports absent, and why, when every tool answered and found nothing', async () => {
      const projectRoot = await setupAsync('go-app');
      const env = await stubDeviceToolsAsync(projectRoot, { ios: 'none', android: 'none' });

      const report = await reportInAsync(projectRoot, [], env);

      expect(report.device).toMatchObject({ state: 'absent', deviceId: null, devices: [] });
      expect(report.device!.reason).toContain('no Android device or emulator is attached');

      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        { env }
      );
      expect(result.stdout).toMatch(/device\s+none/);
    });

    // A tool that could not be run establishes nothing, and `unknown` is never rounded down to
    // "none": the difference is what keeps `navigate` on the ladder. Windows runs a `.cmd` shim
    // that no execute bit can withhold, so the case is a POSIX one.
    it.skipIf(process.platform === 'win32')(
      'reports unknown, never none, when no tool could be run',
      async () => {
        const projectRoot = await setupAsync('go-app');
        const env = await stubDeviceToolsAsync(projectRoot, {
          ios: 'not-runnable',
          android: 'not-runnable',
        });

        const report = await reportInAsync(projectRoot, [], env);

        expect(report.device).toMatchObject({ state: 'unknown', deviceId: null, devices: [] });
        expect(report.device!.reason).toContain('could not be run');

        const result = await executeAgentCliAsync(
          projectRoot,
          ['status', '--dev-server-url', await getUnusedDevServerUrlAsync()],
          { env }
        );
        expect(result.stdout).toMatch(/device\s+unknown/);
      }
    );

    // @ref llp/0009-smart-followups.rfc.md §Device-aware ladders
    // A dev server with nothing attached and no device to open the app on: the answer is an
    // address, or the command that prints one, and never `navigate /`.
    it('hands over an address instead of navigate when a dev server is up and no device is here', async () => {
      const projectRoot = await setupAsync('go-app');
      const env = await stubDeviceToolsAsync(projectRoot, { ios: 'none', android: 'none' });
      const devServer = await startDevServerDoubleAsync([]);
      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['status', '--json', '--dev-server-url', devServer.url],
          { env }
        );

        expect(result.exitCode).toBe(0);
        const report: StatusReport = JSON.parse(result.stdout);
        expect(report.devServer).toMatchObject({ running: true, appsConnected: 0 });
        // Which of the two depends on whether this machine has a LAN address to name.
        expect(report.next!.command).toMatch(/^exp:\/\/|navigate \/ --print-url$/);
        expect(report.next!.command).not.toBe('npx @expo/agent-cli navigate /');
        expect(report.next!.why).toContain('no booted simulator or attached device');
      } finally {
        await new Promise<void>((resolve) => devServer.server.close(() => resolve()));
      }
    });

    // @ref llp/0021-honest-reports.rfc.md §The rules — K7(a)
    // A cloud loop is not a local loop with a longer wire: with an EAS Simulator session on record
    // and no device here, every rung is the `--eas` one.
    describe('a project with an EAS Simulator session on record', () => {
      it('sends a dev server with an app connected to smoke --eas', async () => {
        const projectRoot = await setupAsync('go-app');
        const env = await stubDeviceToolsAsync(projectRoot, { ios: 'none', android: 'none' });
        await writeCloudSessionFileAsync(projectRoot, 'sess-e2e');
        const devServer = await startDevServerDoubleAsync([CDP_TARGET]);
        try {
          const result = await executeAgentCliAsync(
            projectRoot,
            ['status', '--json', '--dev-server-url', devServer.url],
            { env }
          );

          expect(result.exitCode).toBe(0);
          const report: StatusReport = JSON.parse(result.stdout);
          expect(report.next!.command).toBe('npx @expo/agent-cli smoke --ios --eas');
          expect(report.next!.why).toContain('EAS Simulator session');
        } finally {
          await new Promise<void>((resolve) => devServer.server.close(() => resolve()));
        }
      });

      it('sends a dev server with nothing attached to navigate --eas', async () => {
        const projectRoot = await setupAsync('go-app');
        const env = await stubDeviceToolsAsync(projectRoot, { ios: 'none', android: 'none' });
        await writeCloudSessionFileAsync(projectRoot, 'sess-e2e');
        const devServer = await startDevServerDoubleAsync([]);
        try {
          const result = await executeAgentCliAsync(
            projectRoot,
            ['status', '--json', '--dev-server-url', devServer.url],
            { env }
          );

          expect(result.exitCode).toBe(0);
          const report: StatusReport = JSON.parse(result.stdout);
          expect(report.next!.command).toBe('npx @expo/agent-cli navigate / --eas');
          expect(report.next!.why).toContain('dev:stop --eas');
        } finally {
          await new Promise<void>((resolve) => devServer.server.close(() => resolve()));
        }
      });

      // `!== 'present'`: with a session on record, a probe that could not run is not a reason to
      // name the local path.
      it.skipIf(process.platform === 'win32')(
        'still names the session when the device tools could not answer',
        async () => {
          const projectRoot = await setupAsync('go-app');
          const env = await stubDeviceToolsAsync(projectRoot, {
            ios: 'not-runnable',
            android: 'not-runnable',
          });
          await writeCloudSessionFileAsync(projectRoot, 'sess-e2e');
          const devServer = await startDevServerDoubleAsync([]);
          try {
            const result = await executeAgentCliAsync(
              projectRoot,
              ['status', '--json', '--dev-server-url', devServer.url],
              { env }
            );

            const report: StatusReport = JSON.parse(result.stdout);
            expect(report.next!.command).toBe('npx @expo/agent-cli navigate / --eas');
            expect(report.next!.why).toContain('device tools could not answer');
          } finally {
            await new Promise<void>((resolve) => devServer.server.close(() => resolve()));
          }
        }
      );

      it('keeps the local path when a device is here, session or not', async () => {
        const projectRoot = await setupAsync('go-app');
        const env = await stubDeviceToolsAsync(projectRoot, { ios: 'none', android: 'answers' });
        await writeCloudSessionFileAsync(projectRoot, 'sess-e2e');
        const devServer = await startDevServerDoubleAsync([CDP_TARGET]);
        try {
          const result = await executeAgentCliAsync(
            projectRoot,
            ['status', '--json', '--dev-server-url', devServer.url],
            { env }
          );

          const report: StatusReport = JSON.parse(result.stdout);
          expect(report.next!.command).toBe('npx @expo/agent-cli smoke --android');
        } finally {
          await new Promise<void>((resolve) => devServer.server.close(() => resolve()));
        }
      });
    });
  });

  // @ref llp/0021-honest-reports.rfc.md §The rules — K7(c), K8
  // A tunnelled dev server listens on 127.0.0.1 and is reached at its tunnel host; only the
  // second is an address a phone or a cloud simulator can use, and the URL that opens the app is
  // the encoded launcher form, not the line `expo start` printed for itself.
  describe('a tunnelled dev server', () => {
    it('names the tunnel and the URLs that open the app on it', async () => {
      const projectRoot = await setupAsync('go-app');
      const devServer = await startDevServerDoubleAsync([]);
      // The lock says a dev server of this project is running; the detached log, written after the
      // lock was taken, says where it advertised itself.
      const startedAt = new Date(Date.now() - 5_000).toISOString();
      const releaseLock = await holdDevLockAsync(projectRoot, {
        url: devServer.url,
        port: Number(new URL(devServer.url).port),
        pid: process.pid,
        startedAt,
        projectRoot,
      });
      const logDir = path.join(projectRoot, '.expo', 'dev', 'logs');
      await fs.promises.mkdir(logDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(logDir, 'dev-detached.log'),
        'Starting Metro Bundler\nWaiting on https://e2e-tunnel.boltexpo.dev\nLogs for your project will appear below.\n'
      );
      try {
        const result = await executeAgentCliAsync(projectRoot, ['status', '--json']);

        expect(result.exitCode).toBe(0);
        const report: StatusReport = JSON.parse(result.stdout);
        expect(report.devServer).toMatchObject({
          running: true,
          source: 'lock',
          hostType: 'tunnel',
          tunnelUrl: 'https://e2e-tunnel.boltexpo.dev',
        });
        // Expo Go's form for a Go-compatible project, on the tunnel host and not on 127.0.0.1.
        expect(report.devServer!.openUrls).toContainEqual(
          expect.objectContaining({ url: 'exp://e2e-tunnel.boltexpo.dev' })
        );

        const text = await executeAgentCliAsync(projectRoot, ['status']);
        expect(text.stdout).toContain('tunnel https://e2e-tunnel.boltexpo.dev');
        expect(text.stdout).toMatch(/open in .*: exp:\/\/e2e-tunnel\.boltexpo\.dev/);
      } finally {
        releaseLock();
        await new Promise<void>((resolve) => devServer.server.close(() => resolve()));
      }
    });

    it('drops a tunnel the log names once the dev server it belonged to is gone', async () => {
      const projectRoot = await setupAsync('go-app');
      const logDir = path.join(projectRoot, '.expo', 'dev', 'logs');
      await fs.promises.mkdir(logDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(logDir, 'dev-detached.log'),
        'Waiting on https://stale-tunnel.boltexpo.dev\n'
      );

      const report = await reportInAsync(projectRoot);

      expect(report.devServer).toMatchObject({ running: false, tunnelUrl: null, openUrls: [] });
    });
  });

  // @ref llp/0011-impact-and-freshness.rfc.md §The three comparisons
  // @ref llp/0021-honest-reports.rfc.md §The rules
  //
  // `--build <id>` replaces the base of the headline with one EAS build. The stub `eas` answers
  // `fingerprint:compare` and `build:view`; the stub `fingerprint` diffs the two sides the way the
  // real CLI does, because the diff is a local elaboration of the server's two hashes.
  describe('status --build <id>', () => {
    const BUILD_ID = '21d7d434-6495-4e74-b8c7-68ecd0dff489';
    const NATIVE_MODULE = {
      type: 'dir',
      filePath: 'node_modules/react-native-mmkv',
      reasons: ['rncoreAutolinkingIos'],
      hash: 'aabb',
    };
    const APP_CONFIG = { type: 'file', filePath: 'app.json', reasons: ['expoConfig'], hash: 'cc' };

    /** A `fingerprint` bin that also answers `fingerprint:diff`, which the comparison needs. */
    const STUB_FINGERPRINT = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'fingerprint:diff') {
  const base = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  const head = JSON.parse(fs.readFileSync(args[2], 'utf8'));
  const key = (source) => source.filePath || source.id || JSON.stringify(source);
  const before = new Map(base.sources.map((source) => [key(source), source]));
  const after = new Map(head.sources.map((source) => [key(source), source]));
  const items = [];
  for (const [id, source] of after) {
    if (!before.has(id)) {
      items.push({ op: 'added', addedSource: source });
    } else if (before.get(id).hash !== source.hash) {
      items.push({ op: 'changed', beforeSource: before.get(id), afterSource: source });
    }
  }
  for (const [id, source] of before) {
    if (!after.has(id)) {
      items.push({ op: 'removed', removedSource: source });
    }
  }
  process.stdout.write(JSON.stringify(items, null, 2) + '\\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  hash: process.env.STUB_FINGERPRINT_HASH || ${JSON.stringify(FIXTURE_FINGERPRINT_HASH)},
  sources: JSON.parse(process.env.STUB_FP_SOURCES || '[]'),
}) + '\\n');
`;

    /** The payload `fingerprint:compare` prints: the build's fingerprint, then the working tree's. */
    function comparePayload(buildSources: unknown[], headSources: unknown[]) {
      return JSON.stringify({
        fingerprint1: { hash: 'build-hash-1111', sources: buildSources },
        fingerprint2: {
          hash:
            JSON.stringify(buildSources) === JSON.stringify(headSources)
              ? 'build-hash-1111'
              : 'head-hash-2222',
          sources: headSources,
        },
      });
    }

    async function setupCompareAsync(): Promise<string> {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      const binDir = path.join(projectRoot, '.stub-bin');
      await fs.promises.mkdir(binDir, { recursive: true });
      const stub = path.join(binDir, 'fingerprint-compare-stub.js');
      await fs.promises.writeFile(stub, STUB_FINGERPRINT);
      for (const dir of [binDir, path.join(projectRoot, 'node_modules', '.bin')]) {
        await installStubBinAsync(dir, 'fingerprint', stub);
      }
      await fs.promises.writeFile(
        path.join(projectRoot, '.expo', 'agent-cli-last-build.json'),
        JSON.stringify({
          ios: { hash: FIXTURE_FINGERPRINT_HASH, sources: [APP_CONFIG] },
          android: { hash: FIXTURE_FINGERPRINT_HASH, sources: [APP_CONFIG] },
        })
      );
      await installSharedStubEasAsync(projectRoot);
      await pinEasCliAsync(projectRoot);
      return projectRoot;
    }

    async function runBuildAsync(
      projectRoot: string,
      args: string[],
      env: Record<string, string> = {}
    ) {
      return executeAgentCliAsync(
        projectRoot,
        [
          'status',
          '--build',
          BUILD_ID,
          ...args,
          '--dev-server-url',
          await getUnusedDevServerUrlAsync(),
        ],
        { env: { STUB_FP_SOURCES: JSON.stringify([APP_CONFIG]), ...env }, reject: false }
      );
    }

    function easAxis(report: StatusReport, platform: 'ios' | 'android') {
      return report.freshness!.platforms.find(
        (entry) => entry.platform === platform && entry.backend === 'eas'
      )!;
    }

    it("compares against the named build, on that build's platform only", async () => {
      const projectRoot = await setupCompareAsync();

      const result = await runBuildAsync(projectRoot, ['--json'], {
        STUB_EAS_COMPARE_JSON: comparePayload([APP_CONFIG], [APP_CONFIG]),
      });

      expect(result.exitCode).toBe(0);
      const report: StatusReport = JSON.parse(result.stdout);
      expect(report.freshness!.comparison).toEqual({
        kind: 'eas-build',
        label: `EAS build ${BUILD_ID}`,
        buildId: BUILD_ID,
        platform: 'ios',
      });
      expect(easAxis(report, 'ios')).toMatchObject({
        state: 'fresh',
        buildId: BUILD_ID,
        detail: `matches EAS build ${BUILD_ID}`,
        impact: { class: 'js-only', fingerprintChanged: false, changedCount: 0 },
      });
      // One build is one platform: the other axis says it was not compared, and names no class.
      expect(easAxis(report, 'android')).toMatchObject({ state: 'unknown', buildId: null });
      expect(easAxis(report, 'android').detail).toContain('not compared');
      expect(easAxis(report, 'android').impact?.class).toBeNull();
      // The local axis is untouched: this machine's own record still answers its own question.
      expect(
        report.freshness!.platforms.find(
          (entry) => entry.platform === 'ios' && entry.backend === 'local'
        )
      ).toMatchObject({ state: 'fresh', buildId: null });
      expect(report.errors).toEqual({});
    });

    it('reports what differs from the named build, and what that costs', async () => {
      const projectRoot = await setupCompareAsync();

      const result = await runBuildAsync(projectRoot, ['--json'], {
        STUB_EAS_COMPARE_JSON: comparePayload([APP_CONFIG], [APP_CONFIG, NATIVE_MODULE]),
      });

      expect(result.exitCode).toBe(0);
      const report: StatusReport = JSON.parse(result.stdout);
      expect(easAxis(report, 'ios')).toMatchObject({
        state: 'stale',
        detail: `differs from EAS build ${BUILD_ID}`,
        impact: { class: 'needs-native-build', fingerprintChanged: true, changedCount: 1 },
      });
      expect(easAxis(report, 'ios').impact!.changedSources).toEqual([
        expect.objectContaining({ op: 'added', path: 'node_modules/react-native-mmkv' }),
      ]);
    });

    it('says which build the headline was measured against, for a human', async () => {
      const projectRoot = await setupCompareAsync();

      const result = await runBuildAsync(projectRoot, [], {
        STUB_EAS_COMPARE_JSON: comparePayload([APP_CONFIG], [APP_CONFIG, NATIVE_MODULE]),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`vs EAS build ${BUILD_ID}`);
      expect(result.stdout).toContain('ios (eas): needs-native-build');
      expect(result.stdout).toContain(`differs from EAS build ${BUILD_ID}`);
    });

    // Under `--build` the gate is about the named build, so only the eas axis is judged
    // (`src/status/assert.ts`): the local axis answers a question the caller did not ask.
    it('judges the eas axis under --assert', async () => {
      const projectRoot = await setupCompareAsync();

      const differs = await runBuildAsync(projectRoot, ['--assert', 'js-only'], {
        STUB_EAS_COMPARE_JSON: comparePayload([APP_CONFIG], [APP_CONFIG, NATIVE_MODULE]),
      });
      expect(differs.exitCode).toBe(20);
      expect(differs.stdout).toContain('the change costs needs-native-build');

      const matches = await runBuildAsync(projectRoot, ['--assert', 'js-only'], {
        STUB_EAS_COMPARE_JSON: comparePayload([APP_CONFIG], [APP_CONFIG]),
      });
      expect(matches.exitCode).toBe(0);
    });

    // S1: one build is one platform, and copying its verdict onto both said an iOS build could run
    // android code. When EAS cannot say which platform, the comparison is attributed to none.
    it('attributes the comparison to no platform when EAS cannot say which one the build is for', async () => {
      const projectRoot = await setupCompareAsync();

      const result = await runBuildAsync(projectRoot, ['--json', '--assert', 'js-only'], {
        STUB_EAS_COMPARE_JSON: comparePayload([APP_CONFIG], [APP_CONFIG]),
        STUB_EAS_BUILD_VIEW_EXIT: '1',
      });

      // Nothing measured, so the gate does not pass on a guess.
      expect(result.exitCode).toBe(22);
      const report: StatusReport = JSON.parse(result.stdout);
      expect(report.freshness!.comparison.platform).toBeNull();
      for (const platform of ['ios', 'android'] as const) {
        expect(easAxis(report, platform).detail).toContain('not compared');
        expect(easAxis(report, platform).impact?.class).toBeNull();
      }
    });

    // F66: a `--build` that failed used to print an ordinary report with the id nowhere on it.
    it('keeps the report, echoes the build, and notes the failure when the comparison cannot run', async () => {
      const projectRoot = await setupCompareAsync();

      const result = await runBuildAsync(projectRoot, [], { STUB_EAS_COMPARE_EXIT: '1' });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('freshness note');
      expect(result.stdout).toContain(BUILD_ID);
      expect(result.stdout).toContain('project     dev-client-fresh-app');

      const json = await runBuildAsync(projectRoot, ['--json'], { STUB_EAS_COMPARE_EXIT: '1' });
      const report: StatusReport = JSON.parse(json.stdout);
      expect(report.freshness!.comparison).toMatchObject({ kind: 'eas-build', buildId: BUILD_ID });
      expect(report.errors.freshness).toContain(BUILD_ID);
    });
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Not an Expo app
  // `status` is the one command that answers here rather than refusing: it is how a caller finds
  // out it is in the wrong directory.
  describe('a directory that is not an Expo app', () => {
    async function setupNotAnAppAsync(): Promise<string> {
      const projectRoot = await setupAsync('go-app');
      const manifestPath = path.join(projectRoot, 'package.json');
      const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
      delete manifest.dependencies.expo;
      await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      return projectRoot;
    }

    it('says so, points at creating an app rather than running one, and exits 0', async () => {
      const projectRoot = await setupNotAnAppAsync();

      const report = await reportInAsync(projectRoot);

      expect(report.project).toMatchObject({ isExpoApp: false });
      expect(report.next).toMatchObject({
        command: 'npx @expo/agent-cli new my-app',
        steps: [],
        buildLocation: null,
      });
      expect(report.next!.why).toContain('not an Expo app');
    });

    it('prints the fact second on the project line, where a reader cannot miss it', async () => {
      const projectRoot = await setupNotAnAppAsync();

      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--dev-server-url',
        await getUnusedDevServerUrlAsync(),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/project\s+go-app · not an Expo app/);
      expect(result.stdout).toContain('npx @expo/agent-cli new my-app');
    });
  });

  // @ref llp/0011-impact-and-freshness.rfc.md §When the fingerprint did not move
  // The file-level view: read only when the fingerprint says the native surface did not move,
  // which is the one case where it can change the answer.
  describe('the changed files, when the fingerprint did not move', () => {
    const APP_CONFIG = { type: 'file', filePath: 'app.json', reasons: ['expoConfig'], hash: 'cc' };
    const STUB_FINGERPRINT = `#!/usr/bin/env node
'use strict';
process.stdout.write(JSON.stringify({
  hash: process.env.STUB_FINGERPRINT_HASH || ${JSON.stringify(FIXTURE_FINGERPRINT_HASH)},
  sources: JSON.parse(process.env.STUB_FP_SOURCES || '[]'),
}) + '\\n');
`;

    /** A committed working tree whose fingerprint matches its recorded build. */
    async function setupCommittedAsync(): Promise<string> {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      const binDir = path.join(projectRoot, '.stub-bin');
      await fs.promises.mkdir(binDir, { recursive: true });
      const stub = path.join(binDir, 'fingerprint-files-stub.js');
      await fs.promises.writeFile(stub, STUB_FINGERPRINT);
      for (const dir of [binDir, path.join(projectRoot, 'node_modules', '.bin')]) {
        await installStubBinAsync(dir, 'fingerprint', stub);
      }
      await fs.promises.writeFile(
        path.join(projectRoot, '.expo', 'agent-cli-last-build.json'),
        JSON.stringify({
          ios: { hash: FIXTURE_FINGERPRINT_HASH, sources: [APP_CONFIG] },
          android: { hash: FIXTURE_FINGERPRINT_HASH, sources: [APP_CONFIG] },
        })
      );
      // What the test doubles write during a run is not the project's change.
      await fs.promises.writeFile(
        path.join(projectRoot, '.gitignore'),
        ['node_modules/', '.expo/', '.stub-bin/', 'stub-*.jsonl', ''].join('\n')
      );
      await initGitRepoAsync(projectRoot);
      git(projectRoot, ['add', '-A']);
      git(projectRoot, [
        '-c',
        'user.name=e2e',
        '-c',
        'user.email=e2e@example.com',
        'commit',
        '-q',
        '-m',
        'init',
      ]);
      return projectRoot;
    }

    const env = { STUB_FP_SOURCES: JSON.stringify([APP_CONFIG]) };

    it('says nothing about files when nothing in the tree changed', async () => {
      const projectRoot = await setupCommittedAsync();

      const report = await reportInAsync(projectRoot, [], env);

      expect(report.freshness!.changedFiles).toEqual({ total: 0, native: 0, js: 0, config: 0 });
      expect(
        report.freshness!.platforms.find(
          (entry) => entry.platform === 'ios' && entry.backend === 'local'
        )!.impact
      ).toMatchObject({ class: 'js-only', fingerprintChanged: false });
    });

    it('counts a JavaScript edit, and keeps the class at js-only', async () => {
      const projectRoot = await setupCommittedAsync();
      await fs.promises.writeFile(path.join(projectRoot, 'index.js'), '// edited\n');

      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        { env }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('ios, android: js-only');
      expect(result.stdout).toMatch(/files\s+1 changed · 1 js · 0 config · 0 native/);
    });

    // A file the dev server read once at start-up needs Metro restarted: the installed app is still
    // the right one, and only the bundler has to come back.
    it('raises the class to dev-client-compatible for a file the dev server read at start-up', async () => {
      const projectRoot = await setupCommittedAsync();
      await fs.promises.writeFile(
        path.join(projectRoot, 'metro.config.js'),
        "const { getDefaultConfig } = require('expo/metro-config');\nmodule.exports = getDefaultConfig(__dirname);\n"
      );

      const report = await reportInAsync(projectRoot, [], env);

      // `metro.config.js` is a file the bundler reads, not the app config: it counts as JavaScript
      // and still raises the class, because Metro has to come back for it.
      expect(report.freshness!.changedFiles).toMatchObject({ total: 1, js: 1, config: 0 });
      expect(
        report.freshness!.platforms.find(
          (entry) => entry.platform === 'ios' && entry.backend === 'local'
        )!.impact
      ).toMatchObject({ class: 'dev-client-compatible', fingerprintChanged: false });
      expect(report.followups.map((followup) => followup.id)).toContain('change-restart-metro');
    });
  });

  // @ref llp/0009-smart-followups.rfc.md §Examples per command
  // The follow-ups reach a driving agent through `--json` and the event only; each rung fires on
  // one fact of the report.
  describe('the follow-ups', () => {
    it('names runtime:errors when an app is connected to the dev server', async () => {
      const projectRoot = await setupAsync('go-app');
      const devServer = await startDevServerDoubleAsync([CDP_TARGET]);
      try {
        const result = await executeAgentCliAsync(projectRoot, [
          'status',
          '--json',
          '--dev-server-url',
          devServer.url,
        ]);

        expect(result.exitCode).toBe(0);
        const report: StatusReport = JSON.parse(result.stdout);
        expect(report.followups).toContainEqual(
          expect.objectContaining({
            id: 'runtime-errors',
            command: 'npx @expo/agent-cli runtime:errors',
          })
        );
      } finally {
        await new Promise<void>((resolve) => devServer.server.close(() => resolve()));
      }
    });

    it('names expo-dev-client for a project Expo Go cannot run and that has no dev client', async () => {
      const projectRoot = await goAppOnDumpSdkAsync();
      await addNativeModuleAsync(projectRoot, 'expo-observe');

      const report = await reportInAsync(projectRoot);

      expect(report.expoGo?.compatible).toBe(false);
      expect(report.project?.usesDevClient).toBe(false);
      expect(report.followups).toContainEqual(
        expect.objectContaining({
          id: 'install-dev-client',
          command: 'npx @expo/agent-cli install expo-dev-client',
        })
      );
    });

    it('names skills:sync when the project ships skills the selected agent has not linked', async () => {
      const projectRoot = await setupAsync('skills-app');
      await writeAgentSelectionAsync(projectRoot, ['claude-code']);

      const report = await reportInAsync(projectRoot);

      expect(report.skills).toMatchObject({ agentIds: ['claude-code'], linked: 0 });
      expect(report.skills!.discovered).toBeGreaterThan(0);
      expect(report.followups).toContainEqual(
        expect.objectContaining({ id: 'skills-sync', command: 'npx @expo/agent-cli skills:sync' })
      );
    });
  });

  describe('the dev server the project log names', () => {
    // Step 2 of the discovery ladder: `expo start` logs a `metro:instantiate` event with its port
    // into `.expo/dev/logs/start.log`, which is what finds a dev server no `@expo/agent-cli` wrapper
    // holds a lock for. The port is only a candidate until it answers.
    it('finds it with no URL given, and says the log named it', async () => {
      const projectRoot = await setupAsync('go-app');
      const devServer = await startDevServerDoubleAsync([]);
      try {
        const port = new URL(devServer.url).port;
        const logDir = path.join(projectRoot, '.expo', 'dev', 'logs');
        await fs.promises.mkdir(logDir, { recursive: true });
        await fs.promises.writeFile(
          path.join(logDir, 'start.log'),
          JSON.stringify({ _e: 'metro:instantiate', _t: Date.now(), port: Number(port) }) + '\n'
        );

        const result = await executeAgentCliAsync(projectRoot, ['status', '--json']);

        expect(result.exitCode).toBe(0);
        const report: StatusReport = JSON.parse(result.stdout);
        expect(report.devServer).toMatchObject({
          running: true,
          source: 'log',
          url: devServer.url,
        });
      } finally {
        await new Promise<void>((resolve) => devServer.server.close(() => resolve()));
      }
    });
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Status
  //
  // The one path out of this command that is not 0, and the reason it does not break the exit-0
  // contract: nothing changes unless the caller types the flag. These run the published bin, so
  // they assert the exit code a CI line would actually read.
  describe('status --assert', () => {
    const NATIVE_MODULE = {
      type: 'dir',
      filePath: 'node_modules/react-native-mmkv',
      reasons: ['rncoreAutolinkingIos'],
      hash: 'aabb',
    };
    const APP_CONFIG = { type: 'file', filePath: 'app.json', reasons: ['expoConfig'], hash: 'cc' };

    const STUB_FINGERPRINT = `#!/usr/bin/env node
'use strict';
process.stdout.write(JSON.stringify({
  hash: process.env.STUB_FINGERPRINT_HASH || ${JSON.stringify(FIXTURE_FINGERPRINT_HASH)},
  sources: JSON.parse(process.env.STUB_FP_SOURCES || '[]'),
}) + '\\n');
`;

    async function setupAssertAsync(recorded: unknown): Promise<string> {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      const binDir = path.join(projectRoot, '.stub-bin');
      await fs.promises.mkdir(binDir, { recursive: true });
      const stub = path.join(binDir, 'fingerprint-assert-stub.js');
      await fs.promises.writeFile(stub, STUB_FINGERPRINT);
      for (const dir of [binDir, path.join(projectRoot, 'node_modules', '.bin')]) {
        await installStubBinAsync(dir, 'fingerprint', stub);
      }
      await fs.promises.writeFile(
        path.join(projectRoot, '.expo', 'agent-cli-last-build.json'),
        JSON.stringify(recorded)
      );
      return projectRoot;
    }

    /** Both platforms recorded from the same fingerprint, so the gate has something to measure. */
    function recordedWith(sources: unknown[]) {
      return {
        ios: { hash: FIXTURE_FINGERPRINT_HASH, sources },
        android: { hash: FIXTURE_FINGERPRINT_HASH, sources },
      };
    }

    async function runAssertAsync(
      projectRoot: string,
      args: string[],
      env: Record<string, string> = {}
    ) {
      return executeAgentCliAsync(
        projectRoot,
        ['status', ...args, '--dev-server-url', await getUnusedDevServerUrlAsync()],
        { env, reject: false }
      );
    }

    it('exits 0 when the change costs at most the asserted class', async () => {
      const projectRoot = await setupAssertAsync(recordedWith([APP_CONFIG]));

      const result = await runAssertAsync(projectRoot, ['--assert', 'needs-native-build'], {
        STUB_FINGERPRINT_HASH: 'ffff1111ffff1111ffff1111ffff1111ffff1111',
        STUB_FP_SOURCES: JSON.stringify([APP_CONFIG, NATIVE_MODULE]),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('assert');
      expect(result.stdout).toContain('the change costs at most that');
    });

    it('exits 20 when the change costs more than the asserted class', async () => {
      const projectRoot = await setupAssertAsync(recordedWith([APP_CONFIG]));

      const result = await runAssertAsync(projectRoot, ['--assert', 'js-only'], {
        STUB_FINGERPRINT_HASH: 'ffff1111ffff1111ffff1111ffff1111ffff1111',
        STUB_FP_SOURCES: JSON.stringify([APP_CONFIG, NATIVE_MODULE]),
      });

      expect(result.exitCode).toBe(20);
      // The report is printed either way: a gate that failed is still a report, and the reasons
      // above it are what an agent reads next.
      expect(result.stdout).toContain('project');
      expect(result.stdout).toContain('the change costs needs-native-build');
    });

    // llp/0010's code for "nothing was shown to be wrong and nothing was proved right", which is
    // the third outcome and the one that keeps the gate honest.
    it('exits 22 when nothing could be measured', async () => {
      const projectRoot = await setupAssertAsync({});

      const result = await runAssertAsync(projectRoot, ['--assert', 'js-only']);

      expect(result.exitCode).toBe(22);
      expect(result.stdout).toContain('not verified');
    });

    it('carries the OTA verdict beside the gate', async () => {
      const projectRoot = await setupAssertAsync(recordedWith([APP_CONFIG]));
      const payload = path.join(projectRoot, 'stub-expo-config.json');
      await fs.promises.writeFile(
        payload,
        JSON.stringify({ name: 'fresh', slug: 'fresh', runtimeVersion: { policy: 'appVersion' } })
      );

      const result = await runAssertAsync(projectRoot, ['--assert', 'js-only'], {
        STUB_EXPO_CONFIG_JSON: payload,
        STUB_FINGERPRINT_HASH: 'ffff1111ffff1111ffff1111ffff1111ffff1111',
        STUB_FP_SOURCES: JSON.stringify([APP_CONFIG, NATIVE_MODULE]),
      });

      expect(result.exitCode).toBe(20);
      // Both halves ran: the deep dive printed, and the gate judged what it found.
      expect(result.stdout).toContain('ota');
      expect(result.stdout).toContain('the change costs needs-native-build');
    });

    it('carries the verdict in --json, which exits with the same code', async () => {
      const projectRoot = await setupAssertAsync(recordedWith([APP_CONFIG]));

      const result = await runAssertAsync(projectRoot, ['--assert', 'js-only', '--json'], {
        STUB_FINGERPRINT_HASH: 'ffff1111ffff1111ffff1111ffff1111ffff1111',
        STUB_FP_SOURCES: JSON.stringify([APP_CONFIG, NATIVE_MODULE]),
      });

      expect(result.exitCode).toBe(20);
      const report: StatusReport = JSON.parse(result.stdout);
      expect(report.assertion).toMatchObject({
        asserted: 'js-only',
        actual: 'needs-native-build',
        ok: false,
        exitCode: 20,
      });
    });

    it('reports no assertion, and exits 0, when the flag is absent', async () => {
      const projectRoot = await setupAssertAsync(recordedWith([APP_CONFIG]));

      const result = await runAssertAsync(projectRoot, ['--json'], {
        STUB_FINGERPRINT_HASH: 'ffff1111ffff1111ffff1111ffff1111ffff1111',
        STUB_FP_SOURCES: JSON.stringify([APP_CONFIG, NATIVE_MODULE]),
      });

      expect(result.exitCode).toBe(0);
      expect((JSON.parse(result.stdout) as StatusReport).assertion).toBeNull();
    });

    it('rejects a class it does not report, with exit 1', async () => {
      const projectRoot = await setupAssertAsync(recordedWith([APP_CONFIG]));

      const result = await runAssertAsync(projectRoot, ['--assert', 'native']);

      // A usage error is the tool not working, which is 1 — never the outcome band.
      expect(result.exitCode).toBe(1);
      expect(result.all).toContain('not one of the classes');
    });

    // @ref llp/0004-smart-start-and-project-state.rfc.md §Status
    // The flag that gated the per-source list, the OTA verdict and the EAS lookup is gone, with no
    // alias — an unknown option, the way `--cloud` became one. Every run carries all three.
    it('no longer takes --explain', async () => {
      const projectRoot = await setupAssertAsync(recordedWith([APP_CONFIG]));

      const result = await runAssertAsync(projectRoot, ['--explain']);

      expect(result.exitCode).toBe(1);
      expect(result.all).toContain('--explain');
    });

    // Naming a build is the ask: `--build` used to need `--explain` as the word for "you may spend
    // a round trip". The comparison itself is a stub `eas` that does not answer `fingerprint:compare`,
    // so what this pins is that the flag is taken on its own and the id is echoed (F66).
    it('takes --build on its own, and echoes the build it was given', async () => {
      const projectRoot = await setupAssertAsync(recordedWith([APP_CONFIG]));
      await installSharedStubEasAsync(projectRoot);
      await pinEasCliAsync(projectRoot);

      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--json',
        '--build',
        'build-1',
        '--dev-server-url',
        await getUnusedDevServerUrlAsync(),
      ]);

      expect(result.exitCode).toBe(0);
      const report: StatusReport = JSON.parse(result.stdout);
      expect(report.freshness!.comparison).toMatchObject({ kind: 'eas-build', buildId: 'build-1' });
      expect(result.all).not.toContain('--explain');
    });
  });

  // @ref llp/0011-impact-and-freshness.rfc.md §The build-cache lookup
  //
  // Three states, and one cost. The cost is the design: a remembered answer must not spawn `eas
  // build:list`, an unlinked project must not either, and a cold run of a linked project spawns it
  // once per platform. All of it is pinned by counting what crossed the process boundary, because a
  // section that quietly grew a network call would pass every assertion about its *answer*.
  describe('the EAS build lookup', () => {
    /** The per-platform hashes the stub prints, which is what an EAS build carries. */
    const IOS_HASH = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';
    const ANDROID_HASH = 'ffff6666eeee7777dddd8888cccc9999bbbb0000';
    const BUILD_ID = '21d7d434-6495-4e74-b8c7-68ecd0dff489';

    /** One finished build, in the shape the recorded `build:list` payload has. */
    const FINISHED_BUILD = {
      id: BUILD_ID,
      status: 'FINISHED',
      platform: 'IOS',
      buildProfile: 'simulator',
      createdAt: '2026-08-19T17:37:12.674Z',
      artifacts: { buildUrl: 'https://expo.dev/artifacts/eas/abc.tar.gz' },
    };

    /**
     * A `fingerprint` bin that answers a different hash per platform, the way the real one does.
     *
     * This is the fact the whole design turns on, and the fixture's own stub cannot show it: the
     * project hash covers both platforms and is not a hash any build carries. Live, on one working
     * tree: `031f6b0c…` for the project and `8ce1acfb…` for iOS [observed — apps/observe-tester,
     * 2026-08-26].
     */
    const STUB_FINGERPRINT = `#!/usr/bin/env node
'use strict';
const args = process.argv.slice(2);
const platform = args.includes('--platform') ? args[args.indexOf('--platform') + 1] : null;
const hash = platform === 'ios'
  ? ${JSON.stringify(IOS_HASH)}
  : platform === 'android'
    ? ${JSON.stringify(ANDROID_HASH)}
    : (process.env.STUB_FINGERPRINT_HASH || ${JSON.stringify(FIXTURE_FINGERPRINT_HASH)});
process.stdout.write(JSON.stringify({ hash, sources: [] }) + '\\n');
`;

    /** Copy the fixture and install both stubs over the ones `setupAsync` put there. */
    async function setupWithEasAsync(
      fixture = 'dev-client-fresh-app',
      /** Whether `app.json` names an EAS project. The lookup only runs for one that does. */
      { linked = true }: { linked?: boolean } = {}
    ): Promise<string> {
      const projectRoot = await setupAsync(fixture);
      const binDir = path.join(projectRoot, '.stub-bin');
      await fs.promises.mkdir(binDir, { recursive: true });

      const fingerprintStub = path.join(binDir, 'fingerprint-platform-stub.js');
      await fs.promises.writeFile(fingerprintStub, STUB_FINGERPRINT);
      for (const dir of [binDir, path.join(projectRoot, 'node_modules', '.bin')]) {
        await installStubBinAsync(dir, 'fingerprint', fingerprintStub);
      }
      // The shared stub `eas` (`e2e/stubs/eas.js`; the `STUB_EAS_*` variables below are documented
      // there), behind one runner because there is one rung; and the pin, so the EAS CLI is what
      // answers `whoami`.
      await installSharedStubEasAsync(projectRoot, { linked });
      await pinEasCliAsync(projectRoot);
      return projectRoot;
    }

    /** The commands the stub `eas` was asked for, in order. */
    const easCommands = stubEasCommands;

    function iosOf(report: StatusReport) {
      return report.builds!.platforms.find((platform) => platform.platform === 'ios')!;
    }

    it('asks EAS about both platforms on a plain run, and says it did', async () => {
      const projectRoot = await setupWithEasAsync();

      const report = await reportInAsync(projectRoot);

      expect(report.builds?.askedEas).toBe(true);
      expect(report.builds?.platforms.map((platform) => platform.state)).toEqual(['none', 'none']);
      expect(easCommands(projectRoot).filter((command) => command === 'build:list')).toHaveLength(
        2
      );
    });

    it('prints the eas build line with the answer, even when it is none', async () => {
      const projectRoot = await setupWithEasAsync();
      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--dev-server-url',
        await getUnusedDevServerUrlAsync(),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('eas build');
      expect(result.stdout).toContain('ios: none');
    });

    // Every platform gated before the call, so nothing was asked and nothing is owed: the freshness
    // rows carry the reason once, and a line of two `unknown`s would say it a second time.
    it('leaves the eas build line out of the human report of an unlinked project', async () => {
      const projectRoot = await setupWithEasAsync('dev-client-fresh-app', { linked: false });
      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--dev-server-url',
        await getUnusedDevServerUrlAsync(),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('eas build');
      expect(result.stdout).toContain('not linked to an EAS project');
    });

    it('asks EAS about the per-platform fingerprint, and reports the hit', async () => {
      const projectRoot = await setupWithEasAsync();

      const report = await reportInAsync(projectRoot, [], {
        STUB_EAS_BUILD_LIST: JSON.stringify([FINISHED_BUILD]),
      });

      expect(report.builds?.askedEas).toBe(true);
      expect(iosOf(report)).toMatchObject({
        state: 'found',
        source: 'eas',
        buildId: BUILD_ID,
        buildProfile: 'simulator',
        createdAt: '2026-08-19T17:37:12.674Z',
        buildUrl: 'https://expo.dev/artifacts/eas/abc.tar.gz',
        // The per-platform hash, not `freshness.hash`, which is the project's and is unchanged.
        fingerprintHash: IOS_HASH,
      });
      expect(report.freshness?.hash).toBe(FIXTURE_FINGERPRINT_HASH);
      expect(
        report.builds!.platforms.find((platform) => platform.platform === 'android')
          ?.fingerprintHash
      ).toBe(ANDROID_HASH);
    });

    // @ref llp/0021-honest-reports.rfc.md §The rules — K7(b) and K7(d). The report
    // called this project `ios: stale (no recorded build)` while EAS held a development-simulator
    // build made from this exact fingerprint [observed — cloud loop, 2026-08-27].
    it('reports a matching EAS build as fresh on the eas axis, and names it', async () => {
      const projectRoot = await setupWithEasAsync();

      const report = await reportInAsync(projectRoot, [], {
        STUB_EAS_BUILD_LIST: JSON.stringify([FINISHED_BUILD]),
      });

      const axis = (platform: string, backend: string) =>
        report.freshness!.platforms.find(
          (entry) => entry.platform === platform && entry.backend === backend
        )!;

      expect(axis('ios', 'eas')).toMatchObject({
        state: 'fresh',
        buildId: BUILD_ID,
        buildProfile: 'simulator',
      });
      expect(axis('ios', 'eas').detail).toContain('simulator build');
      // The local axis answers its own question, from this project's own record, and never carries
      // an EAS build: the two are reported apart, which is the whole point of the split.
      expect(axis('ios', 'local').buildId).toBeNull();
      expect(axis('ios', 'local').detail).not.toContain('simulator');
      // The stub answers the same list for both platforms, so android's axis is fresh too; what
      // matters is that the two axes are reported apart.
      expect(axis('android', 'eas').state).toBe('fresh');
    });

    it('says on the eas axis when EAS was asked and has nothing', async () => {
      const projectRoot = await setupWithEasAsync();

      const report = await reportInAsync(projectRoot, [], {
        STUB_EAS_BUILD_LIST: '[]',
      });

      const iosEas = report.freshness!.platforms.find(
        (entry) => entry.platform === 'ios' && entry.backend === 'eas'
      )!;
      expect(iosEas).toMatchObject({ state: 'stale', buildId: null });
      expect(iosEas.detail).toContain('no finished build');
    });

    it('pins the argv of the lookup that crossed the process boundary', async () => {
      const projectRoot = await setupWithEasAsync();
      await reportInAsync(projectRoot, []);

      const invocations = fs
        .readFileSync(path.join(projectRoot, STUB_EAS_LOG_NAME), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { args: string[] }).args);

      expect(invocations).toContainEqual([
        'build:list',
        '--platform',
        'ios',
        '--fingerprint-hash',
        IOS_HASH,
        '--status',
        'finished',
        '--limit',
        '1',
        '--json',
        '--non-interactive',
      ]);
    });

    // The other half of the decision: a hit is written against the *project* fingerprint, so the
    // next run answers it for free. A cache that still spawned would be no cache at all.
    it('answers a second run from the cache, spawning no lookup at all', async () => {
      const projectRoot = await setupWithEasAsync();
      await reportInAsync(projectRoot, [], {
        STUB_EAS_BUILD_LIST: JSON.stringify([FINISHED_BUILD]),
      });
      await fs.promises.rm(path.join(projectRoot, STUB_EAS_LOG_NAME));

      const report = await reportInAsync(projectRoot);

      expect(iosOf(report)).toMatchObject({ state: 'found', source: 'cache', buildId: BUILD_ID });
      expect(easCommands(projectRoot)).toEqual(['whoami']);
    });

    it('stops trusting the cached answer once the project fingerprint moves', async () => {
      const projectRoot = await setupWithEasAsync();
      await reportInAsync(projectRoot, [], {
        STUB_EAS_BUILD_LIST: JSON.stringify([FINISHED_BUILD]),
      });

      // Two changes, and both are the point. `STUB_FINGERPRINT_HASH` is what makes the stub print a
      // different hash, and `app.json` is what makes the *fingerprint* cache recompute at all: an
      // environment variable is not a file, so a run that only set it would be answered out of
      // `.expo/agent-cli-fingerprint.json` with the old hash and this section's cache would still
      // match (llp/0023 §What invalidates an answer). A real project moves its hash by changing a
      // file, which is what the second line stands in for.
      const configPath = path.join(projectRoot, 'app.json');
      const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
      config.expo.orientation = 'landscape';
      await fs.promises.writeFile(configPath, JSON.stringify(config));

      const report = await reportInAsync(projectRoot, [], {
        STUB_FINGERPRINT_HASH: 'aaaabbbbccccddddeeeeffff0000111122223333',
      });

      // Asked again, rather than answered from a record keyed on a hash the project no longer has.
      expect(iosOf(report)).toMatchObject({ state: 'none', source: 'eas' });
      expect(easCommands(projectRoot)).toContain('build:list');
    });

    it('reports none when EAS answered and has no build for the fingerprint', async () => {
      const projectRoot = await setupWithEasAsync();

      const report = await reportInAsync(projectRoot, []);

      expect(iosOf(report)).toMatchObject({
        state: 'none',
        source: 'eas',
        reason: expect.any(String),
      });
    });

    // The live case: `notesapp` has no EAS link, and the CLI refuses on stdout with exit 1.
    it('reports a project with no EAS link as unknown, and still exits 0', async () => {
      const projectRoot = await setupWithEasAsync();
      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--json', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        {
          env: {
            STUB_EAS_BUILD_LIST_EXIT: '1',
            STUB_EAS_BUILD_LIST_STDOUT:
              'EAS project not configured. This command cannot configure it in non-interactive mode.',
          },
        }
      );

      expect(result.exitCode).toBe(0);
      const report: StatusReport = JSON.parse(result.stdout);
      // @ref llp/0027-everything-on-eas.rfc.md §What EAS said — in this CLI's words, with the fix,
      // rather than the first line of the EAS CLI's explanation with the rest cut off.
      expect(iosOf(report)).toMatchObject({ state: 'unknown' });
      expect(iosOf(report).reason).toContain('not linked to an EAS project');
      expect(iosOf(report).reason).toContain('npx --yes eas-cli init --account');
      expect(report.errors).toEqual({});
    });

    // The auth section already answered this, so the lookup asks nobody a second time.
    it('reports a signed-out machine as unknown without calling eas build:list', async () => {
      const projectRoot = await setupWithEasAsync();

      const report = await reportInAsync(projectRoot, [], { STUB_EAS_WHOAMI_EXIT: '1' });

      expect(report.auth?.loggedIn).toBe(false);
      expect(iosOf(report)).toMatchObject({ state: 'unknown' });
      expect(iosOf(report).reason).toContain('not signed in');
      expect(easCommands(projectRoot)).toEqual(['whoami']);
    });

    it('names the download command on the human line and in the follow-ups when the build is stale', async () => {
      const projectRoot = await setupWithEasAsync();
      const env = {
        STUB_EAS_BUILD_LIST: JSON.stringify([FINISHED_BUILD]),
        // The project's own recorded build no longer matches, so a rebuild was the alternative.
        STUB_FINGERPRINT_HASH: 'aaaabbbbccccddddeeeeffff0000111122223333',
      };
      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        { env }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('eas build');
      expect(result.stdout).toContain(`npx --yes eas-cli build:download --build-id ${BUILD_ID}`);

      const report = await reportInAsync(projectRoot, [], env);
      expect(report.followups.map((followup) => followup.id)).toContain('cached-build');
    });

    // @ref llp/0011-impact-and-freshness.rfc.md §The build-cache lookup
    // A `none` used to be written nowhere, so every run of a linked project paid the network call
    // to be told the same thing. It is remembered now, for a bounded while, and the report says how
    // old the answer is — a remembered none must never read as a fresh one (llp/0021).
    it('remembers a none for a while, and says how old it is', async () => {
      const projectRoot = await setupWithEasAsync();
      await reportInAsync(projectRoot, []);
      await fs.promises.rm(path.join(projectRoot, STUB_EAS_LOG_NAME));

      const report = await reportInAsync(projectRoot, []);

      expect(iosOf(report)).toMatchObject({ state: 'none', source: 'cache' });
      expect(iosOf(report).checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(iosOf(report).ageMs).toBeGreaterThanOrEqual(0);
      // The auth section still asks `whoami`; the lookup asks nothing.
      expect(easCommands(projectRoot)).toEqual(['whoami']);

      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--dev-server-url',
        await getUnusedDevServerUrlAsync(),
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/none \(as of \d+[smh]/);
    });

    it('asks EAS again once the remembered none is older than its bound', async () => {
      const projectRoot = await setupWithEasAsync();
      await reportInAsync(projectRoot, []);
      await fs.promises.rm(path.join(projectRoot, STUB_EAS_LOG_NAME));

      // Age the record rather than wait: the bound is minutes, and the test is about the rule.
      const recordPath = path.join(projectRoot, '.expo', 'agent-cli-eas-builds.json');
      const record = JSON.parse(await fs.promises.readFile(recordPath, 'utf8'));
      const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      for (const platform of Object.keys(record)) {
        record[platform].checkedAt = old;
      }
      await fs.promises.writeFile(recordPath, JSON.stringify(record));

      const report = await reportInAsync(projectRoot, []);

      expect(iosOf(report)).toMatchObject({ state: 'none', source: 'eas' });
      expect(easCommands(projectRoot)).toContain('build:list');
    });

    // @ref llp/0023-fingerprint-caching.rfc.md §Every consumer can turn it off
    // The flag is about what the caller will accept, not which file the answer came out of: a
    // caller who refused the fingerprint record is refused the remembered EAS answer too.
    it('asks EAS again under --no-fingerprint-cache, whatever the record remembers', async () => {
      const projectRoot = await setupWithEasAsync();
      await reportInAsync(projectRoot, [], {
        STUB_EAS_BUILD_LIST: JSON.stringify([FINISHED_BUILD]),
      });
      await fs.promises.rm(path.join(projectRoot, STUB_EAS_LOG_NAME));

      const report = await reportInAsync(projectRoot, ['--no-fingerprint-cache'], {
        STUB_EAS_BUILD_LIST: JSON.stringify([FINISHED_BUILD]),
      });

      expect(iosOf(report)).toMatchObject({ state: 'found', source: 'eas' });
      expect(easCommands(projectRoot)).toContain('build:list');
    });

    // The refusal `eas build:list` prints for an unlinked project, read off `app.json` for free
    // instead of paid for with a network call. The fix it names is the one `eas init` form the
    // account is known for (llp/0027 §Check the EAS project before starting the environment).
    it('skips the lookup for a project whose app.json names no EAS project, and names eas init', async () => {
      const projectRoot = await setupWithEasAsync('dev-client-fresh-app', { linked: false });

      const report = await reportInAsync(projectRoot, []);

      expect(report.builds?.platforms.map((platform) => platform.state)).toEqual([
        'unknown',
        'unknown',
      ]);
      expect(iosOf(report).reason).toContain('not linked to an EAS project');
      expect(iosOf(report).reason).toContain('app.json names no extra.eas.projectId');
      expect(iosOf(report).reason).toContain('eas-cli init --account e2e-user --non-interactive');
      expect(easCommands(projectRoot)).toEqual(['whoami']);
      expect(report.errors).toEqual({});
    });

    // A dynamic config may fill the id in from the environment, and this CLI does not evaluate it
    // (llp/0001 §Constraints item 5) — so "not seen" is not "not there", and EAS is asked.
    it('asks EAS when the config is dynamic and the static one names no project', async () => {
      const projectRoot = await setupWithEasAsync('dev-client-fresh-app', { linked: false });
      await fs.promises.writeFile(
        path.join(projectRoot, 'app.config.js'),
        'module.exports = ({ config }) => ({ ...config, extra: { eas: { projectId: process.env.EAS_PROJECT_ID } } });\n'
      );

      const report = await reportInAsync(projectRoot, []);

      expect(iosOf(report)).toMatchObject({ state: 'none', source: 'eas' });
      expect(easCommands(projectRoot)).toContain('build:list');
    });
  });

  // @ref llp/0023-fingerprint-caching.rfc.md
  //
  // The whole subject is a number of subprocesses. A memo hit, a cache hit and a recomputation all
  // print the same hash, so the stub `fingerprint` bin's invocation log is what these assert on —
  // and the report line beside it, because an answer from a record must say so (llp/0021).
  describe('the fingerprint cache', () => {
    /** How many times the fingerprint CLI was spawned, and with which platforms. */
    function spawns(projectRoot: string): string[] {
      return readStubFingerprintInvocations(projectRoot).map((invocation) => {
        const index = invocation.args.indexOf('--platform');
        return index < 0 ? 'all' : invocation.args[index + 1]!;
      });
    }

    it('computes one fingerprint on a first default run', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');

      const report = await reportInAsync(projectRoot);

      expect(spawns(projectRoot)).toEqual(['all']);
      expect(report.freshness?.hashSource.source).toBe('computed');
      expect(report.freshness?.hashSource.revalidatedAgainst).toBeNull();
    });

    it('computes three fingerprints: the project, then one per platform', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      // The per-platform pair is computed for the EAS lookup, which only runs for a linked project.
      await linkFixtureToEasAsync(projectRoot);

      await reportInAsync(projectRoot, []);

      // The cost this wave is about. The project hash answers freshness; the EAS build lookup needs
      // a per-platform hash, because a build is made for one platform (`src/status/easBuilds.ts`).
      expect(spawns(projectRoot).sort()).toEqual(['all', 'android', 'ios']);
    });

    it('spawns nothing on the next run and says the answer came from a record', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      await reportInAsync(projectRoot, []);
      clearStubFingerprintInvocations(projectRoot);

      const report = await reportInAsync(projectRoot, []);

      expect(spawns(projectRoot)).toEqual([]);
      expect(report.freshness?.hash).toBe(FIXTURE_FINGERPRINT_HASH);
      expect(report.freshness?.hashSource.source).toBe('cache');
      expect(report.freshness!.hashSource.revalidatedAgainst!).toBeGreaterThan(0);
      expect(report.freshness?.hashSource.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // Never silent about what the revalidation could not cover.
      expect(report.freshness!.hashSource.caveats.join('\n')).toMatch(/node_modules/);
    });

    it('says so in the human report too, with the count and the way out', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      await reportInAsync(projectRoot);

      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--dev-server-url',
        await getUnusedDevServerUrlAsync(),
      ]);

      expect(result.exitCode).toBe(0);
      // The kind of check, the count, and the age — the three facts that make a cached answer
      // weighable rather than merely disclosed (llp/0023 §The report says where the answer came from).
      expect(result.stdout).toMatch(
        /from cache, revalidated by mtime\+size of \d+ files?, cached \d+[smh]/
      );
      expect(result.stdout).toContain('--no-fingerprint-cache');
      // Never a stronger claim than the check that ran.
      expect(result.stdout).not.toMatch(/content hash|sha256/i);
    });

    it('recomputes after the app config is touched', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      await reportInAsync(projectRoot);
      clearStubFingerprintInvocations(projectRoot);

      const configPath = path.join(projectRoot, 'app.json');
      const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
      config.expo.orientation = 'landscape';
      await fs.promises.writeFile(configPath, JSON.stringify(config));

      const report = await reportInAsync(projectRoot);

      expect(spawns(projectRoot)).toEqual(['all']);
      expect(report.freshness?.hashSource.source).toBe('computed');
    });

    it('recomputes after a lockfile appears', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      await reportInAsync(projectRoot);
      clearStubFingerprintInvocations(projectRoot);

      // A sentinel the project did not have. A key that *gained* an entry is a miss, because a
      // project that grew a lockfile changed what its node_modules is a function of.
      await fs.promises.writeFile(
        path.join(projectRoot, 'package-lock.json'),
        '{"lockfileVersion":3}'
      );

      await reportInAsync(projectRoot);

      expect(spawns(projectRoot)).toEqual(['all']);
    });

    it('still answers from the record after a file no sentinel names is touched', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      await reportInAsync(projectRoot);
      clearStubFingerprintInvocations(projectRoot);

      // JavaScript is not a fingerprint source, and the whole point of the pinned set is that a
      // change to it costs nothing.
      await fs.promises.writeFile(path.join(projectRoot, 'index.js'), '// edited\n');

      const report = await reportInAsync(projectRoot);

      expect(spawns(projectRoot)).toEqual([]);
      expect(report.freshness?.hashSource.source).toBe('cache');
    });

    it('recomputes after the fingerprint CLI is upgraded', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      await reportInAsync(projectRoot);
      clearStubFingerprintInvocations(projectRoot);

      // A hash from another version of the tool is not comparable with this one
      // (llp/0001 §Constraints item 5), so the entry is dropped rather than believed.
      const manifestPath = path.join(
        projectRoot,
        'node_modules',
        '@expo',
        'fingerprint',
        'package.json'
      );
      const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
      manifest.version = '0.21.0';
      await fs.promises.writeFile(manifestPath, JSON.stringify(manifest));

      const report = await reportInAsync(projectRoot);

      expect(spawns(projectRoot)).toEqual(['all']);
      expect(report.freshness?.hashSource.source).toBe('computed');
    });

    it('recomputes when --no-fingerprint-cache is passed', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      await reportInAsync(projectRoot);
      clearStubFingerprintInvocations(projectRoot);

      const report = await reportInAsync(projectRoot, ['--no-fingerprint-cache']);

      expect(spawns(projectRoot)).toEqual(['all']);
      expect(report.freshness?.hashSource.source).toBe('computed');
    });

    it('recomputes when AGENT_CLI_NO_FINGERPRINT_CACHE is set', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      await reportInAsync(projectRoot);
      clearStubFingerprintInvocations(projectRoot);

      // The variable is for the paths that have no flag of their own — a probe inside another
      // command — so it has to work on the ones that do as well.
      const report = await reportInAsync(projectRoot, [], { AGENT_CLI_NO_FINGERPRINT_CACHE: '1' });

      expect(spawns(projectRoot)).toEqual(['all']);
      expect(report.freshness?.hashSource.source).toBe('computed');
    });

    it('writes the record under .expo, keyed per platform', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      await linkFixtureToEasAsync(projectRoot);

      await reportInAsync(projectRoot, []);

      const record = JSON.parse(
        await fs.promises.readFile(
          path.join(projectRoot, '.expo', 'agent-cli-fingerprint.json'),
          'utf8'
        )
      );
      expect(Object.keys(record.entries).sort()).toEqual([
        'all|default',
        'android|default',
        'ios|default',
      ]);
      expect(Object.keys(record.entries['all|default'].keyManifest.files)).toEqual(
        expect.arrayContaining(['package.json', 'app.json', '.gitignore'])
      );
    });

    // @ref llp/0023-fingerprint-caching.rfc.md §The native directories are not pinned
    //
    // `ios/` and `android/` are outside the key [decided, 2026-08-27], and bare projects are
    // cached like any other. So a nested native edit is **not** seen here, and the record's
    // ten-minute expiry is the whole of what catches it. These cases assert that as intended
    // behaviour, through the published CLI, so the day the TTL or the key changes the tests say
    // which one moved.
    describe('a project with committed native directories', () => {
      /** `dev-client-fresh-app` plus native directories: a fixture with both is not committed. */
      async function setupBareAsync(): Promise<string> {
        const projectRoot = await setupAsync('dev-client-fresh-app');
        await fs.promises.mkdir(path.join(projectRoot, 'ios', 'App'), { recursive: true });
        await fs.promises.writeFile(
          path.join(projectRoot, 'ios', 'App', 'AppDelegate.swift'),
          'import UIKit\n'
        );
        return projectRoot;
      }

      it('answers from the record when the native tree is unchanged', async () => {
        const projectRoot = await setupBareAsync();
        await reportInAsync(projectRoot);
        clearStubFingerprintInvocations(projectRoot);

        const report = await reportInAsync(projectRoot);

        expect(spawns(projectRoot)).toEqual([]);
        expect(report.freshness?.hashSource.source).toBe('cache');
      });

      it('does not see a nested native edit, and says the expiry is what covers it', async () => {
        const projectRoot = await setupBareAsync();
        await reportInAsync(projectRoot);
        clearStubFingerprintInvocations(projectRoot);

        await fs.promises.writeFile(
          path.join(projectRoot, 'ios', 'App', 'AppDelegate.swift'),
          'import UIKit\n// a native change no lockfile records\n'
        );

        const report = await reportInAsync(projectRoot);

        // A hit, on purpose. The honest half is that the report names the gap rather than hiding it.
        expect(spawns(projectRoot)).toEqual([]);
        expect(report.freshness?.hashSource.source).toBe('cache');
        expect(report.freshness!.hashSource.caveats.join('\n')).toMatch(/ios\/ and android\//);
      });

      it('costs a bare project nothing to revalidate, however large its native tree', async () => {
        const projectRoot = await setupBareAsync();
        await reportInAsync(projectRoot);
        clearStubFingerprintInvocations(projectRoot);

        // Nothing under `ios/` is stat-ed, so a Pods tree — tens of thousands of files on a real
        // project — is neither read nor a reason to recompute. That is the saving the decision to
        // leave the native directories out of the key buys, and its cost is the case above.
        await fs.promises.mkdir(path.join(projectRoot, 'ios', 'Pods'), { recursive: true });
        await fs.promises.writeFile(
          path.join(projectRoot, 'ios', 'Pods', 'Manifest.lock'),
          'PODS: []\n'
        );

        expect((await reportInAsync(projectRoot)).freshness?.hashSource.source).toBe('cache');
        expect(spawns(projectRoot)).toEqual([]);
      });
    });
  });

  describe('bare-app — committed native directories', () => {
    it('reports the project as bare and plans a build', async () => {
      const report = await reportAsync('bare-app');

      expect(report.project?.native).toBe('bare');
      expect(report.project?.nativeDirs).toEqual({ ios: true, android: true });
      expect(report.next?.rule).toBe('bare-stale');
    });

    it('names the checked-in native directories in the human report', async () => {
      const projectRoot = await setupAsync('bare-app');
      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--dev-server-url',
        await getUnusedDevServerUrlAsync(),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bare (ios, android)');
    });
  });

  // @ref llp/0015-backend-selection-and-config.rfc.md §What `status` reports
  describe('where the next build would run', () => {
    it('says nothing about a build for a project whose next plan has none', async () => {
      const projectRoot = await setupAsync('go-app');
      const report = await reportInAsync(projectRoot);
      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--dev-server-url',
        await getUnusedDevServerUrlAsync(),
      ]);

      expect(report.next?.buildLocation).toBeNull();
      expect(result.stdout).not.toMatch(/^build\s/m);
    });

    it('names the place and the cause for a project that needs one', async () => {
      const report = await reportAsync('dev-client-app');

      expect(report.next?.buildLocation).not.toBeNull();
      expect(['local', 'eas']).toContain(report.next!.buildLocation!.runsOn);
      // Something chose it, and said so in a sentence every other surface prints too.
      expect(report.next!.buildLocation!.selection!.because).toBeTruthy();
    });

    it('reports the backend the project config asked for, in both outputs', async () => {
      const projectRoot = await setupAsync('dev-client-app');
      const file = path.join(projectRoot, 'package.json');
      const packageJson = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      packageJson.expo = { ...packageJson.expo, 'agent-cli': { buildBackend: 'eas' } };
      await fs.promises.writeFile(file, JSON.stringify(packageJson, null, 2));

      const report = await reportInAsync(projectRoot);
      expect(report.next!.buildLocation).toMatchObject({
        runsOn: 'eas',
        selection: { source: 'config' },
      });

      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--dev-server-url',
        await getUnusedDevServerUrlAsync(),
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('build ');
      expect(result.stdout).toContain('"expo.agent-cli" in package.json');
    });

    // `status` exits 0 by contract, and a preference file it cannot read must not change that:
    // every other line of the report is still a fact worth having.
    it('still reports everything else when the config cannot be read', async () => {
      const projectRoot = await setupAsync('dev-client-app');
      const file = path.join(projectRoot, 'package.json');
      const packageJson = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      packageJson.expo = { ...packageJson.expo, 'agent-cli': { buildBackend: 'cloud' } };
      await fs.promises.writeFile(file, JSON.stringify(packageJson, null, 2));

      const report = await reportInAsync(projectRoot);

      expect(report.project?.name).toBeTruthy();
      expect(report.next?.rule).toBe('dev-client-stale');
    });
  });

  describe('the dev server section', () => {
    let server: Server | undefined;

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = undefined;
      }
    });

    it('reports a running dev server and the app connected to it', async () => {
      const projectRoot = await setupAsync('go-app');
      const devServer = await startDevServerDoubleAsync([CDP_TARGET]);
      server = devServer.server;

      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--json',
        '--dev-server-url',
        devServer.url,
      ]);

      expect(result.exitCode).toBe(0);
      const report: StatusReport = JSON.parse(result.stdout);
      // `toMatchObject` and then the one key that cannot be pinned: `openUrls` carries this
      // machine's LAN address, and a test that asserted one would pass or fail by which network the
      // suite is on. What it *can* pin is the form — Expo Go's, for a project with no dev client.
      expect(report.devServer).toMatchObject({
        url: devServer.url,
        running: true,
        appsConnected: 1,
        appsListed: 1,
        appsStale: 0,
        // The double answers the target list and 404s everything else, so it is reachable and its
        // bundler is not ready — which is exactly what a port that is not Metro looks like.
        source: 'flag',
        ready: false,
        projectRootMatched: null,
        hostType: null,
        tunnelUrl: null,
      });
      expect(Object.keys(report.devServer!).sort()).toEqual([
        'appsConnected',
        'appsListed',
        'appsStale',
        'hostType',
        'openUrls',
        'projectRootMatched',
        'ready',
        'running',
        'source',
        'tunnelUrl',
        'url',
      ]);
      expect(report.devServer!.openUrls.every((connect) => connect.url.startsWith('exp://'))).toBe(
        true
      );
    });

    // The readiness probe of status is short and never waits for a bundle, so this asserts the
    // answer a dev server that has already finished gives.
    it('reports a ready bundler and the project it serves', async () => {
      const projectRoot = await setupAsync('go-app');
      const stub = await startStubDevServerAsync({ projectRoot, targets: [CDP_TARGET] });

      try {
        const result = await executeAgentCliAsync(projectRoot, [
          'status',
          '--json',
          '--dev-server-url',
          stub.url,
        ]);

        expect(JSON.parse(result.stdout).devServer).toMatchObject({
          url: stub.url,
          running: true,
          appsConnected: 1,
          appsListed: 1,
          appsStale: 0,
          source: 'flag',
          ready: true,
          projectRootMatched: true,
          hostType: null,
          tunnelUrl: null,
        });
      } finally {
        await stub.close();
      }
    });

    // The report used to say "running on http://127.0.0.1:8099" and, three lines below it,
    // "next  @expo/agent-cli dev → expo-go: expo start --go" — advice to start a second dev server, which
    // is both a contradiction and a command that would fail on the busy port.
    it('sends a healthy dev server to verification instead of to a second dev server', async () => {
      const projectRoot = await setupAsync('go-app');
      const stub = await startStubDevServerAsync({ projectRoot, targets: [CDP_TARGET] });

      try {
        const result = await executeAgentCliAsync(projectRoot, [
          'status',
          '--json',
          '--dev-server-url',
          stub.url,
        ]);

        const report: StatusReport = JSON.parse(result.stdout);
        expect(report.next?.command).toMatch(/^npx @expo\/agent-cli smoke --(ios|android)$/);
        expect(report.next?.why).toContain('instead of starting a second server');
        // The project's own shape is still reported: a running server does not change it.
        expect(report.next?.rule).toBe('expo-go');
        expect(report.next?.steps).toEqual([]);
      } finally {
        await stub.close();
      }
    });

    it('prints the reason on the human next line', async () => {
      const projectRoot = await setupAsync('go-app');
      const stub = await startStubDevServerAsync({ projectRoot, targets: [CDP_TARGET] });

      try {
        const result = await executeAgentCliAsync(projectRoot, [
          'status',
          '--dev-server-url',
          stub.url,
        ]);

        expect(result.stdout).toContain('@expo/agent-cli smoke');
        expect(result.stdout).not.toContain('@expo/agent-cli dev → expo-go');
      } finally {
        await stub.close();
      }
    });

    // A dev server that serves someone else is not this project's, so the plan still stands.
    it('keeps the plan when the dev server belongs to another project', async () => {
      const projectRoot = await setupAsync('go-app');
      const stub = await startStubDevServerAsync({ projectRoot: '/somewhere/else', targets: [] });

      try {
        const result = await executeAgentCliAsync(projectRoot, [
          'status',
          '--json',
          '--dev-server-url',
          stub.url,
        ]);

        const report: StatusReport = JSON.parse(result.stdout);
        expect(report.next?.command).toBe(
          `npx @expo/agent-cli dev --${process.platform === 'darwin' ? 'ios' : 'android'}`
        );
        expect(report.next?.why).toBeNull();
      } finally {
        await stub.close();
      }
    });

    it('names another project as the owner of the dev server that answered', async () => {
      const projectRoot = await setupAsync('go-app');
      const stub = await startStubDevServerAsync({ projectRoot: '/somewhere/else', targets: [] });

      try {
        const result = await executeAgentCliAsync(projectRoot, [
          'status',
          '--dev-server-url',
          stub.url,
        ]);

        expect(result.stdout).toContain('serves another project');
      } finally {
        await stub.close();
      }
    });

    it('prints the running dev server and its connected app for a human', async () => {
      const projectRoot = await setupAsync('go-app');
      const devServer = await startDevServerDoubleAsync([CDP_TARGET]);
      server = devServer.server;

      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--dev-server-url',
        devServer.url,
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`running on ${devServer.url}`);
      expect(result.stdout).toContain('1 app connected');
    });

    it('reports a dev server without a connected app', async () => {
      const projectRoot = await setupAsync('go-app');
      const devServer = await startDevServerDoubleAsync([]);
      server = devServer.server;

      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--json',
        '--dev-server-url',
        devServer.url,
      ]);

      expect(result.exitCode).toBe(0);
      const report: StatusReport = JSON.parse(result.stdout);
      expect(report.devServer).toMatchObject({ running: true, appsConnected: 0 });
    });

    it('reports a dev server that does not answer, still exiting 0', async () => {
      const report = await reportAsync('go-app');

      expect(report.devServer?.running).toBe(false);
      expect(report.devServer?.appsConnected).toBe(0);
      expect(report.devServer?.reason).toBeTruthy();
    });

    // @ref llp/0004-smart-start-and-project-state.rfc.md §Status
    // With no `--dev-server-url`, discovery asks the project's dev-server lock before it scans
    // ports. The lock is held by this test, standing in for a running `@expo/agent-cli start`.
    it('finds the dev server the project lock names, with no URL given', async () => {
      const projectRoot = await setupAsync('go-app');
      const devServer = await startDevServerDoubleAsync([CDP_TARGET]);
      server = devServer.server;
      const releaseLock = await holdDevLockAsync(projectRoot, {
        url: devServer.url,
        port: Number(new URL(devServer.url).port),
        pid: process.pid,
        startedAt: new Date().toISOString(),
        projectRoot,
      });

      try {
        const result = await executeAgentCliAsync(projectRoot, ['status', '--json']);

        expect(result.exitCode).toBe(0);
        const report: StatusReport = JSON.parse(result.stdout);
        // An ephemeral port, so no scan of 8081-8085 could have found it — and `source` now says
        // which step did.
        expect(report.devServer).toMatchObject({
          url: devServer.url,
          running: true,
          appsConnected: 1,
          appsListed: 1,
          appsStale: 0,
          source: 'lock',
          ready: false,
          projectRootMatched: null,
          hostType: null,
          tunnelUrl: null,
        });
      } finally {
        releaseLock();
      }
    });

    it('ignores a lock whose dev server is gone', async () => {
      const projectRoot = await setupAsync('go-app');
      const goneUrl = await getUnusedDevServerUrlAsync();
      const releaseLock = await holdDevLockAsync(projectRoot, {
        url: goneUrl,
        port: Number(new URL(goneUrl).port),
        pid: process.pid,
        startedAt: new Date().toISOString(),
        projectRoot,
      });

      try {
        const result = await executeAgentCliAsync(projectRoot, ['status', '--json']);

        expect(result.exitCode).toBe(0);
        const report: StatusReport = JSON.parse(result.stdout);
        // The lock is probed, never trusted, so a URL that does not answer is not the answer.
        // What discovery falls through to depends on the machine, so only this is asserted.
        expect(report.devServer?.url).not.toBe(goneUrl);
      } finally {
        releaseLock();
      }
    });

    // @ref llp/0004-smart-start-and-project-state.rfc.md §Discovery ladder
    // The regression this pins was invisible to every other test: the report was correct, complete
    // and printed at 263 ms, and the process then sat for another 1321 ms on timers no probe was
    // waiting for any more [observed — `friction/run7/tapapp`, 2026-08-27]. An agent loop pays that
    // on every `status`, and nothing in the output says so — only the exit does.
    //
    // Measured against the *named* path in the same run rather than against a fixed number, so the
    // test states the property it means — discovery costs about what naming a dead port costs — and
    // does not have to be retuned per machine. The margin is wide on purpose: it is well under the
    // 1321 ms it exists to catch and well over the spread of two process spawns.
    it('exits as promptly when it discovers the dev server as when it is named', async () => {
      const projectRoot = await setupAsync('go-app');
      const deadUrl = await getUnusedDevServerUrlAsync();

      const timeAsync = async (args: string[]): Promise<number> => {
        // Best of four: what is under test is the floor, and a scheduler hiccup only ever raises a
        // sample above it — so **more samples only ever make this estimate truer**, and cannot
        // inflate it the way they would for a mean. Two was not enough. The suite runs sharded and
        // in parallel, so both samples of one side landing on a busy moment is ordinary, and that
        // is the whole of the flake this row had [observed — 2026-09-06]. Four spawns per side cost
        // about two seconds against a 60s budget.
        const runs: number[] = [];
        for (let attempt = 0; attempt < 4; attempt++) {
          const startedAt = Date.now();
          const result = await executeAgentCliAsync(projectRoot, args);
          expect(result.exitCode).toBe(0);
          runs.push(Date.now() - startedAt);
        }
        return Math.min(...runs);
      };

      const named = await timeAsync(['status', '--json', '--dev-server-url', deadUrl]);
      const discovered = await timeAsync(['status', '--json']);

      expect(discovered - named).toBeLessThan(750);
    }, 60_000);

    it('rejects a `--dev-server-url` that is not a URL', async () => {
      const projectRoot = await setupAsync('go-app');
      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--dev-server-url', 'not a url'],
        { reject: false }
      );

      // A flag the user got wrong is an argument error, not a status the command can report.
      expect(result.exitCode).toBe(1);
      expect(result.all).toContain('--dev-server-url');
    });
  });

  describe('broken-app — a dependency missing from node_modules', () => {
    it('still reports the sections it can read', async () => {
      const report = await reportAsync('broken-app');

      expect(report.project?.name).toBe('broken-app');
      expect(report.next).not.toBeNull();
      expect(report.devServer?.running).toBe(false);
    });
  });
});

// @ref llp/0015-backend-selection-and-config.rfc.md §The selection — named, not taken. A `next`
// has to be a line that runs, and a bare `dev` stops on a route detection chose.
describe('status on a machine that cannot build', () => {
  // `status` takes no platform flag: it plans for the host's default, iOS on a Mac and Android
  // elsewhere. A broken `xcode-select` makes a Mac the machine that cannot build; on the other
  // runners the default is Android and the runner's own Android SDK decides, so this case says
  // nothing there [observed — tier0-linux and tier0-windows, 2026-09-09].
  it.skipIf(process.platform !== 'darwin')(
    'offers dev --eas as the next step, and says why in the plan',
    async () => {
      const projectRoot = await setupAsync('dev-client-app');
      await breakXcodeSelectAsync(projectRoot);

      const report = await reportInAsync(projectRoot);

      expect(report.next!.command).toBe('npx @expo/agent-cli dev --ios --eas');
      expect(report.next!.steps.map((step) => step.argv[0])).toContain('eas');
    }
  );
});
