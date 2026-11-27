import { stripVTControlCharacters } from 'util';

import type { SubprocessResult } from '../utils/subprocess';
import { looksLikeWrapperCrash } from '../utils/wrapperCrash';

type WhoamiAnswer =
  | { status: 'signed-in'; user: string | null }
  | { status: 'signed-out' }
  | { status: 'token-rejected' }
  | { status: 'failed' }
  | { status: 'unavailable' };

/** Decode the EAS machine response, or the human response from older pins and Expo CLI. */
export function readWhoamiAnswer(result: SubprocessResult, tool: 'eas' | 'expo'): WhoamiAnswer {
  if (result.spawnError) {
    return { status: 'unavailable' };
  }
  if (result.signal || result.timedOut || result.exitCode === null) {
    return { status: 'failed' };
  }
  const stdout = result.stdout.trimStart();
  if (tool === 'eas') {
    // Package runners can print a notice before the CLI writes its JSON object.
    // A bracketed log prefix such as "[dotenv@17] injecting env" is also a notice.
    const start = stdout.search(/^[ \t]*(?:\{|\[(?![\w@./:-]+\][ \t]+\S))/m);
    if (start >= 0) {
      return readEasJson(stdout.slice(start), result.exitCode);
    }
  }

  if (looksLikeWrapperCrash({ tool, ...result })) {
    return { status: 'unavailable' };
  }
  if (result.exitCode === 0) {
    return { status: 'signed-in', user: parseWhoamiUser(result.stdout) };
  }
  const said = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`);
  if (/The bearer token is invalid\./.test(said)) {
    return { status: 'token-rejected' };
  }
  return { status: /^Not logged in\s*$/m.test(said) ? 'signed-out' : 'failed' };
}

function readEasJson(stdout: string, exitCode: number): WhoamiAnswer {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return { status: 'failed' };
  }
  if (!payload || typeof payload !== 'object' || !('status' in payload)) {
    return { status: 'failed' };
  }
  // An indeterminate lookup and future unknown statuses carry no identity.
  if (exitCode === 1 && (payload.status === 'signed-out' || payload.status === 'token-rejected')) {
    return { status: payload.status };
  }
  if (exitCode === 0 && payload.status === 'signed-in' && 'actor' in payload) {
    const actor = payload.actor;
    if (
      actor &&
      typeof actor === 'object' &&
      'displayName' in actor &&
      typeof actor.displayName === 'string' &&
      actor.displayName.trim() &&
      !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(actor.displayName)
    ) {
      return { status: 'signed-in', user: actor.displayName };
    }
  }
  return { status: 'failed' };
}

/**
 * The account name from legacy human output.
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
function parseWhoamiUser(stdout: string): string | null {
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
