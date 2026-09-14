import { expect } from '@expo/agent-eval-vitest';
import { agentEval, setupProject } from '../harness/cli';
import { projectFiles } from '../harness/results';
import { snapshot } from '../harness/workspace';
import { startRuntimeFixture } from '../harness/runtime-fixture';

agentEval(
  import.meta.url,
  {
    prompt: 'After my last edit, the app shows a red error screen. Find out what went wrong.',
    projectSetup: setupProject({
      fixture: 'e2e/fixtures/go-app',
      setupProject: ({ root }) => startRuntimeFixture(root, 'bundler-error'),
    }),
  },
  (check) => {
    check('retrieves the bundling error and its source location', (_workspace, { fixture }) => {
      expect(
        fixture
          .output()
          .commands.some((call) =>
            (call.argv[0] === 'dev:logs' && call.exitCode === 0) ||
            (['runtime:reload', 'smoke'].includes(call.argv[0]!) && call.exitCode === 20)
              ? /src\/app\/index\.tsx/.test(call.stdout) &&
                /Unexpected keyword/.test(call.stdout) &&
                /101/.test(call.stdout)
              : false
          )
      ).toBe(true);
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
                'typecheck',
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
