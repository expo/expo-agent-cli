// Fakes and builders shared by the `phases*-test.ts` files: each case is a set of answers and the
// verdict they add up to (@ref ./phases-test).

import type { ScreenshotResult } from '../../device/screenshot';
import type { OpenRouteResult } from '../../navigate/openRoute';
import type { BundleCheckResult } from '../../runtime/bundleCheck';
import type { DevServerDiscovery } from '../../runtime/devServer';
import type { RuntimeErrorRecord } from '../../runtime/runtimeErrorCollector';
import type { SmokeDeps, SmokeRun } from '../contract';
import { silentProgress } from '../progress';
import type { SmokeOptions } from '../resolveOptions';
import type { SmokePhaseId, SmokePhaseStatus } from '../types';

export function options(overrides: Partial<SmokeOptions> = {}): SmokeOptions {
  return {
    route: null,
    platform: 'ios',
    cloud: 'fallback',
    configuredEas: false,
    // Off by default *in this table*, and on by default in the command: almost every case below is
    // about a machine that already has a dev server and a device, and a helper that bootstrapped
    // would make each of them assert the absence of a start it never needed.
    bootstrap: false,
    windowMs: 3_000,
    timeoutMs: 60_000,
    screenshotPath: null,
    screenshot: true,
    devServerUrl: null,
    routeCheck: true,
    // On by default here *and* in the command, unlike `bootstrap` above: this is the flag that
    // decides whether the four phases below the `app` one are about the code on disk, so a table
    // that defaulted it off would be a table of the bug it was added to remove.
    reload: true,
    json: true,
    followups: false,
    ...overrides,
  };
}

export function discovery(overrides: Partial<DevServerDiscovery> = {}): DevServerDiscovery {
  return {
    reachable: true,
    targets: [],
    devServerUrl: 'http://127.0.0.1:8081',
    source: 'lock',
    discovered: true,
    ...overrides,
  };
}

export function bundle(overrides: Partial<BundleCheckResult> = {}): BundleCheckResult {
  return {
    outcome: 'ok',
    platform: 'ios',
    url: 'http://127.0.0.1:8081/index.bundle?platform=ios',
    error: null,
    waitedMs: 12,
    ...overrides,
  };
}

export function opened(overrides: Partial<OpenRouteResult> = {}): OpenRouteResult {
  return {
    route: '/',
    url: 'exp://127.0.0.1:8081/--/?',
    devServerUrl: 'http://127.0.0.1:8081',
    devServerSource: 'lock',
    devServerReachable: true,
    deviceBackend: 'local-ios',
    hostType: 'localhost',
    connect: [{ target: 'expo-go', label: 'Expo Go', url: 'exp://127.0.0.1:8081' }],
    resolution: 'target app is Expo Go',
    target: 'expo go',
    platform: 'ios',
    deviceId: 'SIM-1',
    appId: null,
    command: 'xcrun simctl openurl SIM-1 exp://127.0.0.1:8081/--/?',
    exitCode: 0,
    stdout: '',
    stderr: '',
    routeCheck: { checked: true, ok: true, matched: '/', routeCount: 4, reason: null },
    isExpoGo: true,
    // `smoke` has an app-connection phase of its own, so its opens never wait for one — and the
    // launcher-first ladder of F123 needs a budget to wait with, so it never fires here either.
    launch: null,
    adbPath: null,
    reverse: null,
    attach: {
      checked: false,
      confirmed: null,
      waitedMs: 0,
      targets: 0,
      loaded: null,
      recovery: null,
      alert: null,
      reason: 'this run did not wait for the app to attach',
    },
    ...overrides,
  };
}

export function screenshot(overrides: Partial<ScreenshotResult> = {}): ScreenshotResult {
  return {
    path: '/project/.expo/agent-cli/smoke.png',
    ok: true,
    reason: null,
    platform: 'ios',
    deviceId: 'SIM-1',
    command: 'xcrun simctl io SIM-1 screenshot /project/.expo/agent-cli/smoke.png',
    bytes: 1024,
    ...overrides,
  };
}

/**
 * One record the gate fails on.
 *
 * `source: 'console'` on purpose, and that is the finding this whole file turns on: React Native
 * does not deliver an uncaught throw as `Runtime.exceptionThrown`, it reports it through the
 * console path [observed — 2026-08-24, live]. A fixture that used `source: 'exception'` would be
 * a fixture of a runtime this command never talks to, and every assertion below would pass for a
 * gate that lets real crashes through.
 */
export function record(overrides: Partial<RuntimeErrorRecord> = {}): RuntimeErrorRecord {
  return {
    source: 'console',
    timestamp: 1,
    message: 'Error: BOOM',
    stack: '  at boom (src/app/index.tsx:12:3)',
    isError: true,
    ...overrides,
  };
}

/** Every dependency answering the way a healthy project answers. */
export function deps(overrides: Partial<SmokeDeps> = {}): SmokeDeps {
  let clock = 0;
  return {
    discoverDevServer: async () => discovery(),
    startDevServer: async () => ({ ok: true, devServerUrl: 'http://127.0.0.1:8081', reason: null }),
    stopDevServer: async () => ({ ok: true, target: 'http://127.0.0.1:8081', reason: null }),
    releaseDevice: async () => ({ ok: true, target: 'SIM-BOOTED', reason: null }),
    readBoundDevice: () => null,
    bootDevice: async () => ({
      ok: true,
      deviceId: 'SIM-BOOTED',
      backend: 'local-ios' as const,
      reason: null,
    }),
    // A session that was already up, by default: the `--eas` cases override it.
    ensureEasSession: async () => ({
      ok: true,
      sessionId: 'sess-up',
      started: false,
      reason: null,
    }),
    cloudRoute: { current: 'fallback' },
    stopEasSession: async (sessionId) => ({ ok: true, target: sessionId, reason: null }),
    // Nothing to install by default: the device this run settled on already has the app.
    installNeededOnDevice: async () => false,
    installApp: async () => ({ ok: true, version: null, replaced: null, reason: null }),
    // Settled by default: the wait before the picture has its own cases (F57).
    waitForStableTargets: async () => ({ stable: true }),
    waitForBundlerReady: async () => ({
      ready: true,
      projectRootMatched: true,
      reportedProjectRoot: '/project',
      timedOut: false,
      waitedMs: 5,
      skippedApps: [],
    }),
    checkEntryBundle: async () => bundle(),
    waitForAppConnection: async () => ({
      appsConnected: 1,
      timedOut: false,
      waitedMs: 3,
      skippedApps: [],
    }),
    probeDevice: async () => ({ deviceId: 'SIM-1', backend: 'local-ios' as const, reason: null }),
    openRoute: async (route) => opened({ route }),
    // The ordinary case: the app that answered is one this project can run, with nothing to note.
    checkAppFitsProject: async () => ({ mismatch: null, kind: null, note: null }),
    // @ref ../contract §SmokeDeps.explainSilentApp — nothing on the device explains a wait that
    // expired, which is the ordinary answer: a slow app is not a wrong app.
    explainSilentApp: async () => null,
    // A reload the dev server's own command socket proved, which is the healthy local case.
    reloadApp: async () => ({
      ok: true,
      verifiedBy: 'message-socket-peers' as const,
      knownTargetIds: ['page-1'],
      freshTargets: 0,
      commandSocketReconnected: true,
      targetOutcomes: [],
      bundleServed: false,
      reason: null,
    }),
    evaluate: async () => ({ ok: true, unsupported: false, reason: null }),
    collectErrors: async () => ({ ok: true, records: [], reason: null }),
    captureScreenshot: async () => screenshot(),
    // @ref ./progress §silentProgress — the walk narrates itself on stderr, and these cases are
    // about the outcome table rather than about the prose. The cases that *are* about the narration
    // pass a recorder of their own.
    progress: silentProgress,
    // Monotonic and coarse, so every phase reports a duration a test can assert on.
    now: () => (clock += 10),
    ...overrides,
  };
}

/** A machine with no device until the run boots one; its probe then finds the device booted. */
export function bootableDevice(
  boot: SmokeDeps['bootDevice'] = async () => ({
    ok: true,
    deviceId: 'SIM-BOOTED',
    backend: 'local-ios' as const,
    reason: null,
  })
): Pick<SmokeDeps, 'probeDevice' | 'bootDevice'> {
  let found: Awaited<ReturnType<SmokeDeps['probeDevice']>> = {
    deviceId: null,
    backend: null,
    reason: 'no simulator',
  };
  return {
    probeDevice: async () => found,
    bootDevice: async () => {
      const booted = await boot();
      if (booted.ok && booted.deviceId) {
        found = { deviceId: booted.deviceId, backend: booted.backend, reason: null };
      }
      return booted;
    },
  };
}

/** One phase's status, by id, so a case reads as a table row. */
export function statusOf(run: SmokeRun, id: SmokePhaseId): SmokePhaseStatus | undefined {
  return run.phases.find((phase) => phase.id === id)?.status;
}

/** A clock that moves `ms` forward on every read. */
export function steppingClock(ms: number): () => number {
  let clock = 0;
  return () => (clock += ms);
}
