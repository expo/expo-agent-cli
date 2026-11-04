import type { DeviceBackend } from '../../navigate/device';
import type { SmokeDeps, SmokeRun, SmokeRunContext } from '../phases';
import { coldWaitMs, type SmokeOptions } from '../resolveOptions';
import { noReload, noScreenshot } from '../results';
import { APP_ATTACH_TIMEOUT_MS, CONDITIONAL_PHASES, PHASE_ORDER } from '../timeouts';
import type { SmokeOutcome, SmokePhase, SmokePhaseId, SmokePhaseStatus } from '../types';

/** What one step of the walk hands back: the run, when it ends here, or what the next step needs. */
export type Step<T> = { stop: SmokeRun } | { next: T };

export type PhaseRunner<T> = () => Promise<{
  status: SmokePhaseStatus;
  reason?: string | null;
  value: T;
}>;

export type RecordPhase = <T>(
  id: SmokePhaseId,
  run: PhaseRunner<T>,
  budgetMs?: number | null
) => Promise<T>;

export interface DeviceProbe {
  deviceId: string | null;
  backend: DeviceBackend | null;
  reason: string | null;
}

/** The state every step shares: the phase list, the budget, and the run's context. */
export interface PhaseWalk extends SmokeRunContext {
  deps: SmokeDeps;
  options: SmokeOptions;
  phases: SmokePhase[];
  remaining(): number;
  record: RecordPhase;
  recordBootstrap: RecordPhase;
  chargeToBootstrap(): void;
  skipRest(from: SmokePhaseId, reason: string, stopBefore?: SmokePhaseId): void;
  done(outcome: SmokeOutcome, run: Partial<SmokeRun>): SmokeRun;
  deviceAsync(): Promise<DeviceProbe>;
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
   * Record one phase and hand back what it produced.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §The gate says what it is doing while it does it
   * The progress line is said here rather than at each call site, because "a phase is starting" and
   * "a phase is being recorded" are the same event and a second place to say it would be a second
   * place to forget one. The phases that are pushed straight onto the list instead of going through
   * this — a `route` that was already opened, a `reload` the run declined — say nothing, and that is
   * right: they are rows about work that did not happen, and a progress line for one would report a
   * wait the caller is not in.
   *
   * @param budgetMs how long this phase may spend, when the walk knows (@ref ../progress §SmokeProgress).
   */
  const record: RecordPhase = async (id, run, budgetMs) => {
    deps.progress(id, budgetMs ?? null);
    const at = deps.now();
    const { status, reason, value } = await run();
    phases.push({ id, status, ms: deps.now() - at, reason: reason ?? null });
    return value;
  };

  /** Take the phase that was just recorded off the reading budget rather than out of it. */
  const chargeToBootstrap = (): void => {
    bootstrapMs += phases[phases.length - 1]!.ms;
  };

  /** The same, for a phase that is always bootstrap. */
  const recordBootstrap: RecordPhase = async (id, run, budgetMs) => {
    const value = await record(id, run, budgetMs);
    chargeToBootstrap();
    return value;
  };

  /**
   * Everything from `from` onwards did not run, for the reason given.
   *
   * `stopBefore` is for the two exits that still take a picture: a phase must appear exactly once,
   * and a `screenshot` marked skipped here and then attempted below would appear twice.
   *
   * The conditional phases are never filled in here: a run that stopped at the bundle did not skip
   * a device boot, it had no device boot to do (@ref ../timeouts §CONDITIONAL_PHASES).
   */
  const skipRest = (from: SmokePhaseId, reason: string, stopBefore?: SmokePhaseId): void => {
    const end = stopBefore == null ? PHASE_ORDER.length : PHASE_ORDER.indexOf(stopBefore);
    for (const id of PHASE_ORDER.slice(PHASE_ORDER.indexOf(from), end)) {
      if (!CONDITIONAL_PHASES.has(id) && !phases.some((phase) => phase.id === id)) {
        phases.push({ id, status: 'skipped', ms: 0, reason });
      }
    }
  };

  const done = (outcome: SmokeOutcome, run: Partial<SmokeRun>): SmokeRun => ({
    outcome,
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
    durationMs: deps.now() - startedAt,
    ...run,
  });

  // The dependencies own the chosen device, including one returned by boot/session creation.
  // Asking again lets a failed lookup recover without a second cache in the phase runner.
  const deviceAsync = () => deps.probeDevice();

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
    remaining,
    record,
    recordBootstrap,
    chargeToBootstrap,
    skipRest,
    done,
    deviceAsync,
    coldEnvironment,
    attachBudget,
  };
}
