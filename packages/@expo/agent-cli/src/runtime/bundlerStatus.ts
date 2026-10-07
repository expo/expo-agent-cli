import { waitForBundlerReadyAsync } from './waitReady';

/** How long one `/status` probe may take by default. */
const STATUS_PROBE_TIMEOUT_MS = 2000;

/** What one `/status` probe learned about the dev server at a URL. */
export interface BundlerProbe {
  /** It answered as a finished Expo dev server. */
  answering: boolean;
  /**
   * Whether it serves `projectRoot`, from the project root its `/status` headers name. Null when
   * no project root was given or the dev server named none; `false` is another project's Metro.
   */
  projectRootMatched: boolean | null;
  /** The project root the dev server named, or null when it named none. */
  reportedProjectRoot: string | null;
}

/** One `/status` probe: whether the bundler at `url` answers, and for which project. */
export async function probeBundlerAsync(
  url: string,
  {
    timeoutMs = STATUS_PROBE_TIMEOUT_MS,
    projectRoot = null,
  }: { timeoutMs?: number; projectRoot?: string | null } = {}
): Promise<BundlerProbe> {
  const result = await waitForBundlerReadyAsync(url, { timeoutMs, projectRoot });
  return {
    answering: result.ready,
    projectRootMatched: result.projectRootMatched,
    reportedProjectRoot: result.reportedProjectRoot,
  };
}

/** One `/status` probe: whether the bundler at `url` answers as a finished Expo dev server. */
export async function isBundlerAnsweringAsync(
  url: string,
  { timeoutMs = STATUS_PROBE_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<boolean> {
  return (await probeBundlerAsync(url, { timeoutMs })).answering;
}
