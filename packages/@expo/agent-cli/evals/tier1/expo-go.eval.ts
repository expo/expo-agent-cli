import { expect } from '@expo/agent-eval-vitest';
import { agentEval, setupProject } from '../harness/cli';
import { projectFiles } from '../harness/results';
import { snapshot } from '../harness/workspace';

agentEval(
  import.meta.url,
  {
    prompt: 'Can I use Expo Go for this project?',
    projectSetup: setupProject({ fixture: 'evals/fixtures/real-app', linkDependencies: true }),
  },
  (check) => {
    check('inspects this project’s Expo Go compatibility', (_workspace, { fixture }) => {
      expect(
        fixture.output().cliEvents.filter((event) => event._e === 'cli:status')
      ).toContainEqual(expect.objectContaining({ expoGoCompatible: true, sdkVersion: '57.0.19' }));
    });

    check('avoids unrelated setup, builds, or server starts', (_workspace, { fixture }) => {
      expect(
        fixture
          .output()
          .commands.every(
            (call) =>
              ['--help', 'help', 'status'].includes(call.argv[0]!) ||
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
