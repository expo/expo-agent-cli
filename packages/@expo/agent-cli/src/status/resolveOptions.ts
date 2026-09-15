// @ref llp/0004-smart-start-and-project-state.rfc.md §Status
// Argument resolution for the flags `status` grew when it absorbed `@expo/agent-cli impact`. Pure: values
// in, options out, `CommandError` for anything a caller can get wrong, so every combination is
// unit-testable without a project.

import { IMPACT_CLASS_ORDER, type ImpactClass } from '../impact/types';
import { PROGRAM_PREFIX } from '../programName';
import { CommandError } from '../utils/errors';
import { easCommandPrefix } from '../utils/easCli';

/**
 * The class `--assert` names, or null when the flag was not given.
 *
 * @throws {CommandError} `BAD_ARGS` when the value is not one of the three classes.
 */
export function resolveAssertClass(value: unknown): ImpactClass | null {
  if (value == null) {
    return null;
  }
  if (typeof value === 'string' && (IMPACT_CLASS_ORDER as string[]).includes(value)) {
    return value as ImpactClass;
  }
  throw new CommandError(
    'BAD_ARGS',
    [
      `--assert ${String(value)} is not one of the classes this reports.`,
      `Why: --assert is a gate on the class in the report, so it has to name one of them: it passes when the real class is at most the one named.`,
      `How: pass one of ${IMPACT_CLASS_ORDER.join(', ')}, weakest first. "--assert js-only" is the strictest gate.`,
    ].join('\n')
  );
}

/**
 * The EAS build `--build` names, or null.
 *
 * The flag fetches the fingerprint EAS computed for that one build — a network call the default
 * report does not make on its own — and it is made because the caller named the build. It used to
 * require `--explain` as the word for "you may spend a round trip"; there is no such word now, and
 * naming a build is the ask.
 *
 * @throws {CommandError} `BAD_ARGS` for an empty value.
 */
export function resolveBuildId(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  const buildId = typeof value === 'string' ? value.trim() : '';
  if (!buildId) {
    throw new CommandError(
      'BAD_ARGS',
      [
        `--build needs the id of an EAS build.`,
        `Why: it compares this working tree against the fingerprint EAS computed for one specific build, which is server ground truth and needs no local record.`,
        `How: find the id with "${easCommandPrefix()} build:list --limit 5 --json --non-interactive", then run "${PROGRAM_PREFIX} status --build <id>".`,
      ].join('\n')
    );
  }
  return buildId;
}
