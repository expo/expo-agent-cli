import { expect } from 'vitest';

import { agentEval, setupProject } from '../harness/cli';
import { jsonReports, projectFiles } from '../harness/results';
import { snapshot } from '../harness/workspace';

agentEval(
  import.meta.url,
  {
    prompt:
      'Get a JSON plan for running this app on iOS. Do not execute the plan, start a server, or build anything.',
    projectSetup: setupProject({ fixture: 'e2e/fixtures/dev-client-app' }),
  },
  (check) => {
    check('completes the requested CLI task', (_workspace, { fixture }) => {
      const output = fixture.output();
      // status --json also returns the same executable plan under next.
      expect(
        jsonReports(output).flatMap((report) => [report, report.next]),
        'plan targets a development client and iOS'
      ).toContainEqual(
        expect.objectContaining({
          target: 'dev-client',
          buildLocation: expect.objectContaining({ platform: 'ios' }),
          steps: expect.arrayContaining([
            expect.objectContaining({ argv: expect.arrayContaining(['--platform', 'ios']) }),
          ]),
        })
      );
      expect(
        output.commands.every(
          (call) =>
            call.argv.includes('--help') ||
            ['status', '--help', 'help'].includes(call.argv[0]!) ||
            (['dev', 'dev:run'].includes(call.argv[0]!) && call.argv.includes('--plan'))
        ),
        'all development calls remain plan-only'
      ).toBe(true);
      expect(
        projectFiles(snapshot(output.root)),
        'source and native directories are unchanged'
      ).toEqual(projectFiles(output.before));
    });
  }
);
