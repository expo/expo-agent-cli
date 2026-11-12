// @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads — in place.
// Real CLI, bindings and HTTP. The inspector, `eas` and `xcrun` are protocol doubles: the stub app
// ignores the broadcast (`no-churn`), as the SDK 58 iOS development build does, and reloads on
// `expo.reloadAppAsync` only when the call carries a reason, as SDK 58 requires.
import fs from 'node:fs';

import { runtimeTarget } from '../runtimeTargetFixtures';
import {
  installStubEasAsync,
  stubEasArgs,
  writeCloudBindingAsync,
  writeCloudSessionFileAsync,
} from '../stubEas';
import {
  executeAgentCliAsync,
  expoHomeOf,
  setupFixtureAsync,
  startStubDevServerAsync,
} from '../utils';
import { BOOTED_SIMULATOR, installStubXcrunAsync, SIMULATOR_UDID } from './installedAppStubs';

const FLAGS = ['--timeout', '12s', '--json', '--no-followups'];

interface Attempt {
  method: string;
  ok: boolean;
  reason: string;
}

async function onIosSessionAsync(appId = 'dev.example.app') {
  const root = await fs.promises.realpath(await setupFixtureAsync('go-app'));
  await installStubXcrunAsync(root, { simulators: [] });
  await installStubEasAsync(root);
  await writeCloudBindingAsync(expoHomeOf(root), root, { id: 'sess-e2e' });
  await writeCloudSessionFileAsync(root, 'sess-e2e');
  return { root, target: runtimeTarget('session', { deviceName: 'iPhone 17 Pro', appId }) };
}

function reloadCalls(evaluated: string[]): number {
  return evaluated.filter((expression) => /reloadAppAsync\(/.test(expression)).length;
}

describe('runtime:reload on an iOS EAS session', () => {
  it.each([
    {
      pageReload: 'replaces-context' as const,
      attempts: [['page-reload', true]],
      method: 'dev-server',
    },
    {
      pageReload: 'keeps-context' as const,
      attempts: [
        ['page-reload', false],
        ['runtime', true],
      ],
      method: 'runtime',
    },
  ])(
    'reloads in place and never broadcasts or relaunches ($pageReload)',
    async ({ pageReload, attempts, method }) => {
      const { root, target } = await onIosSessionAsync();
      const server = await startStubDevServerAsync({
        projectRoot: root,
        targets: [target],
        messageSocket: 'no-churn',
        pageReload,
      });
      try {
        const result = await executeAgentCliAsync(
          root,
          ['runtime:reload', '--ios', '--eas', '--dev-server-url', server.url, ...FLAGS],
          { reject: false }
        );
        expect(result.exitCode, result.all).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report).toMatchObject({
          reloaded: true,
          method,
          verifiedBy: 'debugger-context-replaced',
        });
        expect(report.attempts.map((each: Attempt) => [each.method, each.ok])).toEqual(attempts);
        expect(report.attempts[0].reason).toContain('iOS EAS Simulator session');
        expect(report.attempts[0].reason).not.toContain('skippedApps');
        expect(server.broadcasts()).toBe(0);
        expect(stubEasArgs(root).filter((argv) => argv[0] === 'simulator:exec')).toEqual([]);
      } finally {
        await server.close();
      }
    }
  );
});

// A local development build that ignores the broadcast: the reload stays in place, and the
// relaunch is left for an app this run cannot ask. Expo Go is not asked: on Expo Go the call can
// close the app (llp/0005 §How it reloads).
describe('runtime:reload after a broadcast that proved nothing', () => {
  it.each([
    { appId: 'dev.example.app', attempts: ['dev-server', 'runtime'], relaunched: false },
    { appId: 'host.exp.Exponent', attempts: ['dev-server', 'device'], relaunched: true },
  ])(
    'asks $appId to reload itself only when it is not Expo Go',
    async ({ appId, attempts, relaunched }) => {
      const root = await fs.promises.realpath(await setupFixtureAsync('dev-client-app'));
      const { calls } = await installStubXcrunAsync(root, { simulators: [BOOTED_SIMULATOR] });
      const evaluated: string[] = [];
      const server = await startStubDevServerAsync({
        projectRoot: root,
        targets: [runtimeTarget('local', { deviceName: BOOTED_SIMULATOR.name, appId })],
        messageSocket: 'no-churn',
        inspectorEvaluate: (expression) => {
          evaluated.push(expression);
          return /reloadAppAsync\(/.test(expression) ? 'sent' : undefined;
        },
      });
      try {
        const result = await executeAgentCliAsync(
          root,
          ['runtime:reload', '--ios', '--dev-server-url', server.url, ...FLAGS],
          { reject: false }
        );
        const report = JSON.parse(result.stdout);
        expect(
          report.attempts.map((each: Attempt) => each.method),
          result.all
        ).toEqual(attempts);
        expect(reloadCalls(evaluated)).toBe(relaunched ? 0 : 1);
        expect(calls().some((argv) => argv.join(' ').includes(`terminate ${SIMULATOR_UDID}`))).toBe(
          relaunched
        );
        if (!relaunched) {
          expect(result.exitCode).toBe(0);
          expect(report).toMatchObject({
            method: 'runtime',
            verifiedBy: 'debugger-context-replaced',
          });
        }
      } finally {
        await server.close();
      }
    }
  );
});

describe('runtime:reload --method runtime', () => {
  it.each([
    { answer: 'sent', exitCode: 0, reason: 'answered from a new JavaScript context' },
    { answer: 'no-expo-global', exitCode: 20, reason: 'no "expo" global' },
  ])(
    'passes the reason SDK 58 requires, and an app that cannot reload says so at once ($answer)',
    async ({ answer, exitCode, reason }) => {
      const { root, target } = await onIosSessionAsync();
      const evaluated: string[] = [];
      const server = await startStubDevServerAsync({
        projectRoot: root,
        targets: [target],
        inspectorEvaluate: (expression) => {
          evaluated.push(expression);
          return /reloadAppAsync\(/.test(expression) ? answer : undefined;
        },
      });
      try {
        const started = Date.now();
        const result = await executeAgentCliAsync(
          root,
          [
            'runtime:reload',
            '--ios',
            '--eas',
            '--method',
            'runtime',
            '--dev-server-url',
            server.url,
            ...FLAGS,
          ],
          { reject: false }
        );
        expect(result.exitCode, result.all).toBe(exitCode);
        const report = JSON.parse(result.stdout);
        expect(report).toMatchObject({ method: exitCode === 0 ? 'runtime' : null });
        expect(report.attempts).toEqual([
          expect.objectContaining({ method: 'runtime', reason: expect.stringContaining(reason) }),
        ]);
        expect(evaluated.find((expression) => /reloadAppAsync\(/.test(expression))).toMatch(
          /reloadAppAsync\((['"])@expo\/agent-cli/
        );
        // Not the 8 s proof window: an app with nothing to call is known after one answer.
        expect(Date.now() - started).toBeLessThan(8000);
      } finally {
        await server.close();
      }
    }
  );
});

describe('smoke on an iOS EAS session', () => {
  it.each([
    { appId: 'dev.example.app', pageReload: 'replaces-context' as const, reload: 'ok', calls: 0 },
    { appId: 'dev.example.app', pageReload: 'keeps-context' as const, reload: 'ok', calls: 1 },
    {
      appId: 'host.exp.Exponent',
      pageReload: 'keeps-context' as const,
      reload: 'inconclusive',
      calls: 0,
    },
  ])(
    'reloads $appId in place, and never asks Expo Go ($pageReload)',
    async ({ appId, pageReload, reload, calls }) => {
      const { root, target } = await onIosSessionAsync(appId);
      const evaluated: string[] = [];
      const server = await startStubDevServerAsync({
        projectRoot: root,
        targets: [target],
        messageSocket: 'no-churn',
        pageReload,
        inspectorEvaluate: (expression) => {
          evaluated.push(expression);
          return /reloadAppAsync\(/.test(expression) ? 'sent' : 1;
        },
      });
      try {
        const result = await executeAgentCliAsync(
          root,
          [
            'smoke',
            '--ios',
            '--eas',
            '--dev-server-url',
            server.url,
            '--no-screenshot',
            '--window',
            '100ms',
            ...FLAGS,
          ],
          { reject: false }
        );
        const report = JSON.parse(result.stdout);
        const phase = report.phases.find((each: { id: string }) => each.id === 'reload');
        expect(phase.status, result.all).toBe(reload);
        expect(reloadCalls(evaluated)).toBe(calls);
        expect(server.broadcasts()).toBe(0);
        if (reload === 'ok') {
          expect(report.reload).toMatchObject({ verifiedBy: 'debugger-context-replaced' });
        }
      } finally {
        await server.close();
      }
    }
  );
});
