import packageJson from '../../../package.json';
import { printCommandHelp } from '../../help/format';
import { recordCommand } from '../../telemetry';
import { agentCliFeedback } from '..';
import {
  createFeedbackMetadataAsync,
  getSession,
  isTelemetryDisabled,
  sendFeedbackAsync,
} from '../feedbackAsync';
import type { CliFeedbackMetadata } from '../types';

vi.mock('../../help/format', () => ({ printCommandHelp: vi.fn() }));
vi.mock('../../telemetry', () => ({ recordCommand: vi.fn() }));
vi.mock('../feedbackAsync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../feedbackAsync')>()),
  createFeedbackMetadataAsync: vi.fn(),
  getSession: vi.fn(),
  sendFeedbackAsync: vi.fn(),
}));

const message = 'Please improve how error messages explain actionable next steps.';
const metadata: CliFeedbackMetadata = { category: 'unknown', feedbackId: 'feedback-session' };

beforeEach(() => {
  vi.stubEnv('DO_NOT_TRACK', undefined);
  vi.stubEnv('EXPO_NO_TELEMETRY', undefined);
  vi.stubEnv('EXPO_OFFLINE', undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(createFeedbackMetadataAsync).mockResolvedValue(metadata);
  vi.mocked(getSession).mockReturnValue(null);
  vi.mocked(sendFeedbackAsync).mockImplementation(async () => !isTelemetryDisabled());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it('records one command event after metadata evaluation and before submission', async () => {
  vi.mocked(createFeedbackMetadataAsync).mockImplementation(async () => {
    expect(recordCommand).not.toHaveBeenCalled();
    return metadata;
  });
  vi.mocked(sendFeedbackAsync).mockImplementation(async () => {
    expect(recordCommand).toHaveBeenCalledExactlyOnceWith('feedback', packageJson.version);
    return true;
  });

  await agentCliFeedback(['--message', message, '--json']);

  expect(createFeedbackMetadataAsync).toHaveBeenCalledOnce();
  expect(sendFeedbackAsync).toHaveBeenCalledExactlyOnceWith({
    feedback: message,
    metadata,
    session: null,
  });
  expect(console.log).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ sent: true, feedbackId: metadata.feedbackId })
  );
});

it.each(['DO_NOT_TRACK', 'EXPO_NO_TELEMETRY'])(
  'skips command telemetry when project config enables %s',
  async (name) => {
    vi.mocked(createFeedbackMetadataAsync).mockImplementation(async () => {
      vi.stubEnv(name, 'true');
      return metadata;
    });

    await agentCliFeedback(['--message', message, '--json']);

    expect(recordCommand).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ sent: false, feedbackId: null })
    );
  }
);

it.each(['DO_NOT_TRACK', 'EXPO_NO_TELEMETRY'])(
  'skips metadata, command telemetry, and submission when %s is already enabled',
  async (name) => {
    vi.stubEnv(name, '1');

    await agentCliFeedback(['--message', message, '--json']);

    expect(createFeedbackMetadataAsync).not.toHaveBeenCalled();
    expect(recordCommand).not.toHaveBeenCalled();
    expect(sendFeedbackAsync).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ sent: false, feedbackId: null })
    );
  }
);

it.each(['0', 'false'])(
  'records telemetry when config sets false opt-out values: %s',
  async (value) => {
    vi.mocked(createFeedbackMetadataAsync).mockImplementation(async () => {
      vi.stubEnv('DO_NOT_TRACK', value);
      vi.stubEnv('EXPO_NO_TELEMETRY', value);
      return metadata;
    });

    await agentCliFeedback(['--message', message]);

    expect(recordCommand).toHaveBeenCalledExactlyOnceWith('feedback', packageJson.version);
    expect(sendFeedbackAsync).toHaveBeenCalledOnce();
  }
);

it.each([
  { argv: ['--message', message, '--dry-run'] },
  { argv: ['--message', message, '--catgory', 'skills'] },
  { argv: [message, '--unknown'] },
])('rejects unknown options before telemetry or submission: $argv', async ({ argv }) => {
  await expect(agentCliFeedback(argv)).rejects.toMatchObject({ code: 'BAD_ARGS' });

  expect(createFeedbackMetadataAsync).not.toHaveBeenCalled();
  expect(recordCommand).not.toHaveBeenCalled();
  expect(sendFeedbackAsync).not.toHaveBeenCalled();
});

it('retains positional messages with a deprecation warning', async () => {
  await agentCliFeedback([message]);

  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('positional argument'));
  expect(recordCommand).toHaveBeenCalledExactlyOnceWith('feedback', packageJson.version);
  expect(sendFeedbackAsync).toHaveBeenCalledWith({ feedback: message, metadata, session: null });
});

it.each([
  { argv: ['--message', 'too short'] },
  { argv: ['--message', message, '--category', 'not-a-category'] },
  { argv: ['--message', message, message] },
])('rejects invalid feedback before telemetry or submission: $argv', async ({ argv }) => {
  await expect(agentCliFeedback(argv)).rejects.toMatchObject({ code: 'FEEDBACK_ERROR' });

  expect(createFeedbackMetadataAsync).not.toHaveBeenCalled();
  expect(recordCommand).not.toHaveBeenCalled();
  expect(sendFeedbackAsync).not.toHaveBeenCalled();
});

it('does not record or submit feedback when help exits', async () => {
  const helpExit = new Error('help exited');
  vi.mocked(printCommandHelp).mockImplementation(() => {
    throw helpExit;
  });

  await expect(agentCliFeedback(['--help'])).rejects.toBe(helpExit);

  expect(printCommandHelp).toHaveBeenCalledOnce();
  expect(createFeedbackMetadataAsync).not.toHaveBeenCalled();
  expect(recordCommand).not.toHaveBeenCalled();
  expect(sendFeedbackAsync).not.toHaveBeenCalled();
});

it('does not record or submit feedback for version', async () => {
  await agentCliFeedback(['--version']);

  expect(console.log).toHaveBeenCalledExactlyOnceWith(packageJson.version);
  expect(createFeedbackMetadataAsync).not.toHaveBeenCalled();
  expect(recordCommand).not.toHaveBeenCalled();
  expect(sendFeedbackAsync).not.toHaveBeenCalled();
});
