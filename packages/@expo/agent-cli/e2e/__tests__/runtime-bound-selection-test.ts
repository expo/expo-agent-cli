// @ref llp/0035-one-device-per-worktree.rfc.md §Readers
// Exercise binding resolution, flag precedence and diagnostics through the published CLI.
import fs from 'node:fs';

import { runtimeTarget } from '../runtimeTargetFixtures';
import { cloudBindingFile, writeCloudBindingAsync } from '../stubEas';
import {
  executeAgentCliAsync,
  expoHomeOf,
  setupFixtureAsync,
  startStubDevServerAsync,
} from '../utils';
import {
  bindingFixture,
  BOOTED_SIMULATOR,
  EMULATOR_SERIAL,
  installStubAdbAsync,
  installStubXcrunAsync,
  stubEmulatorStatePath,
} from './installedAppStubs';

const A = BOOTED_SIMULATOR;
const B = { udid: 'SIM-B', name: 'iPhone 16', state: 'Booted' as const };
const apps = {
  a: runtimeTarget('a', { deviceName: A.name, appId: 'host.exp.Exponent' }),
  b: runtimeTarget('b', { deviceName: B.name, appId: 'host.exp.Exponent' }),
  cloud: runtimeTarget('cloud', { deviceName: 'iPhone 17' }),
  android: runtimeTarget('android', {
    deviceName: 'sdk_gphone64_arm64 - 15 - API 35',
    appId: 'host.exp.exponent',
  }),
  // An EAS Android session runs an x86_64 image; the local emulator on Apple Silicon is arm64.
  androidSession: runtimeTarget('androidSession', {
    deviceName: 'sdk_gphone64_x86_64 - 15 - API 35',
    appId: 'host.exp.exponent',
  }),
};
type BindingKind =
  | 'emulator'
  | 'simulator'
  | 'ios-cloud'
  | 'android-cloud'
  | 'simulator-and-ios-cloud';
type AppId = keyof typeof apps;
const sessionLine =
  'Scoped to ios: the EAS Simulator session 01a160c1, the device bound to this worktree.';
const simulatorLine = `Scoped to ios: the iOS simulator "${A.name}", the device bound to this worktree.`;

async function setupBoundAsync(
  binding: BindingKind,
  {
    shutdown = false,
    attached = binding === 'emulator',
    bound = binding === 'emulator',
  }: { shutdown?: boolean; attached?: boolean; bound?: boolean } = {}
) {
  const root = await fs.promises.realpath(await setupFixtureAsync('go-app'));
  await installStubXcrunAsync(root, {
    simulators: [shutdown ? { ...A, state: 'Shutdown' as const } : A, B],
  });
  // The stub binds the first booted simulator; this worktree's binding is A in every state.
  const bindingFile = await bindingFixture(root, A.udid);
  if (!binding.startsWith('simulator')) await fs.promises.rm(bindingFile);
  const adb = await installStubAdbAsync(root, 'dev.example.app', {
    attached,
    bound,
  });
  if (binding.endsWith('cloud')) {
    await writeCloudBindingAsync(expoHomeOf(root), root, {
      platform: binding === 'android-cloud' ? 'android' : 'ios',
      id: binding === 'android-cloud' ? '01a15bf1' : '01a160c1',
    });
  }
  return { root, bindingFile, env: { ...adb.env, AGENT_CLI_NO_DEVICE: '0' } };
}

/** A second emulator of the bound one's model; `reversing` lists the serials that forward `port`. */
async function attachTwinAsync(root: string, reversing: string[], port: number) {
  await fs.promises.writeFile(stubEmulatorStatePath(root), `${TWIN}\n`);
  return {
    STUB_ADB_REVERSE: JSON.stringify(Object.fromEntries(reversing.map((serial) => [serial, port]))),
  };
}
const TWIN = 'emulator-5556';

// Local iOS binding inspection intentionally only runs on macOS; cloud and Android rows run on all hosts.
const selectionCases: {
  binding: BindingKind;
  flag?: 'ios' | 'android';
  /** List the local emulator beside an EAS Android session. */
  emulatorAttached?: boolean;
  targets: AppId[];
  selected: AppId;
  line: string | null;
}[] = [
  {
    binding: 'emulator',
    targets: ['a', 'android'],
    selected: 'android',
    line: 'Scoped to android: the Android device emulator-5554, the device bound to this worktree.',
  },
  {
    binding: 'android-cloud',
    targets: ['a', 'android'],
    selected: 'android',
    line: 'Scoped to android: the EAS Simulator session 01a15bf1, the device bound to this worktree.',
  },
  {
    binding: 'android-cloud',
    emulatorAttached: true,
    targets: ['android', 'androidSession'],
    selected: 'androidSession',
    line: 'Scoped to android: the EAS Simulator session 01a15bf1, the device bound to this worktree.',
  },
  {
    binding: 'ios-cloud',
    targets: ['a', 'cloud', 'android'],
    selected: 'cloud',
    line: sessionLine,
  },
  {
    binding: 'ios-cloud',
    flag: 'ios',
    targets: ['a', 'cloud', 'android'],
    selected: 'cloud',
    line: sessionLine,
  },
  {
    binding: 'ios-cloud',
    flag: 'android',
    targets: ['a', 'cloud', 'android'],
    selected: 'android',
    line: null,
  },
  {
    binding: 'simulator',
    targets: ['b', 'a', 'android'],
    selected: 'a',
    line: simulatorLine,
  },
  {
    binding: 'simulator',
    flag: 'ios',
    targets: ['b', 'a', 'android'],
    selected: 'a',
    line: simulatorLine,
  },
];
for (const row of selectionCases) {
  it.skipIf(row.binding === 'simulator' && process.platform !== 'darwin')(
    `eval with ${row.binding}, flag ${row.flag ?? 'none'}, reads ${row.selected}`,
    async () => {
      const { root, env } = await setupBoundAsync(row.binding, {
        attached: row.emulatorAttached ?? row.binding === 'emulator',
      });
      const evaluated: string[] = [];
      const server = await startStubDevServerAsync({
        projectRoot: root,
        targets: row.targets.map((id) => apps[id]),
        inspectorEvaluate: (expression, device) => {
          if (!expression.includes('selected-app-sentinel')) return undefined;
          evaluated.push(device);
          return device;
        },
      });
      try {
        const result = await executeAgentCliAsync(
          root,
          [
            'runtime:eval',
            '"selected-app-sentinel"',
            ...(row.flag ? [`--${row.flag}`] : []),
            '--dev-server-url',
            server.url,
            '--json',
          ],
          { reject: false, env }
        );
        expect(result.exitCode, result.all).toBe(0);
        expect(JSON.parse(result.stdout).value).toBe(row.selected);
        expect(evaluated).toEqual([row.selected]);
        expect(result.stderr.split('\n').filter((line) => line.startsWith('Scoped to'))).toEqual(
          row.line ? [row.line] : []
        );
      } finally {
        await server.close();
      }
    }
  );
}

const refusalCases: {
  name: string;
  binding: BindingKind;
  shutdown?: boolean;
  flag?: 'ios' | 'android';
  targets: AppId[];
  how?: string;
  app?: string;
  device?: string;
  text?: string;
  /** A sentence of the Why line. */
  why?: string;
  /** Attach a twin of the bound emulator; the serials that reverse the dev server's port. */
  twin?: string[];
  /** `adb reverse --list` fails on every device. */
  reverseFails?: boolean;
  /** The bound emulator is not among the devices adb lists. */
  emulatorGone?: boolean;
}[] = [
  {
    name: 'two emulators of one model that both reverse the port',
    binding: 'emulator',
    targets: ['android'],
    twin: [EMULATOR_SERIAL, TWIN],
    text: `How: remove a forward the other device keeps with "adb -s ${TWIN} reverse --remove tcp:`,
  },
  {
    name: 'two emulators of one model that neither reverses the port',
    binding: 'emulator',
    targets: ['android'],
    twin: [],
    text: `How: detach "${TWIN}", or reverse the port on ${EMULATOR_SERIAL} with "adb -s ${EMULATOR_SERIAL} reverse tcp:`,
  },
  {
    name: 'two emulators of one model whose reverse list cannot be read',
    binding: 'emulator',
    targets: ['android'],
    twin: [],
    reverseFails: true,
    text: 'How: run this command again once "adb reverse --list" works on each of them.',
  },
  {
    name: 'a bound emulator that is not attached',
    binding: 'emulator',
    targets: ['android'],
    emulatorGone: true,
  },
  {
    name: 'a shut-down bound simulator beside a booted one',
    binding: 'simulator',
    shutdown: true,
    targets: ['b'],
    app: `"${B.name}"`,
    device: `the iOS simulator "${A.name}"`,
  },
  {
    name: 'a shut-down bound simulator beside a live session',
    binding: 'simulator-and-ios-cloud',
    shutdown: true,
    targets: ['cloud'],
    device: `the iOS simulator "${A.name}"`,
    why: 'This worktree also has a live EAS Simulator session.',
  },
  {
    name: 'another simulator',
    binding: 'simulator',
    targets: ['b'],
    app: `"${B.name}"`,
    device: `the iOS simulator "${A.name}"`,
  },
  {
    name: 'cloud iOS can suggest Android',
    binding: 'ios-cloud',
    targets: ['android'],
    how: 'How: open the app on ios with "npx @expo/agent-cli navigate / --ios --eas", then run this command again. Pass --android to read the other app instead.',
  },
  {
    name: 'explicit iOS retains its platform',
    binding: 'ios-cloud',
    flag: 'ios',
    targets: ['android'],
    how: 'How: open the app on ios with "npx @expo/agent-cli navigate / --ios --eas", then run this command again.',
  },
  {
    name: 'explicit iOS can be dropped',
    binding: 'emulator',
    flag: 'ios',
    targets: ['android'],
    how: 'How: open the app on ios with "npx @expo/agent-cli navigate / --ios", then run this command again. Drop --ios to read whichever app is connected.',
  },
];
for (const row of refusalCases) {
  it.skipIf(row.binding.startsWith('simulator') && process.platform !== 'darwin')(
    `eval refusal: ${row.name}`,
    async () => {
      const { root, env } = await setupBoundAsync(row.binding, {
        shutdown: row.shutdown,
        attached: !row.emulatorGone && row.binding === 'emulator',
      });
      const server = await startStubDevServerAsync({
        projectRoot: root,
        targets: row.targets.map((id) => apps[id]),
      });
      const twinEnv = row.twin ? await attachTwinAsync(root, row.twin, server.port) : {};
      try {
        const result = await executeAgentCliAsync(
          root,
          [
            'runtime:eval',
            '1',
            ...(row.flag ? [`--${row.flag}`] : []),
            '--dev-server-url',
            server.url,
            '--json',
          ],
          {
            reject: false,
            env: {
              ...env,
              ...twinEnv,
              ...(row.reverseFails ? { STUB_ADB_REVERSE_FAIL: '1' } : {}),
            },
          }
        );
        expect(result.exitCode).toBe(1);
        const { error } = JSON.parse(result.stdout);
        expect(error.code).toBe('NO_APP_CONNECTED');
        expect(error.message.split('\n').at(-1)).toMatch(/^How: /);
        expect(error.message.split('\n').at(-1)).toMatch(/^How: /);
        if (row.how) expect(error.message.split('\n').at(-1)).toBe(row.how);
        if (row.app) expect(error.message).toContain(row.app);
        if (row.device) expect(error.message).toContain(row.device);
        if (row.text) expect(error.message).toContain(row.text);
        if (row.why)
          expect(
            error.message.split('\n').find((line: string) => line.startsWith('Why:'))
          ).toContain(row.why);
        expect(result.stderr).not.toContain('Scoped to');
      } finally {
        await server.close();
      }
    }
  );
}

it('eval reads the bound emulator beside a twin when only the bound one reverses the port', async () => {
  const { root, env } = await setupBoundAsync('emulator');
  const evaluated: string[] = [];
  const server = await startStubDevServerAsync({
    projectRoot: root,
    targets: [apps.android],
    inspectorEvaluate: (expression, device) => {
      if (!expression.includes('selected-app-sentinel')) return undefined;
      evaluated.push(device);
      return device;
    },
  });
  const twinEnv = await attachTwinAsync(root, [EMULATOR_SERIAL], server.port);
  try {
    const result = await executeAgentCliAsync(
      root,
      ['runtime:eval', '"selected-app-sentinel"', '--dev-server-url', server.url, '--json'],
      {
        reject: false,
        env: { ...env, ...twinEnv },
      }
    );
    expect(result.exitCode, result.all).toBe(0);
    expect(evaluated).toEqual(['android']);
  } finally {
    await server.close();
  }
});

it.skipIf(process.platform !== 'darwin')(
  'eval refuses with NO_BOUND_DEVICE when its own binding file cannot be read',
  async () => {
    const { root, bindingFile, env } = await setupBoundAsync('simulator');
    await fs.promises.writeFile(bindingFile, '{');
    const server = await startStubDevServerAsync({
      projectRoot: root,
      targets: [apps.a],
    });
    try {
      const result = await executeAgentCliAsync(
        root,
        ['runtime:eval', '1', '--dev-server-url', server.url, '--json'],
        { reject: false, env }
      );
      expect(result.exitCode, result.all).toBe(7);
      expect(JSON.parse(result.stdout).error.code).toBe('NO_BOUND_DEVICE');
    } finally {
      await server.close();
    }
  }
);

it('eval refuses with NO_BOUND_DEVICE when its own cloud binding file cannot be read', async () => {
  const { root, env } = await setupBoundAsync('ios-cloud');
  await fs.promises.writeFile(cloudBindingFile(expoHomeOf(root), root, 'ios'), '{');
  const server = await startStubDevServerAsync({
    projectRoot: root,
    targets: [apps.a],
  });
  try {
    const result = await executeAgentCliAsync(
      root,
      ['runtime:eval', '1', '--dev-server-url', server.url, '--json'],
      { reject: false, env }
    );
    expect(result.exitCode, result.all).toBe(7);
    expect(JSON.parse(result.stdout).error.code).toBe('NO_BOUND_DEVICE');
  } finally {
    await server.close();
  }
});

// The variable keeps this machine's devices untouched; an EAS session is not one of them.
it('eval with AGENT_CLI_NO_DEVICE=1 still scopes to the EAS session binding', async () => {
  const { root, env } = await setupBoundAsync('ios-cloud');
  const server = await startStubDevServerAsync({
    projectRoot: root,
    targets: [apps.cloud],
    inspectorEvaluate: (expression) => (expression === '1' ? 1 : undefined),
  });
  try {
    const result = await executeAgentCliAsync(
      root,
      ['runtime:eval', '1', '--dev-server-url', server.url, '--json'],
      { reject: false, env: { ...env, AGENT_CLI_NO_DEVICE: '1' } }
    );
    expect(result.exitCode, result.all).toBe(0);
    expect(result.stderr).toContain('Scoped to');
  } finally {
    await server.close();
  }
});

it.skipIf(process.platform !== 'darwin')(
  'eval with no dev server refuses with NO_DEV_SERVER beside an unreadable binding file',
  async () => {
    const { root, bindingFile, env } = await setupBoundAsync('simulator');
    await fs.promises.writeFile(bindingFile, '{');
    const result = await executeAgentCliAsync(
      root,
      ['runtime:eval', '1', '--dev-server-url', 'http://127.0.0.1:1', '--json'],
      { reject: false, env }
    );
    expect(result.exitCode, result.all).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe('NO_DEV_SERVER');
  }
);

it.skipIf(process.platform !== 'darwin')(
  'eval with AGENT_CLI_NO_DEVICE=1 reads by the flag and skips the binding',
  async () => {
    const { root, env } = await setupBoundAsync('simulator');
    const evaluated: string[] = [];
    const server = await startStubDevServerAsync({
      projectRoot: root,
      targets: [apps.b, apps.android],
      inspectorEvaluate: (expression, device) => {
        if (!expression.includes('selected-app-sentinel')) return undefined;
        evaluated.push(device);
        return device;
      },
    });
    try {
      const result = await executeAgentCliAsync(
        root,
        [
          'runtime:eval',
          '"selected-app-sentinel"',
          '--ios',
          '--dev-server-url',
          server.url,
          '--json',
        ],
        { reject: false, env: { ...env, AGENT_CLI_NO_DEVICE: '1' } }
      );
      expect(result.exitCode, result.all).toBe(0);
      expect(evaluated).toEqual(['b']);
      expect(result.stderr).not.toContain('Scoped to');
    } finally {
      await server.close();
    }
  }
);
