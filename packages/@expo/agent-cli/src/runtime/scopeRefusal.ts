// @ref llp/0005-runtime-loop-tools.rfc.md §One preflight for the runtime family
// The refusals for "there is no app to read": no app connected, or none in this run's scope. They
// live apart from the preflight so the transport client can refuse the same way without importing it.

import type { NavigatePlatform } from '../navigate/device';
import { PROGRAM_PREFIX } from '../programName';
import { EXIT_OUTCOME_TIMEOUT } from '../exitCodes';
import { hostPlatform } from '../smoke/suggest';
import { CommandError } from '../utils/errors';
import type { RuntimePreflightData } from './preflight';
import {
  skippedAppsOf,
  describeSkippedApps,
  describeSelectedDevice,
  androidModelTwins,
  EMPTY_DEVICE_INVENTORY,
  type DeviceInventory,
  type ClassifiedTargets,
  type TargetSelection,
} from './targetSelection';

/**
 * The ladder out of "there is nothing to talk to", as one `How:` sentence.
 *
 * One ladder for the whole family, and the reason it is a function rather than a string per command:
 * the rungs are the same — a dev server, then an app on a device, then the wait that proves both —
 * and six copies of them drifted into six different first steps, one of which named a keypress in a
 * terminal a detached dev server does not have (F48-5).
 */
export function reachTheAppLadder({
  state,
  cloud,
  platform,
}: {
  state: 'no-dev-server' | 'no-app';
  cloud: boolean;
  platform?: NavigatePlatform;
}): string {
  // Carried onto every command in the ladder that takes it as a device flag. `dev` takes `--eas` as
  // its build backend and not as a device (llp/0015 §One flag for EAS), so it is not put there;
  // what a cloud session needs from a dev server is a tunnel, because a datacenter cannot reach
  // this loopback.
  const cloudFlag = cloud ? ' --eas' : '';
  // `dev` and `navigate` both take it, and `dev` requires it now, so a platform is always stated.
  const platformFlag = ` --${platform ?? hostPlatform()}`;
  const navigate = `${PROGRAM_PREFIX} navigate /${platformFlag}${cloudFlag}`;
  // `dev` takes the platform too, and dropping it here was F142's sibling: a bare `dev` asks the
  // plan engine to pick a platform, and on a Mac it picks iOS — so the first rung of the ladder out
  // of "no android app is connected" started a dev server for the other one.
  const dev = `${PROGRAM_PREFIX} dev --detach${cloud ? ' --tunnel' : ''}${platformFlag}`;

  if (state === 'no-dev-server') {
    return `start one with "${dev}" in the project root and open the app with "${navigate}", then run this command again.`;
  }
  // `smoke` requires a platform now, so name one even when the caller did not: the app runs on a
  // device of some platform, and the host's default is the right guess when nothing else said.
  const smokePlatform = platform ?? (process.platform === 'darwin' ? 'ios' : 'android');
  return `open the app on a device or simulator with "${navigate}" — or, when the device is a phone or a cloud simulator this machine cannot drive, get the URL to open on it with "${PROGRAM_PREFIX} navigate /${platformFlag} --print-url". Then let "${PROGRAM_PREFIX} smoke --${smokePlatform}${cloudFlag}" wait for the bundle and the app together, and run this command again.`;
}

/** Attach the observed counts to a refusal, in the shape the whole family uses. */
export function withData(
  error: CommandError,
  data: Partial<RuntimePreflightData> & { devServerUrl: string }
): CommandError {
  error.data = {
    devServerUrl: data.devServerUrl,
    devServerReachable: data.devServerReachable ?? false,
    debuggerTargets: data.debuggerTargets ?? 0,
    commandSocketClients: data.commandSocketClients ?? null,
    platform: data.platform ?? null,
  } satisfies RuntimePreflightData;
  return error;
}

/**
 * The dev server is running and nothing has attached a debugger to it.
 *
 * **Exit 22, not 1** — @ref llp/0010-agent-conventions.rfc.md §An empty target list is
 * inconclusive, F141. `1` promises that running the same line again changes nothing, and this is the
 * one refusal of the family where that promise is false: a reloading app is absent from
 * `/json/list` for about half a second, so an empty list can describe a runtime on its way back.
 * The wait above is what makes the code honest either way — 22 is reported only once the reconnect
 * window has been waited out, so it says "asked for as long as it was worth asking".
 */
export function noAppConnectedError({
  devServerUrl,
  retryMs = 0,
  cloud = false,
  platform,
}: {
  devServerUrl: string;
  retryMs?: number;
  cloud?: boolean;
  platform?: NavigatePlatform;
}): CommandError {
  const error = new CommandError(
    'NO_APP_CONNECTED',
    [
      `The Expo dev server at ${devServerUrl} is running, but no app is connected to it.`,
      `Why: its debugger target list (${devServerUrl}/json/list) is empty${retryMs > 0 ? `, and it was still empty ${retryMs}ms later` : ''}, so there is no JavaScript runtime to talk to. Either no app has been opened on it, or one is re-registering — a reloading app is absent from that list for about half a second, which is the window this wait was for.`,
      // Not "press i in the dev server's terminal": a dev server this CLI started with --detach has
      // no terminal to press a key in, and a driving agent has no keyboard for one that has
      // [friction run 5, F48-5]. `navigate` is the command that does the same thing.
      `How: ${reachTheAppLadder({ state: 'no-app', cloud, platform })} If the app was mid-reload, running this command again is the whole recovery.`,
    ].join('\n')
  );
  // 22 rather than 1: the CLI worked and could not *conclude*, which is what this band is for.
  error.exitCode = EXIT_OUTCOME_TIMEOUT;
  error.suggestedCommand = `${PROGRAM_PREFIX} navigate /${platform == null ? '' : ` --${platform}`}${cloud ? ' --eas' : ''}`;
  return withData(error, { devServerUrl, devServerReachable: true, platform });
}

/**
 * The failure for an EAS Simulator session with no platform flag whose app nothing places.
 *
 * Two or more unclaimed apps leave no way to say which one is the session's, and a device tool that
 * gave no answer cannot show that an app is off this machine. The session's platform flag narrows
 * which tool has to answer.
 */
function noSessionAppError(
  devServerUrl: string,
  unplaced: number,
  skippedWhy: string
): CommandError {
  const apps = `${unplaced} app${unplaced === 1 ? '' : 's'}`;
  const error = new CommandError(
    'NO_APP_CONNECTED',
    [
      `No app connected to the Expo dev server at ${devServerUrl} could be shown to be the EAS Simulator session's app.`,
      `Why: its debugger target list names ${apps} that nothing on this machine places. One unclaimed app is the session's only when the local device tools answered and no other app is unclaimed.${skippedWhy}`,
      `How: close the apps on this dev server that are not the session's, then run this command again. A platform flag ("--ios --eas" or "--android --eas") only chooses which device tool has to answer; it does not choose between two unclaimed apps.`,
    ].join('\n')
  );
  error.suggestedCommand = `${PROGRAM_PREFIX} status --json`;
  return withData(error, {
    devServerUrl,
    devServerReachable: true,
    debuggerTargets: unplaced,
    platform: null,
  });
}

/**
 * The refusal for a dev server whose apps are all out of this run's scope.
 *
 * The apps stay connected, so asking again gives the same answer (exit 1) until the app is opened.
 * When only other worktrees' apps are connected, it names them: their simulator loads from this
 * port, and a reader who is not told so debugs the wrong build (llp/0005 §Target owner).
 */
export function emptyScopeError(
  devServerUrl: string,
  targetSelection: TargetSelection,
  classifiedTargets: ClassifiedTargets,
  deviceInventory: DeviceInventory = EMPTY_DEVICE_INVENTORY
): CommandError {
  const twins = androidModelTwins(targetSelection, deviceInventory);
  if (twins && classifiedTargets.undetermined.length > 0) {
    return androidTwinsError(
      devServerUrl,
      twins,
      deviceInventory.androidReverse,
      classifiedTargets
    );
  }
  const platform = targetSelection.platform?.value;
  const cloud = targetSelection.device?.backend === 'cloud';
  const skipped = skippedAppsOf(classifiedTargets);
  const boundTo =
    targetSelection.bound && targetSelection.device != null
      ? ` This worktree is bound to ${describeSelectedDevice(targetSelection.device)}.`
      : '';
  const scopeWhy = `${skipped.length > 0 ? ` ${describeSkippedApps(skipped)}` : ''}${boundTo}`;
  if (platform == null && classifiedTargets.undetermined.length > 0) {
    return noSessionAppError(devServerUrl, classifiedTargets.undetermined.length, scopeWhy);
  }
  if (
    targetSelection.platform != null &&
    classifiedTargets.otherPlatform.length + classifiedTargets.undetermined.length > 0
  ) {
    return noAppOnPlatformError(
      devServerUrl,
      { ...targetSelection, platform: targetSelection.platform },
      classifiedTargets,
      scopeWhy
    );
  }
  const navigate = `${PROGRAM_PREFIX} navigate / --${platform ?? hostPlatform()}${cloud ? ' --eas' : ''}`;
  const otherWorktreeOnly =
    skipped.length > 0 && skipped.every((app) => app.group === 'other-worktree');
  const error = new CommandError(
    'NO_APP_CONNECTED',
    [
      otherWorktreeOnly
        ? `No app of this worktree is connected to the Expo dev server at ${devServerUrl}, so there is nothing to read.`
        : `No app on this run's device is connected to the Expo dev server at ${devServerUrl}, so there is nothing to read.`,
      `Why:${scopeWhy} Such an app loads its JavaScript from this port, but ${
        otherWorktreeOnly
          ? "it is not the app on this worktree's device"
          : "it is not on this run's device"
      }, so a read of it says nothing about that app.`,
      `How: open the app on this worktree's device with "${navigate}", then run this command again.`,
    ].join('\n')
  );
  error.suggestedCommand = navigate;
  return withData(error, {
    devServerUrl,
    devServerReachable: true,
    debuggerTargets: skipped.length,
    platform,
  });
}

/**
 * The failure for a dev server whose apps are all on some other platform, or unreadable.
 *
 * Two shapes, because the next steps differ. Apps on another platform means `--android` was asked
 * of a machine running the iOS app, and the fix is to open the Android one. Apps nobody could place
 * means the evidence ran out, and the honest answer is to say which evidence and stop — the whole
 * of F51 was this command answering from a runtime it had not identified.
 */
function noAppOnPlatformError(
  devServerUrl: string,
  targetSelection: TargetSelection & { platform: NonNullable<TargetSelection['platform']> },
  scoped: Pick<ClassifiedTargets, 'otherPlatform' | 'undetermined'>,
  scopeWhy: string
): CommandError {
  const { value: platform, by } = targetSelection.platform;
  const cloud = targetSelection.device?.backend === 'cloud';
  const others = scoped.otherPlatform.map((entry) => entry.platform);
  const uniqueOthers = [...new Set(others)];
  // A flag hint only where the flag can help. Dropping a flag reads every app only when no device
  // of that platform is bound; the other platform's flag is said only to a caller who named none.
  const bound = targetSelection.bound && targetSelection.device != null;
  const instead = !bound
    ? ` Drop --${platform} to read whichever app is connected.`
    : by === 'bound-device'
      ? ` Pass --${uniqueOthers[0]} to read the other app instead.`
      : '';

  const error = new CommandError(
    'NO_APP_CONNECTED',
    uniqueOthers.length > 0
      ? [
          `No ${platform} app is connected to the Expo dev server at ${devServerUrl}, so there is nothing on ${platform} to read.`,
          `Why: its debugger target list names ${others.length} app${others.length === 1 ? '' : 's'}, and ${others.length === 1 ? 'it is' : 'they are'} on ${uniqueOthers.join(' and ')}${scoped.undetermined.length > 0 ? `, plus ${scoped.undetermined.length} whose platform nothing in the target names` : ''}. Reading one of those would answer a question about ${uniqueOthers[0]} while reporting it as ${platform}.${scopeWhy}`,
          `How: open the app on ${platform} with "${PROGRAM_PREFIX} navigate / --${platform}${cloud ? ' --eas' : ''}", then run this command again.${instead}`,
        ].join('\n')
      : [
          `No app connected to the Expo dev server at ${devServerUrl} could be shown to be running on ${platform}.`,
          `Why: its debugger target list names ${scoped.undetermined.length} app${scoped.undetermined.length === 1 ? '' : 's'}, and nothing in ${scoped.undetermined.length === 1 ? 'its target' : 'their targets'} says which platform ${scoped.undetermined.length === 1 ? 'it is' : 'they are'} on — the dev server does not label them, so this is read from the device name and the app id. A development build on a physical device can look like this.${scopeWhy}`,
          cloud
            ? `How: close the apps on this dev server that are not the EAS Simulator session's, then run this command again. --${platform} only chooses which device tool has to answer; it does not choose between two unclaimed apps.`
            : `How: ${bound ? '' : `drop --${platform} to read the app that is connected, which is the honest command when only one is. Or `}connect the device where this machine's device tools can see it ("adb devices -l", "xcrun simctl list devices booted"), so its platform is recognised.`,
        ].join('\n')
  );
  error.suggestedCommand =
    uniqueOthers.length > 0
      ? `${PROGRAM_PREFIX} navigate / --${platform}${cloud ? ' --eas' : ''}`
      : `${PROGRAM_PREFIX} status --json`;
  return withData(error, {
    devServerUrl,
    devServerReachable: true,
    debuggerTargets: others.length + scoped.undetermined.length,
    platform,
  });
}

/**
 * Two attached Android devices share the bound device's model, and `adb reverse` does not show
 * that only the bound one forwards this dev server's port.
 *
 * @ref llp/0035-one-device-per-worktree.rfc.md §Readers
 */
function androidTwinsError(
  devServerUrl: string,
  { serial, model, twins }: NonNullable<ReturnType<typeof androidModelTwins>>,
  reverse: DeviceInventory['androidReverse'],
  classifiedTargets: ClassifiedTargets
): CommandError {
  const others = twins.filter((twin) => twin !== serial);
  const port = reverse?.port ?? new URL(devServerUrl).port;
  const forwarded =
    reverse == null
      ? '"adb reverse --list" could not be read on each of them'
      : reverse.serials.length === 0
        ? `none of them reverses tcp:${port}`
        : `${reverse.serials.join(' and ')} reverse${reverse.serials.length === 1 ? 's' : ''} tcp:${port}`;
  const error = new CommandError(
    'NO_APP_CONNECTED',
    [
      `No app connected to the Expo dev server at ${devServerUrl} could be shown to be on the Android device ${serial}, the device bound to this worktree.`,
      `Why: an Android app names its device by model only, and ${twins.length} attached devices have the model ${model} (${twins.join(', ')}). Of these, ${forwarded}, so the port does not single out ${serial}.`,
      `How: remove a forward the other device keeps with ${others.map((other) => `"adb -s ${other} reverse --remove tcp:${port}"`).join(' or ')}, or detach that device, then run this command again.`,
    ].join('\n')
  );
  return withData(error, {
    devServerUrl,
    devServerReachable: true,
    debuggerTargets:
      classifiedTargets.undetermined.length +
      classifiedTargets.otherPlatform.length +
      classifiedTargets.skipped.length,
    platform: 'android',
  });
}
