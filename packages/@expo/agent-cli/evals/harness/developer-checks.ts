import { expect } from 'vitest';
import type { EvalOutput } from './cli';
import { snapshot } from './workspace';

export type DeveloperTask = 'expo-go' | 'native' | 'js' | 'reload' | 'bundler-error';

/** Outcome checks are never included in the model's context. */
export function checkDeveloperTask(task: DeveloperTask, output: EvalOutput) {
  const reports = output.cliEvents.filter((event) => event._e === 'cli:status');
  if (task === 'expo-go') {
    expect(reports, 'inspected this project’s Expo Go compatibility').toContainEqual(
      expect.objectContaining({ expoGoCompatible: true, sdkVersion: '57.0.19' })
    );
  } else if (task === 'native' || task === 'js') {
    const impact = task === 'native' ? 'needs-native-build' : 'js-only';
    expect(reports, 'checked the changes against the previous native build').toContainEqual(
      expect.objectContaining({ impact: { ios: impact, android: impact } })
    );
  } else if (task === 'reload') {
    expect(
      output.fixtureEvidence,
      'dev server observed a reload caused by the agent'
    ).toMatchObject({
      reloaded: true,
    });
  } else {
    expect(
      output.commands.some((call) =>
        (call.argv[0] === 'dev:logs' && call.exitCode === 0) ||
        (['runtime:reload', 'smoke'].includes(call.argv[0]!) && call.exitCode === 20)
          ? /src\/app\/index\.tsx/.test(call.stdout) &&
            /Unexpected keyword/.test(call.stdout) &&
            /101/.test(call.stdout)
          : false
      ),
      'retrieved the actual bundling error and its source location'
    ).toBe(true);
  }
  // Reading a report must not turn into a build or a server restart. Reload is the only
  // requested mutation, and runtime:errors may legitimately precede bundler log inspection.
  const allowed = ['--help', 'help', 'status'];
  if (task === 'reload' || task === 'bundler-error') {
    allowed.push('dev:logs', 'runtime:errors', 'runtime:reload', 'smoke');
    if (task === 'bundler-error') allowed.push('typecheck');
  }
  expect(
    output.commands.every(
      (call) =>
        allowed.includes(call.argv[0]!) || call.argv.includes('--help') || call.argv.includes('-h')
    ),
    'no unrelated setup, build, or server start'
  ).toBe(true);
  const sources = (files: Record<string, string>) =>
    Object.fromEntries(Object.entries(files).filter(([name]) => !name.startsWith('.expo/')));
  expect(sources(snapshot(output.root)), 'preserved project sources and configuration').toEqual(
    sources(output.before)
  );
}
