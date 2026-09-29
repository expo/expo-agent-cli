import * as os from 'node:os';

import { getAgentTelemetryContext } from '../../utils/agent';
import { getTelemetryIdentityAsync } from '../identity';
import { sendCommandTelemetryAsync, TELEMETRY_TIMEOUT_MS } from '../send';

const { detectSandbox } = vi.hoisted(() => ({ detectSandbox: vi.fn() }));
vi.mock('sandbox-cli-detector', () => ({ detectSandbox }));
vi.mock('../../utils/agent', () => ({ getAgentTelemetryContext: vi.fn() }));
vi.mock('../identity', () => ({ getTelemetryIdentityAsync: vi.fn() }));
vi.mock('ci-info', () => ({ isCI: true, name: 'GitHub Actions', isPR: false }));

const data = { command: 'runtime:eval', version: '1.2.3', timestamp: '2026-09-29T12:00:00.000Z' };
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
  vi.mocked(getTelemetryIdentityAsync).mockResolvedValue({
    anonymousId: 'anonymous',
    userHash: 'hashed',
  });
  vi.mocked(getAgentTelemetryContext).mockReturnValue({ id: 'codex', sessionId: 'agent-session' });
  detectSandbox.mockReturnValue({ detected: true, sandbox: { id: 'e2b' } });
  for (const name of ['EXPO_NO_TELEMETRY', 'EXPO_OFFLINE', 'EXPO_STAGING', 'EXPO_LOCAL']) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('sends the Expo unified action schema with CLI, agent, sandbox, and runtime context', async () => {
  await sendCommandTelemetryAsync(data);

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, options] = fetchMock.mock.calls[0]!;
  expect(url).toBe('https://cdp.expo.dev/v1/batch');
  expect(options).toMatchObject({
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'expo-agent-cli/1.2.3',
      authorization: `Basic ${Buffer.from('24TKR7CQAaGgIrLTgu3Fp4OdOkI:').toString('base64')}`,
    },
    signal: expect.any(AbortSignal),
  });
  expect(JSON.parse(options!.body as string)).toEqual({
    sentAt: expect.any(String),
    batch: [
      {
        type: 'track',
        event: 'action',
        anonymousId: 'anonymous',
        userHash: 'hashed',
        messageId: expect.any(String),
        sentAt: expect.any(String),
        originalTimestamp: data.timestamp,
        properties: { action: 'expo-agent-cli runtime:eval' },
        context: {
          sessionId: expect.any(String),
          app: { name: 'expo/agent-cli', version: '1.2.3' },
          os: { name: os.platform(), version: os.release(), node: process.versions.node },
          device: { arch: os.arch() },
          ci: { name: 'GitHub Actions', isPr: false },
          client: { mode: 'detached' },
          agent: { id: 'codex', sessionId: 'agent-session' },
          sandbox_provider: 'e2b',
        },
      },
    ],
  });
});

it.each(['EXPO_STAGING', 'EXPO_LOCAL'])('uses the staging target for %s', async (name) => {
  vi.stubEnv(name, 'true');
  await sendCommandTelemetryAsync(data);
  expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({
    authorization: `Basic ${Buffer.from('24TKICqYKilXM480mA7ktgVDdea:').toString('base64')}`,
  });
});

it.each(['EXPO_NO_TELEMETRY', 'EXPO_OFFLINE'])(
  'respects %s without reading identity or detectors',
  async (name) => {
    vi.stubEnv(name, '1');
    await sendCommandTelemetryAsync(data);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getTelemetryIdentityAsync).not.toHaveBeenCalled();
    expect(getAgentTelemetryContext).not.toHaveBeenCalled();
    expect(detectSandbox).not.toHaveBeenCalled();
  }
);

it('does not interpret false environment flags as opt-out or staging', async () => {
  vi.stubEnv('EXPO_NO_TELEMETRY', 'false');
  vi.stubEnv('EXPO_OFFLINE', '0');
  vi.stubEnv('EXPO_STAGING', 'false');
  vi.stubEnv('EXPO_LOCAL', '0');
  await sendCommandTelemetryAsync(data);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({
    authorization: `Basic ${Buffer.from('24TKR7CQAaGgIrLTgu3Fp4OdOkI:').toString('base64')}`,
  });
});

it('omits unavailable agent and sandbox context', async () => {
  vi.mocked(getAgentTelemetryContext).mockReturnValue(null);
  detectSandbox.mockReturnValue({ detected: false, sandbox: null });
  await sendCommandTelemetryAsync(data);
  const { context } = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).batch[0];
  expect(context).not.toHaveProperty('agent');
  expect(context).not.toHaveProperty('sandbox_provider');
});

it('does not lose the event when sandbox detection throws', async () => {
  detectSandbox.mockImplementation(() => {
    throw new Error('detector failure');
  });
  await expect(sendCommandTelemetryAsync(data)).resolves.toBeUndefined();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]![1]!.body).not.toContain('detector failure');
});

it('suppresses network failures and never retries', async () => {
  fetchMock.mockRejectedValue(new Error('network failure'));
  await expect(sendCommandTelemetryAsync(data)).resolves.toBeUndefined();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('aborts a stalled request within the deadline without retrying', async () => {
  vi.useFakeTimers();
  fetchMock.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(new Error('aborted')));
      })
  );
  const sending = sendCommandTelemetryAsync(data);
  await vi.advanceTimersByTimeAsync(TELEMETRY_TIMEOUT_MS);
  await expect(sending).resolves.toBeUndefined();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
});
