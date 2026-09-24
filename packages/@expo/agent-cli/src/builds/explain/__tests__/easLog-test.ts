// @ref llp/0012-build-explain.rfc.md §What ships, and what is reserved
// The fetch eas-cli does not do: two `eas` questions and one download per log file, every step of
// which can fail and every failure of which names the `eas` command that shows the same thing.
import zlib from 'node:zlib';

import { resolveEasCliOrThrow } from '../../../utils/easCli';
import { spawnSubprocessAsync } from '../../../utils/subprocess';
import { decodeLogBytes, erroredBuildListArgs, fetchEasBuildLogAsync } from '../easLog';

vi.mock('../../../utils/subprocess', () => ({ spawnSubprocessAsync: vi.fn() }));
vi.mock('../../../utils/easCli', async () => ({
  ...(await vi.importActual('../../../utils/easCli')),
  resolveEasCliOrThrow: vi.fn(),
}));

const projectRoot = '/project';
const BUILD_ID = '2f1c9f0e-6b1e-4a3d-9c1a-0b6f1e2d3c4a';
const LOG_URL = 'https://storage.example/logs/xcodebuild.log.br?signed=1';

/** One `eas` answer per command word, in the order the calls arrive. */
function answerEas(
  answers: Record<string, { stdout?: string; exitCode?: number; stderr?: string }>
) {
  vi.mocked(spawnSubprocessAsync).mockImplementation(async (_command, args) => {
    const word = args.find((arg) => !arg.startsWith('-') && !arg.startsWith('eas-cli'))!;
    const answer = answers[word] ?? {};
    return {
      exitCode: answer.exitCode ?? 0,
      stdout: answer.stdout ?? '',
      stderr: answer.stderr ?? '',
    };
  });
}

function fetchAnswering(bodies: Record<string, Buffer | string>, status = 200): typeof fetch {
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    const body = bodies[url];
    const bytes = typeof body === 'string' ? Buffer.from(body) : (body ?? Buffer.alloc(0));
    return {
      ok: status >= 200 && status < 300,
      status,
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as Response;
  }) as unknown as typeof fetch;
}

const easCommands = () =>
  vi
    .mocked(spawnSubprocessAsync)
    .mock.calls.map(([, args]) =>
      args.find((arg) => !arg.startsWith('-') && !arg.startsWith('eas-cli'))
    );

beforeEach(() => {
  vi.mocked(resolveEasCliOrThrow).mockReturnValue({
    command: 'npx',
    prefixArgs: ['--yes', 'eas-cli@latest'],
    source: 'npx --yes eas-cli@latest',
    runner: 'npx',
    pinned: false,
  });
  vi.mocked(spawnSubprocessAsync).mockReset();
});

describe(fetchEasBuildLogAsync, () => {
  it(`should list the last errored build of the platform, view it, and download its log files`, async () => {
    answerEas({
      'build:list': {
        stdout: JSON.stringify([{ id: BUILD_ID, status: 'ERRORED', platform: 'IOS' }]),
      },
      'build:view': {
        stdout: JSON.stringify({
          id: BUILD_ID,
          platform: 'IOS',
          logFiles: [LOG_URL, `${LOG_URL}&part=2`],
        }),
      },
    });

    const log = await fetchEasBuildLogAsync(projectRoot, {
      platform: 'ios',
      buildId: null,
      fetchImpl: fetchAnswering({
        [LOG_URL]: 'first file\n',
        [`${LOG_URL}&part=2`]: 'second file',
      }),
    });

    expect(log).toEqual({
      buildId: BUILD_ID,
      platform: 'ios',
      logFiles: 2,
      text: 'first file\nsecond file\n',
    });
    expect(easCommands()).toEqual(['build:list', 'build:view']);
    expect(vi.mocked(spawnSubprocessAsync).mock.calls[0]![1]).toEqual([
      '--yes',
      'eas-cli@latest',
      ...erroredBuildListArgs('ios'),
    ]);
  });

  it(`should skip the listing when a build id was given`, async () => {
    answerEas({
      'build:view': {
        stdout: JSON.stringify({ id: BUILD_ID, platform: 'ANDROID', logFiles: [LOG_URL] }),
      },
    });

    const log = await fetchEasBuildLogAsync(projectRoot, {
      platform: 'android',
      buildId: BUILD_ID,
      fetchImpl: fetchAnswering({ [LOG_URL]: 'gradle says no\n' }),
    });

    expect(log.text).toBe('gradle says no\n');
    expect(easCommands()).toEqual(['build:view']);
  });

  it(`should decode a log file that arrived brotli-compressed with no header`, async () => {
    answerEas({
      'build:view': {
        stdout: JSON.stringify({ id: BUILD_ID, platform: 'IOS', logFiles: [LOG_URL] }),
      },
    });

    const log = await fetchEasBuildLogAsync(projectRoot, {
      platform: 'ios',
      buildId: BUILD_ID,
      fetchImpl: fetchAnswering({
        [LOG_URL]: zlib.brotliCompressSync(Buffer.from('error: boom\n')),
      }),
    });

    expect(log.text).toBe('error: boom\n');
  });

  it(`should refuse a build of the other platform, naming the flag that reads it`, async () => {
    answerEas({
      'build:view': {
        stdout: JSON.stringify({ id: BUILD_ID, platform: 'ANDROID', logFiles: [LOG_URL] }),
      },
    });

    await expect(
      fetchEasBuildLogAsync(projectRoot, {
        platform: 'ios',
        buildId: BUILD_ID,
        fetchImpl: fetchAnswering({}),
      })
    ).rejects.toMatchObject({
      code: 'EAS_BUILD_PLATFORM_MISMATCH',
      message: expect.stringContaining(`--eas --android ${BUILD_ID}`),
    });
  });

  it(`should say when EAS has no errored build of the platform`, async () => {
    answerEas({ 'build:list': { stdout: '[]' } });

    await expect(
      fetchEasBuildLogAsync(projectRoot, {
        platform: 'ios',
        buildId: null,
        fetchImpl: fetchAnswering({}),
      })
    ).rejects.toMatchObject({
      code: 'EAS_BUILD_NOT_FOUND',
      message: expect.stringContaining('no errored ios build'),
      suggestedCommand: expect.stringContaining('build:list --platform ios --status errored'),
    });
  });

  // @ref llp/0027-everything-on-eas.rfc.md §What EAS said — the refusal is rewritten in this
  // CLI's words, with the fix, rather than quoted by its first line.
  it(`should carry an eas refusal in this CLI's words`, async () => {
    answerEas({
      'build:list': {
        exitCode: 1,
        stdout:
          'EAS project not configured. This command cannot configure it in non-interactive mode. Run one of the following, then re-run this command:\n- eas init --account acme --non-interactive',
      },
    });

    await expect(
      fetchEasBuildLogAsync(projectRoot, {
        platform: 'ios',
        buildId: null,
        fetchImpl: fetchAnswering({}),
      })
    ).rejects.toMatchObject({
      code: 'EAS_BUILD_NOT_FOUND',
      message: expect.stringContaining('not linked to an EAS project'),
    });
  });

  it(`should say when the build has no log files`, async () => {
    answerEas({
      'build:view': { stdout: JSON.stringify({ id: BUILD_ID, platform: 'IOS', logFiles: [] }) },
    });

    await expect(
      fetchEasBuildLogAsync(projectRoot, {
        platform: 'ios',
        buildId: BUILD_ID,
        fetchImpl: fetchAnswering({}),
      })
    ).rejects.toMatchObject({
      code: 'EAS_BUILD_LOG_UNAVAILABLE',
      message: expect.stringContaining('no log files'),
    });
  });

  it(`should say when a log file could not be downloaded`, async () => {
    answerEas({
      'build:view': {
        stdout: JSON.stringify({ id: BUILD_ID, platform: 'IOS', logFiles: [LOG_URL] }),
      },
    });

    await expect(
      fetchEasBuildLogAsync(projectRoot, {
        platform: 'ios',
        buildId: BUILD_ID,
        fetchImpl: fetchAnswering({ [LOG_URL]: 'gone' }, 403),
      })
    ).rejects.toMatchObject({
      code: 'EAS_BUILD_LOG_UNAVAILABLE',
      message: expect.stringContaining('HTTP 403'),
    });
  });
});

describe(decodeLogBytes, () => {
  it(`should leave text alone and decode brotli`, () => {
    expect(decodeLogBytes(Buffer.from('plain\n'), BUILD_ID, 'ios', LOG_URL)).toBe('plain\n');
    expect(
      decodeLogBytes(zlib.brotliCompressSync(Buffer.from('packed\n')), BUILD_ID, 'ios', LOG_URL)
    ).toBe('packed\n');
  });

  it(`should refuse bytes that are neither`, () => {
    expect(() =>
      decodeLogBytes(Buffer.from([0, 1, 2, 3, 0, 0, 0, 0]), BUILD_ID, 'ios', LOG_URL)
    ).toThrow(/neither text nor brotli/);
  });
});
