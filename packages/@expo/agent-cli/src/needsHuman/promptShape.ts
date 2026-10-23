// @ref llp/0010-agent-conventions.rfc.md §Needs-human protocol
// Layer 4 of the detection: whether captured output ends on a question. A leaf module, so the
// subprocess runner can use it without importing the registry that names EAS commands.

/**
 * Whether a line reads like a tool waiting for an answer.
 *
 * Half of the layer-4 guard, and the half that keeps it from killing a slow but healthy command:
 * silence alone is a long build, and silence *on a question* is a prompt nobody will ever answer.
 *
 * The leading `?` and `›` are the markers `prompts` and `inquirer` write, which is how both CLIs
 * ask — `? Select a platform` is a question that ends in neither a question mark nor a colon.
 *
 * @ref llp/0006-agent-native-cli-surface.rfc.md §Surface improvements
 */
export function isPromptShaped(line: string): boolean {
  return /[?:]\s*$|^\s*[?›»]\s+\S|\(y\/N\)|\(Y\/n\)|Password|passphrase/i.test(line);
}

/** The last line of a captured stream that has anything on it, which is where a prompt sits. */
export function lastNonEmptyLine(output: string): string | null {
  const lines = output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  return lines.length ? lines[lines.length - 1]! : null;
}
