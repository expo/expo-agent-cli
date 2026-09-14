import { expect } from '@expo/agent-eval-vitest';

import { agentEval, setupProject } from '../harness/cli';
import { projectFiles } from '../harness/results';
import { startRuntimeFixture } from '../harness/runtime-fixture';
import { snapshot } from '../harness/workspace';

agentEval(
  import.meta.url,
  {
    prompt: 'The app still shows the old screen after my edit. Refresh it.',
    projectSetup: setupProject({
      fixture: 'e2e/fixtures/go-app',
      setupProject: ({ root }) => startRuntimeFixture(root, 'reload'),
    }),
  },
  (check) => {
    check('dev server receives a reload caused by the agent', (_workspace, { fixture }) => {
      expect(fixture.output().fixtureEvidence).toMatchObject({ reloaded: true });
    });

    check('avoids unrelated setup, builds, or server starts', (_workspace, { fixture }) => {
      expect(
        fixture
          .output()
          .commands.every(
            (call) =>
              [
                '--help',
                'help',
                'status',
                'dev:logs',
                'runtime:errors',
                'runtime:reload',
                'smoke',
              ].includes(call.argv[0]!) ||
              call.argv.includes('--help') ||
              call.argv.includes('-h')
          )
      ).toBe(true);
    });

    check('preserves project sources and configuration', (workspace, { fixture }) => {
      expect(projectFiles(snapshot(workspace.root))).toEqual(projectFiles(fixture.output().before));
    });
  }
);
