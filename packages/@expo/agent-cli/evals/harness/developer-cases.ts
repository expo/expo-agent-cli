import type { EvalInput } from './cli';
import type { DeveloperTask } from './developer-checks';
import { startRuntimeFixture } from './runtime-fixture';
import { setupImpactFixture } from './impact-fixture';

export const developerCases: { task: DeveloperTask; input: EvalInput; baseline: string[][] }[] = [
  {
    task: 'expo-go',
    input: {
      id: 'developer-expo-go',
      prompt: 'Can I use Expo Go for this project?',
      fixture: 'evals/fixtures/real-app',
      linkDependencies: true,
    },
    baseline: [['status']],
  },
  ...(['native', 'js'] as const).map((task) => ({
    task,
    input: {
      id: `developer-impact-${task}`,
      prompt:
        'I made some changes to this app. Is reloading enough, or do I need a new development build?',
      fixture: 'e2e/fixtures/dev-client-fresh-app',
      setupProject: (context: Parameters<typeof setupImpactFixture>[0]) =>
        setupImpactFixture(context, task),
    },
    baseline: [['status']],
  })),
  {
    task: 'reload',
    input: {
      id: 'developer-refresh-screen',
      prompt: 'The app still shows the old screen after my edit. Refresh it.',
      fixture: 'e2e/fixtures/go-app',
      setupProject: ({ root }) => startRuntimeFixture(root, 'reload'),
    },
    baseline: [['runtime:reload']],
  },
  {
    task: 'bundler-error',
    input: {
      id: 'developer-red-screen',
      prompt: 'After my last edit, the app shows a red error screen. Find out what went wrong.',
      fixture: 'e2e/fixtures/go-app',
      setupProject: ({ root }) => startRuntimeFixture(root, 'bundler-error'),
    },
    baseline: [['dev:logs']],
  },
];
