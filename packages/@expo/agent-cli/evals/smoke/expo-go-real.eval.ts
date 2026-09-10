import { expect } from 'vitest';
import { describeEval } from 'vitest-evals';
import { cliHarness } from '../harness/cli';
import { snapshot } from '../harness/workspace';

describeEval('real Expo project', { harness: cliHarness }, (it) => {
  it('reports Expo Go compatibility without starting or changing the app', async ({ run }) => {
    const { output } = await run({
      id: 'expo-go-real',
      fixture: 'evals/fixtures/real-app',
      linkDependencies: true,
      prompt:
        'Check whether this app can run in Expo Go. Get a JSON report without starting or modifying the app.',
    });
    const reports = output.commands
      .filter((call) => call.exitCode === 0)
      .flatMap((call) => {
        try {
          return [JSON.parse(call.stdout)];
        } catch {
          return [];
        }
      });
    expect(reports, 'agent obtained a real project report').toContainEqual(
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
    const projectFiles = (files: Record<string, string>) =>
      Object.fromEntries(Object.entries(files).filter(([name]) => !name.startsWith('.expo/')));
    expect(
      projectFiles(snapshot(output.root)),
      'project sources and configuration were preserved'
    ).toEqual(projectFiles(output.before));
  });
});
