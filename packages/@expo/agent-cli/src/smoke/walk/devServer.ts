import { noScreenshot } from '../results';
import type { PhaseWalk, Step } from './walk';

// ---- Phase 1: is there a dev server, and does this run start one? -------------------------
//
// The look comes first and is not a phase of its own: it is the question "is one running", and
// its answer decides whether there is a start to report at all. Its time belongs to the
// `dev-server` phase, which is the phase about finding one, so it is counted there by hand.
export async function devServerStep(walk: PhaseWalk): Promise<Step<null>> {
  const { deps, options, environment, cleanups, phases, report } = walk;
  let started = false;
  /**
   * The start phase ran a plan that compiled (@ref ../timeouts §BUILD_DEV_SERVER_TIMEOUT_MS).
   *
   * Kept for the follow-ups, and set whether the start succeeded or failed: a build that failed is
   * exactly the case where the cheapest next step differs from the ordinary one.
   */
  let buildAttempted = false;
  let devServerMs = 0;
  // @ref llp/0005-runtime-loop-tools.rfc.md §The gate says what it is doing while it does it
  //
  // Said here rather than left to `record`, because this phase is the one that does not go through
  // it: its row is pushed by hand further down, since its milliseconds are the *sum* of the look
  // and the second look after a start. The caller is nonetheless waiting on this from the first
  // moment of the run, so it is the first thing the run says.
  deps.progress('dev-server', null);
  const lookAt = deps.now();
  let discovery = await deps.discoverDevServer(options.devServerUrl);
  devServerMs += deps.now() - lookAt;

  if (discovery.reachable) {
    environment.devServer = 'reused';
  } else if (options.bootstrap) {
    // @ref llp/0015-backend-selection-and-config.rfc.md §The device backend — this run starts the
    // dev server, so the config's EAS device applies. Set on the shared options, because the deps
    // read it when they start the child and the session.
    if (options.configuredEas && options.cloud === 'fallback') {
      options.cloud = 'required';
    }
    // @ref ../contract §RegisteredCleanup — registered **before** the start, so a start that got
    // halfway is still put back: a detached child that published its lock and then died in the
    // readiness wait is a dev server this run is responsible for, and one it never saw succeed.
    cleanups.push({ resource: 'dev-server', target: null, release: () => deps.stopDevServer() });
    const { value: start } = await walk.record(
      'start-dev-server',
      async () => {
        const result = await deps.startDevServer();
        buildAttempted = result.built === true;
        return result.ok && result.devServerUrl != null
          ? {
              status: 'ok' as const,
              reason: `started for this run at ${result.devServerUrl}, and stopped again afterwards`,
              value: result,
            }
          : { status: 'failed' as const, reason: result.reason, value: result };
      },
      { bootstrap: true }
    );
    if (start.ok && start.devServerUrl != null) {
      started = true;
      environment.devServer = 'started';
      environment.boundDevice = start.bound
        ? {
            ...start.bound,
            released: start.bound.action === 'existing' ? null : false,
            shutDown: false,
          }
        : null;
      // Discovered the same way the first look was, rather than by naming the URL the start
      // reported: naming it would make `source` say `flag` for a run whose caller passed no flag,
      // and `source` is reported precisely because `lock` and `flag` prove different things
      // (llp/0005 §One preflight for the runtime family).
      const againAt = deps.now();
      discovery = await deps.discoverDevServer(options.devServerUrl);
      devServerMs += deps.now() - againAt;
    } else {
      environment.devServer = 'failed';
    }
  }

  phases.push({
    id: 'dev-server',
    status: discovery.reachable ? 'ok' : 'failed',
    ms: devServerMs,
    reason: discovery.reachable
      ? started
        ? 'the dev server started above answered'
        : null
      : started
        ? `a dev server was started and nothing answered at ${discovery.devServerUrl} afterwards`
        : environment.devServer === 'failed'
          ? `nothing answered at ${discovery.devServerUrl}, and the start above did not produce one`
          : `nothing answered at ${discovery.devServerUrl} (${discovery.reason ?? 'no answer'})`,
  });

  Object.assign(report, {
    devServerUrl: discovery.devServerUrl,
    discovery,
    started,
    buildAttempted,
  });
  if (!discovery.reachable) {
    walk.skipRest('bundler-ready', 'no dev server answered, so nothing could be read');
    return {
      stop: walk.done('failed', {
        screenshot: noScreenshot('no dev server answered, so nothing was opened to photograph'),
      }),
    };
  }
  return { next: null };
}
