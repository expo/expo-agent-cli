import type { LastDevRequest } from '../../dev/lastRequest';
import { lockInfo } from '../../devLock/__tests__/fakeLock';
import type { BindingSummary } from '../../deviceBinding/summary';
import { decideStartPlan } from '../../plan/decide';
import type { ProjectState, StartPlan } from '../../project/types';
import {
  chooseNextAction,
  resolveNextTarget,
  type NextActionFacts,
  type NextActionHost,
  type NextTargetFacts,
} from '../nextAction';
import type { DevServerStatus } from '../types';

const state: ProjectState = {
  projectRoot: '/project',
  isExpoApp: true,
  sdkVersion: '54.0.0',
  nativeDirs: { ios: false, android: false },
  usesDevClient: false,
  hasWeb: true,
  expoGo: { compatible: true, reasons: [] },
  fingerprint: { hash: 'abcdef0123456789' },
};

function server(overrides: Partial<DevServerStatus> = {}): DevServerStatus {
  return {
    url: 'http://127.0.0.1:8081',
    running: true,
    appsConnected: 1,
    appsListed: 1,
    appsStale: 0,
    source: 'default',
    ready: true,
    projectRootMatched: true,
    hostType: null,
    tunnelUrl: null,
    openUrls: [],
    ...overrides,
  };
}

const stopped = server({
  running: false,
  appsConnected: 0,
  appsListed: 0,
  ready: null,
  projectRootMatched: null,
});
const noApp = server({ appsConnected: 0, appsListed: 0 });
const foreign = server({ appsConnected: 0, appsListed: 0, projectRootMatched: false });

function binding(overrides: Partial<BindingSummary>): BindingSummary {
  return {
    platform: 'ios',
    backend: 'local-ios',
    id: 'local-ios',
    name: 'local-ios',
    origin: 'started',
    state: 'recorded',
    expiresAt: '2999-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const expired = '2026-01-01T00:00:00.000Z';
const own = lockInfo();
const easLock = (platform: 'ios' | 'android') => lockInfo({ easPlatform: platform });
const androidRequest: LastDevRequest = {
  platform: 'android',
  port: 19082,
  device: 'emulator-5556',
  buildBackend: 'local',
  runTarget: 'dev-build',
};
const dev = 'npx @expo/agent-cli dev';
const easWhy = (platform: string, phase: 'is starting' | 'is not bound yet') =>
  `The dev server's EAS Simulator session for ${platform} ${phase}. This command waits for it, or reopens the app on the running Metro. No restart is needed.`;
const unbound = (platform: string) => `No ${platform} device is bound to this worktree.`;
const restart = (platform: string) =>
  `${unbound(platform)} The running dev server must restart to bind one.`;

type Facts = Omit<NextTargetFacts & NextActionFacts, 'host' | 'bindings' | 'recoveryPort'> & {
  bindings: BindingSummary[] | null;
};

const defaults: Facts = {
  state,
  record: {},
  platform: 'ios',
  devServerUrl: 'http://127.0.0.1:8081',
  devServer: stopped,
  device: null,
  devBuildScheme: null,
  bindings: [],
  ownServer: null,
  request: null,
  deviceBackend: 'local',
  plan: null,
};

const host: NextActionHost = {
  now: Date.parse('2026-10-30T00:00:00.000Z'),
  devicesDisabled: false,
  bindsPlatform: () => true,
  childStartsSession: () => false,
  unreadableBindingFile: () => null,
};

interface Row {
  name: string;
  facts?: Partial<Facts>;
  host?: Partial<NextActionHost>;
  plan?: (plan: StartPlan) => StartPlan;
  command: string;
  /** Null when the plan's own reason stands. */
  why: unknown;
  /** The `--port` value the first plan step carries, when the row is about it. */
  stepsPort?: string | null;
}

// @ref llp/0021-honest-reports.rfc.md §How they show up
describe(chooseNextAction, () => {
  it.each<Row>([
    {
      name: 'keeps a saved Android request before Metro published a lock',
      facts: { platform: undefined, request: androidRequest, devServerUrl: null },
      command: `${dev} --android --local --dev-client --port 19082 --device emulator-5556 --detach --wait-ready`,
      why: unbound('android'),
    },
    {
      name: 'takes the named platform when there is no saved request',
      facts: { devServerUrl: null },
      command: `${dev} --ios --detach --wait-ready`,
      why: unbound('ios'),
    },
    {
      name: 'takes the port of an explicit local URL and keeps the saved device',
      facts: {
        platform: undefined,
        request: androidRequest,
        devServerUrl: 'http://localhost:19090',
      },
      command: `${dev} --android --local --dev-client --port 19090 --device emulator-5556 --detach --wait-ready`,
      why: unbound('android'),
      stepsPort: '19090',
    },
    {
      name: 'takes the port of a current own lock over the saved one',
      facts: {
        platform: undefined,
        request: androidRequest,
        devServerUrl: null,
        ownServer: lockInfo({ port: 19091, url: 'http://127.0.0.1:19091' }),
      },
      command: `${dev}:stop && ${dev} --android --local --dev-client --port 19091 --device emulator-5556 --detach --wait-ready`,
      why: restart('android'),
    },
    {
      name: 'names no local port for a remote URL',
      facts: {
        platform: undefined,
        request: androidRequest,
        devServerUrl: 'http://example.test:19090',
      },
      command: `${dev} --android --local --dev-client --device emulator-5556 --detach --wait-ready`,
      why: unbound('android'),
    },
    {
      name: 'names no saved port that now serves another project',
      facts: {
        platform: undefined,
        request: androidRequest,
        devServerUrl: null,
        devServer: server({
          url: 'http://127.0.0.1:19082',
          appsConnected: 0,
          appsListed: 0,
          ready: false,
          projectRootMatched: false,
        }),
      },
      command: `${dev} --android --local --dev-client --device emulator-5556 --detach --wait-ready`,
      why: unbound('android'),
      stepsPort: null,
    },
    {
      name: 'takes the platform of a sole binding',
      facts: {
        platform: undefined,
        devServerUrl: null,
        bindings: [binding({ platform: 'android', backend: 'local-android', expiresAt: expired })],
      },
      command: `${dev} --android --detach --wait-ready`,
      why: 'The lease on the bound android device expired.',
    },
    ...(['ios', 'android'] as const).flatMap((platform): Row[] => [
      {
        name: `binds a ${platform} device beside another project's server`,
        facts: { platform, devServer: foreign },
        command: `${dev} --${platform} --detach --wait-ready`,
        why: unbound(platform),
      },
      {
        name: `restarts an own ${platform} server with no app, keeping the plan's steps`,
        facts: { platform, devServer: noApp, ownServer: own },
        command: `${dev}:stop && ${dev} --${platform} --port 8081 --detach --wait-ready`,
        why: restart(platform),
        stepsPort: '8081',
      },
      {
        name: `waits for the ${platform} session of an own EAS server instead of a restart`,
        facts: { platform, devServer: noApp, ownServer: easLock(platform) },
        command: `${dev} --${platform} --eas --detach --wait-ready`,
        why: easWhy(platform, 'is not bound yet'),
      },
    ]),
    {
      name: 'says the session is starting while the detached child starts it',
      facts: { devServer: noApp, ownServer: easLock('ios') },
      host: { childStartsSession: () => true },
      command: `${dev} --ios --eas --detach --wait-ready`,
      why: easWhy('ios', 'is starting'),
    },
    {
      name: 'binds the session again, not smoke, for an app on an own EAS server',
      facts: { platform: 'android', devServer: server(), ownServer: easLock('android') },
      command: `${dev} --android --eas --detach --wait-ready`,
      why: easWhy('android', 'is not bound yet'),
    },
    {
      name: 'takes the platform of the EAS lock when nothing names one',
      facts: { platform: undefined, devServer: server(), ownServer: easLock('android') },
      command: `${dev} --android --eas --detach --wait-ready`,
      why: easWhy('android', 'is not bound yet'),
    },
    {
      name: 'stays smoke --eas for an app on an own EAS server with a live session binding',
      facts: {
        platform: 'android',
        devServer: server(),
        ownServer: easLock('android'),
        bindings: [binding({ platform: 'android', backend: 'cloud', id: 'sess-live' })],
      },
      command: 'npx @expo/agent-cli smoke --android --eas',
      why: expect.stringContaining('an EAS Simulator session is on record'),
    },
    {
      name: 'never stops an EAS server for a remembered request of the other platform',
      facts: {
        platform: undefined,
        devServer: noApp,
        ownServer: easLock('android'),
        request: { platform: 'ios', port: null, buildBackend: null, runTarget: null },
      },
      command: `${dev} --android --eas --detach --wait-ready`,
      why: easWhy('android', 'is not bound yet'),
    },
    {
      name: 'never stops an EAS server for a caller who names the other platform',
      facts: { devServer: noApp, ownServer: easLock('android') },
      command: `${dev} --ios --port 8081 --detach --wait-ready`,
      why: unbound('ios'),
    },
    {
      name: 'binds the session of the lock on a host that binds no device',
      facts: { devServer: noApp, ownServer: easLock('ios') },
      host: { devicesDisabled: true },
      command: `${dev} --ios --eas --detach --wait-ready`,
      why: easWhy('ios', 'is not bound yet'),
    },
    {
      name: 'names no --port beside an EAS server for an explicit URL on another port',
      facts: { devServer: noApp, ownServer: easLock('ios'), devServerUrl: 'http://127.0.0.1:9000' },
      command: `${dev} --ios --eas --detach --wait-ready`,
      why: easWhy('ios', 'is not bound yet'),
    },
    {
      name: 'says nothing of an expired session row beside a live local binding',
      facts: {
        bindings: [
          binding({ backend: 'cloud', id: 'sess-old', state: 'gone', expiresAt: expired }),
          binding({}),
        ],
      },
      command: `${dev} --ios --port 8081 --detach --wait-ready`,
      why: null,
    },
    ...[noApp, server()].map((devServer): Row => ({
      name: `says an own session lease expired, with ${devServer.appsConnected} app connected`,
      facts: {
        devServer,
        ownServer: easLock('ios'),
        bindings: [
          binding({ backend: 'cloud', id: 'sess-old', state: 'gone', expiresAt: expired }),
        ],
      },
      command: `${dev} --ios --eas --detach --wait-ready`,
      why: 'The lease on the bound ios EAS Simulator session sess-old expired. This command binds a session again.',
    })),
    {
      name: "detaches the plan's own dev command",
      command: `${dev} --ios --port 8081 --detach --wait-ready`,
      why: unbound('ios'),
    },
    {
      name: "keeps the plan's flags when it detaches the plan's dev command",
      plan: (plan) => ({
        ...plan,
        buildLocation: {
          ...plan.buildLocation,
          runsOn: 'eas',
          selection: { implicit: true },
        } as StartPlan['buildLocation'],
      }),
      command: `${dev} --ios --eas --port 8081 --detach --wait-ready`,
      why: unbound('ios'),
    },
    ...[null, own].map((ownServer): Row => ({
      name: `reuses an expired binding (own server=${ownServer != null})`,
      facts: { ownServer, bindings: [binding({ state: 'gone', expiresAt: expired })] },
      command: `${dev} --ios --port 8081 --detach --wait-ready`,
      why: 'The lease on the bound ios device expired.',
    })),
    {
      name: "keeps the plan's next while an app is connected to this project's dev server",
      facts: { devServer: server(), bindings: [binding({ state: 'gone', expiresAt: expired })] },
      command: 'npx @expo/agent-cli smoke --ios',
      why: expect.stringContaining('instead of starting a second server'),
    },
    {
      name: "keeps the plan's next under AGENT_CLI_NO_DEVICE",
      host: { devicesDisabled: true },
      command: `${dev} --ios --port 8081 --detach --wait-ready`,
      why: null,
    },
    {
      name: "keeps the plan's next on a host that cannot bind the platform",
      host: { bindsPlatform: () => false },
      command: `${dev} --ios --port 8081 --detach --wait-ready`,
      why: null,
    },
    {
      name: "keeps the plan's next while the project has an EAS session, on either platform",
      facts: {
        bindings: [binding({ platform: 'android', backend: 'cloud', id: 'session-1' })],
      },
      command: `${dev} --ios --port 8081 --detach --wait-ready`,
      why: null,
    },
    {
      name: "keeps the plan's next when the binding registry could not be read",
      facts: { bindings: null },
      command: `${dev} --ios --port 8081 --detach --wait-ready`,
      why: null,
    },
    {
      name: 'asks for no local device when the config puts the device on EAS',
      facts: { deviceBackend: 'eas', devServer: foreign },
      command: `${dev} --ios`,
      why: null,
    },
    {
      name: "keeps the plan's next for web",
      facts: { platform: 'web' },
      command: `${dev} --web --port 8081`,
      why: null,
    },
    {
      name: "carries a saved web request's port and flags without detaching",
      facts: {
        platform: undefined,
        devServerUrl: null,
        request: { platform: 'web', port: 19006, buildBackend: 'local', runTarget: 'expo-go' },
      },
      command: `${dev} --web --local --go --port 19006`,
      why: null,
    },
    {
      name: 'removes an unreadable binding file before the dev command that would refuse on it',
      host: { unreadableBindingFile: () => '/bindings/local-ios.json' },
      command: `rm -f '/bindings/local-ios.json' && ${dev} --ios --port 8081 --detach --wait-ready`,
      why: 'The binding file /bindings/local-ios.json does not parse; a newer CLI may have written it.',
    },
  ])('$name', ({ facts, host: hostOverrides, plan: editPlan, command, why, stepsPort }) => {
    const input = { ...defaults, ...facts };
    const { platform, recoveryPort } = resolveNextTarget({
      ...input,
      bindings: input.bindings ?? [],
    });
    const plan = decideStartPlan(input.state, { platform, lastBuild: input.record });

    const next = chooseNextAction({
      ...input,
      platform,
      recoveryPort,
      plan: editPlan ? editPlan(plan) : plan,
      host: { ...host, ...hostOverrides },
    });

    expect({ command: next.command, why: next.why }).toEqual({ command, why });
    if (stepsPort !== undefined) {
      const argv = next.steps[0]!.argv;
      expect(argv.includes('--port') ? argv[argv.indexOf('--port') + 1] : null).toBe(stepsPort);
    }
  });
});
