// @ref llp/0012-build-explain.rfc.md
//
// `@expo/agent-cli inspect:build-log` at the process boundary, through the published bin. The unit suite pins
// what the extractor answers for each committed log; this pins the things only a real process
// shows — that `--json` is one parseable object, that a piped log is read off a real pipe with no
// TTY anywhere, that a report is exit 0 even when it located nothing, and that a log that could
// not be read is exit 1 with the `--json` error envelope.
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';

import { installStubEasAsync, stubEasArgs } from '../stubEas';

import {
  bin,
  collectOutput,
  executeAgentCliAsync,
  setupFixtureAsync,
  waitForExitAsync,
  type ExecuteResult,
} from '../utils';

/**
 * The unit fixtures, read from where they live rather than copied.
 *
 * One set of logs with one set of expectations: an e2e copy would be a second place for a fixture
 * to drift, and these are large enough that duplicating them is not free either.
 */
const LOG_FIXTURES = path.resolve(__dirname, '../../src/builds/explain/__tests__/fixtures');

function fixture(name: string): string {
  return path.join(LOG_FIXTURES, name);
}

/** The shape `inspect:build-log --json` prints, per `src/builds/explain/types.ts`. */
type ExplainReport = {
  source: {
    kind: 'file' | 'stdin';
    path: string | null;
    platform: 'ios' | 'android' | null;
    bytes: number;
    lines: number;
    truncated: boolean;
    droppedLines: number;
  };
  phases: {
    name: string;
    status: string;
    startLine: number;
    endLine: number;
  }[];
  failure: {
    phase: string;
    signature: string;
    line: number;
    message: string;
    matchedLine: string;
    context: { before: string[]; match: string; after: string[] };
    confidence: string;
    suggestedCommand: string | null;
    docsUrl: string | null;
  } | null;
  otherFailures: { signature: string; line: number }[];
  logTail: string;
  followups: { id: string; command: string; why: string }[];
};

/**
 * Run the CLI with a log written to its stdin, over a real pipe.
 *
 * The shared `spawnAgentCli` wires stdin to `ignore`, which is the right default for every other
 * command and is exactly what this one must not be tested with: `--stdin` reading `/dev/null`
 * would pass whatever the pipe handling did.
 */
async function pipeIntoAgentCliAsync(
  cwd: string,
  args: string[],
  input: string,
  env: Record<string, string> = {}
): Promise<ExecuteResult> {
  const { npm_config_minimum_release_age, ...processEnv } = process.env;
  const child: ChildProcess = spawn(process.execPath, [bin, ...args], {
    cwd,
    env: { ...processEnv, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = collectOutput(child);
  child.stdin!.end(input);
  return waitForExitAsync(child, output);
}

/** Every JSONL event of one run, as `2g` wrote them. */
function readEvents(eventsFile: string): Record<string, any>[] {
  return fs
    .readFileSync(eventsFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('@expo/agent-cli inspect:build-log --file', () => {
  it('reports the failure in a real xcodebuild log, and exits 0', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    const result = await executeAgentCliAsync(projectRoot, [
      'inspect:build-log',
      '--file',
      fixture('xcodebuild-pods-out-of-sync.log'),
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ios.pods.sandbox-out-of-sync');
    expect(result.stdout).toContain('xcodebuild');
    // The quoted line, from the log, with its number: the whole claim of the command is that
    // nothing has to be taken on trust.
    expect(result.stdout).toContain('231');
    expect(result.stdout).toContain('The sandbox is not in sync with the Podfile.lock');
    expect(result.stdout).toContain('npx pod-install --non-interactive');
  });

  it('prints exactly one JSON object under --json, with the progress on the event stream', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const eventsFile = path.join(projectRoot, 'events.jsonl');

    const result = await executeAgentCliAsync(
      projectRoot,
      ['inspect:build-log', '--file', fixture('metro-unresolved-module.log'), '--json'],
      { env: { LOG_EVENTS: eventsFile } }
    );

    // One object and nothing else: a `JSON.parse` of the whole stream is the assertion.
    const report: ExplainReport = JSON.parse(result.stdout);
    expect(result.stdout.trim().startsWith('{')).toBe(true);
    expect(result.stdout.trim().endsWith('}')).toBe(true);
    // The follow-up section is a terminal affordance and stays off stdout here.
    expect(result.stdout).not.toContain('Suggested next:');

    expect(report.failure).toMatchObject({
      phase: 'bundle-js',
      signature: 'bundle.unresolved-module',
      confidence: 'high',
    });
    expect(report.source).toMatchObject({ kind: 'file', truncated: false });
    // Real ANSI in the recording, and none of it in the payload.
    expect(JSON.stringify(report)).not.toMatch(/\[/);

    const events = readEvents(eventsFile);
    expect(events.find((entry) => entry._e === 'cli:build_explain')).toMatchObject({
      source: 'file',
      signature: 'bundle.unresolved-module',
      confidence: 'high',
    });
  });

  it('suggests a re-run that actually runs', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const logPath = fixture('gradle-kotlin-compile-error.log');

    const first: ExplainReport = JSON.parse(
      (await executeAgentCliAsync(projectRoot, ['inspect:build-log', '--file', logPath, '--json']))
        .stdout
    );
    const rerun = first.followups.find((followup) => followup.id === 'explain-all')!;

    // A follow-up is the next thing to *run* (llp/0009), so the suggested command is executed
    // here rather than pattern-matched: a rung that dropped `--file` would read this run's stdin
    // and fail with BAD_ARGS, and a substring assertion would not notice.
    expect(rerun.command).toContain(logPath);
    const args = rerun.command.replace(/^npx @expo\/agent-cli /, '').split(' ');
    const result = await executeAgentCliAsync(projectRoot, [...args, '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).otherFailures.length).toBeGreaterThan(0);
  });

  it('exits 0 with failure: null for a log that holds no failure', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    // A pod install that printed eight `[!]` warnings and succeeded. "No error located" is a
    // report, and a report is exit 0 (llp/0012 §Exit codes).
    const result = await executeAgentCliAsync(projectRoot, [
      'inspect:build-log',
      '--file',
      fixture('no-failure-successful-pod-install.log'),
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    const report: ExplainReport = JSON.parse(result.stdout);
    expect(report.failure).toBeNull();
    expect(report.logTail.length).toBeGreaterThan(0);
  });

  it('lists the other matches only when --all is passed', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const args = [
      'inspect:build-log',
      '--file',
      fixture('gradle-kotlin-compile-error.log'),
      '--json',
    ];

    const plain: ExplainReport = JSON.parse((await executeAgentCliAsync(projectRoot, args)).stdout);
    const all: ExplainReport = JSON.parse(
      (await executeAgentCliAsync(projectRoot, [...args, '--all'])).stdout
    );

    expect(plain.otherFailures).toEqual([]);
    expect(all.otherFailures.length).toBeGreaterThan(0);
    expect(all.failure!.signature).toBe('android.kotlin.compile-error');
  });
});

describe('@expo/agent-cli inspect:build-log --stdin', () => {
  it('reads a log off a pipe, with no TTY anywhere', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const log = fs.readFileSync(fixture('npm-package-not-found.log'), 'utf8');

    const result = await pipeIntoAgentCliAsync(
      projectRoot,
      ['inspect:build-log', '--stdin', '--json'],
      log
    );

    expect(result.exitCode).toBe(0);
    const report: ExplainReport = JSON.parse(result.stdout);
    expect(report.source).toMatchObject({ kind: 'stdin', path: null });
    expect(report.failure).toMatchObject({
      phase: 'install-dependencies',
      signature: 'deps.package-not-found',
    });
  });

  it('implies --stdin when something is piping in and no source was named', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const log = fs.readFileSync(fixture('gradle-duplicate-class.log'), 'utf8');

    const result = await pipeIntoAgentCliAsync(projectRoot, ['inspect:build-log', '--json'], log);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).failure.signature).toBe('android.gradle.duplicate-class');
  });

  it('reads a log arriving in many small writes', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const log = fs.readFileSync(fixture('xcodebuild-swift-compile-error.log'), 'utf8');

    // A chunk boundary lands in the middle of a line here, which is what a real subprocess pipe
    // does and what a naive reader gets wrong.
    const { npm_config_minimum_release_age, ...processEnv } = process.env;
    const child = spawn(process.execPath, [bin, 'inspect:build-log', '--stdin', '--json'], {
      cwd: projectRoot,
      env: { ...processEnv, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = collectOutput(child);
    for (let offset = 0; offset < log.length; offset += 37) {
      child.stdin!.write(log.slice(offset, offset + 37));
    }
    child.stdin!.end();
    const result = await waitForExitAsync(child, output);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).failure.signature).toBe('ios.swift.compile-error');
  });

  it('exits 1 when nothing arrives, rather than reporting a clean log', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    // The shared runner wires stdin to `ignore`, so this is a run with stdin at EOF and no TTY —
    // exactly the "the log never arrived" case.
    const result = await executeAgentCliAsync(projectRoot, ['inspect:build-log', '--json'], {
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: 'EMPTY_LOG',
    });
    expect(result.stderr).toContain('An empty log is not a log with no errors in it');
  });
});

// @ref llp/0012-build-explain.rfc.md §What ships, and what is reserved
// `--local` reads the log `dev` wrote for the last native build of one platform.
describe('@expo/agent-cli inspect:build-log --local', () => {
  /** A project whose last iOS build `dev` wrote a log for, planted from a captured fixture. */
  async function setupWithBuildLogAsync(platform: 'ios' | 'android', log: string): Promise<string> {
    const projectRoot = await setupFixtureAsync('go-app');
    const logDir = path.join(projectRoot, '.expo', 'dev', 'logs');
    await fs.promises.mkdir(logDir, { recursive: true });
    await fs.promises.copyFile(fixture(log), path.join(logDir, `build-${platform}.log`));
    return projectRoot;
  }

  it('reports the failure in the last build dev ran for the platform, and says where it read it', async () => {
    const projectRoot = await setupWithBuildLogAsync('ios', 'xcodebuild-no-profile.log');

    const result = await executeAgentCliAsync(projectRoot, [
      'inspect:build-log',
      '--local',
      '--ios',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.source).toMatchObject({ kind: 'local', platform: 'ios' });
    // The path as the CLI resolved the project, which on macOS is the real path of the temp dir.
    expect(report.source.path).toMatch(/[\\/]\.expo[\\/]dev[\\/]logs[\\/]build-ios\.log$/);
    expect(report.failure).not.toBeNull();
    expect(
      report.followups.map((followup: { command: string }) => followup.command)
    ).toContainEqual(expect.stringContaining('inspect:build-log --local --ios'));
  });

  it('names the file and the platform on the human report', async () => {
    const projectRoot = await setupWithBuildLogAsync('android', 'npm-peer-conflict.log');

    const result = await executeAgentCliAsync(projectRoot, [
      'inspect:build-log',
      '--local',
      '--android',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('build-android.log');
    expect(result.stdout).toContain('the last android build dev ran here');
  });

  it('exits 1 naming dev when the project has no build log for the platform', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    const result = await executeAgentCliAsync(
      projectRoot,
      ['inspect:build-log', '--local', '--ios'],
      {
        reject: false,
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no ios build log');
    expect(result.stderr).toContain('npx @expo/agent-cli dev --ios');
  });

  it('needs a platform, and says which two', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    const result = await executeAgentCliAsync(projectRoot, ['inspect:build-log', '--local'], {
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--local needs the platform');
    expect(result.stderr).toContain('--local --android');
  });

  it('is refused beside --file, because a report is about one log', async () => {
    const projectRoot = await setupWithBuildLogAsync('ios', 'xcodebuild-no-profile.log');

    const result = await executeAgentCliAsync(
      projectRoot,
      ['inspect:build-log', '--local', '--ios', '--file', fixture('npm-peer-conflict.log')],
      { reject: false }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--local were passed');
  });
});

// @ref llp/0012-build-explain.rfc.md §What ships, and what is reserved
// `--eas` reads an EAS build's log the way eas-cli does not offer to: `build:list` names the last
// errored build, `build:view` names its log files, and this CLI downloads them. The files here come
// off a local server, plain or brotli-compressed the way EAS serves them.
describe('@expo/agent-cli inspect:build-log --eas', () => {
  const BUILD_ID = '2f1c9f0e-6b1e-4a3d-9c1a-0b6f1e2d3c4a';
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  /** A server that answers `/plain`, `/br` (raw brotli bytes) and `/br-encoded` (with the header). */
  async function serveLogAsync(log: string): Promise<string> {
    const bytes = fs.readFileSync(fixture(log));
    server = createServer((request, response) => {
      if (request.url === '/plain') {
        response.writeHead(200, { 'content-type': 'text/plain' }).end(bytes);
      } else if (request.url === '/br') {
        response
          .writeHead(200, { 'content-type': 'application/octet-stream' })
          .end(zlib.brotliCompressSync(bytes));
      } else if (request.url === '/br-encoded') {
        response
          .writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'br' })
          .end(zlib.brotliCompressSync(bytes));
      } else if (request.url === '/empty') {
        response.writeHead(200).end('');
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  /** A linked project with the stub `eas` pinned, so the resolver finds it without a network. */
  async function setupWithEasAsync(): Promise<string> {
    const projectRoot = await setupFixtureAsync('go-app');
    await installStubEasAsync(projectRoot);
    const manifestPath = path.join(projectRoot, 'package.json');
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
    manifest.devDependencies = { ...manifest.devDependencies, 'eas-cli': '^22.0.0' };
    await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    return projectRoot;
  }

  /** What the stub `eas` was asked, as command words. */
  function easWords(projectRoot: string): string[] {
    return stubEasArgs(projectRoot).map((args) => args[0]!);
  }

  const ERRORED_IOS = JSON.stringify([{ id: BUILD_ID, status: 'ERRORED', platform: 'IOS' }]);

  it('reads the last errored build of the platform, fetching its log files', async () => {
    const projectRoot = await setupWithEasAsync();
    const origin = await serveLogAsync('xcodebuild-no-profile.log');

    const result = await executeAgentCliAsync(
      projectRoot,
      ['inspect:build-log', '--eas', '--ios', '--json'],
      {
        env: {
          STUB_EAS_BUILDS: ERRORED_IOS,
          STUB_EAS_BUILD_VIEW_LOG_FILES: JSON.stringify([`${origin}/plain`]),
        },
      }
    );

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.source).toMatchObject({
      kind: 'eas',
      path: null,
      buildId: BUILD_ID,
      logFiles: 1,
      platform: 'ios',
    });
    expect(report.failure).not.toBeNull();
    expect(easWords(projectRoot)).toEqual(['build:list', 'build:view']);
    expect(stubEasArgs(projectRoot)[0]).toEqual([
      'build:list',
      '--platform',
      'ios',
      '--status',
      'errored',
      '--limit',
      '1',
      '--json',
      '--non-interactive',
    ]);
    // The re-run names the build by id: "the last errored build" moves.
    expect(
      report.followups.map((followup: { command: string }) => followup.command)
    ).toContainEqual(expect.stringContaining(`inspect:build-log --eas --ios ${BUILD_ID}`));
  });

  it('reads the build an id names without listing, --eas implied by the id', async () => {
    const projectRoot = await setupWithEasAsync();
    const origin = await serveLogAsync('npm-peer-conflict.log');

    const result = await executeAgentCliAsync(
      projectRoot,
      ['inspect:build-log', '--android', BUILD_ID],
      {
        env: {
          STUB_EAS_BUILD_VIEW_PLATFORM: 'ANDROID',
          STUB_EAS_BUILD_VIEW_LOG_FILES: JSON.stringify([`${origin}/plain`]),
        },
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`EAS build ${BUILD_ID}`);
    expect(result.stdout).toContain('1 log file, fetched from EAS');
    expect(easWords(projectRoot)).toEqual(['build:view']);
  });

  // EAS serves the files brotli-compressed. A body the response declares as such is decoded by
  // the fetch; one stored compressed with no header arrives as bytes, and is decoded here rather
  // than refused the way a `--file` of the same bytes is (llp/0012 §Is this a log at all).
  it.each([['/br-encoded'], ['/br']])(
    'decodes a log file served brotli-compressed at %s',
    async (route) => {
      const projectRoot = await setupWithEasAsync();
      const origin = await serveLogAsync('xcodebuild-no-profile.log');

      const result = await executeAgentCliAsync(
        projectRoot,
        ['inspect:build-log', '--ios', BUILD_ID, '--json'],
        {
          env: { STUB_EAS_BUILD_VIEW_LOG_FILES: JSON.stringify([`${origin}${route}`]) },
        }
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).failure).not.toBeNull();
    }
  );

  it('reads several log files as one log, in order', async () => {
    const projectRoot = await setupWithEasAsync();
    const origin = await serveLogAsync('xcodebuild-no-profile.log');

    const result = await executeAgentCliAsync(
      projectRoot,
      ['inspect:build-log', '--ios', BUILD_ID, '--json'],
      {
        env: {
          STUB_EAS_BUILD_VIEW_LOG_FILES: JSON.stringify([`${origin}/plain`, `${origin}/plain`]),
        },
      }
    );

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.source.logFiles).toBe(2);
    expect(report.source.lines).toBe(
      2 * fs.readFileSync(fixture('xcodebuild-no-profile.log'), 'utf8').trimEnd().split('\n').length
    );
  });

  it('exits 1 when EAS has no errored build of the platform', async () => {
    const projectRoot = await setupWithEasAsync();

    const result = await executeAgentCliAsync(
      projectRoot,
      ['inspect:build-log', '--eas', '--ios'],
      {
        env: { STUB_EAS_BUILDS: '[]' },
        reject: false,
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no errored ios build');
    expect(result.stderr).toContain('build:list --platform ios --status errored');
  });

  it('exits 1 when the build has no log files', async () => {
    const projectRoot = await setupWithEasAsync();

    const result = await executeAgentCliAsync(
      projectRoot,
      ['inspect:build-log', '--ios', BUILD_ID],
      {
        reject: false,
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`EAS build ${BUILD_ID} has no log files`);
  });

  it('exits 1 naming the other platform when the build is not for the one asked', async () => {
    const projectRoot = await setupWithEasAsync();
    const origin = await serveLogAsync('npm-peer-conflict.log');

    const result = await executeAgentCliAsync(
      projectRoot,
      ['inspect:build-log', '--ios', BUILD_ID],
      {
        env: {
          STUB_EAS_BUILD_VIEW_PLATFORM: 'ANDROID',
          STUB_EAS_BUILD_VIEW_LOG_FILES: JSON.stringify([`${origin}/plain`]),
        },
        reject: false,
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`is an android build`);
    expect(result.stderr).toContain(`--eas --android ${BUILD_ID}`);
  });

  it('exits 1 when a log file cannot be downloaded', async () => {
    const projectRoot = await setupWithEasAsync();
    const origin = await serveLogAsync('npm-peer-conflict.log');

    const result = await executeAgentCliAsync(
      projectRoot,
      ['inspect:build-log', '--ios', BUILD_ID],
      {
        env: { STUB_EAS_BUILD_VIEW_LOG_FILES: JSON.stringify([`${origin}/missing`]) },
        reject: false,
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('could not be read: HTTP 404');
  });

  // @ref llp/0027-everything-on-eas.rfc.md §What EAS said
  it("carries an unlinked project's refusal in this CLI's words", async () => {
    const projectRoot = await setupWithEasAsync();

    const result = await executeAgentCliAsync(
      projectRoot,
      ['inspect:build-log', '--eas', '--ios'],
      {
        env: {
          STUB_EAS_BUILD_LIST_EXIT: '1',
          STUB_EAS_BUILD_LIST_STDOUT:
            'EAS project not configured. This command cannot configure it in non-interactive mode. Run one of the following, then re-run this command:\n- eas init --account acme --non-interactive',
        },
        reject: false,
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not linked to an EAS project');
  });

  it('needs a platform', async () => {
    const projectRoot = await setupWithEasAsync();

    const result = await executeAgentCliAsync(projectRoot, ['inspect:build-log', '--eas'], {
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--eas needs the platform');
  });

  it('is refused beside --local, because a report is about one log', async () => {
    const projectRoot = await setupWithEasAsync();

    const result = await executeAgentCliAsync(
      projectRoot,
      ['inspect:build-log', '--eas', '--local', '--ios'],
      {
        reject: false,
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--local and --eas were passed');
  });
});

// @ref llp/0012-build-explain.rfc.md §Summary — the meaningful portion, rule or no rule.
describe('the error lines of the failing phase', () => {
  it('carries them in --json beside the located failure', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    const result = await executeAgentCliAsync(projectRoot, [
      'inspect:build-log',
      '--file',
      fixture('xcodebuild-no-profile.log'),
      '--ios',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    const report: ExplainReport & { errorLines: { line: number; text: string }[] } = JSON.parse(
      result.stdout
    );
    expect(report.errorLines.length).toBeGreaterThan(0);
    expect(report.errorLines.map((entry) => entry.line)).toContain(report.failure!.line);
  });

  it('prints the rest of them under the located failure, numbered like the context', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    const result = await executeAgentCliAsync(projectRoot, [
      'inspect:build-log',
      '--file',
      fixture('gradle-duplicate-class.log'),
      '--android',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Other lines that read like errors in this phase \(\d+/);
  });

  it('prints them in place of the raw tail when no rule matched but the tool marked errors', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const logPath = path.join(projectRoot, 'unknown-failure.log');
    await fs.promises.writeFile(
      logPath,
      [
        'Command line invocation:',
        '    /usr/bin/xcodebuild -workspace App.xcworkspace',
        'ld: error: undefined symbol: _OBJC_CLASS_$_Nope',
        'ld: error: 1 duplicate symbol for architecture arm64',
        'the build stopped',
        '',
      ].join('\n')
    );

    const result = await executeAgentCliAsync(projectRoot, [
      'inspect:build-log',
      '--file',
      logPath,
      '--ios',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('none located');
    expect(result.stdout).toContain('The lines that read like errors in the last phase (2)');
    expect(result.stdout).toContain('undefined symbol');
    expect(result.stdout).not.toContain('The last lines of the log');
  });
});

// Every way a log reaches this command, for each platform: the same report shape comes back, and
// the platform the caller named is on it. The details of each source have their own describes.
describe('every calling path, on both platforms', () => {
  const PLATFORMS = ['ios', 'android'] as const;
  const BUILD_ID = '2f1c9f0e-6b1e-4a3d-9c1a-0b6f1e2d3c4a';

  async function expectReport(
    result: { exitCode: number | null; stdout: string },
    kind: string,
    platform: string
  ) {
    expect(result.exitCode).toBe(0);
    const report: ExplainReport = JSON.parse(result.stdout);
    expect(report.source).toMatchObject({ kind, platform });
    expect(Object.keys(report)).toEqual([
      'source',
      'phases',
      'failure',
      'otherFailures',
      'errorLines',
      'logTail',
      'followups',
    ]);
  }

  it.each(PLATFORMS)('--file --%s', async (platform) => {
    const projectRoot = await setupFixtureAsync('go-app');
    const result = await executeAgentCliAsync(projectRoot, [
      'inspect:build-log',
      '--file',
      fixture('npm-peer-conflict.log'),
      `--${platform}`,
      '--json',
    ]);
    await expectReport(result, 'file', platform);
  });

  it.each(PLATFORMS)('--stdin --%s', async (platform) => {
    const projectRoot = await setupFixtureAsync('go-app');
    const result = await pipeIntoAgentCliAsync(
      projectRoot,
      ['inspect:build-log', '--stdin', `--${platform}`, '--json'],
      fs.readFileSync(fixture('npm-peer-conflict.log'), 'utf8')
    );
    await expectReport(result, 'stdin', platform);
  });

  it.each(PLATFORMS)('--local --%s', async (platform) => {
    const projectRoot = await setupFixtureAsync('go-app');
    const logDir = path.join(projectRoot, '.expo', 'dev', 'logs');
    await fs.promises.mkdir(logDir, { recursive: true });
    await fs.promises.copyFile(
      fixture('npm-peer-conflict.log'),
      path.join(logDir, `build-${platform}.log`)
    );
    const result = await executeAgentCliAsync(projectRoot, [
      'inspect:build-log',
      '--local',
      `--${platform}`,
      '--json',
    ]);
    await expectReport(result, 'local', platform);
  });

  it.each(PLATFORMS)('--eas --%s, by id', async (platform) => {
    const projectRoot = await setupFixtureAsync('go-app');
    await installStubEasAsync(projectRoot);
    const manifestPath = path.join(projectRoot, 'package.json');
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
    manifest.devDependencies = { ...manifest.devDependencies, 'eas-cli': '^22.0.0' };
    await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const bytes = fs.readFileSync(fixture('npm-peer-conflict.log'));
    const server = createServer((_request, response) => response.writeHead(200).end(bytes));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const result = await executeAgentCliAsync(
        projectRoot,
        ['inspect:build-log', `--${platform}`, BUILD_ID, '--json'],
        {
          env: {
            STUB_EAS_BUILD_VIEW_PLATFORM: platform.toUpperCase(),
            STUB_EAS_BUILD_VIEW_LOG_FILES: JSON.stringify([`${origin}/log`]),
          },
        }
      );
      await expectReport(result, 'eas', platform);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('when no report can be produced', () => {
  it('exits 1 with the --json error envelope for a file that is not there', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const eventsFile = path.join(projectRoot, 'events.jsonl');

    const result = await executeAgentCliAsync(
      projectRoot,
      ['inspect:build-log', '--file', path.join(projectRoot, 'nope.log'), '--json'],
      { reject: false, env: { LOG_EVENTS: eventsFile } }
    );

    expect(result.exitCode).toBe(1);
    // Under `--json` the caller has committed to parsing stdout, so a failure prints one object
    // there too (llp/0010 §The `--json` error envelope).
    expect(JSON.parse(result.stdout)).toEqual({
      error: {
        code: 'LOG_UNREADABLE',
        message: expect.stringContaining('there is nothing at that path'),
        suggestedCommand: 'npx @expo/agent-cli inspect:build-log --help',
        needsHuman: null,
        data: null,
      },
    });

    const events = readEvents(eventsFile);
    expect(events.find((entry) => entry._e === 'cli:error')).toMatchObject({
      code: 'LOG_UNREADABLE',
      suggestedCommand: 'npx @expo/agent-cli inspect:build-log --help',
    });
  });

  // The bare build id is the EAS form, and it needs the platform like every EAS read does.
  it('takes a build id as the EAS form, and asks for the platform it is missing', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const buildId = '2f1c9f0e-6b1e-4a3d-9c1a-0b6f1e2d3c4a';

    const result = await executeAgentCliAsync(projectRoot, ['inspect:build-log', buildId], {
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--eas needs the platform');
    expect(result.stderr).toContain(
      `Try: npx @expo/agent-cli inspect:build-log --eas --ios ${buildId}`
    );
  });

  // The platform is `--ios` / `--android`, the spelling `dev` and `smoke` take. `--platform` was
  // this command's own spelling and is gone, with an answer that names the replacement.
  it('takes --ios as the platform hint, and carries it in the report', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    const result = await executeAgentCliAsync(projectRoot, [
      'inspect:build-log',
      '--file',
      fixture('npm-peer-conflict.log'),
      '--ios',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).source.platform).toBe('ios');
  });

  it('answers the retired --platform with the flag that replaced it', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    const result = await executeAgentCliAsync(
      projectRoot,
      ['inspect:build-log', '--file', fixture('npm-peer-conflict.log'), '--platform', 'android'],
      { reject: false }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--platform is not an option of this command any more');
    expect(result.stderr).toContain('the platform is --android');
  });

  it('reports an unknown flag rather than ignoring it', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    const result = await executeAgentCliAsync(
      projectRoot,
      ['inspect:build-log', '--file', fixture('npm-peer-conflict.log'), '--bogus'],
      { reject: false }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--bogus');
  });
});

describe('the registry', () => {
  // @ref llp/0016-v1-scope.rfc.md §Experimental is per command
  // Wave 36 graduated this action and kept the one beside it, so the group listing is where the
  // per-command rule is visible at the process boundary: one line tagged, one not, one footnote.
  it('lists inspect:build-log in the group, untagged beside the action that kept the tag', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    const result = await executeAgentCliAsync(projectRoot, ['inspect', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('inspect:build-log');
    expect(result.stdout).not.toMatch(/build-log.*\[experimental\]/);
    expect(result.stdout).toMatch(/config-plugins.*\[experimental\]/);
    expect(result.stdout).toContain('experimental commands may change or vanish');
  });

  // The bare verb belongs to the EAS CLI, and this one never wrapped it (llp/0016).
  it('answers the bare build verb with the CLI that does start a build', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    const result = await executeAgentCliAsync(projectRoot, ['build', '--platform', 'ios'], {
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.all).toContain('npx --yes eas-cli@latest build');
    expect(result.all).toContain('npx @expo/agent-cli inspect:build-log');
  });

  it('prints usage for --help without reading anything', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    const result = await executeAgentCliAsync(projectRoot, ['inspect:build-log', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--file <path>');
    expect(result.stdout).toContain('--stdin');
    // The two sources that fetch a log for the caller, documented where a caller looks first.
    expect(result.stdout).toContain('--local');
    expect(result.stdout).toContain('--eas [<build-id>]');
  });
});

// @ref llp/0012-build-explain.rfc.md §Is this a log at all — live run S8.
//
// An EAS build log fetched without decoding its brotli body was read as a clean build: exit 0,
// `failure: null`, and ten kilobytes of control characters in `logTail`.
describe('input that is not a log', () => {
  /** High-entropy bytes with no line structure, which is what an undecoded brotli body is. */
  function compressedBytes(): Buffer {
    return Buffer.from(Array.from({ length: 4000 }, (_unused, index) => index % 256));
  }

  it(`exits 22 and reports no failure at all, rather than a clean build`, async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const file = path.join(projectRoot, 'build.log.br');
    await fs.promises.writeFile(file, compressedBytes());

    const result = await executeAgentCliAsync(
      projectRoot,
      ['inspect:build-log', '--file', file, '--json'],
      { reject: false }
    );

    expect(result.exitCode).toBe(22);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.error.code).toBe('LOG_NOT_TEXT');
    expect(envelope.error.message).toMatch(/brotli/i);
  });

  it(`puts none of the bytes it refused on either stream`, async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const file = path.join(projectRoot, 'binary.log');
    await fs.promises.writeFile(file, compressedBytes());

    const result = await executeAgentCliAsync(projectRoot, ['inspect:build-log', '--file', file], {
      reject: false,
    });

    // Nothing but the message: no NUL, no escape sequences, nothing a terminal would act on.
    const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
    // Colour is off on a pipe, so any escape byte here would be one that came from the input.
    expect(control.test(result.stdout)).toBe(false);
    expect(control.test(result.stderr)).toBe(false);
    expect(result.stderr).toContain('is not a build log');
  });
});
