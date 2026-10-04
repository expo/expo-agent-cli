import { isCancel, type CommonOptions } from '@clack/prompts';

/** Clack handles Escape and Ctrl-C; also cancel on stdin EOF or Ctrl-D. */
export async function askAsync<T>(
  prompt: (io: CommonOptions) => Promise<T | symbol>
): Promise<T | null> {
  const input = process.stdin;
  if (input.readableEnded || input.destroyed) return null;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const onKeypress = (_value: string, key: { ctrl?: boolean; name?: string }) => {
    if (key.ctrl && key.name === 'd') cancel();
  };
  input.once('end', cancel);
  input.once('close', cancel);
  input.on('keypress', onKeypress);
  try {
    const result = await prompt({ input, output: process.stderr, signal: controller.signal });
    return isCancel(result) ? null : (result as T);
  } finally {
    input.off('end', cancel);
    input.off('close', cancel);
    input.off('keypress', onKeypress);
    input.pause();
  }
}
