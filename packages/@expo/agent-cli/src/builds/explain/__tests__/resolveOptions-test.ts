// @ref llp/0012-build-explain.rfc.md §What ships, and what is reserved
// The resolver is pure — argv and two facts about the environment in, options out — so every
// combination a caller can type is asserted here, without a log and without a process.

import path from 'node:path';

import { DEFAULT_CONTEXT_AFTER, DEFAULT_CONTEXT_BEFORE } from '../extract';
import { resolveExplainOptions } from '../resolveOptions';

const cwd = path.resolve('/project');
const PIPED = { stdinIsTTY: false, cwd };
const TERMINAL = { stdinIsTTY: true, cwd };

describe('the input source', () => {
  it('reads the file the caller named, resolved against the working directory', () => {
    expect(resolveExplainOptions(['--file', 'logs/build.log'], TERMINAL).source).toEqual({
      kind: 'file',
      path: path.resolve(cwd, 'logs/build.log'),
    });
  });

  it('leaves an absolute path alone', () => {
    const absolute = path.resolve('/tmp/build.log');
    expect(resolveExplainOptions(['--file', absolute], TERMINAL).source).toEqual({
      kind: 'file',
      path: absolute,
    });
  });

  it('reads stdin when asked, even on a terminal', () => {
    expect(resolveExplainOptions(['--stdin'], TERMINAL).source).toEqual({ kind: 'stdin' });
  });

  it('implies --stdin when something is piping in', () => {
    // `npx expo run:ios 2>&1 | npx @expo/agent-cli inspect:build-log` is the shape the command is for, and
    // making the caller also type `--stdin` would be a flag that only ever has one value.
    expect(resolveExplainOptions([], PIPED).source).toEqual({ kind: 'stdin' });
  });

  it('refuses to wait on a stdin nobody will write to', () => {
    expect(() => resolveExplainOptions([], TERMINAL)).toThrow(/stdin is a terminal/);
  });

  it('refuses two sources rather than picking one', () => {
    expect(() => resolveExplainOptions(['--file', 'a.log', '--stdin'], PIPED)).toThrow(
      /--file a.log and --stdin were passed/
    );
  });
});

describe('--eas', () => {
  const BUILD_ID = '2f1c9f0e-6b1e-4a3d-9c1a-0b6f1e2d3c4a';

  it.each([
    ['--ios', 'ios'],
    ['--android', 'android'],
  ] as const)('reads the last errored %s build when no id is given', (flag, platform) => {
    expect(resolveExplainOptions(['--eas', flag], TERMINAL)).toMatchObject({
      source: { kind: 'eas', platform, buildId: null },
      platform,
    });
  });

  // `inspect:build-log <build-id>` is the command an agent reaches for, so the id alone is the
  // EAS form — no `--eas` needed beside it.
  it('reads the build the positional names, with or without --eas', () => {
    expect(resolveExplainOptions([BUILD_ID, '--ios'], TERMINAL).source).toEqual({
      kind: 'eas',
      platform: 'ios',
      buildId: BUILD_ID,
    });
    expect(resolveExplainOptions(['--eas', '--android', BUILD_ID], TERMINAL).source).toEqual({
      kind: 'eas',
      platform: 'android',
      buildId: BUILD_ID,
    });
  });

  it('needs a platform, and repeats the id in the line that works', () => {
    try {
      resolveExplainOptions([BUILD_ID], PIPED);
      throw new Error('expected a throw');
    } catch (error: any) {
      expect(error.code).toBe('BAD_ARGS');
      expect(error.message).toContain('--eas needs the platform');
      expect(error.suggestedCommand).toBe(
        `npx @expo/agent-cli inspect:build-log --eas --ios ${BUILD_ID}`
      );
    }
  });

  it('is one source among four, refused beside another', () => {
    expect(() => resolveExplainOptions(['--eas', '--ios', '--stdin'], PIPED)).toThrow(
      /--stdin and --eas were passed/
    );
    expect(() => resolveExplainOptions(['--file', 'a.log', BUILD_ID, '--ios'], PIPED)).toThrow(
      new RegExp(`--file a.log and the build id ${BUILD_ID} were passed`)
    );
  });

  it('reads one build id, not two', () => {
    expect(() => resolveExplainOptions([BUILD_ID, 'another', '--ios'], PIPED)).toThrow(
      /2 arguments were passed/
    );
  });
});

describe('the platform flags', () => {
  it.each([
    ['--ios', 'ios'],
    ['--android', 'android'],
  ])('reads %s, the spelling dev and smoke take', (flag, platform) => {
    expect(resolveExplainOptions([flag], PIPED).platform).toBe(platform);
  });

  it('is null when the caller named none, so every rule runs', () => {
    expect(resolveExplainOptions([], PIPED).platform).toBeNull();
  });

  it('refuses both at once, because a log is about one platform', () => {
    expect(() => resolveExplainOptions(['--ios', '--android'], PIPED)).toThrow(
      /Both --ios and --android/
    );
  });

  // Retired with no alias, and accepted only to say what replaced it.
  it.each([
    ['ios', '--ios'],
    ['Android', '--android'],
    ['web', '--ios or --android'],
  ])('answers the retired --platform %s with %s', (value, replacement) => {
    try {
      resolveExplainOptions(['--platform', value], PIPED);
      throw new Error('expected a throw');
    } catch (error: any) {
      expect(error.code).toBe('BAD_ARGS');
      expect(error.message).toContain('--platform is not an option of this command any more');
      expect(error.message).toContain(`the platform is ${replacement}`);
      expect(error.suggestedCommand).toBe('npx @expo/agent-cli inspect:build-log --help');
    }
  });
});

describe('--context', () => {
  it('defaults to more after the match than before it', () => {
    const options = resolveExplainOptions([], PIPED);
    expect(options.contextBefore).toBe(DEFAULT_CONTEXT_BEFORE);
    expect(options.contextAfter).toBe(DEFAULT_CONTEXT_AFTER);
  });

  it('takes one number for both sides', () => {
    expect(resolveExplainOptions(['--context', '12'], PIPED)).toMatchObject({
      contextBefore: 12,
      contextAfter: 12,
    });
  });

  it('takes two, so the asymmetry can be kept while the size changes', () => {
    expect(resolveExplainOptions(['--context', '4:40'], PIPED)).toMatchObject({
      contextBefore: 4,
      contextAfter: 40,
    });
  });

  it('accepts zero, which is the report with no context at all', () => {
    expect(resolveExplainOptions(['--context', '0'], PIPED)).toMatchObject({
      contextBefore: 0,
      contextAfter: 0,
    });
  });

  it.each(['lots', '4:', '1:2:3', ''])('refuses %p', (value) => {
    expect(() => resolveExplainOptions(['--context', value], PIPED)).toThrow(/is not a line count/);
  });

  it('refuses a negative, which the parser sees as another flag', () => {
    // `arg` reads `-3` as an option, so this arrives as "--context had no value" rather than as a
    // bad line count. Both are `BAD_ARGS` and both name `--context`, which is what a reader needs.
    expect(() => resolveExplainOptions(['--context', '-3'], PIPED)).toThrow(/--context/);
  });
});

describe('the rest of the flags', () => {
  it('defaults to a human report with follow-ups and one failure', () => {
    expect(resolveExplainOptions([], PIPED)).toMatchObject({
      all: false,
      json: false,
      followups: true,
    });
  });

  it('reads --all, --json and --no-followups', () => {
    expect(resolveExplainOptions(['--all', '--json', '--no-followups'], PIPED)).toMatchObject({
      all: true,
      json: true,
      followups: false,
    });
  });

  it('reads the short alias of --file', () => {
    expect(resolveExplainOptions(['-f', 'a.log', '--ios'], TERMINAL)).toMatchObject({
      source: { kind: 'file', path: path.resolve(cwd, 'a.log') },
      platform: 'ios',
    });
  });

  it('reports an unknown flag rather than ignoring it', () => {
    expect(() => resolveExplainOptions(['--bogus'], PIPED)).toThrow(/--bogus/);
  });
});

// @ref llp/0012-build-explain.rfc.md §What ships, and what is reserved
describe('--local', () => {
  const projectRoot = path.resolve('/app');
  const IN_PROJECT = { ...TERMINAL, projectRoot: () => projectRoot };

  it.each([
    ['--ios', 'ios'],
    ['--android', 'android'],
  ] as const)('reads the last %s build dev ran in this project', (flag, platform) => {
    expect(resolveExplainOptions(['--local', flag], IN_PROJECT)).toMatchObject({
      source: {
        kind: 'local',
        platform,
        path: path.join(projectRoot, '.expo', 'dev', 'logs', `build-${platform}.log`),
      },
      platform,
    });
  });

  // Required, not defaulted: a project builds for two, and a default would explain a build the
  // caller may not have meant.
  it('needs a platform, and names both', () => {
    try {
      resolveExplainOptions(['--local'], IN_PROJECT);
      throw new Error('expected a throw');
    } catch (error: any) {
      expect(error.code).toBe('BAD_ARGS');
      expect(error.message).toContain('--local needs the platform');
      expect(error.suggestedCommand).toBe('npx @expo/agent-cli inspect:build-log --local --ios');
    }
  });

  it('is one source among three, refused beside another', () => {
    expect(() =>
      resolveExplainOptions(['--local', '--ios', '--file', 'a.log'], IN_PROJECT)
    ).toThrow(/--file a.log and --local were passed/);
    expect(() => resolveExplainOptions(['--stdin', '--local', '--ios'], IN_PROJECT)).toThrow(
      /--stdin and --local were passed/
    );
  });

  it('asks for the project only when it is the source', () => {
    const projectRootResolver = vi.fn(() => projectRoot);
    resolveExplainOptions(['--file', 'a.log'], { ...TERMINAL, projectRoot: projectRootResolver });
    expect(projectRootResolver).not.toHaveBeenCalled();

    resolveExplainOptions(['--local', '--ios'], { ...TERMINAL, projectRoot: projectRootResolver });
    expect(projectRootResolver).toHaveBeenCalledTimes(1);
  });

  it('names --local among the ways to read a log when nothing was passed on a terminal', () => {
    expect(() => resolveExplainOptions([], TERMINAL)).toThrow(/--local --ios/);
  });
});
