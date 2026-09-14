import { expect } from 'vitest';

import { agentEval, setupProject } from '../harness/cli';
import { jsonReports, projectFiles } from '../harness/results';
import { snapshot } from '../harness/workspace';

agentEval(
  import.meta.url,
  {
    prompt:
      'Check whether this app can run in Expo Go. Get a JSON report without starting or modifying the app.',
    projectSetup: setupProject({ fixture: 'evals/fixtures/real-app', linkDependencies: true }),
  },
  (check) => {
    check('completes the requested CLI task', (_workspace, { fixture }) => {
      const output = fixture.output();
      expect(jsonReports(output), 'agent obtained a real project report').toContainEqual(
        expect.objectContaining({
          project: expect.objectContaining({
            isExpoApp: true,
            sdkVersion: '57.0.19',
            usesDevClient: false,
          }),
          expoGo: { compatible: true, reasonCount: 0 },
          devServer: expect.objectContaining({ running: false }),
        })
      );
      expect(
        output.commands.every((call) => ['status', '--help', 'help'].includes(call.argv[0]!)),
        'only read-only calls were made'
      ).toBe(true);
      expect(
        projectFiles(snapshot(output.root)),
        'project sources and configuration were preserved'
      ).toEqual(projectFiles(output.before));
    });
  }
);
