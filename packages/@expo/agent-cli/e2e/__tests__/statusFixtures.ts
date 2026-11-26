// Helpers shared by `status-test.ts`, `status-builds-test.ts`, `status-devices-test.ts`,
// `status-expo-go-test.ts` and `status-impact-test.ts`: fixture setup, stub bins, and the
// `status --json` report shape.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { WebSocketServer } from 'ws';

import { BOOTED_SIMULATOR, installStubAdbAsync, installStubXcrunAsync } from './installedAppStubs';
import {
  executeAgentCliAsync,
  installStubBinAsync,
  installStubEasRunnerAsync,
  installStubFingerprintAsync,
  readEvents,
  setupFixtureAsync,
} from '../utils';

/** The shape `status --json` prints, per `src/status/types.ts`. */
export type StatusReport = {
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
    /** Null when no file-level view was available. */
    changedFiles: { total: number; native: number; js: number; config: number } | null;
    ota: {
      safe: boolean | null;
      runtimeVersion: {
        policy: string | null;
        literal: string | null;
        source: string | null;
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
  orphanSessions: { platform: string; id: string; projectRoot: string; command: string }[];
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
export const FIXTURE_FINGERPRINT_HASH = '0f1e2d3c4b5a69788796a5b4c3d2e1f001234567';

/** One debugger target, the shape `expo start` reports for a connected app. */
export const CDP_TARGET = {
  id: '1',
  appId: 'host.exp.Exponent',
  title: 'Expo Go',
  type: 'native',
  description: '',
  devtoolsFrontendUrl: '/devtools',
  webSocketDebuggerUrl: 'ws://127.0.0.1/inspector/debug?device=1&page=1',
};

/** Copy a fixture and install both stub bins the status sections may reach for. */
export async function setupAsync(fixtureName: string): Promise<string> {
  const projectRoot = await setupFixtureAsync(fixtureName);
  await installStubFingerprintAsync(projectRoot);
  return projectRoot;
}

/** Runtime follow-ups require the connected app's device to belong to this worktree. */
export async function bindDefaultDeviceAsync(projectRoot: string): Promise<Record<string, string>> {
  if (process.platform === 'darwin') {
    await installStubXcrunAsync(projectRoot, { simulators: [BOOTED_SIMULATOR] });
    return {};
  }
  return (await installStubAdbAsync(projectRoot, 'host.exp.Exponent')).env;
}

/** A host where `dev` would bind the default platform's device, and no device bound yet. */
export async function stubUnboundDeviceAsync(projectRoot: string): Promise<Record<string, string>> {
  if (process.platform === 'darwin') {
    await installStubXcrunAsync(projectRoot);
    return { AGENT_CLI_NO_DEVICE: '0' };
  }
  const adb = await installStubAdbAsync(projectRoot, 'host.exp.Exponent', { attached: false });
  return { ...adb.env, AGENT_CLI_NO_DEVICE: '0' };
}

/** A dev server double that answers the debugger target list, and the port it listens on. */
export async function startDevServerDoubleAsync(
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
export async function getUnusedDevServerUrlAsync(): Promise<string> {
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
export const DEVICES_ON = { AGENT_CLI_NO_DEVICE: '0' };

export async function reportInAsync(
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
export async function reportAsync(fixtureName: string): Promise<StatusReport> {
  return reportInAsync(await setupAsync(fixtureName));
}

/**
 * Point the copied `go-app` at the SDK major this CLI captured an Expo Go dump for.
 *
 * Fixtures ship `expo@54.0.0`, and a miss falls back to the short `bundledNativeModules.json`.
 * These tests are about the dump, so the installed `expo` version has to match it.
 */
export const DUMP_SDK_VERSION = '57.0.0';

export async function useCapturedGoDumpAsync(projectRoot: string): Promise<void> {
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
export async function addNativeModuleAsync(
  projectRoot: string,
  packageName: string
): Promise<void> {
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

export async function goAppOnDumpSdkAsync(): Promise<string> {
  const projectRoot = await setupAsync('go-app');
  await useCapturedGoDumpAsync(projectRoot);
  return projectRoot;
}

/** Write the native projects `expo prebuild` generates, plus the template gitignore that covers them. */
export async function writePrebuildOutputAsync(projectRoot: string): Promise<void> {
  await fs.promises.writeFile(path.join(projectRoot, '.gitignore'), '/ios\n/android\n');
  await fs.promises.mkdir(path.join(projectRoot, 'ios'), { recursive: true });
  await fs.promises.mkdir(path.join(projectRoot, 'android'), { recursive: true });
  await fs.promises.writeFile(path.join(projectRoot, 'ios', 'Podfile'), '');
  await fs.promises.writeFile(path.join(projectRoot, 'android', 'build.gradle'), '');
}

export function git(projectRoot: string, args: string[]): void {
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

export async function initGitRepoAsync(projectRoot: string): Promise<void> {
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
export async function pinEasCliAsync(projectRoot: string): Promise<void> {
  const manifestPath = path.join(projectRoot, 'package.json');
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  manifest.devDependencies = { ...manifest.devDependencies, 'eas-cli': '^22.0.0' };
  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

/**
 * Install a `fingerprint` bin that the test steers through env: `STUB_FINGERPRINT_HASH` and
 * `STUB_FP_SOURCES`. The fixture's own stub always prints an empty list, so it can never move the
 * native surface. `diff` also answers `fingerprint:diff`; `platformHashes` gives each `--platform`
 * its own hash.
 */
export async function installEnvFingerprintStubAsync(
  projectRoot: string,
  {
    diff = false,
    platformHashes = {},
  }: { diff?: boolean; platformHashes?: Partial<Record<'ios' | 'android', string>> } = {}
): Promise<void> {
  const diffAnswer = `
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
}`;
  const script = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);${diff ? diffAnswer : ''}
const platform = args.includes('--platform') ? args[args.indexOf('--platform') + 1] : null;
const platformHashes = ${JSON.stringify(platformHashes)};
const hash =
  platformHashes[platform] ||
  process.env.STUB_FINGERPRINT_HASH ||
  ${JSON.stringify(FIXTURE_FINGERPRINT_HASH)};
const sources = JSON.parse(process.env.STUB_FP_SOURCES || '[]');
process.stdout.write(JSON.stringify({ hash, sources }) + '\\n');
`;
  const binDir = path.join(projectRoot, '.stub-bin');
  await fs.promises.mkdir(binDir, { recursive: true });
  const stub = path.join(binDir, 'fingerprint-env-stub.js');
  await fs.promises.writeFile(stub, script);
  for (const dir of [binDir, path.join(projectRoot, 'node_modules', '.bin')]) {
    await installStubBinAsync(dir, 'fingerprint', stub);
  }
}

/**
 * Install an `eas` bin that answers `whoami`, on the `PATH` the wrapper searches.
 *
 * The auth section runs a real subprocess, so without a stub the report would say whatever the
 * machine running the suite happens to be signed in as.
 *
 * @param user the account it names, or null for a CLI that refuses because nobody is signed in
 */
export async function installStubEasAsync(
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

/** The top-level keys of `status --json`, in order: the command's contract. */
export const REPORT_KEYS = [
  'project',
  'expoGo',
  'freshness',
  'installed',
  'builds',
  'devServer',
  'device',
  'binding',
  'orphanSessions',
  'skills',
  'auth',
  'next',
  'assertion',
  'probe',
  'errors',
  'followups',
];

export function statusEvent(eventsFile: string): Record<string, unknown> | undefined {
  return readEvents(eventsFile).find((entry) => entry._e === 'cli:status');
}
