import { describeEval } from 'vitest-evals';
import { cliHarness } from '../harness/cli';
import { developerCases } from '../harness/developer-cases';
import { checkDeveloperTask } from '../harness/developer-checks';

describeEval('app developer requests', { harness: cliHarness }, (it) => {
  for (const { task, input } of developerCases) {
    it(input.id, async ({ run }) => {
      const { output } = await run(input);
      checkDeveloperTask(task, output);
    });
  }
});
