import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root,
  test: {
    include: [process.env.AGENT_CLI_EVAL_SUITE === 'smoke' ? 'smoke/*.eval.ts' : 'tier1/*.eval.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    retry: 0,
    testTimeout: 250_000,
    reporters: ['vitest-evals/reporter', 'json'],
    outputFile: {
      json: path.join(
        process.env.AGENT_CLI_EVAL_ARTIFACTS ?? path.join(root, '.artifacts'),
        'results.json'
      ),
    },
  },
});
