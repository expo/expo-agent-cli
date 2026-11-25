// @ref llp/0005-runtime-loop-tools.rfc.md §Target owner

import { EXIT_OUTCOME_FAILED } from '../exitCodes';
import { buildConnectUrls } from '../navigate/connectUrl';
import { readProjectSchemeConfig } from '../navigate/deepLink';
import type { NavigatePlatform } from '../navigate/device';
import { EXPO_GO_APP_IDS } from '../navigate/target';
import { PROGRAM_PREFIX } from '../programName';
import { classifyDevServerHost } from '../dev/advertisedUrl';
import { quoteArgument } from '../utils/consent';
import { canonicalizeExistingPath } from '../utils/dir';
import { CommandError } from '../utils/errors';
import { deviceFlags } from './appLoadedText';
import { createDefaultTargetSelector, evaluateJsFromCdpAsync, type CdpTarget } from './cdpClient';
import type { DevServerSource } from './devServer';
import { matchProjectRoot, readReportedProjectRootAsync } from './projectRootHeader';
import { withData } from './scopeRefusal';

// `__EXPO_PROJECT_ROOT__` is a dev-bundle global that the environment cannot override (llp/0010
// §Upstream asks). Released Expo CLIs only put `EXPO_PUBLIC_PROJECT_ROOT` on the bundle's `process.env`.
const BUNDLE_ROOT_EXPRESSION = `(function(){var g=globalThis.__EXPO_PROJECT_ROOT__;if(typeof g==='string')return g;var e=globalThis.process&&globalThis.process.env;var r=e&&e.EXPO_PUBLIC_PROJECT_ROOT;return typeof r==='string'?r:null})()`;

const BUNDLE_ROOT_PROBE_MS = 1500;
const SERVER_ROOT_READ_MS = 1500;

interface BundleRoot {
  root: string;
  target: CdpTarget;
}

async function readBundleRootAsync(targets: readonly CdpTarget[]): Promise<BundleRoot | null> {
  try {
    const target = await createDefaultTargetSelector()([...targets]);
    if (target == null) return null;
    const root = await evaluateJsFromCdpAsync(
      target.webSocketDebuggerUrl,
      BUNDLE_ROOT_EXPRESSION,
      BUNDLE_ROOT_PROBE_MS
    );
    return typeof root === 'string' ? { root, target } : null;
  } catch {
    return null;
  }
}

/**
 * Refuse when the app that a runtime command reads ran a bundle that this dev server did not serve.
 * An app stays listed on each dev server it loaded from, so the dev server's list does not prove
 * the origin.
 *
 * @throws {CommandError} `FOREIGN_BUNDLE`, exit 20.
 */
export async function assertOwnBundleAsync(
  read: readonly CdpTarget[],
  {
    devServerUrl,
    devServerSource,
    projectRoot,
    debuggerTargets,
    platform,
    cloud = false,
  }: {
    devServerUrl: string;
    devServerSource: DevServerSource;
    projectRoot: string | null | undefined;
    debuggerTargets: number;
    platform?: NavigatePlatform;
    cloud?: boolean;
  }
): Promise<void> {
  const bundle = await readBundleRootAsync(read);
  if (bundle == null) return;
  const served = await readReportedProjectRootAsync(devServerUrl, SERVER_ROOT_READ_MS);
  // A server with no root header is this project's only when this project's lock or log named it.
  const serverRoot =
    served.kind === 'header'
      ? served.root
      : devServerSource === 'lock' || devServerSource === 'log'
        ? (projectRoot ?? null)
        : null;
  if (serverRoot == null || matchProjectRoot(serverRoot, bundle.root) !== false) return;
  const device = bundle.target.deviceName ?? 'the device';
  const link = connectLink(serverRoot, devServerUrl, bundle.target);
  const open =
    link == null
      ? null
      : `${PROGRAM_PREFIX} navigate ${quoteArgument(link)}${deviceFlags({ platform, cloud })}`;
  const error = new CommandError(
    'FOREIGN_BUNDLE',
    [
      `The app on "${device}" runs JavaScript from ${canonicalizeExistingPath(bundle.root)}, not from the project that ${devServerUrl} serves (${canonicalizeExistingPath(serverRoot)}).`,
      `Why: the app is listed on ${devServerUrl} because it connected to it earlier, but its bundle came from another project's dev server. React Native keeps one debugger connection for each dev server the app loaded from.`,
      link == null
        ? `How: open the app on ${devServerUrl} from the development build's launcher, then run this command again.`
        : `How: open ${link} on "${device}" to load the bundle of ${devServerUrl}, then run this command again: "${open}".`,
    ].join('\n')
  );
  error.exitCode = EXIT_OUTCOME_FAILED;
  if (open != null) error.suggestedCommand = open;
  throw withData(error, { devServerUrl, devServerReachable: true, debuggerTargets, platform });
}

function connectLink(projectRoot: string, devServerUrl: string, target: CdpTarget): string | null {
  const { host, hostname } = new URL(devServerUrl);
  const config = readProjectSchemeConfig(projectRoot);
  const [link] = buildConnectUrls({
    host,
    hostType: classifyDevServerHost(hostname),
    scheme: config.scheme ?? (config.slug ? `exp+${config.slug}` : null),
    isExpoGo: EXPO_GO_APP_IDS.includes(target.appId),
    certain: true,
  });
  return link?.url ?? null;
}
