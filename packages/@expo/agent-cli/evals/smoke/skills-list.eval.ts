import fs from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { describeEval } from 'vitest-evals';
import { cliHarness } from '../harness/cli';
import { jsonReports, projectFiles } from '../harness/results';
import { snapshot } from '../harness/workspace';

describeEval('agent skill discovery', { harness: cliHarness }, (it) => {
  it('reports installed skills without linking or changing files', async ({ run }) => {
    const { output } = await run({
      id: 'skills-list',
      fixture: 'evals/fixtures/claude-skills-app',
      prompt:
        'List the skills shipped by installed packages as JSON. Do not link or change anything.',
    });
    expect(jsonReports(output), 'only the package that ships a skill is reported').toContainEqual({
      skills: [
        expect.objectContaining({
          package: 'fake-module-with-skills',
          skill: 'usage',
          name: 'Fake Module Usage',
          linkName: 'usage',
          linkedIn: [],
          path: fs.realpathSync(
            path.join(output.root, 'node_modules/fake-module-with-skills/skills/usage')
          ),
        }),
      ],
    });
    expect(projectFiles(snapshot(output.root)), 'listing preserves the project').toEqual(
      projectFiles(output.before)
    );
    expect(
      output.commands.every(
        (call) =>
          ['skills:list', 'skills:show', '--help', 'help'].includes(call.argv[0]!) ||
          call.argv.includes('--help')
      ),
      'only read-only discovery calls'
    ).toBe(true);
  });
});
