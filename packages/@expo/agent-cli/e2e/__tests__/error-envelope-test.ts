// @ref llp/0010-agent-conventions.rfc.md §The `--json` error envelope
// Failures that reach `logCmdError` by a path no other suite covers: a plain `Error`, which is a
// defect, and a device that refused the `navigate` link.
import fs from 'node:fs';
import path from 'node:path';

import {
  executeAgentCliAsync,
  readEvents,
  setupFixtureAsync,
  startStubDevServerAsync,
  stubExpoEnv,
} from '../utils';
import { BOOTED_SIMULATOR, installStubXcrunAsync } from './installedAppStubs';

const EXPO_GO_TARGET = {
  id: '1',
  appId: 'host.exp.Exponent',
  deviceName: BOOTED_SIMULATOR.name,
  webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=1&page=1',
};

/**
 * A preload that makes `process.cwd()` throw a plain `Error` inside `doctor:check`, so the defect
 * reaches `logCmdError` the way a bug in a command would. No input reaches that path on purpose.
 */
const DEFECT_PRELOAD = `
const cwd = process.cwd;
process.cwd = function () {
  if (new Error().stack.includes('agentCliDoctorCheck')) throw new Error('injected defect');
  return cwd.call(process);
};
`;

describe('the --json error envelope', () => {
  it('reports a plain Error as a crash, flushes cli:error, and exits 1', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const eventsFile = path.join(projectRoot, 'events.jsonl');
    const preload = path.join(projectRoot, 'defect-preload.js');
    await fs.promises.writeFile(preload, DEFECT_PRELOAD);

    const result = await executeAgentCliAsync(projectRoot, ['doctor:check', '--json'], {
      env: { NODE_OPTIONS: `--require ${preload}`, LOG_EVENTS: eventsFile },
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      error: {
        code: 'UNCAUGHT_EXCEPTION',
        message: expect.stringContaining('This command crashed: Error: injected defect'),
        suggestedCommand: null,
        needsHuman: null,
        data: { errorName: 'Error', errorCode: null, stack: expect.any(String) },
      },
    });
    expect(readEvents(eventsFile).find((entry) => entry._e === 'cli:error')).toMatchObject({
      code: 'UNCAUGHT_EXCEPTION',
    });
  });

  // @ref llp/0010-agent-conventions.rfc.md §Exit codes — a refused link is a tool error.
  it('prints the envelope when the device refuses the navigate link', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const eventsFile = path.join(projectRoot, 'events.jsonl');
    await installStubXcrunAsync(projectRoot, {
      simulators: [BOOTED_SIMULATOR],
      refuses: ['openurl'],
    });
    const stub = await startStubDevServerAsync({ projectRoot, targets: [EXPO_GO_TARGET] });

    try {
      const result = await executeAgentCliAsync(
        projectRoot,
        ['navigate', '/', '--ios', '--json', '--no-route-check', '--dev-server-url', stub.url],
        { env: { ...stubExpoEnv(projectRoot), LOG_EVENTS: eventsFile }, reject: false }
      );

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({
        error: {
          code: 'DEEP_LINK_REFUSED',
          message: expect.stringMatching(
            /^The device did not open the deep link[^]*\nWhy: stub xcrun: openurl refused/
          ),
          suggestedCommand: null,
          needsHuman: null,
          data: {
            url: expect.stringMatching(/^exp:\/\//),
            command: expect.stringContaining('simctl openurl'),
            exitCode: 1,
          },
        },
      });
      expect(readEvents(eventsFile).find((entry) => entry._e === 'cli:error')).toMatchObject({
        code: 'DEEP_LINK_REFUSED',
      });
    } finally {
      await stub.close();
    }
  });
});
