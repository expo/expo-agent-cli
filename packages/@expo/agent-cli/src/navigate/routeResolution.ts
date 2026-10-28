// @ref llp/0005-runtime-loop-tools.rfc.md §Pointing an app at this dev server
import {
  classifyDevServerHost,
  isTunnelCurrent,
  resolveDevServerReachAsync,
  type DevServerHostType,
  type DevServerReach,
} from '../dev/advertisedUrl';
import { PROGRAM_PREFIX } from '../programName';
import { hostPlatform } from '../smoke/suggest';
import { checkExpoGoCompatibilityAsync, decidesAgainstExpoGo } from '../project/expoGo';
import { readProjectNativeDirsAsync } from '../project/nativeCode';
import {
  isInstalledDependencyAsync,
  listDependencyNames,
  readProjectPackageJsonAsync,
} from '../project/nodeModules';
import { readProjectRoutesAsync } from '../project/routes';
import { discoverDevServerAsync } from '../runtime/discoverDevServer';
import { resolveTargetSelectionAsync } from '../runtime/resolveTargetSelection';
import type { CdpTarget } from '../runtime/cdpClient';
import type { DevServerSource } from '../runtime/devServer';
import { CommandError } from '../utils/errors';
import { buildConnectUrls, type ConnectUrl } from './connectUrl';
import {
  isFullUrlRoute,
  readProjectSchemeConfig,
  resolveDeepLinkUrl,
  type ProjectSchemeConfig,
} from './deepLink';
import type { CloudPreference, NavigatePlatform } from './device';
import { debugEvent } from './events';
import {
  checkRoute,
  routeNotFoundError,
  type RouteCheckJson,
  type RouteCommand,
} from './routeCheck';
import { decideExpoGoTarget } from './target';

/** What the URL depends on: the route, the app, and the dev server a device reaches. */
export interface RouteUrlOptions {
  /** Route as the caller wrote it. */
  route: string;
  /** Platform to open on, or undefined for whichever device is booted. */
  platform?: NavigatePlatform;
  /** URL scheme, instead of the one read from the project's config. */
  scheme?: string;
  /** Application id, for scoping the Android intent. */
  appId?: string;
  /** The `--dev-server-url` the caller named, or null when it is still to be found. */
  devServerUrl: string | null;
  /**
   * Where {@link devServerUrl} came from: the **caller's own flag**, or a step of this same run.
   *
   * The two are not the same question, and treating them as one is F96. The reach lookup below is
   * suppressed for a `flag`, because the caller named the host they want reached — but `smoke`
   * discovers this project's dev server in its first phase and hands the URL down to its route
   * phase, and that URL is a *finding of this run*, not a caller's instruction. Passed as `flag`,
   * it silenced the manifest lookup and the gate built `exp://127.0.0.1:<port>` while `navigate`,
   * three minutes earlier and against the same dev server, built the tunnel host from the manifest
   * [observed — live cloud, 2026-08-27, artifacts 003 and 007].
   *
   * Defaults to `flag`, which is the safe reading of a URL whose origin a caller did not say.
   *
   * @see llp/0021-honest-reports.rfc.md §The rules
   */
  devServerUrlSource?: 'flag' | 'discovered';
  /**
   * A tunnel host the caller has just read from the dev server's manifest.
   *
   * It wins over the host in the captured log, which can name an earlier tunnel of the same run.
   */
  tunnelHost?: string | null;
  /** Check the route against the project's routes first, cleared by `--no-route-check`. */
  routeCheck: boolean;
  /**
   * The command a route failure suggests re-running.
   *
   * The `Try:` line is what a driving agent runs next, so it has to be the command the caller was
   * running rather than always `navigate` (friction run 5).
   */
  command?: RouteCommand;
  /**
   * Whether an EAS Simulator session is on this run's device ladder, and how.
   *
   * Defaults to `off`, so a caller that says nothing keeps the two local backends exactly.
   *
   * @see llp/0005-runtime-loop-tools.rfc.md §Cloud simulator
   */
  cloud?: CloudPreference;
}

/** Everything the URL alone amounts to: the answer of a run that opens nothing. */
export interface ResolvedRoute {
  route: string;
  /** URL a device opens to reach this route. */
  url: string;
  /** Where the dev server listens on this machine. */
  devServerUrl: string;
  devServerSource: DevServerSource;
  /** Whether that dev server answered. */
  devServerReachable: boolean;
  /** How the URL was derived. */
  resolution: string;
  /** Why the target app was decided to be Expo Go or a development build. */
  target: string;
  /** Whether the target app was decided to be Expo Go. */
  isExpoGo: boolean;
  /**
   * What kind of host **the URL above carries**: `tunnel`, `lan`, `localhost`, or null.
   *
   * Classified from the URL itself rather than from what the dev server advertised, so the two can
   * never disagree — a report that says `tunnel` over a `127.0.0.1` link reads as "open this
   * anywhere" [observed — live, 2026-08-25]. Null for a development build's `<scheme>://<route>`,
   * which carries no host at all: it reaches whatever dev server the app was launched against.
   */
  hostType: DevServerHostType | null;
  /**
   * How to point an app at this dev server, one entry per application that could be meant.
   *
   * A *different* URL from {@link url}: that one navigates an app already loaded against a dev
   * server, and these get it loaded. `exp://<host>` is the Expo Go form and
   * `<scheme>://?__expo_url=…` the development build's, and they are not
   * interchangeable — so two entries appear when nothing established which application is running,
   * and none when there is no dev server to point at.
   *
   * @see ./connectUrl.ts
   */
  connect: ConnectUrl[];
  /** Whether the route was checked against the project's routes, and what the check said. */
  routeCheck: RouteCheckJson;
}

/** The tunnel host a device link uses: the one the caller just observed, else the log's current one. */
export function currentTunnelHost(
  options: { tunnelHost?: string | null },
  reach: DevServerReach
): string | null {
  if (options.tunnelHost) {
    return options.tunnelHost;
  }
  return isTunnelCurrent(reach) ? (reach.advertised?.host ?? null) : null;
}

export async function loadRouteFactsAsync(projectRoot: string, options: RouteUrlOptions) {
  const { route, platform } = options;

  const [devServer, config, nativeDirs, packageJson, routeTable, reach, expoGo] = await Promise.all(
    [
      discoverDevServerAsync(options.devServerUrl ?? undefined, { projectRoot }),
      readProjectSchemeConfig(projectRoot),
      readProjectNativeDirsAsync(projectRoot),
      readProjectPackageJsonAsync(projectRoot),
      readProjectRoutesAsync(projectRoot),
      // What the dev server said about where a device reaches it (`src/dev/advertisedUrl.ts`).
      //
      // Not asked when `--dev-server-url` **named** one: the caller named the host they want reached,
      // and substituting this project's tunnel host for it would quietly answer a different question —
      // the flag may well name a dev server that is not this project's at all. A URL a *step of this
      // run* found is not that (F96, `devServerUrlSource`), so it is asked for.
      isCallerNamedDevServer(options)
        ? namedDevServerReach()
        : resolveDevServerReachAsync(projectRoot),
      // @ref llp/0005-runtime-loop-tools.rfc.md §Expo Go is only a target for a project that fits in it
      //
      // In this `Promise.all` rather than after it, so it overlaps the dev-server discovery that
      // dominates this function's latency instead of adding to it. Never throws — an unreadable
      // project answers with reasons rather than an error — and its `compatible` is handed to
      // `decideExpoGoTarget` as the one fact about the *project* that outranks the guesses.
      checkExpoGoCompatibilityAsync(projectRoot),
    ]
  );
  const devServerUrl = devServer.devServerUrl;

  // Before anything is opened, and before the device is even looked for. A route the project has
  // not got is the caller's own argument being wrong, and the recovery — the list of routes it
  // does have — costs one directory walk and needs neither a dev server nor a device. Leaving it
  // until after the link is open would put the app on the "Unmatched Route" screen first, which is
  // the state this check exists to prevent (llp/0005 §Verifying the route).
  const routeCheck = checkRoute({
    route,
    table: routeTable,
    enabled: options.routeCheck,
    isFullUrl: isFullUrlRoute(route),
  });
  debugEvent('route_checked', routeCheck);
  if (routeCheck.ok === false) {
    throw routeNotFoundError(route, routeTable, { platform, command: options.command });
  }

  // A named dev server that does not answer is a mistake worth stopping on, and the only case where
  // this command could still build a URL from it: the scheme of a development build needs no dev
  // server, so a `--dev-server-url` typo used to deep-link the device into an app with no bundle to
  // load and report exit 0. Discovery already probes the URL — `flag` is the one source whose
  // failure was not acted on. Attributed to the *caller* rather than to discovery's own label: a
  // URL a phase of this run found reaches discovery as `flag` too, and blaming a flag nobody passed
  // sends a reader to check an argument they never wrote (F96).
  if (devServer.source === 'flag' && isCallerNamedDevServer(options) && !devServer.reachable) {
    throw unreachableNamedDevServerError(devServerUrl, devServer.reason, platform);
  }

  const usesDevClient = await isInstalledDependencyAsync(
    projectRoot,
    listDependencyNames(packageJson),
    'expo-dev-client'
  );

  return {
    options,
    devServer,
    config,
    nativeDirs,
    reach,
    expoGo,
    usesDevClient,
    routeCheck,
    automation: process.env.EXPO_NO_DEV_MENU !== '0',
  };
}

type RouteFacts = Awaited<ReturnType<typeof loadRouteFactsAsync>>;

/** Finalize from project facts and only the targets the caller may read. No device or network I/O. */
export function finalizeRouteUrl(facts: RouteFacts, decisionTargets: CdpTarget[]): ResolvedRoute {
  const { options, devServer, config, nativeDirs, reach, expoGo, usesDevClient, routeCheck } =
    facts;
  const { route, platform, scheme, appId } = options;
  const devServerUrl = devServer.devServerUrl;
  const target = decideExpoGoTarget({
    appIdOverride: appId,
    targetAppIds: decisionTargets.map((item) => item.appId).filter(Boolean),
    hasNativeDirs: nativeDirs.ios || nativeDirs.android,
    usesDevClient,
    expoGoCompatible: decidesAgainstExpoGo(expoGo),
  });

  // Only a tunnel that is *current* changes the URL: a host read out of a log whose dev server has
  // since stopped is worse than the LAN address, because it looks like it should work.
  const tunnelHost = currentTunnelHost(options, reach);

  const resolved = resolveDeepLinkUrl({
    route,
    schemeOverride: scheme,
    config,
    isExpoGo: target.isExpoGo,
    devServerUrl: devServer.reachable ? devServerUrl : null,
    reachHost: tunnelHost,
    // The flag the caller typed, so the commands this recovers into ask for the same platform
    // this run was asked for (F142).
    platform,
  });
  if (!resolved.ok) {
    const error = new CommandError('DEEP_LINK_UNRESOLVED', resolved.error);
    // Decided where the diagnosis was, so the last line of the failure is a command that can be
    // run: one `Try:` for all three ways this fails was a line with two placeholders in it
    // [observed — friction run 5].
    error.suggestedCommand = resolved.suggestedCommand;
    throw error;
  }

  return {
    route,
    url: resolved.url,
    devServerUrl,
    devServerSource: devServer.source,
    devServerReachable: devServer.reachable,
    resolution: resolved.resolution,
    target: target.reason,
    isExpoGo: target.isExpoGo,
    hostType: resolved.host ? classifyDevServerHost(hostnameOf(resolved.host)) : null,
    // Built from the host a *device* uses — the tunnel's when there is one — rather than from the
    // route URL, because a development build's route URL carries no host at all.
    connect: buildConnectUrls({
      host: devServer.reachable ? (tunnelHost ?? hostnameWithPort(devServerUrl)) : null,
      hostType: tunnelHost ? 'tunnel' : hostTypeOfDevServer(devServerUrl),
      scheme: devBuildScheme(scheme, config),
      isExpoGo: target.isExpoGo,
      certain: target.certain,
      // These links are used by navigate and smoke to load a development build unattended.
      // Keep Expo CLI's explicit opt-out for callers testing the dev menu itself.
      automation: facts.automation,
    }),
    routeCheck,
  };
}

/** Device-free URL API for print/connect consumers. */
export async function resolveRouteUrlAsync(
  projectRoot: string,
  options: RouteUrlOptions
): Promise<ResolvedRoute> {
  const facts = await loadRouteFactsAsync(projectRoot, options);
  const { classifiedTargets } = await resolveTargetSelectionAsync({
    projectRoot: null,
    flags: { platform: options.platform, eas: options.cloud === 'required' },
    targets: facts.devServer.targets,
  });
  return finalizeRouteUrl(facts, classifiedTargets.read);
}

/** Project-only URL for a no-device diagnostic; it never decides what gets opened. */
export function provisionalRouteUrl(facts: RouteFacts): string | null {
  try {
    return finalizeRouteUrl(facts, []).url;
  } catch (error) {
    // An attached app can change the project-only guess. Defer its URL error until scoped.
    if (
      facts.devServer.targets.length > 0 &&
      error instanceof CommandError &&
      error.code === 'DEEP_LINK_UNRESOLVED'
    )
      return null;
    throw error;
  }
}

/**
 * Whether the dev server URL in these options is the **caller's** rather than this run's finding.
 *
 * Pure and exported for the table, because it is the whole of F96 in one expression: a URL and its
 * provenance are two facts, and a run that keeps only the first cannot tell "the caller pinned this
 * host" from "an earlier phase of mine found this host".
 */
export function isCallerNamedDevServer(options: {
  devServerUrl: string | null;
  devServerUrlSource?: 'flag' | 'discovered';
}): boolean {
  return options.devServerUrl != null && options.devServerUrlSource !== 'discovered';
}

/** The reach of a dev server the caller named: their host, and nothing this project knows. */
async function namedDevServerReach(): Promise<DevServerReach> {
  return {
    advertised: null,
    running: false,
    reason: '--dev-server-url named the dev server, so its host is the one that was used',
  };
}

/**
 * The scheme a development build of this project registers.
 *
 * The same precedence the deep link itself uses: `--scheme` wins, then the `scheme` field of the
 * app config, then the `exp+<slug>` default a managed development build registers. Null when the
 * project declares none of them, and then no development-build URL is offered rather than one with
 * a hole in it.
 */
function devBuildScheme(
  schemeOverride: string | undefined,
  config: ProjectSchemeConfig
): string | null {
  const override = schemeOverride?.trim();
  if (override) {
    return override.replace(/:\/*$/, '');
  }
  if (config.scheme) {
    return config.scheme;
  }
  return config.slug ? `exp+${config.slug}` : null;
}

/** `host[:port]` of a dev server origin, or null when it cannot be parsed. */
function hostnameWithPort(devServerUrl: string): string | null {
  try {
    return new URL(devServerUrl).host || null;
  } catch {
    return null;
  }
}

/** How a device off this machine reaches a dev server origin. */
function hostTypeOfDevServer(devServerUrl: string): DevServerHostType | null {
  try {
    return classifyDevServerHost(new URL(devServerUrl).hostname);
  } catch {
    return null;
  }
}

/** The name part of a `host[:port]`, which is what a host classification is about. */
function hostnameOf(host: string): string {
  const lastColon = host.lastIndexOf(':');
  // An IPv6 literal is bracketed, so its colons are inside the brackets and never the port's.
  return lastColon > 0 && !host.includes(']') ? host.slice(0, lastColon) : host;
}

/**
 * The failure for a `--dev-server-url` that named a dev server nothing answers on.
 *
 * @ref llp/0021-honest-reports.rfc.md §How they show up — F142. The
 * platform the caller typed goes on the `dev` this recovers into, for the same reason it goes on
 * every other suggestion: a bare `dev` asks the plan engine to choose a platform, and a caller who
 * has already chosen one is not asking it to.
 */
function unreachableNamedDevServerError(
  devServerUrl: string,
  reason: string | undefined,
  platform?: NavigatePlatform
): CommandError {
  // Stated even when the caller named none: `dev` requires one now.
  const platformFlag = ` --${platform ?? hostPlatform()}`;
  const error = new CommandError(
    'DEEP_LINK_UNRESOLVED',
    [
      `No Expo dev server answered at ${devServerUrl}, which --dev-server-url named, so nothing was opened.`,
      `Why: the request for its debugger target list failed (${reason ?? 'no answer'}). Opening a route against a dev server that is not running loads the app onto the device with nothing to bundle for it, which looks like a crash rather than like a wrong URL.`,
      `How: start the dev server ("${PROGRAM_PREFIX} dev --detach --wait-ready${platformFlag}"), or drop --dev-server-url and let this command find the project's own — it asks the dev-server lock first, then the port the project last logged.`,
    ].join('\n')
  );
  error.suggestedCommand = `${PROGRAM_PREFIX} dev --detach --wait-ready${platformFlag}`;
  return error;
}
