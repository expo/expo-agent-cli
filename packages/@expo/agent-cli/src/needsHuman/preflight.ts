// @ref llp/0010-agent-conventions.rfc.md §Needs-human protocol
// Layer 1: ask the cheap question before starting the expensive command.
//
// "Who is this machine signed in as" is the precondition behind most of the registry, and it costs
// one short subprocess to answer. Asking it first turns a failure that arrives after minutes of
// exporting into one that arrives before anything was spent — and it is the fact `@expo/agent-cli status`
// reports, so a driving agent can find out what will need its user before it starts.
//
// Nothing here ever throws. A preflight that cannot run is not an answer of "no": it is no answer,
// and the caller falls back to recognising the failure when it happens (layer 3).

import { readWhoamiAnswer } from './whoami';

import { easCliArgs, mayDownloadEasCli, resolveEasCli } from '../utils/easCli';
import { resolveProjectBin } from '../utils/projectBin';
import { spawnSubprocessAsync, type SubprocessResult } from '../utils/subprocess';

/** Who the Expo CLI family acts as on this machine. */
export interface AuthPreflight {
  /** Null when nothing could answer, which is not the same as "signed out". */
  loggedIn: boolean | null;
  /** The account name, when something knew it. */
  user: string | null;
  /**
   * What answered. Null when nothing did.
   *
   * `expo whoami` is the second rung, and it exists because the first one can be a stranger: on a
   * machine whose `eas` was a broken shim, `status` reported `auth unknown (nothing could answer)`
   * while `@expo/agent-cli whoami` printed the account name in the same directory [observed — friction run
   * 7, F65]. Both CLIs read the same `~/.expo/state.json`, so the second question is the same
   * question asked of the CLI the project actually installed.
   */
  source: 'eas whoami' | 'expo whoami' | 'EXPO_TOKEN' | null;
  /**
   * Set when the service rejected `EXPO_TOKEN`. A login cannot fix that: eas-cli refuses to log in
   * while the variable is set [observed — eas-cli `account/login.js`].
   */
  tokenRejected?: true;
}

/**
 * How long `eas whoami` may take.
 *
 * Each `status` section has a short budget and this is one of them, so a CLI that is slow to start
 * costs an "unknown" line rather than the whole report's speed.
 */
export const AUTH_PREFLIGHT_TIMEOUT_MS = 4000;

/** One answer per project per process: the account does not change while a command runs. */
const cache = new Map<string, Promise<AuthPreflight>>();

/**
 * Who this machine is signed in to Expo as.
 *
 * `eas whoami` is asked first, because it is the one that also knows the *name*, and because it
 * already reads `EXPO_TOKEN` itself — so a token that works is reported as a working login rather
 * than as a variable that is merely set. The variable is only consulted when the CLI could not be
 * asked at all.
 *
 * Cached for the lifetime of the process, so a command that asks twice spawns once.
 */
export function readAuthPreflightAsync(
  projectRoot: string,
  { timeoutMs = AUTH_PREFLIGHT_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<AuthPreflight> {
  const cached = cache.get(projectRoot);
  if (cached) {
    return cached;
  }
  const answer = probeAsync(projectRoot, timeoutMs);
  cache.set(projectRoot, answer);
  return answer;
}

/** Forget what was answered, for tests and for a command that changed the login itself. */
export function resetAuthPreflightCache(): void {
  cache.clear();
}

/** A CLI ran and said nothing about who is signed in: a network failure, a stop, a timeout. */
const UNVERIFIED = 'unverified';
type Asked = AuthPreflight | typeof UNVERIFIED | null;

async function probeAsync(projectRoot: string, timeoutMs: number): Promise<AuthPreflight> {
  const fromEas = await askEasAsync(projectRoot, timeoutMs);
  if (fromEas && fromEas !== UNVERIFIED) {
    return fromEas;
  }
  // The EAS CLI gave no answer. The project's own Expo CLI reads the same session file, and it is
  // the rung `@expo/agent-cli whoami` uses (`passthrough/auth.ts` §resolveAuthCliAsync), so the two
  // commands stop disagreeing about who this machine is (F65).
  const fromExpo = await askProjectExpoAsync(projectRoot, timeoutMs);
  if (fromExpo && fromExpo !== UNVERIFIED) {
    return fromExpo;
  }
  // A CLI that ran and could not verify the account most likely failed on that very token, so
  // the bare variable is no answer then.
  if (fromEas === UNVERIFIED || fromExpo === UNVERIFIED) {
    return { loggedIn: null, user: null, source: null };
  }
  return fromTokenAlone();
}

/**
 * What `eas whoami` said, or null when it said nothing about the account.
 *
 * Null covers three cases and each is "no answer" rather than "signed out": there is no EAS CLI, it
 * could not be run, or what ran was not the EAS CLI. A binary that is not the CLI exits non-zero
 * exactly the way a signed-out one does, and reading that as "signed out" would hand the user a
 * login they do not need — and, worse, would stop a command that had every right to run.
 *
 * **Only when the CLI is already here.** Without a project pin or a recent global `eas-cli`, the
 * resolver's answer is a package runner — `npx --yes eas-cli`, a package install to read
 * `~/.expo/state.json` on a cold cache. The two rungs *below*
 * this one, the project's own `expo whoami` and `EXPO_TOKEN`, answer the same question from the same
 * file for free. Each `status` section has a short budget and this is one of them, so this is the one
 * EAS-backed caller that declines to spend a download: it asks only when the project pins the CLI,
 * where the runner resolves it out of `node_modules` in about a third of a second, or when a global
 * install answers directly. It is the same
 * judgement `askProjectExpoAsync` below already makes for `expo`.
 */
async function askEasAsync(projectRoot: string, timeoutMs: number): Promise<Asked> {
  const easCli = resolveEasCli(projectRoot);
  if (!easCli || mayDownloadEasCli(easCli)) {
    return null;
  }

  const result = await spawnSubprocessAsync(
    easCli.command,
    easCliArgs(easCli, ['whoami', '--json']),
    {
      cwd: projectRoot,
      output: 'capture',
      timeoutMs,
    }
  );

  return fromWhoami(result, 'eas whoami');
}

/**
 * What the **project's own** `expo whoami` said, or null when it said nothing.
 *
 * The project's own `expo` bin and nothing else. `resolveExpoCli` would fall back to a
 * package runner, which downloads the whole SDK to read one JSON file [observed — 2026-08-26,
 * `passthrough/auth.ts`], and a `status` section is not worth a minute and a network install.
 *
 * "The project's own" is the walk of `src/utils/projectBin.ts`, which is what makes this rung reach
 * a workspace: npm installs a package's dependencies at the workspace root, so this used to decline
 * a free answer and report auth as unknown in a repository where `@expo/agent-cli whoami` names the user
 * [observed — 2026-08-27, F113].
 */
async function askProjectExpoAsync(projectRoot: string, timeoutMs: number): Promise<Asked> {
  const bin = resolveProjectBin(projectRoot, 'expo');
  if (!bin) {
    return null;
  }

  const result = await spawnSubprocessAsync(bin, ['whoami'], {
    cwd: projectRoot,
    output: 'capture',
    timeoutMs,
    env: { CI: '1' },
  });
  return fromWhoami(result, 'expo whoami');
}

/**
 * The preflight's answer from one `whoami` run, or `UNVERIFIED` when the run said nothing about who
 * is signed in. A rejected `EXPO_TOKEN` is "signed out", which is exactly the case a bare "the
 * variable is set" would get wrong.
 */
function fromWhoami(result: SubprocessResult, source: 'eas whoami' | 'expo whoami'): Asked {
  const answer = readWhoamiAnswer(result, source === 'eas whoami' ? 'eas' : 'expo');
  switch (answer.status) {
    case 'signed-in':
      return { loggedIn: true, user: answer.user, source };
    case 'signed-out':
      return { loggedIn: false, user: null, source };
    case 'token-rejected':
      return { loggedIn: false, user: null, source, tokenRejected: true };
    case 'unavailable':
      return null;
    case 'failed':
      return UNVERIFIED;
  }
}

/**
 * What `EXPO_TOKEN` alone says.
 *
 * Nothing was verified: no request was made and the token may be expired. It is reported because
 * a machine with the variable set is a machine that was *configured* to act as an account, which
 * is what an agent deciding whether to hand a login to its user needs to know.
 */
function fromTokenAlone(): AuthPreflight {
  return process.env.EXPO_TOKEN
    ? { loggedIn: true, user: null, source: 'EXPO_TOKEN' }
    : { loggedIn: null, user: null, source: null };
}
