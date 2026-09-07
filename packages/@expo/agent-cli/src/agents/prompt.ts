import { createInterface } from 'readline';

export type SetupQuestion = (message: string) => Promise<string | null>;

/** Keep one iterator for the whole conversation so pasted answers and EOF are not lost. */
export function createSetupPrompt(): { question: SetupQuestion; close(): void } {
  const input = createInterface({ input: process.stdin, output: process.stderr });
  const lines = input[Symbol.asyncIterator]();
  input.on('SIGINT', () => input.close());
  return {
    async question(message) {
      process.stderr.write(`${message}\n> `);
      const answer = await lines.next();
      return answer.done ? null : answer.value.trim();
    },
    close: () => input.close(),
  };
}
