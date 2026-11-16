// @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads — in place.
// Real CLI, bindings and HTTP. The inspector, `eas` and `xcrun` are protocol doubles: no broadcast
// reloads the stub app (`no-churn`), as none reaches the SDK 58 iOS app through a tunnel, and it reloads on
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
import { installStubAdbAsync, installStubXcrunAsync } from './installedAppStubs';

const FLAGS = ['--timeout', '12s', '--json', '--no-followups'];

interface Attempt {
  method: string;
  ok: boolean;
  reason: string;
}

async function onIosSessionAsync() {
  const root = await fs.promises.realpath(await setupFixtureAsync('go-app'));
  await installStubXcrunAsync(root, { simulators: [] });
  await installStubEasAsync(root);
  await writeCloudBindingAsync(expoHomeOf(root), root, { id: 'sess-e2e' });
  await writeCloudSessionFileAsync(root, 'sess-e2e');
  return {
    root,
    target: runtimeTarget('session', { deviceName: 'iPhone 17 Pro', appId: 'dev.example.app' }),
  };
}

describe('runtime:reload on an iOS EAS session', () => {
  // Right after `dev`, the session app may not be listed yet: the run reads the list again.
  it.each([0, 3])(
    'reloads in place and never broadcasts or relaunches (listed from read %i)',
    async (listedFromRead) => {
      const { root, target } = await onIosSessionAsync();
      let reads = 0;
      const server = await startStubDevServerAsync({
        projectRoot: root,
        targets: () => (++reads >= listedFromRead ? [target] : []),
        messageSocket: 'no-churn',
        pageReload: 'replaces-context',
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
          method: 'dev-server',
          verifiedBy: 'debugger-context-replaced',
        });
        expect(report.attempts.map((each: Attempt) => [each.method, each.ok])).toEqual([
          ['page-reload', true],
        ]);
        expect(report.attempts[0].reason).toContain(
          'cannot reach the dev server through the tunnel'
        );
        expect(report.attempts[0].reason).not.toContain('skippedApps');
        expect(server.broadcasts()).toBe(0);
        expect(stubEasArgs(root).filter((argv) => argv[0] === 'simulator:exec')).toEqual([]);
      } finally {
        await server.close();
      }
    }
  );
});

describe('runtime:reload on an iOS EAS session, after a Page.reload that proved nothing', () => {
  it.each([
    { pageReload: 'keeps-context' as const, nativePageReloads: true },
    { pageReload: 'replaces-context' as const, nativePageReloads: false },
  ])(
    'relaunches the session app after a Page.reload that proved nothing ($pageReload, $nativePageReloads)',
    async ({ pageReload, nativePageReloads }) => {
      const { root, target } = await onIosSessionAsync();
      const server = await startStubDevServerAsync({
        projectRoot: root,
        targets: [
          {
            ...target,
            reactNative: { ...target.reactNative, capabilities: { nativePageReloads } },
          },
        ],
        messageSocket: 'no-churn',
        pageReload,
      });
      try {
        const result = await executeAgentCliAsync(
          root,
          ['runtime:reload', '--ios', '--eas', '--dev-server-url', server.url, ...FLAGS],
          { reject: false }
        );
        const report = JSON.parse(result.stdout);
        expect(
          report.attempts.map((each: Attempt) => each.method),
          result.all
        ).toEqual(['page-reload', 'device']);
        expect(server.broadcasts()).toBe(0);
        expect(stubEasArgs(root).some((argv) => argv[0] === 'simulator:exec')).toBe(true);
      } finally {
        await server.close();
      }
    }
  );
});

// A pinned method does what it names, and an app that took the call and never answered is left to
// reload, not relaunched under it.
describe('runtime:reload on an iOS EAS session under a pinned method', () => {
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

  it('waits on a lost --method runtime answer and never relaunches', async () => {
    const { root, target } = await onIosSessionAsync();
    const server = await startStubDevServerAsync({
      projectRoot: root,
      targets: [target],
      messageSocket: 'no-churn',
      reloadAppAsyncAnswer: 'lost',
    });
    try {
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
      expect(result.exitCode, result.all).toBe(22);
      const report = JSON.parse(result.stdout);
      expect(report.method).toBe('runtime');
      expect(report.attempts).toEqual([
        expect.objectContaining({ method: 'runtime', ok: false, delivered: true }),
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
      // No Page.reload: the target cannot take it, so this run sent nothing.
      targets: [{ ...target, reactNative: { ...target.reactNative, capabilities: {} } }],
      messageSocket: 'no-churn',
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
      expect(result.all).toContain('a runtime this run could not reach');
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

  it('sends no expo.reloadAppAsync when its own app cannot keep the marker, and names --method device', async () => {
    const { root, target } = await onIosSessionAsync();
    const server = await startStubDevServerAsync({
      projectRoot: root,
      targets: [target],
      inspectorSocket: 'no-debugger',
    });
    try {
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
      expect(result.exitCode, result.all).toBe(20);
      expect(result.stderr).toContain(
        'could keep the marker that proves a reload by expo.reloadAppAsync, so none was sent'
      );
      expect(result.stderr).toContain('runtime:reload --eas --method device');
    } finally {
      await server.close();
    }
  });

  it('reloads a local Android app with the reason and proves it', async () => {
    const root = await fs.promises.realpath(await setupFixtureAsync('go-app'));
    await installStubXcrunAsync(root, { simulators: [] });
    const adb = await installStubAdbAsync(root, 'dev.example.app');
    const evaluated: string[] = [];
    const server = await startStubDevServerAsync({
      projectRoot: root,
      targets: [
        runtimeTarget('android', {
          deviceName: 'sdk_gphone64_arm64 - 15 - API 35',
          appId: 'dev.example.app',
        }),
      ],
      inspectorEvaluate: (expression) => {
        evaluated.push(expression);
        return /reloadAppAsync\(/.test(expression) ? 'sent' : undefined;
      },
    });
    try {
      const result = await executeAgentCliAsync(
        root,
        [
          'runtime:reload',
          '--android',
          '--method',
          'runtime',
          '--dev-server-url',
          server.url,
          ...FLAGS,
        ],
        { reject: false, env: { ...adb.env, AGENT_CLI_NO_DEVICE: '0' } }
      );
      expect(result.exitCode, result.all).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        method: 'runtime',
        verifiedBy: 'debugger-context-replaced',
      });
      expect(evaluated.find((expression) => /reloadAppAsync\(/.test(expression))).toMatch(
        /reloadAppAsync\((['"])@expo\/agent-cli/
      );
    } finally {
      await server.close();
    }
  });
});

describe('smoke on an iOS EAS session', () => {
  it.each([
    { pageReload: 'replaces-context' as const, reload: 'ok' },
    { pageReload: 'keeps-context' as const, reload: 'inconclusive' },
  ])(
    'smoke reloads the session app with Page.reload and never broadcasts ($pageReload)',
    async ({ pageReload, reload }) => {
      const { root, target } = await onIosSessionAsync();
      const server = await startStubDevServerAsync({
        projectRoot: root,
        targets: [target],
        messageSocket: 'no-churn',
        pageReload,
        // The liveness check evaluates `1`.
        inspectorEvaluate: () => 1,
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
