import { expect } from '@expo/agent-eval-vitest';
import { agentEval, setupProject } from '../harness/cli';
import { projectFiles } from '../harness/results';
import { snapshot } from '../harness/workspace';
import { setupImpactFixture } from '../harness/impact-fixture';

agentEval(
  import.meta.url,
  {
    prompt:
      'I made some changes to this app. Is reloading enough, or do I need a new development build?',
    projectSetup: setupProject({
      fixture: 'e2e/fixtures/dev-client-fresh-app',
      setupProject: (context) => setupImpactFixture(context, 'native'),
    }),
  },
  (check) => {
    check('inspects the changes against the previous native build', (_workspace, { fixture }) => {
      expect(
        fixture.output().cliEvents.filter((event) => event._e === 'cli:status')
      ).toContainEqual(
        expect.objectContaining({
          impact: { ios: 'needs-native-build', android: 'needs-native-build' },
        })
      );
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
