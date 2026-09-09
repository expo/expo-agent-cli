import fs from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { describeEval } from 'vitest-evals';
import { cliHarness } from '../harness/cli';
import { jsonReports } from '../harness/results';
import { snapshot } from '../harness/workspace';

describeEval('agent project setup', { harness: cliHarness }, (it) => {
  it('writes usable guidance and links package skills without external plugins', async ({
    run,
  }) => {
    const { output } = await run({
      id: 'agents-setup',
      fixture: 'evals/fixtures/claude-skills-app',
      prompt:
        'Set this project up for Claude Code: create its agent guide and link installed package skills. You may confirm the setup, but do not install external plugins. Report the result as JSON.',
    });
    expect(
      jsonReports(output),
      'setup completed with skills and no plugin installation'
    ).toContainEqual(
      expect.objectContaining({
        cancelled: false,
        errors: [],
        plugins: [],
        skills: expect.objectContaining({ synced: true, discovered: 1, agents: ['claude-code'] }),
      })
    );
    const guide = fs.readFileSync(path.join(output.root, 'AGENTS.md'), 'utf8');
    expect(guide, 'managed Expo instructions exist').toContain(
      '<!-- BEGIN EXPO AGENT CLI MANAGED BLOCK -->'
    );
    expect(guide, 'guide includes the installed package skill').toContain(
      'fake-module-with-skills'
    );
    expect(
      fs.readFileSync(path.join(output.root, 'CLAUDE.md'), 'utf8'),
      'Claude loads the guide'
    ).toContain('@AGENTS.md');
    expect(
      fs.realpathSync(path.join(output.root, '.claude/skills/usage')),
      'skill link resolves to package content'
    ).toBe(
      fs.realpathSync(path.join(output.root, 'node_modules/fake-module-with-skills/skills/usage'))
    );
    const after = snapshot(output.root);
    for (const [file, hash] of Object.entries(output.before))
      expect(after[file], `preserves ${file}`).toBe(hash);
    expect(
      output.commands
        .filter(
          (call) =>
            ['agents:setup', 'agents'].includes(call.argv[0]!) && !call.argv.includes('--help')
        )
        .every((call) => call.argv.includes('--no-plugins')),
      'external plugin installation was disabled'
    ).toBe(true);
  });
});
