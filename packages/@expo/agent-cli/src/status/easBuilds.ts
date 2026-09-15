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
// So the network half is opt-in (`--explain`) and the **cache is always read**, because the cache
// is exact rather than approximate: the whole-project hash *dominates* the per-platform ones —
// `--platform` filters the same source list, so an unchanged project hash implies unchanged
// per-platform hashes — which makes the hash `status` already has a sound key for an answer about
// a hash it does not have. A hit costs one `readFileSync` and is as true as the lookup that wrote
// it. See the LLP section for the argument in full.
//
// A `none` is remembered too, for a short while (§A none is remembered for five minutes), and a
// project whose static config says it is not linked to EAS is never asked at all: `eas build:list`
// refuses an unlinked project, and this CLI can read that refusal off `app.json` for free.

import fs from 'fs';
import path from 'path';

import { lookUpCachedBuildAsync, runnerDownloadNote } from '../impact/buildCache';
import type { CachedBuild } from '../impact/types';
import type { NativePlatform } from '../plan/types';
import type { EasProjectLink } from '../project/appConfig';
import { generateFingerprintAsync } from '../project/fingerprint';
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
 * Generous, because it is only ever spent by a caller who asked for it: the two halves measured
 * 1.24 s and 1.10–1.33 s live, so a budget under about four seconds would abandon answers that were
 * on their way. Expiring costs the platform an answer (`unknown`), never the report.
 */
export const EAS_BUILD_LOOKUP_TIMEOUT_MS = 10_000;

/**
 * How long the same lookup gets when the EAS CLI has to be **downloaded** first.
 *
 * @ref llp/0015-backend-selection-and-config.rfc.md §Resolving the EAS CLI
 * In a project that does not pin `eas-cli`, the one rung is `npx --yes eas-cli@latest`: its first
 * run installs the package before the query starts, and every run asks the registry, which no budget
 * written for a warm CLI can cover. Two answers were possible and this section takes the *middle*
 * one [decided — 2026-08-27, wave 18]: a wider budget, still bounded, so the common case of a modest
 * install answers rather than expires — and never the minutes a cold install, or an unreachable
 * registry, can take, because `status` must not hang. A run that expires anyway says the download was
 * why, and the next run is warm. Only reached under `--explain`; a default `status` asks EAS nothing.
 *
 * A project that *pins* the CLI keeps the tighter budget above: the runner resolves it out of
 * `node_modules` without a network call at all.
 */
export const EAS_BUILD_RUNNER_TIMEOUT_MS = 45_000;

/**
 * How long a `none` is believed before EAS is asked again.
 *
 * @ref llp/0011-impact-and-freshness.rfc.md §The build-cache lookup
 * A `found` is exact for as long as the project hash it is keyed on stands: a build EAS has does not
 * stop existing. A `none` is a fact about a *moment* — the build that answers it may be in the queue
 * right now — so it used to be written nowhere, and every run of a linked project paid the network
 * call again [decided — 2026-08-26]. An agent loop runs `status` many times per minute, and paying
 * 1.3 s each time to be told "still none" is the cost this bound removes.
 *
 * Five minutes, and not the fingerprint cache's ten: what a stale `none` misdirects is a native
 * build (`stale` on the EAS axis, when a download was the answer), and five minutes is less than
 * the build the reader would otherwise start. `--no-fingerprint-cache` is the way out for a caller
 * who cannot accept even that, and the report says how old the answer is.
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
  /**
   * The build EAS had, or **null** when EAS answered that it has none.
   *
   * A null is bounded by {@link EAS_NONE_CACHE_TTL_MS} from `checkedAt`; a build is bounded by the
   * project hash alone.
   */
  build: CachedBuild | null;
}

type EasBuildsRecord = Partial<Record<NativePlatform, CachedEntry>>;

export interface EasBuildsOptions {
  /** Whether this run may call EAS. False on every run without `--explain`. */
  lookUp: boolean;
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
   * Whether the per-platform fingerprint below may come out of the project's `.expo` record — and
   * whether this section's own record may answer at all.
   *
   * @see llp/0023-fingerprint-caching.rfc.md — this is the section that pays for *two* of the three
   * fingerprints a `status --explain` used to compute, so it is the one the cache helps most. A
   * caller who refused that cache wants a measurement, so the remembered EAS answer is refused too:
   * the flag is about what the caller will accept, not about which file the answer came out of.
   */
  fingerprintCache?: boolean;
  /**
   * Whether the project is linked to an EAS project, per its **static** app config.
   *
   * An unlinked project is answered without a network call: `eas build:list` refuses it with a
   * sentence this CLI already rewrites (`classifyEasFailure`), and `app.json` says the same thing
   * for free. A dynamic config cannot be read here, so it is asked as before — `projectId: null`
   * with `dynamic: true` proves nothing. Null when the project could not be read at all.
   */
  easProject?: EasProjectLink | null;
}

/**
 * What EAS already has for this project, per platform.
 *
 * Reads the cache always and calls EAS only under `--explain`. Never throws: every way of not
 * getting an answer is an `unknown` carrying the reason, so a section that could not be read costs
 * one line of the report and the command still exits 0.
 */
export async function readEasBuildsStatusAsync(
  projectRoot: string,
  options: EasBuildsOptions
): Promise<BuildsStatus> {
  // A refused cache is refused whole: the record is not read, so every platform is asked again.
  const record = options.fingerprintCache === false ? {} : readEasBuildsRecord(projectRoot);
  // Once for the whole section rather than once per platform: the answer cannot differ between them,
  // and the two rungs it may take both touch the filesystem. It is also what lets the deadline below
  // say *why* a lookup ran out of time.
  const easCli = options.lookUp ? resolveEasCli(projectRoot) : null;
  const platforms = await Promise.all(
    PLATFORMS.map((platform) => readPlatformAsync(projectRoot, platform, record, options, easCli))
  );
  return { askedEas: options.lookUp, platforms };
}

async function readPlatformAsync(
  projectRoot: string,
  platform: NativePlatform,
  record: EasBuildsRecord,
  options: EasBuildsOptions,
  easCli: EasCli | null
): Promise<PlatformBuild> {
  const cached = record[platform];
  if (cached && options.projectHash && cached.projectHash === options.projectHash) {
    if (cached.build) {
      return found(platform, cached.fingerprintHash, cached.build, 'cache', cached.checkedAt);
    }
    // A remembered `none`, believed only while it is young. Older than that it is not an answer,
    // and the run falls through to asking — or to `unknown`, on a run that may not.
    const age = ageOf(cached.checkedAt);
    if (age != null && age <= EAS_NONE_CACHE_TTL_MS) {
      return none(platform, cached.fingerprintHash, 'cache', cached.checkedAt, age);
    }
  }

  if (!options.lookUp) {
    // Short on purpose: this is the reason on every platform of every default run, and the cost it
    // is short about is spelled out in `status --help`, which is where somebody weighing it looks.
    return unknown(platform, null, 'EAS was not asked — pass --explain');
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
  if (options.easProject && !options.easProject.projectId && !options.easProject.dynamic) {
    // The refusal `eas build:list` would print, read off the static config instead of paid for
    // with a network call. Only when the config is static: a dynamic one may name the id from an
    // environment variable this CLI does not evaluate, and "not seen" is not "not there".
    return unknown(platform, null, unlinkedReason(projectRoot, options.easProject, options.auth));
  }

  const deadline =
    options.timeoutMs ??
    (mayDownloadEasCli(easCli) ? EAS_BUILD_RUNNER_TIMEOUT_MS : EAS_BUILD_LOOKUP_TIMEOUT_MS);
  const outcome = await withDeadlineAsync(
    lookUpPlatformAsync(projectRoot, platform, deadline, easCli, options.fingerprintCache),
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
  // EAS answered and has none. Remembered, so the next few minutes of `status` runs do not pay the
  // same network call to be told the same thing (§EAS_NONE_CACHE_TTL_MS).
  writeEasBuildsEntry(projectRoot, platform, {
    projectHash: options.projectHash,
    fingerprintHash: outcome.fingerprintHash,
    build: null,
    checkedAt,
  });
  return none(platform, outcome.fingerprintHash, 'eas', checkedAt, null);
}

/**
 * The sentence for a project whose static config names no EAS project.
 *
 * The same two `eas init` forms `assertEasProjectConfiguredAsync` names, because they are the fix;
 * with the account filled in when the auth section knew it, the way `classifyEasFailure` fills in
 * the one EAS listed (llp/0027 §What EAS said).
 */
function unlinkedReason(
  projectRoot: string,
  easProject: EasProjectLink,
  auth: AuthStatus | null
): string {
  const config = easProject.source ?? 'its app config';
  const account = auth?.user ?? '<account>';
  return `this project is not linked to an EAS project — ${config} names no extra.eas.projectId, so EAS was not asked; link it once with "${easCommandPrefix(projectRoot)} init --account ${account} --non-interactive" (or --id <project-id> for one that exists)`;
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
  fingerprintCache: boolean | undefined
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
    // A found build is exact for as long as its key stands, so its age is not a bound on anything
    // and is not claimed.
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

/** How old a timestamp is, or null when it is not one this can subtract from now. */
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
 * An entry without both hashes is dropped rather than repaired: the whole value of this cache is
 * that a hit is *exact*, and an entry that cannot name what it was true for is not. A build without
 * an id is dropped for the same reason. A `none` (`build: null`) is dropped when it cannot say
 * *when* it was true, because a none with no time is a none with no bound.
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
 * A **hit** is written against the project hash and believed for as long as that hash stands: a hit
 * only goes out of date when somebody deletes a build, and the download command says so when they
 * have. A **none** is written with the time it was true, and believed for
 * {@link EAS_NONE_CACHE_TTL_MS} — it goes out of date on the ordinary timeline of the workflow this
 * exists to serve (you start a build, it finishes fifteen minutes later), so it is not believed for
 * long, and the report says how old it is.
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
