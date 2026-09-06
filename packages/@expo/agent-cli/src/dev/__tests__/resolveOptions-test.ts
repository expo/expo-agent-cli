import { DEFAULT_DETACH_TIMEOUT_MS } from '../detachAsync';
import { resolveDevOptions } from '../resolveOptions';

describe(resolveDevOptions, () => {
  it(`should forward every argument the plan engine does not own`, () => {
    expect(resolveDevOptions(['--web', '--port', '8082'])).toEqual({
      mode: 'run',
      expoArgs: ['--web', '--port', '8082'],
      agentSkills: true,
      platform: 'web',
      buildBackend: null,
      runTarget: null,
      json: false,
      fingerprintCache: true,
      followups: true,
      open: true,
      detach: false,
      waitReady: false,
      detachTimeoutMs: DEFAULT_DETACH_TIMEOUT_MS,
      detachArgv: expect.any(Array),
      // Read, and still forwarded: `--port` is an `expo start` flag, and the plan's last step is
      // what acts on it. Reading it only lets this command validate it and name it in a URL.
      port: 8082,
    });
  });

  it(`should strip --no-agent-skills and skip the sync`, () => {
    expect(resolveDevOptions(['--ios', '--no-agent-skills', '--clear'])).toEqual({
      mode: 'run',
      expoArgs: ['--clear'],
      agentSkills: false,
      platform: 'ios',
      buildBackend: null,
      runTarget: null,
      json: false,
      fingerprintCache: true,
      followups: true,
      open: true,
      detach: false,
      waitReady: false,
      detachTimeoutMs: DEFAULT_DETACH_TIMEOUT_MS,
      detachArgv: expect.any(Array),
      port: null,
    });
  });

  it(`should run the plan without any mode flag`, () => {
    expect(resolveDevOptions(['--ios']).mode).toBe('run');
  });

  it(`should enter plan mode and strip the flag`, () => {
    expect(resolveDevOptions(['--ios', '--plan', '--port', '8082'])).toEqual({
      mode: 'plan',
      expoArgs: ['--port', '8082'],
      agentSkills: true,
      platform: 'ios',
      buildBackend: null,
      runTarget: null,
      json: false,
      fingerprintCache: true,
      followups: true,
      open: true,
      detach: false,
      waitReady: false,
      detachTimeoutMs: DEFAULT_DETACH_TIMEOUT_MS,
      detachArgv: expect.any(Array),
      port: 8082,
    });
  });

  // `--smart` and `--passthrough` were `@expo/agent-cli start`'s mode flags and this command has neither:
  // running the plan is what it does, and the plain `expo start` wrapper is `@expo/agent-cli start`.
  //
  // They used to be forwarded to `expo start`, which does not have them either, so the run
  // decided a plan, printed it, and then failed on the Expo CLI's own report of a flag nobody has
  // [friction run 5, F48-3]. Refused here instead, with the same envelope every other bad option
  // in this CLI gets.
  it.each(['--smart', '--passthrough'])(`should refuse %s, which neither CLI has`, (flag) => {
    expect(() => resolveDevOptions([flag])).toThrow(new RegExp(flag));
  });

  // @ref llp/0008-guardrails.rfc.md §The plan is announced, not negotiated
  // `--yes` was the consent for a plan that builds. `dev` runs that plan either way now, so the
  // flag is gone rather than accepted-and-ignored — a flag that does nothing is a flag a caller
  // keeps passing to get a behaviour they already have.
  it(`should refuse --yes, which no longer exists`, () => {
    expect(() => resolveDevOptions(['--ios', '--yes'])).toThrow(/--yes/);
  });

  it.each([
    ['--ios', 'ios'],
    ['-i', 'ios'],
    ['--android', 'android'],
    ['-a', 'android'],
    ['--web', 'web'],
    ['-w', 'web'],
  ])(`should read the platform from %s`, (flag, platform) => {
    expect(resolveDevOptions([flag]).platform).toBe(platform);
  });

  // @ref llp/0026-dev-owns-the-open.rfc.md — `expo start --ios` opens the app through an
  // osascript a Mac without the Automation grant refuses; the open is this command's own now.
  it(`should keep native platform flags away from the expo start passthrough`, () => {
    expect(resolveDevOptions(['--ios']).expoArgs).toEqual([]);
    expect(resolveDevOptions(['--android', '-a']).expoArgs).toEqual([]);
  });

  it(`should keep --web in the passthrough, which serves the web bundle`, () => {
    expect(resolveDevOptions(['--web']).expoArgs).toEqual(['--web']);
  });

  // @ref llp/0005-runtime-loop-tools.rfc.md §Which platform is the caller's to say
  // The same rule `smoke` settled: the platform is the caller's to say, and this command has no
  // default to fall back on. One line, because the fix is visible on the command line.
  describe('the platform is required', () => {
    it(`should refuse a run with no platform flag`, () => {
      expect(() => resolveDevOptions([])).toThrow(/Missing platform/);
      expect(() => resolveDevOptions(['--port', '8082'])).toThrow(/Missing platform/);
      expect(() => resolveDevOptions(['--plan'])).toThrow(/Missing platform/);
    });

    it(`should suggest a runnable command`, () => {
      try {
        resolveDevOptions([]);
        throw new Error('did not throw');
      } catch (error: any) {
        expect(error.suggestedCommand).toBe('npx @expo/agent-cli dev --ios');
      }
    });

    it(`should refuse two platforms at once`, () => {
      expect(() => resolveDevOptions(['--android', '--ios'])).toThrow(/two platforms/);
      expect(() => resolveDevOptions(['--ios', '--web'])).toThrow(/two platforms/);
    });

    it(`should allow one platform said twice`, () => {
      expect(resolveDevOptions(['--ios', '-i']).platform).toBe('ios');
    });

    // The more specific mistake is reported first, so a caller with two things wrong is not sent
    // around twice: fixing the missing platform would only surface the conflict afterwards.
    it(`should report a flag conflict before the missing platform`, () => {
      expect(() => resolveDevOptions(['--eas', '--local'])).toThrow(/--eas and --local/);
      expect(() => resolveDevOptions(['--wait-ready'])).toThrow(/--wait-ready/);
    });

    // The conflict errors quote command lines, and those lines carry the platform the caller
    // typed, so following one does not walk into the missing-platform refusal.
    it(`should keep the caller's platform in a conflict error`, () => {
      try {
        resolveDevOptions(['--android', '--eas', '--local']);
        throw new Error('did not throw');
      } catch (error: any) {
        expect(error.suggestedCommand).toBe('npx @expo/agent-cli dev --android --plan --eas');
      }
    });
  });

  // The platform names what the plan is for; `--no-open` keeps it away from `expo start`, where
  // it would open the app. This is how `smoke` starts a dev server, and the way past a refused
  // macOS Automation grant.
  describe('--no-open', () => {
    it(`should keep the platform for the plan and strip it from the passthrough`, () => {
      const options = resolveDevOptions(['--ios', '--no-open', '--clear']);

      expect(options.open).toBe(false);
      expect(options.platform).toBe('ios');
      expect(options.expoArgs).toEqual(['--clear']);
    });

    it(`should still require a platform`, () => {
      expect(() => resolveDevOptions(['--no-open'])).toThrow(/Missing platform/);
    });

    it(`should open by default`, () => {
      expect(resolveDevOptions(['--ios']).open).toBe(true);
    });

    it(`should survive the detach round trip`, () => {
      // The child is started with `detachArgv`, so the flag has to be on it: a child that opened
      // the app would be exactly the run the parent was told not to start.
      expect(resolveDevOptions(['--ios', '--no-open', '--detach']).detachArgv).toContain(
        '--no-open'
      );
    });
  });

  it(`should ask for a JSON plan and strip the flag`, () => {
    expect(resolveDevOptions(['--android', '--plan', '--json'])).toEqual({
      mode: 'plan',
      expoArgs: [],
      agentSkills: true,
      platform: 'android',
      buildBackend: null,
      runTarget: null,
      json: true,
      fingerprintCache: true,
      followups: true,
      open: true,
      detach: false,
      waitReady: false,
      detachTimeoutMs: DEFAULT_DETACH_TIMEOUT_MS,
      detachArgv: expect.any(Array),
      port: null,
    });
  });

  it(`should not ask for JSON without the flag`, () => {
    expect(resolveDevOptions(['--ios', '--plan']).json).toBe(false);
  });

  it(`should suppress the follow-ups and strip the flag`, () => {
    expect(resolveDevOptions(['--web', '--no-followups', '--clear'])).toEqual({
      mode: 'run',
      expoArgs: ['--web', '--clear'],
      agentSkills: true,
      platform: 'web',
      buildBackend: null,
      runTarget: null,
      json: false,
      fingerprintCache: true,
      followups: false,
      open: true,
      detach: false,
      waitReady: false,
      detachTimeoutMs: DEFAULT_DETACH_TIMEOUT_MS,
      detachArgv: expect.any(Array),
      port: null,
    });
  });

  // @ref llp/0023-fingerprint-caching.rfc.md §Every consumer can turn it off
  it(`should refuse a cached fingerprint and strip the flag`, () => {
    const options = resolveDevOptions(['--ios', '--no-fingerprint-cache', '--clear']);

    expect(options.fingerprintCache).toBe(false);
    // The flag is this command's own, so `expo start` never sees it.
    expect(options.expoArgs).toEqual(['--clear']);
  });

  it(`should allow a cached fingerprint without the flag`, () => {
    expect(resolveDevOptions(['--ios']).fingerprintCache).toBe(true);
  });

  it(`should keep the follow-ups without the flag`, () => {
    expect(resolveDevOptions(['--ios']).followups).toBe(true);
  });

  // @ref llp/0010-agent-conventions.rfc.md §Needs-human protocol — `--port` is the answer to the
  // one question `@expo/agent-cli dev` cannot be asked, so an unusable value is reported here and not by
  // `expo start` a minute later.
  describe('--port', () => {
    it(`should read every spelling of the flag`, () => {
      expect(resolveDevOptions(['--ios', '--port', '8082']).port).toBe(8082);
      expect(resolveDevOptions(['--ios', '--port=8082']).port).toBe(8082);
      expect(resolveDevOptions(['--ios', '-p', '8082']).port).toBe(8082);
    });

    it(`should be null when the flag is not passed`, () => {
      expect(resolveDevOptions(['--ios']).port).toBeNull();
    });

    it(`should reject a value that is not a port`, () => {
      expect(() => resolveDevOptions(['--ios', '--port', 'abc'])).toThrow(/must be a port number/);
      expect(() => resolveDevOptions(['--ios', '--port', '0'])).toThrow(/must be a port number/);
      expect(() => resolveDevOptions(['--ios', '--port', '70000'])).toThrow(
        /must be a port number/
      );
      expect(() => resolveDevOptions(['--ios', '--port'])).toThrow(/must be a port number/);
    });

    // Everything after the separator is forwarded to something else, so a `--port` there is that
    // tool's flag and this command has no opinion about it.
    it(`should ignore a port after the separator`, () => {
      expect(resolveDevOptions(['--ios', '--', '--port', 'abc']).port).toBeNull();
    });
  });
});
