// @ref llp/0002-testing-and-evals.plan.md §Tier 0 doubles the dev server, not the app
// @ref llp/0005-runtime-loop-tools.rfc.md §Reloading the app
import fs from 'node:fs';
import path from 'node:path';
import { holdDevLockAsync, startStubDevServerAsync, STUB_TRANSFORM_ERROR } from '../../e2e/utils';
import { detachedLogPath } from '../../src/dev/logFile';
import { readDevServerLockAsync } from '../../src/devLock';

/**
 * A disposable dev-server protocol fixture for a fresh eval workspace. No Metro, simulator,
 * Hermes, or CDP evaluation: reload is a /message broadcast and observable server-side churn.
 * The caller owns the workspace and must await close() in finally before removing it.
 */
export async function startRuntimeFixture(root: string, mode: 'reload' | 'bundler-error') {
  if (mode !== 'reload' && mode !== 'bundler-error')
    throw new Error('Unknown runtime fixture mode');
  root = fs.realpathSync(root);
  if (await readDevServerLockAsync(root))
    throw new Error('Runtime fixture requires an unlocked project');
  const startedAt = new Date().toISOString();
  const logFile = detachedLogPath(root);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  // stdout/stderr text, just as detachAsync captures it; not JSONL. The error body was captured
  // from SDK 57 Metro by the e2e stub. A historical Bundled line must not count as a new reload.
  const initialLog = [
    `Starting project at ${root}`,
    'Starting Metro Bundler',
    'Logs for your project will appear below.',
    mode === 'reload'
      ? 'iOS Bundled 1200ms node_modules/expo-router/entry.js (1 module)'
      : `iOS Bundling failed 25ms node_modules/expo-router/entry.js (1 module)\n ERROR  ${STUB_TRANSFORM_ERROR.message}`,
    '',
  ].join('\n');
  fs.writeFileSync(logFile, initialLog);
  const server = await startStubDevServerAsync({
    projectRoot: root,
    bundle: mode === 'reload' ? 'compiles' : 'broken',
    bundleLogPath: mode === 'reload' ? logFile : null,
    messageSocket: 'v2',
    messagePeers: { 'socket#1': 'role=ios' },
    reloadTargets: 'reconnect',
    // The inspector accepts liveness handshakes but never answers a JavaScript request.
    inspectorSocket: 'live',
    targets: [
      {
        id: 'fixture-app-1',
        appId: 'host.exp.Exponent',
        webSocketDebuggerUrl: 'ws://127.0.0.1/inspector/debug?device=1&page=1',
      },
    ],
  });
  let releaseLock: () => void;
  try {
    releaseLock = await holdDevLockAsync(root, {
      url: server.url,
      port: server.port,
      pid: process.pid,
      startedAt,
      projectRoot: root,
    });
  } catch (error) {
    await server.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    close(): Promise<void> {
      return (closing ??= (async () => {
        try {
          releaseLock();
        } finally {
          await server.close();
        }
      })());
    },
    /** Independent of CLI output/agent claims. Read before deleting the workspace. */
    evidence() {
      const log = fs.readFileSync(logFile, 'utf8');
      const appended = log.startsWith(initialLog) ? log.slice(initialLog.length) : '';
      const reloadCount = appended
        .split('\n')
        .filter((line) => /^iOS Bundled \d+ms /.test(line)).length;
      return {
        mode,
        logFile,
        devServerUrl: server.url,
        reloaded: mode === 'reload' && reloadCount > 0,
        reloadCount,
        source: 'dev-server-bundle-log' as const,
      };
    },
  };
}
