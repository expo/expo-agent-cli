// @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions
import { otherPlatformSessionError } from '../../device/cloudErrors';
import { resolveStartPlanAsync } from '../../plan/resolveAsync';
import { openAppOnEasAsync } from '../openAppEas';
import { reopenEasAsync } from '../reopenEas';
import { resolveDevOptions } from '../resolveOptions';

vi.mock('../../project/probe', () => ({ probeProjectStateAsync: vi.fn(async () => ({})) }));
vi.mock('../../plan/lastBuild', () => ({ readLastBuildRecord: vi.fn(() => ({})) }));
vi.mock('../../plan/resolveAsync', () => ({ resolveStartPlanAsync: vi.fn() }));
vi.mock('../../plan/easBuildLookup', () => ({ lookUpEasSimulatorBuildAsync: vi.fn() }));
vi.mock('../openAppEas', () => ({ openAppOnEasAsync: vi.fn() }));

const projectRoot = '/project';
const DEV_SERVER = 'http://127.0.0.1:8081';
const TUNNEL = 'https://abc.tunnel.example';
const options = resolveDevOptions(['--ios', '--eas', '--detach']);
const opened = {
  opened: true,
  sessionId: 'sess-1',
  started: false,
  tunnelHost: 'abc.tunnel.example',
  sessionUrl: null,
  reason: null,
};

beforeEach(() => {
  vi.mocked(resolveStartPlanAsync).mockResolvedValue({
    plan: { target: 'dev-build' },
  } as any);
  vi.mocked(openAppOnEasAsync).mockResolvedValue(opened);
});

afterEach(() => {
  vi.resetAllMocks();
});

it(`refuses at once next to a Metro with no tunnel`, async () => {
  const error = await reopenEasAsync(projectRoot, options, DEV_SERVER, null).catch((e) => e);

  expect(error.code).toBe('DEVICE_UNAVAILABLE');
  expect(error.message).toContain('has no tunnel');
  expect(error.message).toContain('dev:stop", then "npx @expo/agent-cli dev --ios --eas --detach"');
  expect(resolveStartPlanAsync).not.toHaveBeenCalled();
  expect(openAppOnEasAsync).not.toHaveBeenCalled();
});

it(`hands the plan's build to the open`, async () => {
  await expect(reopenEasAsync(projectRoot, options, DEV_SERVER, TUNNEL)).resolves.toBe('sess-1');

  expect(openAppOnEasAsync).toHaveBeenCalledWith(projectRoot, {
    platform: 'ios',
    expoGo: false,
    devServerUrl: DEV_SERVER,
    buildId: null,
    keepSession: true,
  });
});

it(`throws the one-session refusal unchanged`, async () => {
  const refusal = otherPlatformSessionError('android', {
    wanted: 'ios',
    sessionId: 'sess-a',
    devServerRunning: true,
  });
  vi.mocked(openAppOnEasAsync).mockResolvedValue({
    ...opened,
    opened: false,
    sessionId: null,
    reason: 'refused',
    refusal,
  });

  await expect(reopenEasAsync(projectRoot, options, DEV_SERVER, TUNNEL)).rejects.toBe(refusal);
});

it(`fails a plain failed open with DEVICE_UNAVAILABLE`, async () => {
  vi.mocked(openAppOnEasAsync).mockResolvedValue({ ...opened, opened: false, reason: 'no luck' });

  await expect(reopenEasAsync(projectRoot, options, DEV_SERVER, TUNNEL)).rejects.toMatchObject({
    code: 'DEVICE_UNAVAILABLE',
    message: 'no luck',
  });
});

it(`opens nothing for --no-open, with or without a tunnel`, async () => {
  const noOpen = resolveDevOptions(['--ios', '--eas', '--detach', '--no-open']);

  await expect(reopenEasAsync(projectRoot, noOpen, DEV_SERVER, null)).resolves.toBeNull();
  expect(openAppOnEasAsync).not.toHaveBeenCalled();
});
