/**
 * The fenced-code state after one line of Markdown: the open fence's marker, or null outside a block.
 *
 * A closing fence uses the opening one's character, is at least as long, and has no text after it,
 * so a ```` ```ts ```` line inside a ```` ```markdown ```` block is content, not the end of the block.
 */
export function nextFence(line: string, fence: string | null): string | null {
  const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!marker) {
    return fence;
  }
  if (fence == null) {
    return marker[1]!;
  }
  const closes =
    marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim();
  return closes ? null : fence;
}
