import fs from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { describeEval } from 'vitest-evals';
import { cliHarness } from '../harness/cli';

describeEval('agent skills integration', { harness: cliHarness }, (it) => {
  it('links installed package skills for Claude Code', async ({ run }) => {
    const { output } = await run({
      id: 'skills-sync',
      prompt: 'Sync this project’s installed package skills for Claude Code.',
      fixture: 'e2e/fixtures/skills-app',
    });
    const link = path.join(output.root, '.claude/skills/usage');
    expect(fs.realpathSync(link), 'link resolves to the installed package skill').toBe(
      fs.realpathSync(path.join(output.root, 'node_modules/fake-module-with-skills/skills/usage'))
    );
    expect(
      fs.readFileSync(path.join(link, 'SKILL.md'), 'utf8'),
      'skill content is available to the agent'
    ).toContain('Body of usage skill.');
    expect(
      output.commands.some((command) => command.exitCode === 0 && !command.argv.includes('--help')),
      'agent completed a real CLI call'
    ).toBe(true);
  });
});
