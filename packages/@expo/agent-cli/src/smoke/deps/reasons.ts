/** A refusal's What and its How line, as one phase reason; the Why in between is dropped. */
export function whatAndHow(message: string): string {
  const lines = message.split('\n').filter((line) => line.trim());
  const how = lines.find((line) => line.startsWith('How:'));
  return how && how !== lines[0] ? `${lines[0]} ${how}` : (lines[0] ?? message);
}
