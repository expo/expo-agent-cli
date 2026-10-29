import { vol } from 'memfs';

import { devClientConnectUrl } from '../connectUrl';
import { getConfig } from '@expo/config';
import { forgetExpoConfigReads } from '../../project/appConfig';

import {
  buildOpenUrlCommand,
  quoteForDeviceShell,
  readProjectSchemeConfig,
  resolveDeepLinkUrl,
  type ProjectSchemeConfig,
  type ResolveDeepLinkUrlResult,
} from '../deepLink';

const PROJECT_ROOT = '/fixtures/project';

// The declared plugins are read off the loaded module, which these tests do not load.
vi.mock('@expo/config', () => ({
  getConfig: vi.fn(),
  getConfigFilePaths: () => ({ staticConfigPath: null, dynamicConfigPath: null }),
}));

/** Create a project fixture in memory from a map of file name to contents. */
function createProjectFixture(files: Record<string, string>): string {
  vol.fromJSON(files, PROJECT_ROOT);
  // fromJSON does not create the directory when there are no files in it.
  vol.mkdirSync(PROJECT_ROOT, { recursive: true });
  return PROJECT_ROOT;
}

function config(overrides: Partial<ProjectSchemeConfig> = {}): ProjectSchemeConfig {
  return { scheme: null, slug: null, configFile: null, read: { kind: 'none' }, ...overrides };
}

const EVALUATED = { kind: 'evaluated', file: 'app.config.ts', config: {} } as const;
const EVALUATION_FAILED = {
  kind: 'evaluation-failed',
  file: 'app.config.ts',
  error: 'boom',
  fallback: { kind: 'none' },
} as const;

/** Assert the resolution failed and return its error message. */
function expectError(result: ResolveDeepLinkUrlResult): string {
  if (result.ok) {
    throw new Error(`Expected a failure, but got the URL ${result.url}`);
  }
  return result.error;
}

/** Assert the resolution succeeded and return it, so its `resolution` can be read. */
function expectUrl(
  result: ResolveDeepLinkUrlResult
): Extract<ResolveDeepLinkUrlResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`Expected a URL, but the resolution failed: ${result.error}`);
  }
  return result;
}

afterEach(() => {
  vol.reset();
  forgetExpoConfigReads();
});

beforeEach(() => {
  vi.mocked(getConfig).mockReset();
});

describe(readProjectSchemeConfig, () => {
  it(`should read the scheme and slug from app.json`, () => {
    const projectRoot = createProjectFixture({
      'app.json': JSON.stringify({ expo: { name: 'Demo', slug: 'demo', scheme: 'demoapp' } }),
    });

    expect(readProjectSchemeConfig(projectRoot)).toMatchObject({
      scheme: 'demoapp',
      slug: 'demo',
      configFile: 'app.json',
    });
  });

  it(`should take the first entry when scheme is an array`, () => {
    const projectRoot = createProjectFixture({
      'app.json': JSON.stringify({ expo: { slug: 'demo', scheme: ['demoapp', 'demoapp-alt'] } }),
    });

    expect(readProjectSchemeConfig(projectRoot).scheme).toBe('demoapp');
  });

  it(`should accept a config without the expo key`, () => {
    const projectRoot = createProjectFixture({
      'app.json': JSON.stringify({ slug: 'bare', scheme: 'bareapp' }),
    });

    expect(readProjectSchemeConfig(projectRoot)).toMatchObject({
      scheme: 'bareapp',
      slug: 'bare',
      configFile: 'app.json',
    });
  });

  it(`should fall back to app.config.json when app.json is absent`, () => {
    const projectRoot = createProjectFixture({
      'app.config.json': JSON.stringify({ expo: { slug: 'demo', scheme: 'fromconfigjson' } }),
    });

    expect(readProjectSchemeConfig(projectRoot)).toMatchObject({
      scheme: 'fromconfigjson',
      slug: 'demo',
      configFile: 'app.config.json',
    });
  });

  it(`should return a null scheme when app.json has only a slug`, () => {
    const projectRoot = createProjectFixture({
      'app.json': JSON.stringify({ expo: { slug: 'demo' } }),
    });

    expect(readProjectSchemeConfig(projectRoot)).toMatchObject({
      scheme: null,
      slug: 'demo',
      configFile: 'app.json',
    });
  });

  it(`should ignore an empty scheme value`, () => {
    const projectRoot = createProjectFixture({
      'app.json': JSON.stringify({ expo: { slug: 'demo', scheme: '   ' } }),
    });

    expect(readProjectSchemeConfig(projectRoot).scheme).toBeNull();
  });

  it(`should fall back to the package.json name for the slug`, () => {
    const projectRoot = createProjectFixture({
      'package.json': JSON.stringify({ name: 'from-package-json' }),
    });

    expect(readProjectSchemeConfig(projectRoot)).toMatchObject({
      scheme: null,
      slug: 'from-package-json',
      configFile: null,
    });
  });

  it(`should return nulls for a malformed config instead of throwing`, () => {
    const projectRoot = createProjectFixture({ 'app.json': '{ not json' });

    expect(readProjectSchemeConfig(projectRoot)).toMatchObject({
      scheme: null,
      slug: null,
      configFile: null,
    });
  });

  it(`should return nulls for a project with no config files`, () => {
    const projectRoot = createProjectFixture({});

    expect(readProjectSchemeConfig(projectRoot)).toMatchObject({
      scheme: null,
      slug: null,
      configFile: null,
    });
  });

  function createDynamicFixture(files: Record<string, string> = {}): string {
    return createProjectFixture({
      'app.config.ts': 'export default { scheme: "marmelade" };',
      'package.json': JSON.stringify({ name: 'marmelade-app' }),
      ...files,
    });
  }

  function mockEvaluated(exp: Record<string, unknown>) {
    vi.mocked(getConfig).mockReturnValue({
      exp,
      pkg: {},
      staticConfigPath: null,
      dynamicConfigPath: `${PROJECT_ROOT}/app.config.ts`,
    } as never);
  }

  it(`should evaluate nothing for a static config`, () => {
    const projectRoot = createProjectFixture({
      'app.json': JSON.stringify({ expo: { slug: 'demo', scheme: 'demoapp' } }),
    });

    expect(readProjectSchemeConfig(projectRoot)).toMatchObject({
      scheme: 'demoapp',
      slug: 'demo',
      configFile: 'app.json',
    });
    expect(getConfig).not.toHaveBeenCalled();
  });

  it(`should take scheme and slug from the evaluated config, over a static file beside it`, () => {
    const projectRoot = createDynamicFixture({
      'app.json': JSON.stringify({ expo: { slug: 'static', scheme: 'staticapp' } }),
    });
    mockEvaluated({ slug: 'marmelade', scheme: ['marmelade', 'second'] });

    expect(readProjectSchemeConfig(projectRoot)).toMatchObject({
      scheme: 'marmelade',
      slug: 'marmelade',
      configFile: 'app.config.ts',
      read: { kind: 'evaluated' },
    });
  });

  it(`should report a config that names no scheme as evaluated`, () => {
    const projectRoot = createDynamicFixture();
    mockEvaluated({ slug: 'demo' });

    expect(readProjectSchemeConfig(projectRoot)).toMatchObject({
      scheme: null,
      slug: 'demo',
      configFile: 'app.config.ts',
      read: { kind: 'evaluated' },
    });
  });

  it(`should keep the static read and say why when the evaluation fails`, () => {
    const projectRoot = createDynamicFixture({
      'app.config.ts': 'throw new Error("Cannot resolve app config");',
    });
    vi.mocked(getConfig).mockImplementation(() => {
      throw new Error('Cannot resolve app config');
    });

    expect(readProjectSchemeConfig(projectRoot)).toMatchObject({
      scheme: null,
      slug: 'marmelade-app',
      configFile: null,
      read: { kind: 'evaluation-failed', error: 'Cannot resolve app config' },
    });
  });
});

describe(resolveDeepLinkUrl, () => {
  it.each([
    ['myapp://profile/42', config({ scheme: 'other' }), false],
    ['https://example.com/profile/42', config(), true],
  ])(`should open the full URL %j as given`, (route, projectConfig, isExpoGo) => {
    const result = resolveDeepLinkUrl({
      route,
      config: projectConfig,
      isExpoGo,
      devServerUrl: isExpoGo ? 'http://localhost:8081' : undefined,
    });

    expect(result).toEqual({
      ok: true,
      host: null,
      url: route,
      resolution: 'the route was already a full URL, so it was only percent-encoded',
    });
  });

  it(`should prefer the scheme flag over Expo Go and the config`, () => {
    const result = resolveDeepLinkUrl({
      route: '/profile/42',
      schemeOverride: 'override',
      config: config({ scheme: 'fromconfig', configFile: 'app.json' }),
      isExpoGo: true,
      devServerUrl: 'http://localhost:8081',
    });

    expect(result).toEqual({
      ok: true,
      host: null,
      url: 'override://profile/42',
      resolution: 'used the --scheme flag',
    });
  });

  it(`should trim a trailing :// from the scheme flag`, () => {
    const result = resolveDeepLinkUrl({
      route: '/profile/42',
      schemeOverride: 'myapp://',
      config: config(),
      isExpoGo: false,
    });

    expect(result).toMatchObject({ ok: true, url: 'myapp://profile/42' });
  });

  it(`should build the exp:// shape for Expo Go`, () => {
    const result = resolveDeepLinkUrl({
      route: '/profile/42',
      config: config({ scheme: 'demoapp', configFile: 'app.json' }),
      isExpoGo: true,
      devServerUrl: 'http://localhost:8081',
    });

    expect(result).toEqual({
      ok: true,
      host: 'localhost:8081',
      url: 'exp://localhost:8081/--/profile/42',
      resolution:
        'target app is Expo Go, so the exp:// shape was used with dev server host localhost:8081',
    });
  });

  // The root route needs a URL that survives expo-router's Expo Go listener: an `exp://` link
  // whose path is empty or `/` is replaced by the root URL, which in Expo Go is the empty string,
  // and then dropped by a truthiness check before the router sees it. A bare `?` is the smallest
  // thing that survives it and still resolves to the index route.
  it(`should keep the root route addressable on Expo Go`, () => {
    const result = resolveDeepLinkUrl({
      route: '/',
      config: config(),
      isExpoGo: true,
      devServerUrl: 'http://192.168.1.10:8081',
    });

    expect(result).toMatchObject({ ok: true, url: 'exp://192.168.1.10:8081/--/?' });
    expect(expectUrl(result).resolution).toContain('root route');
  });

  it(`should reach the root the same way for every spelling of it`, () => {
    for (const route of ['/', '//', ' / ']) {
      expect(
        resolveDeepLinkUrl({
          route,
          config: config(),
          isExpoGo: true,
          devServerUrl: 'http://192.168.1.10:8081',
        })
      ).toMatchObject({ url: 'exp://192.168.1.10:8081/--/?' });
    }
  });

  // A development build never had the problem: its listener passes the URL through whatever the
  // path is, so `myapp://` already means the index route and a `?` would only be noise.
  it(`should leave the root route of a development build alone`, () => {
    expect(
      resolveDeepLinkUrl({
        route: '/',
        config: config({ scheme: 'demoapp', configFile: 'app.json' }),
        isExpoGo: false,
      })
    ).toMatchObject({ ok: true, url: 'demoapp://' });
  });

  it(`should explain how to fix a missing dev server URL for Expo Go`, () => {
    const result = resolveDeepLinkUrl({ route: '/profile/42', config: config(), isExpoGo: true });

    const error = expectError(result);
    expect(error).toContain('the dev server URL is unknown');
    expect(error).toContain('npx @expo/agent-cli dev --detach');
  });

  it(`should use the config scheme for a development build`, () => {
    const result = resolveDeepLinkUrl({
      route: '/profile/42',
      config: config({ scheme: 'demoapp', slug: 'demo', configFile: 'app.json' }),
      isExpoGo: false,
    });

    expect(result).toEqual({
      ok: true,
      host: null,
      url: 'demoapp://profile/42',
      resolution: 'read the "scheme" field from app.json',
    });
  });

  it(`should keep a query string on the route`, () => {
    const result = resolveDeepLinkUrl({
      route: '/profile/42?tab=posts',
      config: config({ scheme: 'demoapp', configFile: 'app.json' }),
      isExpoGo: false,
    });

    expect(result).toMatchObject({ ok: true, url: 'demoapp://profile/42?tab=posts' });
  });

  it.each([
    ['/street/U Zeleného stromu', 'demoapp://street/U%20Zelen%C3%A9ho%20stromu'],
    ['/street/U%20Zelen%C3%A9ho%20stromu', 'demoapp://street/U%20Zelen%C3%A9ho%20stromu'],
    ['/street/Horní?x=a b&y=1#top', 'demoapp://street/Horn%C3%AD?x=a%20b&y=1#top'],
    ['/discount/50%', 'demoapp://discount/50%25'],
    ['cyclable://street/U Zeleného stromu', 'cyclable://street/U%20Zelen%C3%A9ho%20stromu'],
    ['demoapp://Žižkov/x', 'demoapp://%C5%BDi%C5%BEkov/x'],
    ['exp://[::1]:8081/--/street/U Z', 'exp://[::1]:8081/--/street/U%20Z'],
    ['exp://[fe80::1%25en0]:8081', 'exp://[fe80::1%25en0]:8081'],
    ['exp://[fe80::1%en0]:8081', 'exp://[fe80::1%25en0]:8081'],
    ['myapp://u:p@[::1]:80/x', 'myapp://u:p@[::1]:80/x'],
    ['myapp://foo%5Bbar%5D/baz', 'myapp://foo%5Bbar%5D/baz'],
    ['myapp://foo[bar]/baz', 'myapp://foo%5Bbar%5D/baz'],
    ['exp://[::1%5D:8081/a', 'exp://%5B::1%5D:8081/a'],
    [
      'exp+cyclable://expo-development-client/?url=http%3A%2F%2F192.168.1.10%3A8081',
      'exp+cyclable://expo-development-client/?url=http%3A%2F%2F192.168.1.10%3A8081',
    ],
    ['exp://h/--/a b?q=a b#f g', 'exp://h/--/a%20b?q=a%20b#f%20g'],
    ['myapp:profile/Ž', 'myapp:profile/%C5%BD'],
  ])(`should percent-encode %j once`, (route, url) => {
    const result = resolveDeepLinkUrl({
      route,
      config: config({ scheme: 'demoapp', configFile: 'app.json' }),
      isExpoGo: false,
    });

    expect(result).toMatchObject({ ok: true, url });
  });

  it(`should percent-encode the route in an Expo Go link`, () => {
    const result = resolveDeepLinkUrl({
      route: '/street/U Zeleného stromu',
      config: config(),
      isExpoGo: true,
      devServerUrl: 'http://192.168.1.10:8081',
    });

    expect(result).toMatchObject({
      ok: true,
      url: 'exp://192.168.1.10:8081/--/street/U%20Zelen%C3%A9ho%20stromu',
    });
  });

  it(`should collapse repeated leading slashes`, () => {
    const result = resolveDeepLinkUrl({
      route: '//profile/42',
      config: config({ scheme: 'demoapp', configFile: 'app.json' }),
      isExpoGo: false,
    });

    expect(result).toMatchObject({ ok: true, url: 'demoapp://profile/42' });
  });

  it(`should accept a route without a leading slash`, () => {
    const result = resolveDeepLinkUrl({
      route: 'profile/42',
      config: config({ scheme: 'demoapp', configFile: 'app.json' }),
      isExpoGo: false,
    });

    expect(result).toMatchObject({ ok: true, url: 'demoapp://profile/42' });
  });

  it(`should fall back to exp+<slug> when the config has no scheme`, () => {
    const result = resolveDeepLinkUrl({
      route: '/profile/42',
      config: config({ slug: 'demo', configFile: 'app.json' }),
      isExpoGo: false,
    });

    expect(result).toEqual({
      ok: true,
      host: null,
      url: 'exp+demo://profile/42',
      resolution:
        'no "scheme" field was found, so the development build default exp+<slug>:// was used with slug "demo"',
    });
  });

  it(`should name the evaluated dynamic config file as the source of the scheme`, () => {
    const result = resolveDeepLinkUrl({
      route: '/profile/42',
      config: config({
        scheme: 'marmelade',
        slug: 'marmelade',
        configFile: 'app.config.ts',
        read: EVALUATED,
      }),
      isExpoGo: false,
    });

    expect(expectUrl(result)).toMatchObject({
      url: 'marmelade://profile/42',
      resolution: 'read the "scheme" field from app.config.ts',
    });
  });

  it.each([
    {
      name: 'a static scheme',
      scheme: 'marmelade',
      isExpoGo: false,
      url: 'marmelade://profile/42',
      resolution:
        'read the "scheme" field from app.json; app.config.ts could not be evaluated (boom), so the static config was read',
    },
    {
      name: 'the exp+<slug> fallback',
      scheme: null,
      isExpoGo: false,
      url: 'exp+marmelade://profile/42',
      resolution:
        'no "scheme" field was found, so the development build default exp+<slug>:// was used with slug "marmelade"; app.config.ts could not be evaluated (boom), so the static config was read',
    },
    {
      name: 'an Expo Go URL, whose connect URL still uses the static scheme',
      scheme: 'marmelade',
      isExpoGo: true,
      url: 'exp://127.0.0.1:8081/--/profile/42',
      resolution:
        'target app is Expo Go, so the exp:// shape was used with dev server host 127.0.0.1:8081; app.config.ts could not be evaluated (boom), so the static config was read',
    },
  ])(
    `should say when $name rests on a config it could not evaluate`,
    ({ scheme, isExpoGo, url, resolution }) => {
      const result = resolveDeepLinkUrl({
        route: '/profile/42',
        config: config({
          scheme,
          slug: 'marmelade',
          configFile: 'app.json',
          read: EVALUATION_FAILED,
        }),
        isExpoGo,
        devServerUrl: 'http://127.0.0.1:8081',
      });

      expect(expectUrl(result)).toMatchObject({ url, resolution });
    }
  );

  it(`should name the evaluation failure when nothing is resolvable`, () => {
    const result = resolveDeepLinkUrl({
      route: '/profile/42',
      config: config({ read: EVALUATION_FAILED }),
      isExpoGo: false,
    });

    expect(expectError(result)).toContain(
      'Why: this project uses app.config.ts, and evaluating it failed: boom.'
    );
  });

  it(`should say when the evaluated config names nothing`, () => {
    const result = resolveDeepLinkUrl({
      route: '/profile/42',
      config: config({ configFile: 'app.config.ts', read: EVALUATED }),
      isExpoGo: false,
    });

    expect(expectError(result)).toContain('in the evaluated app.config.ts');
  });

  it(`should reject an empty route`, () => {
    const result = resolveDeepLinkUrl({ route: '   ', config: config(), isExpoGo: false });

    expect(expectError(result)).toContain('nothing to navigate to');
  });

  // @ref llp/0021-honest-reports.rfc.md §How they show up — F58, S5, F103,
  // and now **F142.** `navigate / --ios` against a dev server that had died recovered into
  // `npx @expo/agent-cli dev --detach`, which on this machine plans for whatever platform the probe picks —
  // so the one line the caller was told to run was a different run from the one they asked for, and
  // the `--ios` they had typed was gone from the loop.
  describe('the platform the caller named', () => {
    const platforms = [['ios'], ['android']] as const;

    it.each(platforms)(`survives into the recovery for a missing dev server (--%s)`, (platform) => {
      const result = resolveDeepLinkUrl({
        route: '/profile/42',
        config: config(),
        isExpoGo: true,
        platform,
      });

      expect(expectError(result)).toContain(`npx @expo/agent-cli dev --detach --${platform}`);
      expect(result.ok === false && result.suggestedCommand).toBe(
        `npx @expo/agent-cli dev --detach --${platform}`
      );
    });

    it.each(platforms)(`survives into the recovery for an empty route (--%s)`, (platform) => {
      const result = resolveDeepLinkUrl({
        route: '  ',
        config: config(),
        isExpoGo: true,
        platform,
      });

      expect(result.ok === false && result.suggestedCommand).toBe(
        `npx @expo/agent-cli navigate / --${platform}`
      );
    });

    // `dev` requires a platform now, so a caller who named none is shown the host's — stated
    // text they can change, not a flag smuggled into a run (llp/0005 §Which platform).
    it(`states the host's platform when the caller named none`, () => {
      const result = resolveDeepLinkUrl({ route: '/profile/42', config: config(), isExpoGo: true });

      expect(result.ok === false && result.suggestedCommand).toBe(
        `npx @expo/agent-cli dev --detach --${process.platform === 'darwin' ? 'ios' : 'android'}`
      );
    });
  });
});

describe(buildOpenUrlCommand, () => {
  it(`should build a simctl openurl command for iOS`, () => {
    const command = buildOpenUrlCommand({
      platform: 'ios',
      deviceId: 'ABCD-1234',
      url: 'demoapp://profile/42',
      appId: 'com.example.demo',
    });

    expect(command.bin).toBe('xcrun');
    expect(command.args).toEqual(['simctl', 'openurl', 'ABCD-1234', 'demoapp://profile/42']);
    expect(command.display).toBe("xcrun simctl openurl ABCD-1234 'demoapp://profile/42'");
  });

  it.skipIf(process.platform === 'win32')(
    'preserves iOS automation parameters when replayed in a shell',
    () => {
      const url = devClientConnectUrl('demoapp', 'localhost:8081', 'localhost', true);
      const command = buildOpenUrlCommand({ platform: 'ios', deviceId: 'ABCD-1234', url });
      // Use the real shell, replacing xcrun with an argument recorder so no device is touched.
      const { execFileSync } = process.getBuiltinModule('child_process');
      const replayed = execFileSync(
        '/bin/sh',
        ['-c', `xcrun() { printf '%s\\n' "$@"; }\n${command.display}\nwait`],
        { encoding: 'utf8' }
      );

      expect(command.args.at(-1)).toBe(url);
      expect(replayed.trimEnd().split('\n')).toEqual(command.args);
    }
  );

  it(`should build an ACTION_VIEW intent scoped to the package for Android`, () => {
    const command = buildOpenUrlCommand({
      platform: 'android',
      deviceId: 'emulator-5554',
      url: 'demoapp://profile/42',
      appId: 'com.example.demo',
    });

    expect(command.bin).toBe('adb');
    expect(command.args).toEqual([
      '-s',
      'emulator-5554',
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-c',
      'android.intent.category.BROWSABLE',
      '-d',
      `'demoapp://profile/42'`,
      'com.example.demo',
    ]);
  });

  it(`should omit the package when no appId is given on Android`, () => {
    const command = buildOpenUrlCommand({
      platform: 'android',
      deviceId: 'emulator-5554',
      url: 'demoapp://profile/42',
    });

    expect(command.args.at(-1)).toBe(`'demoapp://profile/42'`);
  });
});

describe(quoteForDeviceShell, () => {
  it(`should quote a URL with a query string so the device shell keeps it whole`, () => {
    expect(quoteForDeviceShell('demoapp://profile/42?tab=posts&sort=new')).toBe(
      `'demoapp://profile/42?tab=posts&sort=new'`
    );
  });

  it(`should escape single quotes inside the value`, () => {
    expect(quoteForDeviceShell("demoapp://search?q=o'brien")).toBe(
      `'demoapp://search?q=o'\\''brien'`
    );
  });
});

// @ref llp/0006-agent-native-cli-surface.rfc.md §Errors are prompts — friction run 5. The last
// line of a failure is what a driving agent runs, and one `Try:` served all three of these:
// `npx @expo/agent-cli navigate <route> --scheme <your-app-scheme>`, which has two holes in it and so is
// not a command at all. Each failure carries the command that answers *it* now.
describe('the Try: line of a URL that could not be resolved', () => {
  const config: ProjectSchemeConfig = {
    scheme: null,
    slug: null,
    configFile: 'app.json',
    read: { kind: 'none' },
  };

  it(`answers a missing dev server with the command that starts one`, () => {
    const result = resolveDeepLinkUrl({
      route: '/notes',
      config,
      isExpoGo: true,
      devServerUrl: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.suggestedCommand).toBe(
      `npx @expo/agent-cli dev --detach --${process.platform === 'darwin' ? 'ios' : 'android'}`
    );
    // The How: and the Try: name the same action, which they did not.
    expect(result.error).toContain('npx @expo/agent-cli dev --detach');
  });

  // The one case where a person has to supply a value this CLI cannot know, so the runnable
  // command is the one that prints what the project *does* declare.
  it(`answers a project with no scheme with a command that has no holes in it`, () => {
    const result = resolveDeepLinkUrl({
      route: '/notes',
      config,
      isExpoGo: false,
      devServerUrl: 'http://127.0.0.1:8081',
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.suggestedCommand).not.toContain('<');
  });

  it(`never suggests a command with a placeholder in it`, () => {
    for (const params of [
      { route: '', config, isExpoGo: true, devServerUrl: null },
      { route: '/notes', config, isExpoGo: true, devServerUrl: null },
      { route: '/notes', config, isExpoGo: false, devServerUrl: 'http://127.0.0.1:8081' },
    ]) {
      const result = resolveDeepLinkUrl(params);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.suggestedCommand).not.toMatch(/[<>]/);
      }
    }
  });
});
