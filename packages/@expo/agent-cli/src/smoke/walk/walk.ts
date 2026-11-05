import type { SmokeDeps, SmokeRun, SmokeRunContext } from '../phases';
import { coldWaitMs, type SmokeOptions } from '../resolveOptions';
import { noReload, noScreenshot } from '../results';
import { APP_ATTACH_TIMEOUT_MS } from '../timeouts';
import type { SmokeOutcome, SmokePhase, SmokePhaseId, SmokePhaseStatus } from '../types';
import { AppSession } from './appSession';

/** What one step of the walk hands back: the run, when it ends here, or what the next step needs. */
export type Step<T> = { stop: WalkRun } | { next: T };

/** A run as the walk ends it. `runSmokePhasesAsync` adds the duration, after the cleanup. */
export type WalkRun = Omit<SmokeRun, 'durationMs'>;

export type PhaseRunner<T> = () => Promise<{
  status: SmokePhaseStatus;
  reason?: string | null;
  value: T;
}>;

export interface RecordOptions {
  /** How long this phase may spend, when the walk knows (@ref ../progress §SmokeProgress). */
  budgetMs?: number | null;
  /** Take the phase off the reading budget rather than out of it. Asked after the phase ran. */
  bootstrap?: boolean | (() => boolean);
}

/** Everything the run reports except the verdict and its duration, filled in as it is learned. */
export type SmokeRunReport = Omit<SmokeRun, 'outcome' | 'durationMs'>;

/** Every phase, in the order they are reported. */
const PHASE_ORDER: SmokePhaseId[] = [
  'start-dev-server',
  'dev-server',
  'bundler-ready',
  'bundle',
  // @ref llp/0027-everything-on-eas.rfc.md §smoke — the EAS device's counterpart of the boot.
  'start-session',
  'boot-device',
  // @ref llp/0005-runtime-loop-tools.rfc.md §Putting Expo Go on a simulator that has not got it.
  // After the boot and not before it: `simctl install` answers `Unable to lookup in current state:
  // Shutdown` for a device that is not up [observed, 2026-09-03].
  'install-app',
  'app',
  // @ref llp/0005-runtime-loop-tools.rfc.md §The app under test is the code on disk. Before
  // `route` rather than after it: a reload sends the app back to its initial route, so a run that
  // opened the route first would reload out of the screen it had just asked for.
  'reload',
  'route',
  'runtime',
  'errors',
  'screenshot',
];

/**
 * The phases that are reported only by a run that performed them.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §The run brings its own environment
 * Every other phase is a question of every run, so a run that did not reach one owes the reader a
 * `skipped` row saying why. These two are not questions; they are *acts*, and a machine that
 * already had a dev server and a simulator did not skip them — there was nothing there to do. A
 * `skipped start dev server` on a healthy run reads as work that was owed and not done. The same
 * holds for the install: a machine that already had the app never had one to do.
 */
const CONDITIONAL_PHASES = new Set<SmokePhaseId>([
  'start-dev-server',
  'start-session',
  'boot-device',
  'install-app',
]);

/** The state every step shares: the phase list, the report, the budget, and the run's context. */
export interface PhaseWalk extends SmokeRunContext {
  deps: SmokeDeps;
  options: SmokeOptions;
  phases: SmokePhase[];
  report: SmokeRunReport;
  /** What this run did to the app. Written from phase 5 on. */
  app: AppSession;
  remaining(): number;
  record<T>(
    id: SmokePhaseId,
    run: PhaseRunner<T>,
    options?: RecordOptions
  ): Promise<{ value: T; phase: SmokePhase }>;
  skipRest(from: SmokePhaseId, reason: string, stopBefore?: SmokePhaseId): void;
  done(outcome: SmokeOutcome, extra?: Partial<SmokeRunReport>): WalkRun;
  coldEnvironment(): boolean;
  attachBudget(): number;
}

export function createPhaseWalk(
  deps: SmokeDeps,
  options: SmokeOptions,
  ctx: SmokeRunContext
): PhaseWalk {
  const { startedAt, environment } = ctx;
  const phases: SmokePhase[] = [];
  const report: SmokeRunReport = {
    phases,
    devServerUrl: '',
    discovery: null,
    projectRootMatched: null,
    started: false,
    environment,
    appsConnected: null,
    skippedApps: [],
    bundle: null,
    route: options.route,
    routeCheck: null,
    deviceId: null,
    deviceBackend: null,
    runtimeSupported: null,
    reload: noReload(),
    appMismatch: null,
    appMismatchKind: null,
    buildAttempted: false,
    windowMs: null,
    errors: [],
    screenshot: noScreenshot('nothing was photographed'),
  };
  /**
   * How much of the clock the bootstrap spent, which `--timeout` is not charged for.
   *
   * A cold simulator takes a minute to come up. A budget that paid for it would leave a run that
   * had to boot one with seconds for the bundle, the app and the error window — so the boot's
   * minute is subtracted here and the phases that read the app get the budget the caller named.
   */
  let bootstrapMs = 0;
  const remaining = () => Math.max(0, options.timeoutMs - (deps.now() - startedAt - bootstrapMs));

  /**
   * Record one phase and hand back what it produced, with the row it wrote.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §The gate says what it is doing while it does it
   * The progress line is said here rather than at each call site, because "a phase is starting" and
   * "a phase is being recorded" are the same event and a second place to say it would be a second
   * place to forget one. The phases that are pushed straight onto the list instead of going through
   * this — a `route` that was already opened, a `reload` the run declined — say nothing, and that is
   * right: they are rows about work that did not happen, and a progress line for one would report a
   * wait the caller is not in.
   */
  const record: PhaseWalk['record'] = async (id, run, { budgetMs, bootstrap } = {}) => {
    deps.progress(id, budgetMs ?? null);
    const at = deps.now();
    const { status, reason, value } = await run();
    const phase: SmokePhase = { id, status, ms: deps.now() - at, reason: reason ?? null };
    phases.push(phase);
    if (typeof bootstrap === 'function' ? bootstrap() : bootstrap) {
      bootstrapMs += phase.ms;
    }
    return { value, phase };
  };

  /**
   * Everything from `from` onwards did not run, for the reason given.
   *
   * `stopBefore` is for the two exits that still take a picture: a phase must appear exactly once,
   * and a `screenshot` marked skipped here and then attempted below would appear twice.
   *
   * The conditional phases are never filled in here: a run that stopped at the bundle did not skip
   * a device boot, it had no device boot to do (@ref ./walk §CONDITIONAL_PHASES).
   */
  const skipRest = (from: SmokePhaseId, reason: string, stopBefore?: SmokePhaseId): void => {
    const end = stopBefore == null ? PHASE_ORDER.length : PHASE_ORDER.indexOf(stopBefore);
    for (const id of PHASE_ORDER.slice(PHASE_ORDER.indexOf(from), end)) {
      if (!CONDITIONAL_PHASES.has(id) && !phases.some((phase) => phase.id === id)) {
        phases.push({ id, status: 'skipped', ms: 0, reason });
      }
    }
  };

  const done = (outcome: SmokeOutcome, extra: Partial<SmokeRunReport> = {}): WalkRun => ({
    outcome,
    ...report,
    ...extra,
  });

  /**
   * Whether this run is the reason the thing it is now waiting for is cold.
   *
   * @ref ../timeouts §APP_ATTACH_TIMEOUT_MS. A dev server it started has never served this app's
   * bundle; a simulator it booted has never launched it. Either one makes the next wait a first
   * launch rather than a measurement.
   */
  const coldEnvironment = () =>
    environment.devServer === 'started' || environment.device === 'booted';

  /**
   * The budget the open gets to wait for the app it loads.
   *
   * @ref ../timeouts §APP_ATTACH_TIMEOUT_MS — the same rule as the attach wait that follows it, and
   * for the same reason: loading an app onto an environment this run made cold is this run's own
   * setup, and loading one onto a warm environment is this run reading a slow app.
   */
  const attachBudget = () => (coldEnvironment() ? coldWaitMs(APP_ATTACH_TIMEOUT_MS) : remaining());

  return {
    ...ctx,
    deps,
    options,
    phases,
    report,
    app: new AppSession(deps, report, remaining),
    remaining,
    record,
    skipRest,
    done,
    coldEnvironment,
    attachBudget,
  };
}
