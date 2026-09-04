// @ref llp/0005-runtime-loop-tools.rfc.md §The gate says what it is doing while it does it
// @ref llp/0006-agent-native-cli-surface.rfc.md §Output contract
//
// What `smoke` says while it is running, as opposed to what it reports when it has finished.
//
// The gate is the slowest command in this CLI by a wide margin — it can start a dev server, wait
// out a cold first bundle, boot a simulator, download an app and then wait two minutes for that
// app to attach — and until now it said **nothing at all** until the last of those was over. A
// caller watching a terminal for three minutes of silence cannot tell a run that is working from
// one that has hung, and the only thing that resolves the difference is a line saying which phase
// is being spent [confirmed, Kudo, 2026-09-03].
//
// Three properties, and the whole module is here to keep them:
//
//  1. **On stderr.** `stdout` carries one JSON object and nothing else, so a progress line printed
//     there would break `JSON.parse(stdout)` for every `--json` caller (llp/0006 §Output contract).
//  2. **On the event stream too.** The reader this CLI is for is an agent, and an agent watching
//     `cli:smoke_phase` sees the same walk without matching English.
//  3. **Said before the work, never after it.** A line's only job is to name the wait the caller is
//     in. One printed on the way out would arrive at the moment it stopped being needed — and the
//     final report already says what every phase came to, with its duration.

import chalk from 'chalk';

import { event } from '../events';
import * as Log from '../log';
import { formatDuration } from './format';
import type { SmokeOptions } from './resolveOptions';
import type { SmokePhaseId } from './types';

/**
 * Called by the phase walk as each phase begins.
 *
 * @param phase which phase is starting.
 * @param budgetMs how long it may spend, when the walk knows — and `null` when it does not, which
 * is not an oversight. A budget is printed only where it is the real bound: `start-dev-server`
 * passes none because a plan that compiles gets the build budget and one that does not gets the
 * start budget, and that is decided inside the phase rather than by the walk. A stated bound that
 * the run then sails past would be worse than no bound at all (llp/0021 §The rules).
 */
export type SmokeProgress = (phase: SmokePhaseId, budgetMs: number | null) => void;

/** Say nothing. For the tests of the outcome table, which are about phases and not about prose. */
export const silentProgress: SmokeProgress = () => {};

/**
 * What each phase is, in the present tense, as the caller waiting on it would ask.
 *
 * Written from the caller's side rather than the code's: `bundle` is not "check the entry bundle",
 * it is "does this project compile", because that is the question the wait is buying an answer to.
 * The three that can take minutes say so in the line itself — that sentence is the one that
 * distinguishes a long phase from a hung one, which is the whole reason this file exists.
 *
 * `app` has two sentences and every other phase has one, because `app` is two things: a two-second
 * look for an app that is already attached, and — only when there is none — an open plus a wait
 * that is the longest thing this command ever does (@ref src/smoke/phases, the `app` phase). The
 * budget is what tells them apart: the walk knows the bound for the second and not for the first.
 */
function phaseSentence(
  phase: SmokePhaseId,
  options: SmokeOptions,
  bounded: boolean,
  context: SmokeProgressContext
): string {
  switch (phase) {
    case 'app':
      return bounded
        ? 'Opening the app on the device, and waiting for it to attach'
        : 'Looking for an app attached to the dev server';
    case 'dev-server':
      return 'Looking for a dev server';
    case 'start-dev-server':
      return 'Starting a dev server for this run';
    case 'bundler-ready':
      return 'Waiting for the bundler — a first build takes a while';
    case 'bundle':
      return `Checking that this project's own code compiles for ${options.platform}`;
    case 'boot-device':
      return `Booting an ${options.platform} device — a cold one takes a minute or two`;
    case 'install-app':
      // @ref llp/0005-runtime-loop-tools.rfc.md §The gate installs the app, whichever app it is
      // Two very different waits behind one phase, and the line has to say which: a download is
      // minutes of network, a native build is minutes of compiler. The walk knows because the plan
      // does, so it is told rather than guessed.
      return context.installKind() === 'native-build'
        ? `Building and installing this project's development build — a native build takes some minutes`
        : `Installing Expo Go on the device — a few hundred megabytes to download first`;
    case 'reload':
      return 'Putting the app back on the code on disk';
    case 'route':
      return `Opening ${options.route ?? 'the route'}`;
    case 'runtime':
      return 'Asking the app whether its runtime answers';
    case 'errors':
      return 'Watching what the app reports';
    case 'screenshot':
      return 'Taking the picture';
  }
}

/**
 * The reporter the real command uses: one dim line on stderr, and one event, per phase.
 *
 * `options` is closed over rather than passed per call, because half of these sentences are only
 * useful with it — "Opening /notes" says what "Opening the route" does not, and a run's platform is
 * the first thing a reader of a mixed log has to establish.
 */
/**
 * What the sentences need that the options do not carry.
 *
 * One reader so far, and it is a *function* rather than a value because the answer is not known
 * when this is built: which kind of install the run would perform comes from the project's plan,
 * which is resolved lazily so that a run failing at the dev-server phase never reads it
 * (@ref src/smoke/smokeAsync §resolveSmokeTargetAsync). By the time the `install-app` line is said,
 * the phase that decided there was an install to do has already asked.
 */
export interface SmokeProgressContext {
  installKind: () => 'expo-go' | 'native-build' | null;
}

export function buildSmokeProgress(
  options: SmokeOptions,
  context: SmokeProgressContext = { installKind: () => null }
): SmokeProgress {
  return (phase, budgetMs) => {
    event('smoke_phase', { phase, platform: options.platform, budgetMs });
    // The bound only when there is one, and only when it is long enough to be worth planning
    // around: "up to 800ms" on a discovery probe is noise dressed as information.
    const bounded = budgetMs != null && budgetMs >= BUDGET_WORTH_SAYING_MS;
    const bound = bounded ? ` (up to ${formatBudget(budgetMs!)})` : '';
    Log.progress(
      chalk.dim(`… ${phaseSentence(phase, options, budgetMs != null, context)}${bound}`)
    );
  };
}

/**
 * A budget, in the unit somebody deciding whether to keep waiting thinks in.
 *
 * Not `./format.ts`'s {@link formatDuration}, which stops at seconds because the durations *it*
 * prints are what a phase came to and almost all of them are under a minute. The longest budget
 * here is thirty minutes — a native build — and `1800.0s` is a number a reader has to do arithmetic
 * on before it means anything.
 */
function formatBudget(ms: number): string {
  return ms >= 60_000 ? `${(ms / 60_000).toFixed(0)}m` : formatDuration(ms);
}

/**
 * Below this, a budget is not worth printing.
 *
 * Five seconds, because the line is for a caller deciding whether to keep waiting and nothing under
 * a few seconds is a decision. It also keeps the sub-second probes — the dev-server look, the app
 * pre-check — from carrying a bound that reads as a promise about the whole phase.
 */
const BUDGET_WORTH_SAYING_MS = 5_000;
