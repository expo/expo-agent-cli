// @ref llp/0004-smart-start-and-project-state.rfc.md
// Shared contract for the project-state probe, the Expo Go compatibility check, the
// post-install impact classifier, and the smart start plan engine. Pure data — no I/O here.
import type { DeviceAction } from '../deviceClaims/types';
import type { RunsOn } from '../toolchain/runsOn';
import type { PlanBuildLocation } from '../toolchain/types';
import type { FingerprintResult, FingerprintSource } from './fingerprint';

/**
 * How the app is expected to run during development.
 *
 * `none` is the one value that is not a way of running the app: it is what a directory that is not
 * an Expo app gets, because there is no app here to run in any of the others
 * (llp/0004-smart-start-and-project-state.rfc.md §Not an Expo app).
 */
export type ProjectTarget = 'expo-go' | 'dev-client' | 'bare' | 'web' | 'none';

/** One reason a project cannot run in Expo Go. */
export interface ExpoGoIncompatibility {
  kind: 'unbundled-native-module' | 'config-plugin' | 'custom-native-code' | 'unknown-sdk';
  /** The offending package or plugin, when one exists. */
  packageName?: string;
  /** Human/agent readable explanation. */
  detail: string;
}

export interface ExpoGoCompatibility {
  compatible: boolean;
  reasons: ExpoGoIncompatibility[];
}

/** Everything the decision table needs, gathered by the probe. All fields are observable
 * without a device: device/simulator install state is intentionally out of scope for v1. */
export interface ProjectState {
  projectRoot: string;
  /**
   * The project's `package.json` declares `expo` as a dependency — which is what makes a package
   * an Expo app.
   *
   * **Declared, not installed**, and deliberately so: a fresh clone with no `node_modules` is the
   * most ordinary state a real project is ever in, and reading the installed package instead would
   * call every one of them "not an Expo app". {@link sdkVersion} is the installed half, and the
   * two answer different questions.
   *
   * @see llp/0004-smart-start-and-project-state.rfc.md §Not an Expo app
   */
  isExpoApp: boolean;
  /** From the installed `expo` package, e.g. "54.0.0". Null when unresolvable. */
  sdkVersion: string | null;
  /**
   * Bare native project directories **checked into the repo** (vs CNG).
   *
   * Presence on disk is not enough: `expo prebuild` writes `ios/` and `android/` that
   * `.gitignore` ignores. Those do not count. See `readProjectNativeDirsAsync`.
   */
  nativeDirs: { ios: boolean; android: boolean };
  /** `expo-dev-client` is a dependency. */
  usesDevClient: boolean;
  /** `react-native-web` is a dependency. */
  hasWeb: boolean;
  expoGo: ExpoGoCompatibility;
  /**
   * `@expo/fingerprint` hash of the native surface, via subprocess. Null + error when the
   * fingerprint CLI is unavailable or fails.
   *
   * `sources` is what the hash was computed from — the half a diff needs, and the half `status`
   * strips before it prints the probe, because it is tens of thousands of bytes and a report
   * about freshness has nothing to say about any of them.
   *
   * The provenance fields ride along whole (llp/0023): a `--json` reader gets the same `source`,
   * `revalidatedAgainst` and `computedAt` the printed report says, so nothing has to infer whether
   * the hash was measured or revalidated.
   */
  fingerprint: Omit<FingerprintResult, 'sources'> & { sources?: FingerprintSource[] | null };
}

/** Classification of one installed package's impact on the native surface. */
export type InstallImpact = 'js-only' | 'native-module' | 'config-plugin';

export interface InstallImpactReport {
  packageName: string;
  impact: InstallImpact;
  /** Bundled in Expo Go for the project's SDK (per bundledNativeModules.json). */
  expoGoBundled: boolean;
  /** What must rerun after installing this package. */
  action: 'none' | 'reload' | 'prebuild-and-build' | 'native-sync';
  reasons: string[];
}

/** Rough duration class, for plan-with-cost display. Never a precise estimate. */
export type TimeClass = 'seconds' | 'a-minute' | 'minutes' | 'many-minutes';

/** One executable step of a smart start plan. `argv` is always an Expo-family CLI
 * invocation run as a subprocess (process boundary, llp/0001 constraint 5). */
export interface PlanStep {
  id: string;
  /** e.g. ["expo", "prebuild", "--platform", "ios"] — argv[0] names the CLI. */
  argv: string[];
  reason: string;
  timeClass: TimeClass;
  /**
   * Where this step runs: `local` on this machine, `eas` in the cloud, `null` when it builds
   * nothing and the question does not apply to it.
   *
   * @see llp/0004-smart-start-and-project-state.rfc.md §Where a build runs
   */
  runsOn: RunsOn | null;
}

export interface StartPlan {
  target: ProjectTarget;
  steps: PlanStep[];
  /** Decision-table row that produced this plan, for tests and debugging. */
  rule: string;
  reasons: string[];
  /**
   * Where the build in this plan runs and what that place needs, or `null` when the plan builds
   * nothing. Filled in by `decideStartPlan`; the machine's own answer is folded in afterwards by
   * `applyToolchainProbe`, so the decision table stays a pure function of probed project state.
   *
   * @see llp/0004-smart-start-and-project-state.rfc.md §Where a build runs
   */
  buildLocation: PlanBuildLocation | null;
  /**
   * The EAS build this plan rests on instead of making one, when the device is an EAS Simulator.
   *
   * Set only by a plan for `deviceBackend: 'eas'` that found a finished build of this fingerprint
   * (llp/0027 §Reuse). The run hands its id to `eas simulator --build-id`. Absent or null otherwise.
   */
  easBuild?: { id: string; profile: string } | null;
  /**
   * The port of the plan's dev server, and what the plan does about it. Absent from a plan `dev`
   * did not resolve a port for.
   *
   * @see llp/0004-smart-start-and-project-state.rfc.md §A busy port is not a step only a person can complete
   */
  devServerPort?: DevServerPort;
  /**
   * The device the plan's `expo run:*` step builds for. Absent from a plan with no such step, and
   * from one that leaves the device to the Expo CLI.
   */
  device?: PlanDevice;
}

/**
 * The device of a plan that builds here: what a run claims, and what `dev --plan` peeks at without
 * claiming it. A run whose claim lands on another device, because a sibling claimed this one
 * first, prints the device it got.
 *
 * `action` is how the run gets it: `reuse` this worktree's claim, `take` a free booted device,
 * `boot` a free shut-down one, or `create` a simulator. `id` is the UDID or adb serial, and
 * `state` whether the device is up now; both are null for a simulator the run creates.
 *
 * @see llp/0030-one-device-per-agent.rfc.md §Every verb uses the claim
 */
export type PlanDevice =
  | { action: DeviceAction; id: string; name: string; state: 'booted' | 'shutdown' }
  | { action: 'create'; id: null; name: null; state: null };

/**
 * Where the plan's dev server listens.
 *
 * - `picked`: `dev` picked a free port; `movedFrom` is the busy port it moved off, or null.
 * - `named`: the caller named the port; `taken` is true when it could not be bound.
 */
export type DevServerPort = {
  port: number;
  movedFrom: number | null;
} & ({ state: 'picked' } | { state: 'named'; taken: boolean });
