import chalk from 'chalk';
import { AGENT_DEVICE_SPEC } from '../../device/cloudSimulator';
import * as Log from '../../log';
import { type PlanPlatform } from '../../plan/types';
import { PROGRAM_PREFIX } from '../../programName';
import { smokeCommand, statedSmokePlatform } from '../../smoke/suggest';
import { describeSkippedApps } from '../targetSelection';
import { keepsPageId, settledAttempt } from './attempt';
import { describeEvidence, type Unwatched } from './evidence';
import { type ReloadOptions } from './resolveOptions';
import { type RungOneOutcome } from './rungOne';
import { easCommandPrefix } from '../../utils/easCli';
import type { ReloadResultJson } from './reloadAsync';

/** What each method is, in the words of the thing it acted on rather than its flag value. */
const METHOD_PHRASE: { [method: string]: string } = {
  'dev-server': "the dev server's client command socket",
  runtime: "the app's own expo.reloadAppAsync, over the debugger",
  device: 'stopping the app on the device and opening it again',
  'page-reload': "Page.reload to this worktree's app, over the debugger",
};

/**
 * What the app being off the screen may mean after a cloud relaunch was refused, and how to fix it.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §Cloud simulator — live run S12.
 *
 * The old fallback `close`d the app and then failed to open it, which left a billed session with
 * nothing running and said so nowhere. The one-verb relaunch cannot strand the app *and* claim to
 * know it did not: `--relaunch` terminates before it launches, so a refusal is genuinely two states
 * this command cannot tell apart. It says that, and hands over the command that ends either one.
 */
function explainCloudRelaunchRefusal(report: ReloadResultJson): string[] {
  const failed = report.attempts.find((attempt) => attempt.method === 'device' && !attempt.ok);
  if (failed == null) {
    return [];
  }
  const appId = /relaunched (\S+)/.exec(failed.reason)?.[1] ?? 'the app';
  return [
    `Whether the app is still on the screen is not known: the relaunch verb terminates the app before it launches it, so a refusal may have left the session with nothing running — and the controller does not say which half it got to.`,
    `To put it back by hand, run "${easCommandPrefix()} simulator:exec npx ${AGENT_DEVICE_SPEC} open ${appId === 'the app' ? '<app-id>' : appId} --platform ${report.platform ?? 'ios'}" — opening the application id rather than a deep link avoids the "Open in Expo Go?" dialog that nothing can answer on a cloud device. "${easCommandPrefix()} simulator:stop --id ${report.deviceId ?? '<session-id>'}" ends the session and its billing.`,
  ];
}

export function printHumanReport(report: ReloadResultJson, options: ReloadOptions): void {
  const lines = [
    chalk`{bold Reloaded} ${report.reloaded ? chalk.green('yes') : chalk.red('no')}${
      report.method
        ? chalk`{dim  · via ${METHOD_PHRASE[report.method === 'dev-server' && report.attempts.some((attempt) => attempt.method === 'page-reload') ? 'page-reload' : report.method]}}`
        : ''
    }`,
  ];
  if (report.verifiedBy) {
    // The evidence beside the label, always: a label a reader has to go looking for the count of is
    // the shape F95 was, and "verified by message-socket-peers" over "0 reconnected" is what it read
    // like.
    lines.push(chalk`{dim  verified by ${report.verifiedBy} · ${describeEvidence(report)}}`);
  }
  lines.push(
    chalk`{bold Dev server} ${report.devServerUrl}{dim  · via ${report.devServerSource}}`,
    // Both numbers whenever a reload happened: the second is what a reload proved by a debugger
    // target is judged on, and printing only the first is what let "Apps connected 1" describe a
    // runtime that was on its way out (F45). A zero says *why* it is zero (F95): "0 reconnected
    // after the reload" was three different facts wearing one number, one of them being "another
    // proof answered first and this watch stopped asking".
    chalk`{bold Apps connected} ${report.appsConnected}{dim  · ${
      report.appsReconnected > 0
        ? `${report.appsReconnected} reconnected after the reload`
        : (report.appsReconnectedReason ?? 'none reconnected after the reload')
    }}`
  );
  // @ref llp/0005 §Target owner. A line per placement group: rung 1 did not reload these apps, and
  // a reader must not take their bundle or their screen for this worktree's.
  for (const group of ['other-worktree', 'other-device'] as const) {
    const apps = report.skippedApps.filter((app) => app.group === group);
    if (apps.length > 0) {
      lines.push(chalk`{bold Not reloaded} {dim ${describeSkippedApps(apps)}}`);
    }
  }
  // @ref llp/0005 §What proves a reload. Its own line, whenever the socket was asked: one number
  // for two lists is how "Apps connected 1" came to sit above a broadcast that reached nobody.
  if (report.commandSocketClients != null) {
    lines.push(
      chalk`{bold Command socket} ${report.commandSocketClients} client(s){dim  · ${
        report.commandSocketClients === report.appsConnected
          ? 'the same count as the debugger target list'
          : `a different list from the ${report.appsConnected} above — a broadcast goes to these, and the rest of this CLI reads those`
      }}`
    );
  }
  // The second proof, watched on every rung (wave 21) and printed when it is load-bearing: it
  // fired, or nothing else answered and this is what the exit code turned on. A successful reload
  // proved by a fresh debugger target would otherwise print `Bundle served after no` under
  // `Reloaded yes`, which reads as a failure inside a success.
  if (
    report.bundlesAfterReload.observed === true ||
    (report.bundlesAfterReload.observed != null && report.appsReconnected === 0)
  ) {
    lines.push(
      chalk`{bold Bundle served after} ${
        report.bundlesAfterReload.observed
          ? chalk.green(`yes · ${report.bundlesAfterReload.count}`)
          : chalk.red('no')
      }${
        report.bundlesAfterReload.line
          ? chalk`{dim  · ${report.bundlesAfterReload.line}}`
          : report.bundlesAfterReload.reason
            ? chalk`{dim  · ${report.bundlesAfterReload.reason}}`
            : ''
      }`
    );
  }
  // Always a line, whatever the check did. Printing one only for an answered check made the
  // *absence* of a line the only signal that a gate had been skipped [observed — friction run 5,
  // F48-7: `runtime:reload --no-bundle-check` printed no Bundle line at all, while a checked run
  // printed `Bundle compiles · for ios`]. A reader cannot notice a line that is not there.
  if (report.bundle.ok != null) {
    // Which platforms, and where they came from: a run that checked a default it was never told to
    // use has to say so, or `for ios` reads as a fact about the app it just reloaded (F53).
    const others = report.bundlePlatforms.filter((name) => name !== report.bundle.platform);
    lines.push(
      chalk`{bold Bundle} ${report.bundle.ok ? chalk.green('compiles') : chalk.red('does not compile')}${
        report.bundle.platform ? chalk`{dim  · for ${report.bundle.platform}}` : ''
      }${others.length ? chalk`{dim  · also checked ${others.join(', ')}}` : ''}${
        report.bundlePlatformSource === 'connected-app'
          ? chalk`{dim  · the platform the connected app is on}`
          : report.bundlePlatformSource === 'default'
            ? chalk`{dim  · a default, because nothing named a platform and no connected app could be placed}`
            : ''
      }`
    );
  } else if (!options.bundleCheck) {
    lines.push(chalk`{bold Bundle} ${chalk.dim('skipped (--no-bundle-check)')}`);
  } else {
    lines.push(
      chalk`{bold Bundle} ${chalk.dim(`not checked${report.bundle.reason ? ` · ${report.bundle.reason}` : ''}`)}`
    );
  }
  if (report.route != null) {
    lines.push(
      chalk`{bold Route} ${report.route}${report.url ? chalk`{dim  · ${report.url}}` : ''}`
    );
  }
  for (const attempt of report.attempts) {
    lines.push(chalk`{dim  ${attempt.method}: ${attempt.reason}}`);
  }
  lines.push(chalk`{bold Took} ${report.waitedMs}ms`);
  Log.log(lines.join('\n'));
}

/**
 * What this run left behind, when the fallback stopped the app and could not start it again.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §Cloud simulator — live
 * run S12.
 *
 * Said out loud because it is a state the command *produced*: the app is not on the screen, and on a
 * cloud session the reopen this command would use is the one that just failed — so the recovery is a
 * command a person runs, and the fallback is not redesigned here. Empty for a run that stopped
 * nothing.
 */
function explainStrandedApp(report: ReloadResultJson, options: ReloadOptions): string[] {
  const appId = report.attempts.find((attempt) => attempt.leftAppStopped != null)?.leftAppStopped;
  if (appId == null) {
    return [];
  }
  return [
    options.cloud
      ? `The app was left closed: the device fallback stopped ${appId} on the cloud session and the relaunch was refused, so the session is still billing with nothing running on it, and this command cannot put it back — the reopen it would use is the one that just failed.`
      : `The app was left closed: the device fallback stopped ${appId} and the relaunch was refused, so nothing is running on the device now.`,
    options.cloud
      ? `To reopen it by hand, run "${easCommandPrefix()} simulator:exec npx ${AGENT_DEVICE_SPEC} open ${appId}" — opening the application id rather than a deep link avoids the "Open in Expo Go?" dialog that nothing can answer on a cloud device. "${PROGRAM_PREFIX} dev:stop --eas" ends the session and its billing.`
      : `Run "${PROGRAM_PREFIX} navigate /" to open it again.`,
  ];
}

/** What the payload does not carry and the failure text needs: the state rung 1 and the wait ended in. */
export interface ReloadFailureState {
  unwatched: Unwatched | null;
  rungOne: RungOneOutcome | null;
}

/** The what / why / how for a reload that did not end where it was supposed to. */
export function explainReloadFailure(
  report: ReloadResultJson,
  options: ReloadOptions,
  state: ReloadFailureState
): string {
  // The `smoke` this points at needs a platform now. Prefer the device this reload ran against,
  // then the flag the caller passed, then the host's default — and carry `--eas` through.
  const smokePlatform =
    statedSmokePlatform((report.platform as PlanPlatform | null) ?? options.platform) ??
    (process.platform === 'darwin' ? 'ios' : 'android');
  const smokeBase = `${smokeCommand(smokePlatform)}${options.cloud ? ' --eas' : ''}`;

  // The refusal comes first, because nothing was attempted: an attempts list that is empty for
  // this reason must not read as "no method worked" (friction run 4, F38).
  if (report.bundle.ok === false) {
    const error = report.bundle.error;
    const where = [error?.filename, error?.lineNumber, error?.column]
      .filter((part) => part != null)
      .join(':');
    return [
      chalk.red(`This project's entry bundle does not compile, so the app was not reloaded.`),
      `Why: a reload makes the app fetch the served bundle again, and that bundle is the one the bundler stopped on${where ? ` at ${where}` : ''} — ${error?.message ?? 'the bundler reported an error'}. Reloading would have replaced the screen the app is on with the same failure, and reported success for it.`,
      `How: fix ${where || 'the file the bundler named'} and run this command again; the dev server rebuilds on save, so no restart is needed. Pass --no-bundle-check to reload without asking, which is only useful when you mean to reload onto a bundle you know is broken.`,
      ...(error?.snippet ? [error.snippet] : []),
    ].join('\n');
  }
  if (
    report.bundle.reason != null &&
    report.bundle.ok == null &&
    options.bundleCheck &&
    report.method == null &&
    report.attempts.length === 0
  ) {
    return [
      chalk.red(
        `The bundler was still building this project's entry bundle after ${options.timeoutMs}ms, so the app was not reloaded.`
      ),
      `Why: ${report.bundle.reason}. Until that build finishes it is not known whether a reload would fetch working code, and nothing was attempted rather than reload onto an answer nobody has.`,
      `How: run this command again with a longer --timeout — a first build of a large app takes tens of seconds — or run "${smokeBase}" first and reload once it is green.`,
    ].join('\n');
  }
  // @ref llp/0005 §Cloud simulator. The relaunch ran and nothing was observed: the app
  // may be back and invisible to this dev server, or it may not be back. Two states this command
  // cannot tell apart, and naming both is the honest report — `reloaded: no` with the mechanism that
  // ran, rather than a success off a verb that answers about no app in particular.
  const keeps = keepsPageId(report.attempts);
  const relaunched = settledAttempt(report.attempts)?.method === 'device';
  const unprovable = state.unwatched === 'nothing-can-prove' ? keeps : null;
  // A mechanism that keeps the page id leaves the old target listed, so that list proves nothing.
  if (report.method != null && (report.verifiedBy == null || keeps != null)) {
    const outside = state.rungOne?.kind === 'acted' ? state.rungOne.reachedOutside : 0;
    const why = unprovable
      ? `Why: ${unprovable}, and no bundle may count here (${describeSkippedApps(report.skippedApps)}), so nothing could prove the reload and nothing was watched.`
      : [
          outside > 0
            ? `Why: the dev server's command socket clients churned, but ${outside} listed app${outside === 1 ? '' : 's'} outside this run's scope ${outside === 1 ? 'was' : 'were'} reloaded too, so the churn proves nothing, and neither observation that could prove it happened within ${options.timeoutMs}ms.`
            : `Why: two observations were watched for ${options.timeoutMs}ms and neither happened.`,
          `The dev server listed no debugger target it had not listed before (${report.devServerUrl}/json/list named ${report.appsConnected})${options.cloud ? ', which a cloud simulator often never does — an app has run this project on one with that list empty throughout' : ''}.`,
          `And ${report.bundlesAfterReload.reason ?? 'the dev server served no bundle after the relaunch'}. So the app may be running the new code invisibly, or it may not have come back.`,
        ].join(' ');
    return [
      chalk.red(
        `The app was ${relaunched ? 'relaunched' : 'asked to reload itself'}${options.cloud ? ' on the cloud simulator' : ''}, and nothing was observed to confirm it reloaded.`
      ),
      why,
      unprovable
        ? `How: ${relaunched ? `look at the screen — "${smokeBase} --no-route-check" photographs it — before you believe "${PROGRAM_PREFIX} runtime:errors".` : `run "${PROGRAM_PREFIX} runtime:reload --method device", which relaunches this worktree's app and proves it by the relaunch, or look at the screen with "${smokeBase} --no-route-check".`}`
        : `How: look at the screen — "${smokeBase} --no-route-check" photographs it — and at what the dev server was asked for, with "${PROGRAM_PREFIX} dev:logs". ${options.cloud ? 'A first bundle over a tunnel can take longer than this wait, so a longer --timeout is worth one try. ' : ''}${report.bundlesAfterReload.observed == null ? `This project has no captured dev server log, which is where the one usable proof would have been: start it with "${PROGRAM_PREFIX} dev --detach${options.cloud ? ' --tunnel' : ''}" so its output is recorded.` : ''}`.trim(),
    ].join('\n');
  }
  if (!report.reloaded) {
    return [
      chalk.red(`The app was not reloaded.`),
      `Why: ${report.attempts.map((attempt) => `${attempt.method} — ${attempt.reason}`).join('; ') || 'no method was tried'}.`,
      ...explainStrandedApp(report, options),
      ...(options.cloud ? explainCloudRelaunchRefusal(report) : []),
      // @ref llp/0005 §What proves a reload — K2 and K3. Two different dead ends, and the old
      // text described only the second: "open the app first" is advice for a caller whose app is
      // *not* running, and printing it for a connected app is how a reader was sent to start a
      // second copy of an app this command could see all along.
      state.rungOne?.kind === 'unprovable'
        ? `How: no app of this worktree could keep the marker that proves a Page.reload, so none was sent. Run "${PROGRAM_PREFIX} runtime:reload --method device", which relaunches this worktree's app and proves it by the relaunch.`
        : report.appsConnected > 0
          ? `How: the app is connected — ${report.devServerUrl}/json/list names ${report.appsConnected === 1 ? 'it' : `${report.appsConnected} of them`} — so this is not a missing app, it is a runtime ${triedMechanisms(report)} could not reach. Editing a file the app has loaded is the cheapest way in: the dev server pushes that on its own. ${report.attempts.some((attempt) => attempt.method === 'runtime') ? 'The deliberate method left is' : `The two deliberate methods are "${PROGRAM_PREFIX} runtime:reload --method runtime", which asks the app's own expo.reloadAppAsync to do it and on Expo Go closes the app instead, and`} "${PROGRAM_PREFIX} runtime:reload --method device", which force-stops the app and opens it again — that always works and costs the app's state${options.cloud ? ', and on a cloud session leaves the app closed if the relaunch is refused' : ''}.`
          : `How: open the app on a device or simulator first ("${PROGRAM_PREFIX} navigate /"), then run this command again. A reload needs an app that is already running: it replaces the JavaScript in one, it does not start one.`,
    ].join('\n');
  }
  // Two shapes of "not back", and they are told apart by what the target list says. An empty list
  // is an app that went and did not return; a list holding only the runtime that was there before
  // the reload is an app that never re-registered. Reporting either as a success is F45.
  if (report.appsConnected === 0) {
    return [
      chalk.red(
        `The app reloaded, but it had not reconnected to the dev server ${options.timeoutMs}ms later.`
      ),
      `Why: its debugger target list (${report.devServerUrl}/json/list) was empty, so no app is running this project's JavaScript — the app either closed or is still loading a cold bundle, which can take longer than this wait.`,
      `How: run "${smokeBase}" to wait for the bundle and the app together, or run this command again with a longer --timeout. If the app is not on screen, "${PROGRAM_PREFIX} navigate /" opens it. Nothing is known to be wrong; the wait ran out first.`,
    ].join('\n');
  }
  return [
    chalk.red(
      `The app reloaded, but its JavaScript had not registered again ${options.timeoutMs}ms later.`
    ),
    `Why: ${report.devServerUrl}/json/list still names ${report.appsConnected === 1 ? 'the same debugger target' : `only the same ${report.appsConnected} debugger targets`} it named before the reload, and the dev server never reuses a target id — so the runtime that answers now is the one from before, not a reloaded one. Its errors and its state describe the run this reload was meant to replace.`,
    `How: run this command again with a longer --timeout, or run "${smokeBase}" and read the app after it. Do not believe "${PROGRAM_PREFIX} runtime:errors" until a reload reports a reconnected app.`,
  ].join('\n');
}

/** The in-place mechanisms this run tried, in the words of what they are. */
function triedMechanisms(report: ReloadResultJson): string {
  const words = {
    'dev-server': 'the broadcast',
    'page-reload': 'Page.reload',
    runtime: 'expo.reloadAppAsync',
  } as const;
  const tried = report.attempts.flatMap((attempt) =>
    attempt.method === 'device' ? [] : [words[attempt.method]]
  );
  return tried.length > 0 ? tried.join(' and ') : 'this run';
}
