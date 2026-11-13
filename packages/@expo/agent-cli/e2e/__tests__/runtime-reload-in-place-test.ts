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
    // A target that cannot take Page.reload can still reload itself.
    {
      pageReload: 'replaces-context' as const,
      nativePageReloads: false,
      attempts: [
        ['page-reload', false],
        ['runtime', true],
      ],
      method: 'runtime',
    },
    // Right after `dev`, the session app may not be listed yet: the run reads the list again.
    {
      pageReload: 'replaces-context' as const,
      listedFromRead: 3,
      attempts: [['page-reload', true]],
      method: 'dev-server',
    },
  ])(
    'reloads in place and never broadcasts or relaunches ($pageReload, $nativePageReloads, $listedFromRead)',
    async ({ pageReload, attempts, method, nativePageReloads = true, listedFromRead = 0 }) => {
      const { root, target } = await onIosSessionAsync();
      const own = {
        ...target,
        reactNative: { ...target.reactNative, capabilities: { nativePageReloads } },
      };
      let reads = 0;
      const server = await startStubDevServerAsync({
        projectRoot: root,
        targets: () => (++reads >= listedFromRead ? [own] : []),
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
        expect(report.attempts[0].reason).toContain('iOS Expo simulator session');
        expect(report.attempts[0].reason).not.toContain('skippedApps');
        expect(server.broadcasts()).toBe(0);
        expect(stubEasArgs(root).filter((argv) => argv[0] === 'simulator:exec')).toEqual([]);
      } finally {
        await server.close();
      }
    }
  );
});

// Rung 2 is the iOS EAS session's alone, where it is measured live: a local build that ignores the
// broadcast is relaunched, as before, and never asked to reload itself (llp/0005 §How it reloads).
describe('runtime:reload after a broadcast that proved nothing', () => {
  it.each(['dev.example.app', 'host.exp.Exponent'])(
    'relaunches %s on a local simulator and never asks it to reload itself',
    async (appId) => {
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
        ).toEqual(['dev-server', 'device']);
        expect(reloadCalls(evaluated)).toBe(0);
        expect(calls().some((argv) => argv.join(' ').includes(`terminate ${SIMULATOR_UDID}`))).toBe(
          true
        );
      } finally {
        await server.close();
      }
    }
  );
});

// The two in-place rules that are not "reload in place": a pinned method does what it names, and
// an app that took the call and never answered is left to reload, not relaunched under it.
describe('runtime:reload on an iOS EAS session, beside the in-place rungs', () => {
  it('broadcasts under a pinned --method dev-server', async () => {
    const { root, target } = await onIosSessionAsync();
    const server = await startStubDevServerAsync({ projectRoot: root, targets: [target] });
    try {
      const result = await executeAgentCliAsync(
        root,
        [
          'runtime:reload',
          '--ios',
          '--eas',
          '--method',
          'dev-server',
          '--dev-server-url',
          server.url,
          ...FLAGS,
        ],
        { reject: false }
      );
      const report = JSON.parse(result.stdout);
      expect(
        report.attempts.map((each: Attempt) => each.method),
        result.all
      ).toEqual(['dev-server']);
      expect(server.broadcasts()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('waits on a lost expo.reloadAppAsync answer and never relaunches under it', async () => {
    const { root, target } = await onIosSessionAsync();
    const server = await startStubDevServerAsync({
      projectRoot: root,
      targets: [target],
      messageSocket: 'no-churn',
      pageReload: 'keeps-context',
      reloadAppAsyncAnswer: 'lost',
    });
    try {
      const result = await executeAgentCliAsync(
        root,
        ['runtime:reload', '--ios', '--eas', '--dev-server-url', server.url, ...FLAGS],
        { reject: false }
      );
      expect(result.exitCode, result.all).toBe(22);
      const report = JSON.parse(result.stdout);
      expect(report.method).toBe('runtime');
      expect(report.attempts.map((each: Attempt) => each.method)).toEqual([
        'page-reload',
        'runtime',
      ]);
      expect(stubEasArgs(root).filter((argv) => argv[0] === 'simulator:exec')).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('names --eas in the relaunch advice on a session run without it, and only what it sent', async () => {
    const { root, target } = await onIosSessionAsync();
    const server = await startStubDevServerAsync({
      projectRoot: root,
      // No Page.reload: the target cannot take it. No expo.reloadAppAsync: the app has no `expo`.
      targets: [{ ...target, reactNative: { ...target.reactNative, capabilities: {} } }],
      messageSocket: 'no-churn',
      inspectorEvaluate: (expression) =>
        /reloadAppAsync\(/.test(expression) ? 'no-expo-global' : undefined,
    });
    try {
      const result = await executeAgentCliAsync(
        root,
        [
          'runtime:reload',
          '--ios',
          '--dev-server-url',
          server.url,
          '--timeout',
          '6s',
          '--no-followups',
        ],
        { reject: false }
      );
      expect(result.exitCode, result.all).toBe(20);
      expect(result.all).toContain('runtime:reload --eas --method device');
      expect(result.all).not.toMatch(/runtime:reload --method device/);
      expect(result.all).toContain('a runtime expo.reloadAppAsync could not reach');
    } finally {
      await server.close();
    }
  });
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
