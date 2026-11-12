import chalk from 'chalk';

import type { ReleasedDevice } from '../deviceBinding';
import type { FollowUp } from '../followups';
import { easStopFollowUp } from '../followups/start';
import * as Log from '../log';
import { PROGRAM_PREFIX } from '../programName';
import { PACKAGER_STATUS_READY } from '../runtime/waitReady';
import { devCommand, hostPlatform } from '../smoke/suggest';
import type { DevStopOptions } from './resolveStopOptions';
import type { DevStopForceRefusal, DevStopResultJson } from './stopTypes';

/** The what / why / how for a `--eas` stop whose run still starts its session at the deadline. */
export function sessionPendingExplanation(report: DevStopResultJson): string {
  return [
    chalk.red(
      `The EAS Simulator session of pid ${report.pid} is not started yet, so it was not stopped.`
    ),
    `Why: the run's dev server is gone, and the run binds the session its start returns. That start is still running, and the session bills from its start.`,
    `How: run "${PROGRAM_PREFIX} dev:stop --eas" again. It waits for the start again and stops the session.`,
  ].join('\n');
}

/**
 * @param finishing the stopped `dev --eas` run's lock answers `finishing`: its dev server is gone,
 * and it binds the session its start returns after this report.
 */
export function buildFollowUps(report: DevStopResultJson, finishing = false): FollowUp[] {
  const recovery: FollowUp[] = report.recoveryCommand
    ? [
        {
          id: 'discard-run',
          command: report.recoveryCommand,
          why: 'The interrupted record still blocks startup. Discarding it stops no processes or EAS sessions.',
        },
      ]
    : [];
  const cloudRows = report.devices?.filter((d) => d.backend === 'cloud') ?? [];
  const kept = keptSessionFollowUp(report, cloudRows, finishing);
  const keptSession = kept ? [kept] : [];
  if (report.stopped) {
    const followups: FollowUp[] = [];
    // First, because it contradicts the line above it: the dev server stopped and the port is
    // still busy, and an agent that reads only "Stopped yes" will start the next one into a
    // collision. This command run again against the port is what names whose listener it is —
    // the unlocked path reports its pid and its command line, and stops a killed run's orphan.
    if (report.portStillAnswering && report.port != null) {
      followups.push({
        id: 'dev-stop-port',
        command: `${PROGRAM_PREFIX} dev:stop --port ${report.port}`,
        why: `Port ${report.port} still answers and may be a surviving subprocess. This names the listener and stops it without --force only when it is the dev server a killed run of this project left.`,
      });
    }
    followups.push(...keptSession, ...recovery);
    if (report.recoveryCommand || report.portStillAnswering || report.admission === 'retained')
      return followups;
    // The run's own EAS platform, else the platform of a session this worktree has or had: a kept
    // session is reused by the next dev --eas.
    const easPlatform =
      report.easPlatform ?? report.session?.platform ?? cloudRows[0]?.platform ?? null;
    // Else the platform of this worktree's local device, when it has devices on one platform only.
    const localPlatforms = [
      ...new Set(report.devices?.filter((d) => d.backend !== 'cloud').map((d) => d.platform)),
    ];
    const localPlatform = localPlatforms.length === 1 ? localPlatforms[0] : undefined;
    followups.push({
      id: 'dev',
      command: easPlatform
        ? devCommand(easPlatform, '--eas')
        : devCommand(localPlatform ?? hostPlatform()),
      why: 'The dev server is stopped, so this is what starts one again when the app is needed.',
    });
    return followups;
  }
  if (recovery.length > 0) return [...keptSession, ...recovery];
  if (report.reason === 'foreign-dev-server') {
    return [
      {
        id: 'status',
        command: `${PROGRAM_PREFIX} status --json`,
        why: 'Reports which dev server this project would talk to, so the one on that port can be told apart from this project’s.',
      },
    ];
  }
  if (report.reason === 'not-running' && report.session?.stopped && report.session.platform) {
    return [
      ...keptSession,
      {
        id: 'dev',
        command: devCommand(report.session.platform, '--eas'),
        why: 'The EAS session is stopped, and no dev-server lock answered for this project. This starts a dev server and a session again when the app is needed.',
      },
    ];
  }
  return keptSession;
}

/** The `dev:stop --eas` follow-up for a session that may still bill, or null. */
function keptSessionFollowUp(
  report: DevStopResultJson,
  cloudRows: ReleasedDevice[],
  finishing: boolean
): FollowUp | null {
  const failedStop =
    report.session?.id && !report.session.stopped
      ? { id: report.session.id, reason: report.session.reason }
      : cloudRows.find((d) => d.released === false);
  if (failedStop)
    return easStopFollowUp(
      `The stop of EAS Simulator session ${failedStop.id} failed${failedStop.reason ? `: ${failedStop.reason.split('\n')[0]}` : ''}. If it still runs, it bills until this ends it.`
    );
  const unchecked = cloudRows.find((d) => d.released == null);
  if (unchecked)
    return easStopFollowUp(
      `EAS Simulator session ${unchecked.id} is recorded for this worktree and was not checked. If it still runs, it bills until this ends it.`
    );
  // @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions — a finishing `dev --eas`
  // process binds the session its start returns after this report, so no binding names it yet.
  // A `dev:stop --eas` that already ran reported a session and asked the listing.
  if (finishing && report.session?.id == null)
    return easStopFollowUp(
      `pid ${report.pid} is still starting its EAS Simulator session and binds it to this worktree when the start returns. A session it keeps bills until this ends it.`
    );
  return null;
}

export function printHumanReport(report: DevStopResultJson, finishing: boolean): void {
  for (const device of report.devices ?? []) {
    Log.log(
      `${device.released ? 'Released' : device.released === false ? 'Could not release' : 'Kept'} ${device.name}${device.reason ? `: ${device.reason}` : '.'}`
    );
  }
  const lines = [
    !report.stopped && report.reason === 'not-running'
      ? // Only a port that was looked at and found quiet shows that nothing runs; with no port, a
        // server a person started may be up, and the line says what was checked.
        chalk.dim(
          report.admission === 'released'
            ? 'Starting run canceled before Metro readiness'
            : report.portStillAnswering === false
              ? 'Dev server not running'
              : `No dev-server lock answered, and no dev server a killed run left was found · pass --port to check a port`
        )
      : chalk`{bold Stopped} ${report.stopped ? chalk.green('yes') : chalk.red('no')}${
          report.forced ? chalk.dim(' · forced') : ''
        }`,
  ];
  if (report.session) {
    lines.push(
      report.session.id == null
        ? chalk`{bold Session} ${chalk.dim('none in progress for this project')}`
        : chalk`{bold Session} ${report.session.id}${
            report.session.stopped
              ? chalk.dim(' · stopped')
              : chalk.red(` · still running — ${report.session.reason ?? 'no reason given'}`)
          }`
    );
  }
  if (report.pid != null) {
    lines.push(
      chalk`{bold Process} ${report.pid}${report.signal ? chalk.dim(` · sent ${report.signal}`) : chalk.dim(' · not signalled')}`
    );
  }
  if (report.url != null || report.port != null) {
    lines.push(
      chalk`{bold Dev server} ${report.url ?? `port ${report.port}`}${chalk.dim(
        report.lockHeld ? ' · via lock' : ' · no lock answered'
      )}`
    );
  }
  // Said out loud on the success path too, because "Stopped yes" and a port that still answers is
  // the one combination a reader would otherwise take for a contradiction.
  if (report.stopped && report.portStillAnswering && report.port != null) {
    lines.push(
      chalk`{bold Port} ${report.port}${chalk.dim(' · still answering, by something else')}`
    );
    lines.push(
      chalk.dim(
        ` The process this command signalled is gone. Another listener has that port number — a second project's dev server, or one on the other IP stack, since this check is over 127.0.0.1 and a listener on ::1 is a different socket.`
      )
    );
  }
  if (report.stopped && report.untracked) {
    lines.push(
      chalk.dim(` This project's dev server had no lock: the run that started it was killed.`)
    );
  }
  if (finishing && report.pid != null) {
    lines.push(
      chalk.dim(
        ` pid ${report.pid} has no dev server any more, and is finishing its EAS session start (it can take minutes). It exits by itself.`
      )
    );
  }
  if (report.detail != null) {
    lines.push(chalk.dim(` ${report.detail}`));
  }
  lines.push(chalk`{bold Took} ${report.waitedMs}ms`);
  Log.log(lines.join('\n'));
}

/** The what / why / how for a dev server that is still running. */
export function explainFailure(report: DevStopResultJson, options: DevStopOptions): string {
  if (report.admission === 'retained') return report.detail ?? 'Detached ownership was retained.';
  if (report.reason === 'foreign-dev-server') {
    // `url` is set on this path exactly when the port answered `packager-status:running`, which is
    // the difference between "someone else's dev server" and "not a dev server at all". They need
    // different advice: `--force` can stop the first and will always decline the second.
    const answeredAsDevServer = report.url != null;
    return [
      chalk.red(
        answeredAsDevServer
          ? `The dev server on port ${report.port} was not stopped.`
          : `Nothing was stopped on port ${report.port}.`
      ),
      answeredAsDevServer
        ? `Why: ${report.detail}. Stopping a process this CLI did not start would be killing something nobody in this command asked about — a second project's dev server on that port is the ordinary case.`
        : `Why: ${report.detail}. This command stops Expo dev servers, so it will not signal a process that has not shown it is one.`,
      report.forceRefusedBy
        ? forceRefusedHow(report, report.forceRefusedBy)
        : answeredAsDevServer
          ? `How: stop it where it was started, or run this command again with --force, which stops it only when the port answers as an Expo dev server ${report.pid != null ? `and pid ${report.pid} looks like one` : 'and its process can be identified'}.`
          : `How: stop whatever holds that port where it was started, or name the port your dev server is really on with --port. --force would be declined here for the same reason, and "${PROGRAM_PREFIX} status --json" reports which dev server this project would talk to.`,
    ].join('\n');
  }
  // Two failures wear this reason, and only one of them is answered by a bigger hammer. Sending
  // SIGKILL to a pid that is already gone is a next action that cannot work, which is the same
  // mistake the `--force` refusal used to make [friction run 5, F48-1].
  if (!report.processStillRunning) {
    return [
      chalk.red(`This project's dev-server lock is still answering.`),
      `Why: ${report.detail}. The signal did its job — pid ${report.pid} is gone — so what is left is a second holder of the lock, which is what happens when this project has two dev servers running and only one of them was this one.`,
      `How: run "${PROGRAM_PREFIX} status --json" to see which dev server this project would now talk to, and stop that one where it was started. Nothing here is waiting on a longer --timeout, and --signal SIGKILL has nothing left to signal.`,
    ].join('\n');
  }
  // No signal reached it (another user's process): a longer wait or SIGKILL would not either.
  if (report.signal == null) {
    return [
      chalk.red(`The dev server is still running.`),
      `Why: ${report.detail}.`,
      `How: stop pid ${report.pid} as the user that owns it, then run this command again.`,
    ].join('\n');
  }
  return [
    chalk.red(`The dev server is still running.`),
    `Why: ${report.detail}.`,
    `How: run this command again with a longer --timeout, or with --signal SIGKILL, which the process cannot decline. A dev server that ignores ${options.signal} is usually mid-shutdown rather than stuck.`,
  ].join('\n');
}

/**
 * The `How:` line for a `--force` that was passed and declined.
 *
 * It never names `--force` as the recovery, because the caller already passed it — the old line
 * did, which is a next action guaranteed to fail again [observed — friction run 5, F48-1]. What it
 * names instead is the proof that was missing and the one thing that would supply it.
 */
function forceRefusedHow(report: DevStopResultJson, refusal: DevStopForceRefusal): string {
  const port = report.port;
  switch (refusal) {
    case 'not-a-dev-server':
      return `How: --force was passed and declined, because the first of its two proofs did not hold — port ${port} answered, but not with "${PACKAGER_STATUS_READY}", so nothing has shown a Metro dev server is on it. --force never kills a listener on that evidence. Stop whatever is on the port where it was started, or name the right port with --port.`;
    case 'unnamed-process':
      return `How: --force was passed and declined, because the second of its two proofs did not hold — the port answers as an Expo dev server, and this machine named no process holding it, so there is no pid to signal. Run "lsof -ti tcp:${port}" yourself to see whether your user owns it; a listener owned by another user is not visible here.`;
    case 'foreign-process':
      return `How: --force was passed and declined, because the second of its two proofs did not hold — the program pid ${report.pid} runs, named above, is not one that runs a dev server, so the pid on the port and the dev server answering on it disagree. That usually means something in front of a dev server elsewhere: stop it where it was started, or point this command at the real port with --port.`;
  }
}
