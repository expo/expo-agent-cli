// @ref llp/0006-agent-native-cli-surface.rfc.md §Output contract
// `--json` must print exactly one JSON object on stdout. Composed commands and project config
// can print diagnostics, which belong on stderr while a JSON result is being prepared.

/**
 * Run `work` with stdout redirected to stderr, including console and direct writes.
 *
 * Only stdout carries the output contract, so the composed text summary stays readable on stderr
 * and a `--json` run remains debuggable.
 */
export async function withStdoutRedirectedAsync<T>(work: () => Promise<T>): Promise<T> {
  const originalWrite = process.stdout.write;
  process.stdout.write = process.stderr.write.bind(process.stderr);
  try {
    return await work();
  } finally {
    process.stdout.write = originalWrite;
  }
}
