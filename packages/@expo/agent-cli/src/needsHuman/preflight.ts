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

import { stripVTControlCharacters } from 'util';

import { easCliArgs, mayDownloadEasCli, resolveEasCli } from '../utils/easCli';
import { resolveProjectBin } from '../utils/projectBin';
import { spawnSubprocessAsync, type SubprocessResult } from '../utils/subprocess';
import { looksLikeWrapperCrash } from '../utils/wrapperCrash';

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

  const result = await spawnSubprocessAsync(easCli.command, easCliArgs(easCli, ['whoami']), {
    cwd: projectRoot,
    output: 'capture',
    timeoutMs,
  });

  if (result.spawnError || looksLikeWrapperCrash({ tool: 'eas', ...result })) {
    return null;
  }
  return fromWhoami(result, 'eas whoami');
}

/**
 * What a `whoami` run answered.
 *
 * `signed-out` only for the two texts the CLIs print for nobody signed in [observed — eas-cli
 * 27.7.2 and expo 58.1.4: `Not logged in` for no session, `The bearer token is invalid.` for a
 * rejected `EXPO_TOKEN`, both at exit 1]. A network failure exits 1 as well, and a child a signal
 * stopped can report exit 0, so both are `failed`: neither says who is signed in.
 */
export function classifyWhoami(
  result: Pick<SubprocessResult, 'exitCode' | 'stdout' | 'stderr' | 'signal'>
): 'signed-in' | 'signed-out' | 'failed' {
  if (result.signal) {
    return 'failed';
  }
  if (result.exitCode === 0) {
    return 'signed-in';
  }
  // Colour wraps the text in escapes when the CLI thinks it writes to a terminal [observed —
  // eas-cli with FORCE_COLOR=1 prints `\x1b[33mNot logged in\x1b[39m`].
  const said = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`);
  return SIGNED_OUT_ANSWERS.some((answer) => answer.test(said)) ? 'signed-out' : 'failed';
}

const SIGNED_OUT_ANSWERS = [/^Not logged in\s*$/m, /The bearer token is invalid\./];

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
  if (result.spawnError || looksLikeWrapperCrash({ tool: 'expo', ...result })) {
    return null;
  }
  return fromWhoami(result, 'expo whoami');
}

/**
 * The preflight's answer from one `whoami` run, or `UNVERIFIED` when the run said nothing about who
 * is signed in. A rejected `EXPO_TOKEN` is "signed out", which is exactly the case a bare "the
 * variable is set" would get wrong.
 */
function fromWhoami(result: SubprocessResult, source: 'eas whoami' | 'expo whoami'): Asked {
  if (result.timedOut) {
    return UNVERIFIED;
  }
  switch (classifyWhoami(result)) {
    case 'signed-in':
      return { loggedIn: true, user: parseWhoamiUser(result.stdout), source };
    case 'signed-out':
      return { loggedIn: false, user: null, source };
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

/**
 * The account name out of a `whoami` run, exported for the `whoami` command's own JSON.
 *
 * The same parse for both CLIs: `expo whoami` prints the display name alone [observed —
 * `@expo/cli` `whoami/whoamiAsync.ts`], and `eas whoami` prints it above more.
 *
 * The **first** line that looks like one name, not the last. `eas whoami` prints the name, then the
 * email, then — for an actor belonging to more than their own personal account — a blank line,
 * `Accounts:`, and one `• <name> (Role: <role>)` per account [observed — the recorded payload in
 * `src/__fixtures__/eas/whoami.txt`, and `eas-cli/build/commands/account/view.js`, 22.4.0]. So the
 * last line of a real signed-in machine's answer is a role, and reading it reported `user: null`
 * for every account that is on a team.
 *
 * Scanning forward for the first line that *looks like* a name rather than taking line one keeps
 * what the previous rule was for: a notice printed above the answer has spaces in it, fails the
 * shape test, and is skipped. The email matches the shape too, but it comes second, so the name
 * still wins.
 *
 * The `(authenticated using EXPO_TOKEN)` note the CLI appends when the session came from the
 * variable is dropped: it says how the account was reached, not which account it is.
 */
export function parseWhoamiUser(stdout: string): string | null {
  for (const raw of stdout.split('\n')) {
    // Everything below this belongs to the account list, and every line of it is a role.
    if (raw.trim() === ACCOUNT_LIST_HEADING) {
      return null;
    }
    const line = raw.trim().replace(EXPO_TOKEN_NOTE, '').trim();
    if (line && /^[\w.@+-]+$/.test(line)) {
      return line;
    }
  }
  return null;
}

/** The line `eas whoami` prints above the account list, and the end of anything worth reading. */
const ACCOUNT_LIST_HEADING = 'Accounts:';

/** How `eas whoami` notes that the session came from the variable rather than from a login. */
const EXPO_TOKEN_NOTE = /\s*\(authenticated using EXPO_TOKEN\)$/;
