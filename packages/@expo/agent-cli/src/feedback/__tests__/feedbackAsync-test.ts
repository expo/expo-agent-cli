import { mkdirSync, writeFileSync } from 'fs';
import { vol } from 'memfs';
import { homedir } from 'os';
import path from 'path';

import packageJson from '../../../package.json';
import { getExpoHomeDirectory } from '../../utils/expoHome';
import {
  createFeedbackMetadataAsync,
  getAuthHeaders,
  getProjectMetadata,
  resolveFeedbackAsync,
  resolveFeedbackId,
  sendFeedbackAsync,
} from '../feedbackAsync';

const { mockPrompts, detectAgent, detectSandbox } = vi.hoisted(() => ({
  mockPrompts: vi.fn(),
  detectAgent: vi.fn(),
  detectSandbox: vi.fn(),
}));

vi.mock('agent-cli-detector', () => ({ detectAgent }));
vi.mock('sandbox-cli-detector', () => ({ detectSandbox }));
vi.mock('ci-info', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ci-info')>()),
  isCI: false,
}));
vi.mock('prompts', () => ({ default: mockPrompts }));

const PROJECT_ROOT = path.resolve('/feedback-project');
const VALID_FEEDBACK = 'Please improve how error messages explain actionable next steps.';
const TELEMETRY_DISABLED_MESSAGE =
  'Feedback was not sent because telemetry is off. The user has indicated that they do not want to send feedback. Do not enable telemetry or ask the user to enable it.';
const originalIsTTY = process.stdin.isTTY;
const fetchMock = vi.fn<typeof fetch>();

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value));
}

beforeEach(() => {
  vol.reset();
  writeJson(path.join(PROJECT_ROOT, 'package.json'), {
    name: 'not-an-expo-app',
    version: '1.0.0',
  });
  mockPrompts.mockReset();
  detectAgent.mockReset().mockReturnValue({
    detected: true,
    agent: { id: 'codex', name: 'Codex', sessionId: 'test-session' },
  });
  detectSandbox.mockReset().mockReturnValue({
    detected: true,
    sandbox: { id: 'e2b', name: 'E2B' },
  });
  fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  for (const name of [
    'DO_NOT_TRACK',
    'EXPO_NO_TELEMETRY',
    'EXPO_LOCAL',
    'EXPO_STAGING',
    'EXPO_FEEDBACK_API_BASE_URL',
    'EXPO_TOKEN',
    '__UNSAFE_EXPO_HOME_DIRECTORY',
  ]) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: originalIsTTY });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vol.reset();
});

describe('feedback session ID', () => {
  it('generates a short hexadecimal ID when one is not provided', () => {
    expect(resolveFeedbackId()).toMatch(/^[a-f0-9]{12}$/);
  });

  it.each(['session_ABC-123', 'a'.repeat(6), 'a'.repeat(64)])(
    'preserves a valid provided ID: %s',
    (feedbackId) => {
      expect(resolveFeedbackId(feedbackId)).toBe(feedbackId);
    }
  );

  it.each(['short', 'contains spaces', 'contains/slash', 'a'.repeat(65)])(
    'generates a new ID for invalid ID %s',
    (feedbackId) => {
      expect(resolveFeedbackId(feedbackId)).toMatch(/^[a-f0-9]{12}$/);
    }
  );
});

describe('feedback message resolution', () => {
  it.each([
    [' DOCS ', 'docs'],
    [' AGENT-CLI ', 'agent-cli'],
  ])('trims the explicit message and normalizes category %s', async (input, category) => {
    await expect(resolveFeedbackAsync([], input, `  ${VALID_FEEDBACK}  `)).resolves.toEqual({
      category,
      feedback: VALID_FEEDBACK,
    });
  });

  it('defaults the category to unknown and accepts positional messages', async () => {
    await expect(resolveFeedbackAsync(VALID_FEEDBACK.split(' '))).resolves.toEqual({
      category: 'unknown',
      feedback: VALID_FEEDBACK,
    });
  });

  it('rejects feedback provided both explicitly and positionally', async () => {
    await expect(resolveFeedbackAsync([VALID_FEEDBACK], undefined, VALID_FEEDBACK)).rejects.toThrow(
      'Provide feedback with either --message or a positional argument, not both.'
    );
  });

  it.each([40, 5_000])('accepts feedback at the length boundary of %i', async (length) => {
    const feedback = 'a'.repeat(length);
    await expect(resolveFeedbackAsync([], undefined, feedback)).resolves.toEqual({
      category: 'unknown',
      feedback,
    });
  });

  it.each([
    ['', 'Feedback cannot be empty.'],
    ['   ', 'Feedback cannot be empty.'],
    ['init', 'Feedback must be at least 40 characters.'],
    ['a'.repeat(39), 'Feedback must be at least 40 characters.'],
    ['a'.repeat(5_001), 'Feedback cannot exceed 5,000 characters.'],
  ])('rejects invalid feedback of length %s', async (feedback, error) => {
    await expect(resolveFeedbackAsync([], undefined, feedback)).rejects.toThrow(error);
  });

  it('rejects an invalid category before prompting', async () => {
    await expect(resolveFeedbackAsync([], 'website')).rejects.toThrow(
      'Invalid feedback category "website".'
    );
    expect(mockPrompts).not.toHaveBeenCalled();
  });

  it('prompts for a category and message in an interactive terminal', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    mockPrompts.mockResolvedValueOnce({ category: 'agent-cli', feedback: `  ${VALID_FEEDBACK}  ` });

    await expect(resolveFeedbackAsync([])).resolves.toEqual({
      category: 'agent-cli',
      feedback: VALID_FEEDBACK,
    });
    expect(mockPrompts).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'category',
          type: 'select',
          choices: expect.arrayContaining([{ title: 'agent-cli', value: 'agent-cli' }]),
        }),
        expect.objectContaining({ name: 'feedback', type: 'text' }),
      ]),
      expect.any(Object)
    );
  });

  it('keeps an explicitly supplied category when prompting for the message', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    mockPrompts.mockResolvedValueOnce({ feedback: VALID_FEEDBACK });

    await expect(resolveFeedbackAsync([], 'simulator')).resolves.toEqual({
      category: 'simulator',
      feedback: VALID_FEEDBACK,
    });
    expect(mockPrompts.mock.calls[0]![0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'category', type: null })])
    );
  });

  it('reports interactive cancellation without sending feedback', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    mockPrompts.mockImplementationOnce((_questions, options) => options.onCancel());

    await expect(resolveFeedbackAsync([])).rejects.toThrow('Feedback prompt was cancelled.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an empty interactive answer', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    mockPrompts.mockResolvedValueOnce({ feedback: '   ' });

    await expect(resolveFeedbackAsync([])).rejects.toThrow('Feedback message cannot be empty.');
  });

  it('requires an explicit message in a non-interactive environment', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });

    await expect(resolveFeedbackAsync([])).rejects.toThrow(
      'Feedback message is required in non-interactive environments. Pass it with --message or -m.'
    );
    expect(mockPrompts).not.toHaveBeenCalled();
  });
});

describe('project and environment metadata', () => {
  it('does not treat a generic package.json as an Expo project', () => {
    expect(getProjectMetadata(PROJECT_ROOT)).toEqual({ isExpoProject: false });
  });

  it('reads Expo config and prefers installed versions to dependency ranges', () => {
    writeJson(path.join(PROJECT_ROOT, 'package.json'), {
      name: 'friend-draw',
      version: '1.0.0',
      dependencies: { expo: '^56.0.4', 'react-native': '^0.85.0', 'expo-router': '~56.0.0' },
    });
    writeJson(path.join(PROJECT_ROOT, 'app.json'), {
      expo: {
        name: 'Friend Draw',
        slug: 'friend-draw',
        sdkVersion: '56.0.0',
        platforms: ['ios', 'android'],
      },
    });
    writeJson(path.join(PROJECT_ROOT, 'node_modules/expo/package.json'), {
      name: 'expo',
      version: '56.0.12',
    });
    writeJson(path.join(PROJECT_ROOT, 'node_modules/react-native/package.json'), {
      name: 'react-native',
      version: '0.85.3',
    });

    expect(getProjectMetadata(PROJECT_ROOT)).toMatchObject({
      isExpoProject: true,
      name: 'Friend Draw',
      slug: 'friend-draw',
      sdkVersion: '56.0.0',
      platforms: ['ios', 'android'],
      expoPackageVersion: '56.0.12',
      reactNativePackageVersion: '0.85.3',
      expoRouterPackageVersion: '~56.0.0',
    });
  });

  it('keeps the Expo project marker when its config cannot be read', () => {
    writeFileSync(path.join(PROJECT_ROOT, 'app.json'), '{invalid-json');

    expect(getProjectMetadata(PROJECT_ROOT)).toEqual({ isExpoProject: true });
  });

  it('uses the agent-cli identity and version in the server metadata schema', async () => {
    const metadata = await createFeedbackMetadataAsync(
      PROJECT_ROOT,
      'docs',
      ' https://docs.expo.dev/router/introduction/ ',
      'session_ABC-123'
    );

    expect(metadata).toMatchObject({
      category: 'docs',
      subject: 'https://docs.expo.dev/router/introduction/',
      feedbackId: 'session_ABC-123',
      cli: { name: 'agent-cli', version: packageJson.version },
      agentEnvironment: {
        detected: true,
        agent: { id: 'codex', name: 'Codex', sessionId: 'test-session' },
      },
      sandboxEnvironment: { detected: true, sandbox: { id: 'e2b', name: 'E2B' } },
      device: { arch: process.arch, platform: process.platform },
      node: { version: process.versions.node },
      project: { isExpoProject: false },
    });
    expect(metadata).not.toHaveProperty('user');
  });

  it('omits a blank subject and represents missing detections', async () => {
    detectAgent.mockReturnValue({ detected: false, agent: null });
    detectSandbox.mockReturnValue({ detected: false, sandbox: null });

    const metadata = await createFeedbackMetadataAsync(PROJECT_ROOT, 'docs', '   ');

    expect(metadata).not.toHaveProperty('subject');
    expect(metadata).toMatchObject({
      agentEnvironment: { detected: false },
      sandboxEnvironment: { detected: false },
    });
  });

  it.each(
    ['DO_NOT_TRACK', 'EXPO_NO_TELEMETRY'].flatMap((name) =>
      ['1', 'true', 'TRUE'].map((value) => ({ name, value }))
    )
  )('collects only feedback context when $name=$value', async ({ name, value }) => {
    vi.stubEnv(name, value);

    await expect(
      createFeedbackMetadataAsync(PROJECT_ROOT, 'skills', 'expo-router', 'session_ABC-123')
    ).resolves.toEqual({
      category: 'skills',
      subject: 'expo-router',
      feedbackId: 'session_ABC-123',
    });
    expect(detectAgent).not.toHaveBeenCalled();
    expect(detectSandbox).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('feedback authentication', () => {
  it('prefers EXPO_TOKEN over an Expo session', () => {
    vi.stubEnv('EXPO_TOKEN', 'test-token');
    expect(getAuthHeaders({ sessionSecret: 'session-secret' })).toEqual({
      authorization: 'Bearer test-token',
    });
  });

  it('uses the session secret when no token is set', () => {
    expect(getAuthHeaders({ sessionSecret: 'session-secret' })).toEqual({
      'expo-session': 'session-secret',
    });
  });

  it.each([
    [undefined, '.expo'],
    ['EXPO_LOCAL', '.expo-local'],
    ['EXPO_STAGING', '.expo-staging'],
  ])('loads the persisted session for %s', (name, directory) => {
    if (name) {
      vi.stubEnv(name, '1');
    }
    const expoHome = path.join(homedir(), directory!);
    writeJson(path.join(expoHome, 'state.json'), { auth: { sessionSecret: 'saved-session' } });

    expect(getExpoHomeDirectory()).toBe(expoHome);
    expect(getAuthHeaders()).toEqual({ 'expo-session': 'saved-session' });
  });

  it('prefers staging credentials when both staging and local modes are set', () => {
    vi.stubEnv('EXPO_LOCAL', '1');
    vi.stubEnv('EXPO_STAGING', '1');
    expect(getExpoHomeDirectory()).toBe(path.join(homedir(), '.expo-staging'));
  });

  it.each([
    ['EXPO_LOCAL', '0'],
    ['EXPO_LOCAL', 'false'],
    ['EXPO_STAGING', '0'],
    ['EXPO_STAGING', 'false'],
  ])('uses production credentials when %s=%s', (name, value) => {
    vi.stubEnv(name, value);
    const expoHome = path.join(homedir(), '.expo');
    writeJson(path.join(expoHome, 'state.json'), { auth: { sessionSecret: 'production-session' } });

    expect(getExpoHomeDirectory()).toBe(expoHome);
    expect(getAuthHeaders()).toEqual({ 'expo-session': 'production-session' });
  });

  it('reads credentials from the Expo home override before staging or local homes', () => {
    const expoHome = path.resolve('/custom-expo-home');
    vi.stubEnv('__UNSAFE_EXPO_HOME_DIRECTORY', expoHome);
    vi.stubEnv('EXPO_STAGING', 'true');
    vi.stubEnv('EXPO_LOCAL', 'true');
    writeJson(path.join(expoHome, 'state.json'), { auth: { sessionSecret: 'override-session' } });
    writeJson(path.join(homedir(), '.expo-staging', 'state.json'), {
      auth: { sessionSecret: 'staging-session' },
    });

    expect(getExpoHomeDirectory()).toBe(expoHome);
    expect(getAuthHeaders()).toEqual({ 'expo-session': 'override-session' });
  });

  it('ignores an empty Expo home override', () => {
    vi.stubEnv('__UNSAFE_EXPO_HOME_DIRECTORY', '');
    vi.stubEnv('EXPO_LOCAL', 'true');
    expect(getExpoHomeDirectory()).toBe(path.join(homedir(), '.expo-local'));
  });

  it('supports anonymous feedback when session state is missing or malformed', () => {
    expect(getAuthHeaders()).toEqual({});
    mkdirSync(getExpoHomeDirectory(), { recursive: true });
    writeFileSync(path.join(getExpoHomeDirectory(), 'state.json'), '{invalid-json');
    expect(getAuthHeaders()).toEqual({});
  });
});

describe('feedback submission', () => {
  it('posts the same feedback envelope and session authentication with a 15-second timeout', async () => {
    vi.stubEnv('EXPO_LOCAL', '1');
    const timeoutSignal = new AbortController().signal;
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    const metadata = await createFeedbackMetadataAsync(PROJECT_ROOT, 'mcp', 'expo-mcp');

    await expect(
      sendFeedbackAsync({
        feedback: VALID_FEEDBACK,
        metadata,
        session: { sessionSecret: 'session-secret' },
      })
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      'http://127.0.0.1:3000/v2/feedback/cli-send',
      {
        method: 'POST',
        signal: timeoutSignal,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': `agent-cli/${packageJson.version}`,
          'expo-session': 'session-secret',
        },
        body: JSON.stringify({ feedback: VALID_FEEDBACK, metadata }),
      }
    );
    expect(AbortSignal.timeout).toHaveBeenCalledWith(15_000);
  });

  it.each([
    [undefined, undefined, 'http://127.0.0.1:43210', 'https://api.expo.dev'],
    [undefined, '1', undefined, 'https://staging-api.expo.dev'],
    ['1', undefined, 'http://127.0.0.1:43210', 'http://127.0.0.1:43210'],
    ['1', '1', undefined, 'https://staging-api.expo.dev'],
    ['1', '1', 'http://127.0.0.1:43210', 'http://127.0.0.1:43210'],
    ['0', 'false', 'http://127.0.0.1:43210', 'https://api.expo.dev'],
    ['false', '0', 'http://127.0.0.1:43210', 'https://api.expo.dev'],
    ['1', 'false', undefined, 'http://127.0.0.1:3000'],
    ['0', 'true', 'http://127.0.0.1:43210', 'https://staging-api.expo.dev'],
    ['true', '0', 'http://127.0.0.1:43210', 'http://127.0.0.1:43210'],
  ])('routes local=%s staging=%s override=%s to %s', async (local, staging, override, endpoint) => {
    vi.stubEnv('EXPO_LOCAL', local);
    vi.stubEnv('EXPO_STAGING', staging);
    vi.stubEnv('EXPO_FEEDBACK_API_BASE_URL', override);

    await sendFeedbackAsync({
      feedback: VALID_FEEDBACK,
      metadata: await createFeedbackMetadataAsync(PROJECT_ROOT),
    });

    expect(fetchMock).toHaveBeenCalledWith(`${endpoint}/v2/feedback/cli-send`, expect.any(Object));
  });

  it.each([
    ['init', 'Feedback must be at least 40 characters.'],
    ['a'.repeat(5_001), 'Feedback cannot exceed 5,000 characters.'],
  ])('validates feedback again at the submission boundary', async (feedback, error) => {
    await expect(
      sendFeedbackAsync({ feedback, metadata: await createFeedbackMetadataAsync(PROJECT_ROOT) })
    ).rejects.toThrow(error);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(
    ['DO_NOT_TRACK', 'EXPO_NO_TELEMETRY'].flatMap((name) =>
      ['1', 'true', 'TRUE'].map((value) => ({ name, value }))
    )
  )('does not send when $name=$value after metadata was collected', async ({ name, value }) => {
    const metadata = await createFeedbackMetadataAsync(PROJECT_ROOT);
    vi.stubEnv(name, value);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(sendFeedbackAsync({ feedback: VALID_FEEDBACK, metadata })).resolves.toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(TELEMETRY_DISABLED_MESSAGE);
  });

  it.each(['0', 'false', 'FALSE'])('still sends when both opt-out flags are %s', async (value) => {
    vi.stubEnv('DO_NOT_TRACK', value);
    vi.stubEnv('EXPO_NO_TELEMETRY', value);
    const metadata = await createFeedbackMetadataAsync(PROJECT_ROOT);

    expect(metadata).toHaveProperty('cli.name', 'agent-cli');
    await expect(sendFeedbackAsync({ feedback: VALID_FEEDBACK, metadata })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports the API error message on a failed submission', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ errors: [{ message: 'Feedback rate limit exceeded' }] }, { status: 429 })
    );

    await expect(
      sendFeedbackAsync({
        feedback: VALID_FEEDBACK,
        metadata: await createFeedbackMetadataAsync(PROJECT_ROOT),
      })
    ).rejects.toThrow('Feedback rate limit exceeded');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['not json', '{}', '{"errors":[{"message":42}]}'])(
    'falls back to the HTTP error when the response has no usable message: %s',
    async (body) => {
      fetchMock.mockResolvedValueOnce(
        new Response(body, { status: 503, statusText: 'Service Unavailable' })
      );

      await expect(
        sendFeedbackAsync({
          feedback: VALID_FEEDBACK,
          metadata: await createFeedbackMetadataAsync(PROJECT_ROOT),
        })
      ).rejects.toThrow('Failed to send feedback (503 Service Unavailable)');
    }
  );

  it.each([
    new TypeError('fetch failed'),
    new DOMException('The operation timed out', 'TimeoutError'),
  ])('reports a transport failure through the command error envelope: $name', async (error) => {
    fetchMock.mockRejectedValueOnce(error);

    await expect(
      sendFeedbackAsync({
        feedback: VALID_FEEDBACK,
        metadata: await createFeedbackMetadataAsync(PROJECT_ROOT),
      })
    ).rejects.toMatchObject({
      code: 'FEEDBACK_ERROR',
      message: `Failed to send feedback: ${error.message}`,
      suggestedCommand: expect.stringContaining(' feedback --help'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
