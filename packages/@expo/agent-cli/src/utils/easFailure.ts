// @ref llp/0007-deploy-and-headless.rfc.md §deploy
// @ref llp/0021-honest-reports.rfc.md §The rules
// @ref llp/0027-everything-on-eas.rfc.md §What EAS said
// Why an `eas` run stopped, read out of what it said. Written for `eas deploy`, and now read by
// every place this CLI quotes the EAS CLI's refusal: the build lookup of `status --explain`, the
// session listing behind every `--eas` device command, and a failed `eas` step of `dev`.
//
// The upload used to be diagnosed from its *exit signature* alone: one `Why:` line, written once,
// naming the most common cause. On an unlinked project that line said "most often an account that is
// not signed in" to somebody who was signed in, while the real cause — `EAS project not configured`,
// and the `eas init` that fixes it — sat in the raw output under a different heading
// [observed — live run S2, 2026-08-26; friction run 7, F67].
//
// The EAS CLI's own message is a better source than a guess, and the two strings below are stable
// enough to key on: both were observed live, and both are the *whole* explanation the CLI gives.
// Anything they do not match keeps the guess — and now says out loud that it is one.
//
// Not a needs-human classification. That is `src/needsHuman/` and it is asked separately: this
// answers "what went wrong and what fixes it", which a signed-out machine and an unlinked project
// both have answers to, and only one of them needs a person.

/** What the EAS CLI's own words say, when they say something this CLI can act on. */
export interface EasFailureCause {
  /** Which sentence was recognised. */
  id: 'eas-project-unlinked' | 'eas-login';
  /** The `Why:` line, in this CLI's voice, about what the tool reported. */
  why: string;
  /** The `How:` line. */
  how: string;
  /**
   * The whole thing in one line, for a status row or a `reason` that has one line to say it in.
   *
   * @ref llp/0027-everything-on-eas.rfc.md §What EAS said
   * The first line of what the EAS CLI printed was what those rows quoted, and for an unlinked
   * project that line is "Run one of the following, then re-run this command:" with the following
   * cut off [observed — `status --explain`, `runtime:stop --eas`, 2026-09-08].
   */
  summary: string;
  /**
   * The command to put on the `Try:` line, or null when the fix is not one command.
   *
   * Never the command that just failed: a `Try:` that reproduces the failure costs the reader a
   * round trip and teaches them nothing [friction run 7, F67].
   */
  command: string | null;
}

/** @deprecated The name this had when only `deploy` read it. */
export type EasDeployCause = EasFailureCause;

/** One recognisable sentence of the EAS CLI's, and what it means. */
interface EasFailureSignature {
  /** How the CLI says it. Matched against stdout and stderr together. */
  pattern: RegExp;
  /**
   * What it means, built from the output rather than written out flat.
   *
   * Because one of these reads a *value* out of it: the accounts a project can be created under are
   * the caller's own, this CLI cannot know them, and the EAS CLI prints them right there.
   */
  cause: (output: string) => EasFailureCause;
}

/**
 * `Accounts you can create projects in: alice, expo, expo-services, bob` — the EAS CLI's own
 * list, printed under the two `eas init` forms [observed — friction run 9; live run, 2026-08-26].
 */
const ACCOUNTS_LINE = /^\s*Accounts you can create projects in:\s*(.+?)\s*$/im;

/** The accounts the EAS CLI listed, or none when it listed none. */
export function readEasAccounts(output: string): string[] {
  return (
    ACCOUNTS_LINE.exec(output)?.[1]
      ?.split(',')
      .map((account) => account.trim())
      .filter(Boolean) ?? []
  );
}

const SIGNATURES: readonly EasFailureSignature[] = [
  {
    // `EAS project not configured.` — printed with the two `eas init` forms that fix it, on
    // **stdout** [observed — live against an unlinked project, 2026-08-26].
    pattern: /EAS project not configured/i,
    // @ref llp/0007-deploy-and-headless.rfc.md §deploy — **F143.** `npx eas init`
    // was this row's answer for two waves, and it is a command that *prompts*: for the account, and
    // for whether to create a project or link one. This failure exists because the run had no
    // terminal to answer a prompt in, so the fix cannot be a command that asks one. The
    // non-interactive form is what the EAS CLI itself prints, and the account it needs is on the
    // line below that.
    cause: (output) => {
      const accounts = readEasAccounts(output);
      // A single account is not a choice, so the line has no hole in it and an agent can run it.
      const account = accounts.length === 1 ? accounts[0]! : '<account-name>';
      return {
        id: 'eas-project-unlinked',
        summary: `this project is not linked to an EAS project — link it once with "npx eas init --account ${account} --non-interactive" (or --id <project-id> for one that exists)`,
        why: 'the EAS CLI reported that this project is not linked to an EAS project, so there is nothing on EAS to act on. This is not about being signed in.',
        how: `link it once, which writes the project id into the app config: "npx eas init --account ${account} --non-interactive" creates a new project under that account, and "npx eas init --id <project-id> --non-interactive" links one that already exists. Then run this command again.${
          accounts.length > 1
            ? ` The EAS CLI listed these accounts: ${accounts.join(', ')} — only a person can choose which one this project belongs to.`
            : ''
        }`,
        command: `npx eas init --account ${account} --non-interactive`,
      };
    },
  },
  {
    // `You are not logged in` / `Not logged in` / `Log in with eas login` — the account case, which
    // is what the old single `Why:` line assumed every failure was.
    pattern: /\bnot logged in\b|\beas login\b|\bmust be logged in\b/i,
    cause: () => ({
      id: 'eas-login',
      summary: 'this machine is not signed in to an Expo account — "npx eas login", or EXPO_TOKEN for a machine with nobody at it',
      why: 'the EAS CLI reported that this machine is not signed in to an Expo account, and the run was non-interactive, so it could not ask.',
      how: 'sign in with "npx eas login", or set EXPO_TOKEN to an access token from expo.dev for a machine with nobody at it, then run this command again.',
      command: 'npx eas login',
    }),
  },
];

/**
 * What the EAS CLI said went wrong, or null when it said nothing recognisable.
 *
 * Pure over the captured text, so every row is testable without an account.
 *
 * @param output stdout and stderr together — the CLI puts the whole explanation of an unlinked
 * project on stdout and one summary line on stderr, so reading either alone loses one of them.
 */
export function classifyEasFailure(output: string): EasFailureCause | null {
  return SIGNATURES.find((signature) => signature.pattern.test(output))?.cause(output) ?? null;
}

/** @deprecated The name this had when only `deploy` read it. */
export const classifyEasDeployFailure = classifyEasFailure;
