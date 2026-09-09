# Agent evals

Tier 1 simulates calls from an agent: a short user prompt, a fixture project, real Ollama inference,
and the built CLI as a subprocess. The model chooses commands and sees their actual output before
its next turn. Expected results are assertions outside the agent context.

We use [vitest-evals](https://github.com/getsentry/vitest-evals)' `describeEval` and `createHarness`
directly. The local adapter owns only the Ollama loop, CLI execution, and temporary projects.
Ollama uses native function calls; CLI results return as tool messages, not new user requests.
Vitest owns test isolation and results; vitest-evals records normalized model/tool events and usage.
No model judges are required.

From this package:

```sh
bun run build
bun run test:eval-harness  # deterministic adapter tests; no model
ollama pull qwen3:4b-instruct
bun run test:evals        # real model integration tests
```

`ollama serve` must be running. The default weight digest is checked before each case. Override
`AGENT_CLI_EVAL_MODEL` and optionally `AGENT_CLI_EVAL_MODEL_DIGEST` for an explicit experiment.
The adapter records the actual digest, Ollama version, Node version, CLI version, and CI commit.
Qwen runs with thinking disabled, temperature 0, seed 42, a 512-token generation limit, and an
8192-token context. There are six turns and a three-minute deadline per case, with a one-minute
limit per CLI call. There are no automatic retries or pass@k masking.

```ts
import { expect } from 'vitest';
import { describeEval } from 'vitest-evals';
import { cliHarness } from './harness/cli';

describeEval('short CLI task', { harness: cliHarness }, (it) => {
  it('reports the project state', async ({ run }) => {
    const { output } = await run({
      id: 'project-state',
      fixture: 'e2e/fixtures/go-app',
      prompt: 'Report this project’s state as JSON without starting anything.',
    });
    expect(output.commands.some(call => call.exitCode === 0)).toBe(true);
    // Add checks for the specific JSON fields and prohibited side effects here.
  });
});
```

Use `expect(value, 'named outcome').…` for each independent assertion. Prefer structured command
results and actual file contents over prose matching. New fixtures must not pass their outcome
checks untouched: `AGENT_CLI_EVAL_DRY=1 bun run test:evals` intentionally fails those checks.
Preservation-only assertions may pass in a dry run.

Every run writes `evals/.artifacts/results.json` (Vitest JSON, including vitest-evals metadata).
Each case also has its own directory with the full trace, CLI events, versions, completion/error
status, and before/after file hashes. `completed` means the agent ended its loop, not that the
assertions passed; the Vitest result is the test verdict. Infrastructure failures, no-op agents,
command timeouts, and exhausted turn budgets throw instead of scoring an untouched workspace.
Set `AGENT_CLI_EVAL_KEEP=1` to retain temporary projects locally. Failed traces survive cleanup.

The JSON scenarios and `run.mjs` still serve Tier 0 and the previous Tier 1/2 entrypoints during
the migration. Model evals are explicitly invoked; ordinary unit/e2e commands do not run models.
