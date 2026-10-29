// @ref llp/0011-impact-and-freshness.rfc.md §The build-cache lookup
//
// "Has anybody already built exactly this?" — the other half of the freshness question, and the
// one a `stale` line could not answer. `impact` has asked it since 2026-08-24; `status` could not,
// for two reasons that are both about cost and are answered differently:
//
// 1. **The hash `status` has is the wrong hash.** Its probe runs `fingerprint:generate` with no
//    `--platform`, which hashes both platforms at once — the right answer for freshness and a hash
//    no EAS build carries, because a build is made for one platform. Live, on the same working
//    tree: `031f6b0c…` for the project and `8ce1acfb…` for iOS [observed — apps/observe-tester,
//    2026-08-26]. Asking EAS therefore costs a *second* fingerprint run before the network call.
// 2. **The network call is not instant.** `eas build:list --fingerprint-hash …` measured
//    1.10–1.33 s over five live runs, hit and miss alike, against a warm CLI [observed — same
//    session]. `status` measures ~65 ms.
//
// So the **cache is read first**, and it is exact rather than approximate: the whole-project hash
// *dominates* the per-platform ones — `--platform` filters the same source list, so an unchanged
// project hash implies unchanged per-platform hashes — which makes the hash `status` already has a
// sound key for an answer about a hash it does not have. A hit costs one `readFileSync` and is as
// true as the lookup that wrote it. See the LLP section for the argument in full.
//
// A `none` is remembered for five minutes. A project whose static config names no EAS project is
// never asked: `eas build:list` would refuse it.

import fs from 'fs';
import path from 'path';

import { lookUpCachedBuildAsync, runnerDownloadNote } from '../impact/buildCache';
import type { CachedBuild } from '../impact/types';
import type { NativePlatform, PlanEasBuild } from '../plan/types';
import type { EasProjectLink } from '../project/appConfig';
import { generateFingerprintAsync } from '../project/fingerprint';
import { EAS_SIMULATOR_PROFILE } from '../toolchain/runsOn';
import { ensureDotExpoProjectDirectoryInitialized } from '../utils/dotExpo';
import { easCommandPrefix, mayDownloadEasCli, resolveEasCli, type EasCli } from '../utils/easCli';
import type { AuthStatus, BuildsStatus, PlatformBuild } from './types';

/** Platforms the section reports, in print order — the same two `freshness` reports. */
const PLATFORMS: NativePlatform[] = ['ios', 'android'];

/** Name of the record inside the project's `.expo` directory. */
export const EAS_BUILDS_FILE_NAME = 'agent-cli-eas-builds.json';

/**
 * How long one platform's lookup may take, fingerprint run and network call together.
 *
 * Generous: the two halves measured 1.24 s and 1.10–1.33 s live, so a budget under about four
 * seconds would abandon answers that were on their way. Expiring costs the platform an answer (`unknown`), never the report.
 */
export const EAS_BUILD_LOOKUP_TIMEOUT_MS = 10_000;

/**
 * How long the same lookup gets when the EAS CLI has to be **downloaded** first.
 *
 * @ref llp/0015-backend-selection-and-config.rfc.md §Resolving the EAS CLI
 * In a project that does not pin `eas-cli`, on a machine without a recent global one, the rung is
 * `npx --yes eas-cli`: its first run installs the package before the query starts, which no budget
 * written for a warm CLI can cover. Two answers were possible and this section takes the *middle*
 * one [decided — 2026-08-27, wave 18]: a wider budget, still bounded, so the common case of a modest
 * install answers rather than expires — and never the minutes a cold install, or an unreachable
 * registry, can take, because `status` must not hang. A run that expires anyway says the download was
 * why, and the next run is warm.
 *
 * A project that *pins* the CLI keeps the tighter budget above: the runner resolves it out of
 * `node_modules` without a network call at all.
 */
export const EAS_BUILD_RUNNER_TIMEOUT_MS = 45_000;

/** The budget one lookup gets with this CLI: the wider one when it may have to download first. */
export function easBuildLookupTimeoutMs(easCli: EasCli | null): number {
  return mayDownloadEasCli(easCli) ? EAS_BUILD_RUNNER_TIMEOUT_MS : EAS_BUILD_LOOKUP_TIMEOUT_MS;
}

/**
 * How long a `none` is believed before EAS is asked again. A build may be in the queue right now, so
 * this stays shorter than a native build.
 *
 * @ref llp/0011-impact-and-freshness.rfc.md §What `status` remembers of the answer
 */
export const EAS_NONE_CACHE_TTL_MS = 5 * 60 * 1000;

/** What was cached for one platform, and the working tree it was cached for. */
interface CachedEntry {
  /**
   * The whole-project fingerprint hash at the moment of the lookup — the cache key.
   *
   * Not the hash that was looked up. This is the one `status` recomputes for free on every run,
   * and it dominates the per-platform hash below, so matching it proves the answer still holds.
   */
  projectHash: string;
  /** The per-platform hash that was actually asked about, reported so the answer can be checked. */
  fingerprintHash: string;
  checkedAt: string;
  /** The build EAS had, or null when it had none (believed for {@link EAS_NONE_CACHE_TTL_MS}). */
  build: CachedBuild | null;
}

type EasBuildsRecord = Partial<Record<NativePlatform, CachedEntry>>;

export interface EasBuildsOptions {
  /**
   * What the auth section answered.
   *
   * A signed-out machine is never probed a second time: the answer is already in the report, and
   * spawning `eas build:list` to be told the same thing would cost a second or more to learn
   * nothing. `null` and `loggedIn: null` both mean nothing was established, so the lookup runs.
   */
  auth: AuthStatus | null;
  /** The whole-project fingerprint hash the freshness section computed. Null when there is none. */
  projectHash: string | null;
  /** Overrides {@link EAS_BUILD_LOOKUP_TIMEOUT_MS}, for tests. */
  timeoutMs?: number;
  /**
   * Whether the per-platform fingerprint below, and this section's own record, may come out of the
   * project's `.expo` record.
   *
   * @see llp/0023-fingerprint-caching.rfc.md — this is the section that pays for *two* of the three
   * fingerprints a `status` computes. A caller who refused that cache wants a measurement, so the
   * remembered EAS answer is refused too.
   */
  fingerprintCache?: boolean;
  /** The EAS project link from the app config. Null when the project could not be read. */
  easProject?: EasProjectLink | null;
}

/**
 * What EAS already has for this project, per platform.
 *
 * Reads the record first and calls EAS for what it does not answer. Never throws: every way of not
 * getting an answer is an `unknown` carrying the reason, so a section that could not be read costs
 * one line of the report and the command still exits 0.
 */
export async function readEasBuildsStatusAsync(
  projectRoot: string,
  options: EasBuildsOptions
): Promise<BuildsStatus> {
  const record = options.fingerprintCache === false ? {} : readEasBuildsRecord(projectRoot);
  // Once for the whole section rather than once per platform: the answer cannot differ between them,
  // and the two rungs it may take both touch the filesystem. It is also what lets the deadline below
  // say *why* a lookup ran out of time.
  const easCli = resolveEasCli(projectRoot);
  // Set once `eas build:list` is spawned, whatever it answers, so a failed call still counts.
  const asked = { eas: false };
  const platforms = await Promise.all(
    PLATFORMS.map((platform) =>
      readPlatformAsync(projectRoot, platform, record, options, easCli, asked)
    )
  );
  return { askedEas: asked.eas, platforms };
}

/**
 * The plan's question, "is there a finished simulator build?", answered from this section's answer.
 *
 * The section asks for the newest finished build of any profile, so `none` and a simulator-profile
 * `found` settle it. `unknown` reads as no build, which is what the plan does when its own call
 * fails. Only a `found` of another profile returns `undefined`: a simulator build may still exist.
 */
export function simulatorBuildFromBuilds(
  builds: BuildsStatus | null,
  platform: NativePlatform
): PlanEasBuild | null | undefined {
  const answer = builds?.platforms.find((entry) => entry.platform === platform);
  if (answer?.state !== 'found' || !answer.buildId) {
    return null;
  }
  return answer.buildProfile === EAS_SIMULATOR_PROFILE
    ? { id: answer.buildId, profile: EAS_SIMULATOR_PROFILE }
    : undefined;
}

/**
 * The platforms whose fingerprint the lookup will compute: signed in, linked, and no record entry
 * that answers for this project hash. `status` starts these early; it must not start one the lookup
 * would never wait for, since an unawaited fingerprint run still holds the process open.
 */
export function platformsToFingerprintEarly(
  projectRoot: string,
  options: Pick<EasBuildsOptions, 'auth' | 'easProject' | 'fingerprintCache' | 'projectHash'>
): NativePlatform[] {
  if (options.auth?.loggedIn === false || !mayAskEas(options.easProject)) {
    return [];
  }
  const record = options.fingerprintCache === false ? {} : readEasBuildsRecord(projectRoot);
  return PLATFORMS.filter((platform) => !recordAnswers(record[platform], options.projectHash));
}

/** Whether a record entry answers for this project hash, the same test the lookup applies. */
function recordAnswers(cached: CachedEntry | undefined, projectHash: string | null): boolean {
  if (!cached || !projectHash || cached.projectHash !== projectHash) {
    return false;
  }
  if (cached.build) {
    return true;
  }
  const age = ageOf(cached.checkedAt);
  return age != null && age <= EAS_NONE_CACHE_TTL_MS;
}

function mayAskEas(easProject: EasProjectLink | null | undefined): boolean {
  return (
    !easProject ||
    (!easProject.unreadable && (!!easProject.projectId || easProject.evaluationError != null))
  );
}

async function readPlatformAsync(
  projectRoot: string,
  platform: NativePlatform,
  record: EasBuildsRecord,
  options: EasBuildsOptions,
  easCli: EasCli | null,
  asked: { eas: boolean }
): Promise<PlatformBuild> {
  const cached = record[platform];
  if (cached && recordAnswers(cached, options.projectHash)) {
    return cached.build
      ? found(platform, cached.fingerprintHash, cached.build, 'cache', cached.checkedAt)
      : none(platform, cached.fingerprintHash, 'cache', cached.checkedAt, ageOf(cached.checkedAt));
  }

  if (options.auth?.loggedIn === false) {
    // The answer is already in the report. A second probe would spend a second to be told the
    // same thing, and this section must never be the reason a signed-out machine waits.
    return unknown(
      platform,
      null,
      `this machine is not signed in to Expo (per ${options.auth.source ?? 'the auth check'}), so EAS has nothing to answer with`
    );
  }
  if (options.easProject?.unreadable) {
    return unknown(
      platform,
      null,
      `${options.easProject.source} does not parse, so whether this project is linked to EAS is unknown and EAS was not asked`
    );
  }
  if (
    options.easProject &&
    !options.easProject.projectId &&
    options.easProject.evaluationError == null
  ) {
    // A config that could not be evaluated may still set the id, so only a config that was read is trusted.
    return unknown(platform, null, unlinkedReason(projectRoot, options.easProject, options.auth));
  }

  const deadline = options.timeoutMs ?? easBuildLookupTimeoutMs(easCli);
  const outcome = await withDeadlineAsync(
    lookUpPlatformAsync(projectRoot, platform, deadline, easCli, options.fingerprintCache, asked),
    deadline
  );
  if (!outcome) {
    return unknown(
      platform,
      null,
      `the lookup did not finish within ${deadline}ms${runnerDownloadNote(easCli)}`
    );
  }
  const checkedAt = new Date().toISOString();
  if (outcome.build) {
    writeEasBuildsEntry(projectRoot, platform, {
      projectHash: options.projectHash,
      fingerprintHash: outcome.fingerprintHash,
      build: outcome.build,
      checkedAt,
    });
    return found(platform, outcome.fingerprintHash, outcome.build, 'eas', checkedAt);
  }
  if (outcome.reason) {
    return unknown(platform, outcome.fingerprintHash, outcome.reason);
  }
  writeEasBuildsEntry(projectRoot, platform, {
    projectHash: options.projectHash,
    fingerprintHash: outcome.fingerprintHash,
    build: null,
    checkedAt,
  });
  return none(platform, outcome.fingerprintHash, 'eas', checkedAt, null);
}

/** Names the same `eas init` forms as `assertEasProjectConfiguredAsync`. */
function unlinkedReason(
  projectRoot: string,
  easProject: EasProjectLink,
  auth: AuthStatus | null
): string {
  const config = easProject.source ?? 'its app config';
  // With no account name (signed in by EXPO_TOKEN alone), the command keeps a visible hole.
  const account = auth?.user ?? '<account-name>';
  const unknownAccount =
    !auth?.user && auth?.loggedIn === true ? ' (the signed-in account is unknown; name yours)' : '';
  return `this project is not linked to an EAS project — ${config} names no extra.eas.projectId, so EAS was not asked; link it once with "${easCommandPrefix(projectRoot)} init --account ${account} --non-interactive"${unknownAccount} (or --id <project-id> for one that exists)`;
}

/** One platform's network answer: the hash that was asked about, and what came back. */
interface LookupOutcome {
  fingerprintHash: string | null;
  build: CachedBuild | null;
  /** Set when nothing was established. A `none` has neither a build nor a reason. */
  reason: string | null;
}

/**
 * Hash this one platform, then ask EAS about that hash.
 *
 * Two subprocesses, in this order because the second needs the first's answer. The fingerprint run
 * is the one `status` does not otherwise make: its probe hashes both platforms together, and an
 * EAS build carries a per-platform hash, so the project hash cannot be handed to the lookup.
 */
async function lookUpPlatformAsync(
  projectRoot: string,
  platform: NativePlatform,
  timeoutMs: number,
  easCli: EasCli | null,
  fingerprintCache: boolean | undefined,
  asked: { eas: boolean }
): Promise<LookupOutcome> {
  const fingerprint = await generateFingerprintAsync(projectRoot, {
    platform,
    cache: fingerprintCache,
  });
  if (!fingerprint.hash) {
    return {
      fingerprintHash: null,
      build: null,
      reason: fingerprint.error ?? `the ${platform} fingerprint could not be computed`,
    };
  }

  asked.eas = true;
  const outcome = await lookUpCachedBuildAsync(easCli, projectRoot, platform, fingerprint.hash, {
    timeoutMs,
  });
  return {
    fingerprintHash: fingerprint.hash,
    build: outcome.state === 'found' ? outcome.build : null,
    reason: outcome.state === 'unknown' ? outcome.reason : null,
  };
}

function found(
  platform: NativePlatform,
  fingerprintHash: string | null,
  build: CachedBuild,
  source: 'cache' | 'eas',
  checkedAt: string
): PlatformBuild {
  return {
    platform,
    state: 'found',
    fingerprintHash,
    buildId: build.id,
    createdAt: build.createdAt,
    buildProfile: build.buildProfile,
    buildUrl: build.buildUrl,
    source,
    checkedAt: checkedAt || null,
    ageMs: null,
    reason: null,
  };
}

function none(
  platform: NativePlatform,
  fingerprintHash: string | null,
  source: 'cache' | 'eas',
  checkedAt: string,
  ageMs: number | null
): PlatformBuild {
  return {
    platform,
    state: 'none',
    fingerprintHash,
    buildId: null,
    createdAt: null,
    buildProfile: null,
    buildUrl: null,
    source,
    checkedAt,
    ageMs,
    reason: 'EAS has no finished build made from this fingerprint',
  };
}

function unknown(
  platform: NativePlatform,
  fingerprintHash: string | null,
  reason: string
): PlatformBuild {
  return {
    platform,
    state: 'unknown',
    fingerprintHash,
    buildId: null,
    createdAt: null,
    buildProfile: null,
    buildUrl: null,
    source: null,
    checkedAt: null,
    ageMs: null,
    reason,
  };
}

function ageOf(checkedAt: string): number | null {
  const age = Date.now() - Date.parse(checkedAt);
  return Number.isFinite(age) && age >= 0 ? age : null;
}

function getRecordPath(projectRoot: string): string {
  return path.join(projectRoot, '.expo', EAS_BUILDS_FILE_NAME);
}

/**
 * Read the project's record of what EAS was found to have.
 *
 * Never throws: a missing, corrupt or half-written record reads as nothing cached, which costs a
 * lookup rather than the command.
 */
export function readEasBuildsRecord(projectRoot: string): EasBuildsRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(getRecordPath(projectRoot), 'utf8'));
  } catch {
    return {};
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const record = parsed as Record<string, unknown>;
  const entries: EasBuildsRecord = {};
  for (const platform of PLATFORMS) {
    const entry = parseEntry(record[platform]);
    if (entry) {
      entries[platform] = entry;
    }
  }
  return entries;
}

/**
 * One platform's entry, or null when it cannot be trusted.
 *
 * An entry without both hashes, or a build without an id, is dropped rather than repaired: the whole
 * value of this cache is that a hit is *exact*. A `none` without a valid `checkedAt` is dropped too,
 * because its age is its only bound.
 */
function parseEntry(value: unknown): CachedEntry | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.projectHash !== 'string' ||
    !entry.projectHash ||
    typeof entry.fingerprintHash !== 'string' ||
    !entry.fingerprintHash
  ) {
    return null;
  }
  const checkedAt = typeof entry.checkedAt === 'string' ? entry.checkedAt : '';

  const build = entry.build;
  if (build === null) {
    if (!checkedAt || !Number.isFinite(Date.parse(checkedAt))) {
      return null;
    }
    return {
      projectHash: entry.projectHash,
      fingerprintHash: entry.fingerprintHash,
      checkedAt,
      build: null,
    };
  }
  if (build == null || typeof build !== 'object') {
    return null;
  }
  const cachedBuild = build as Record<string, unknown>;
  if (typeof cachedBuild.id !== 'string' || !cachedBuild.id) {
    return null;
  }
  return {
    projectHash: entry.projectHash,
    fingerprintHash: entry.fingerprintHash,
    checkedAt,
    build: {
      id: cachedBuild.id,
      status: readString(cachedBuild.status),
      platform: readString(cachedBuild.platform),
      buildProfile: readString(cachedBuild.buildProfile),
      createdAt: readString(cachedBuild.createdAt),
      buildUrl: readString(cachedBuild.buildUrl),
    },
  };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Record what EAS answered for one platform, keeping the other platform's entry.
 *
 * A hit is believed while the project hash stands. A `none` is believed for
 * {@link EAS_NONE_CACHE_TTL_MS}.
 *
 * Best-effort, like every other `.expo` record: a project whose `.expo` cannot be written loses a
 * cache, not a report.
 */
export function writeEasBuildsEntry(
  projectRoot: string,
  platform: NativePlatform,
  entry: {
    projectHash: string | null;
    fingerprintHash: string | null;
    build: CachedBuild | null;
    checkedAt?: string;
  }
): void {
  // Nothing to key the entry on is nothing to cache: an entry that cannot say which working tree
  // it was true for could only ever be believed by guessing.
  if (!entry.projectHash || !entry.fingerprintHash || (entry.build && !entry.build.id)) {
    return;
  }
  try {
    const record = {
      ...readEasBuildsRecord(projectRoot),
      [platform]: {
        projectHash: entry.projectHash,
        fingerprintHash: entry.fingerprintHash,
        checkedAt: entry.checkedAt ?? new Date().toISOString(),
        build: entry.build,
      },
    };
    ensureDotExpoProjectDirectoryInitialized(projectRoot);
    fs.writeFileSync(getRecordPath(projectRoot), JSON.stringify(record, null, 2) + '\n');
  } catch {
    // A cache that could not be written is a lookup next time, which is the state this started in.
  }
}

/** Await a promise, resolving to null when it takes longer than `timeoutMs`. */
async function withDeadlineAsync<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** Forget a remembered `none` for one platform, because this CLI is starting a build for it. */
export function dropEasNoneEntry(projectRoot: string, platform: NativePlatform): void {
  try {
    const record = readEasBuildsRecord(projectRoot);
    if (!record[platform] || record[platform]!.build) {
      return;
    }
    delete record[platform];
    fs.writeFileSync(getRecordPath(projectRoot), JSON.stringify(record, null, 2) + '\n');
  } catch {
    // A none that could not be dropped still expires on its own.
  }
}
