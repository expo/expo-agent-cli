// @ref llp/0004-smart-start-and-project-state.rfc.md §Decision table
import { classifyAgainstRecordedBuild } from '../impact/fromRecord';
import type { ProjectState } from '../project/types';
import type { DecideStartPlanOptions, NativePlatform } from './types';

const HASH_DISPLAY_LENGTH = 8;

interface Freshness {
  /** The installed app can be proven to match this project. */
  fresh: boolean;
  /** One short sentence, shown on the step it explains. */
  summary: string;
  /** The same sentence, plus any diagnostic detail, for the plan's reason list. */
  reasons: string[];
  /**
   * Whether the native project has to be generated again before the build.
   *
   * @ref llp/0004-smart-start-and-project-state.rfc.md §Decision table
   *
   * Meaningless when {@link fresh}, and `true` whenever the comparison could not establish
   * otherwise — a stale build with nothing to compare against is planned exactly as it always was.
   */
  needsPrebuild: boolean;
}

/**
 * Compare the project fingerprint against the last build `@expo/agent-cli` recorded for the platform.
 *
 * Anything short of a proven match is planned as a build. A missing fingerprint (the
 * `fingerprint` CLI is unavailable or failed) and a missing record both mean "cannot prove the
 * installed app matches this project".
 *
 * **A stale build is two questions, not one** (llp/0004 §Decision table). "Is the recorded build
 * still good" is the hash, and it is the whole of {@link Freshness.fresh}. "Does making it good
 * again start with a prebuild" is a different question, and the hash cannot answer it: a changed
 * config plugin and a changed `eas.json` move the hash identically and need different plans. So a
 * hash that moved is handed to `classifyAgainstRecordedBuild`, which diffs the recorded sources
 * against the probed ones in process — no subprocess and no second fingerprint run — and reports
 * which kinds of source moved.
 *
 * Every path that cannot establish an answer keeps `needsPrebuild: true`, which is the plan this
 * table produced before it could ask: an unnecessary prebuild costs a minute, and a skipped one
 * costs a build that does not contain the change.
 */
export function describeFreshness(
  state: ProjectState,
  platform: NativePlatform,
  { lastBuild = {}, installedIosBuild }: DecideStartPlanOptions
): Freshness {
  if (platform === 'ios' && installedIosBuild) {
    const { name, identifier } = installedIosBuild;
    return freshness(
      true,
      `The development build installed on ${name} (${identifier}) matches the project’s iOS fingerprint.`
    );
  }
  const { hash, error } = state.fingerprint;
  if (hash == null) {
    // The error can be long, so it stays out of the step summary and lands in the reasons.
    const summary = 'The project fingerprint is unavailable, so a matching build cannot be proven.';
    return {
      fresh: false,
      summary,
      reasons: error ? [summary, `Fingerprint error: ${error}`] : [summary],
      needsPrebuild: true,
    };
  }

  const recorded = lastBuild[platform];
  if (recorded == null) {
    return freshness(false, `No development build recorded for ${platform}, so a build is needed.`);
  }
  if (recorded.hash !== hash) {
    const summary = `The project fingerprint (${shortHash(hash)}) differs from the last recorded build (${shortHash(recorded.hash)}), so a new build is needed.`;
    const impact = classifyAgainstRecordedBuild(platform, recorded, state.fingerprint);
    // `null` is the comparison saying it could not tell — an older record that stored only a hash,
    // or a fingerprint run that returned no sources. Its own sentence says which, and it is worth
    // printing: it is the difference between "prebuild is needed" and "this could not rule it out".
    if (impact.needsPrebuild == null) {
      return { fresh: false, summary, reasons: [summary, impact.reason], needsPrebuild: true };
    }
    return {
      fresh: false,
      summary,
      reasons: [summary, ...(impact.changedSources.length ? [impact.reason] : [])],
      needsPrebuild: impact.needsPrebuild,
    };
  }
  return freshness(
    true,
    `The project fingerprint (${shortHash(hash)}) matches the last build recorded for ${platform}.`
  );
}

function freshness(fresh: boolean, summary: string, needsPrebuild = true): Freshness {
  return { fresh, summary, reasons: [summary], needsPrebuild };
}

function shortHash(hash: string): string {
  return hash.slice(0, HASH_DISPLAY_LENGTH);
}
