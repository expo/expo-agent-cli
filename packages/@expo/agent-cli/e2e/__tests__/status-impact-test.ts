// @ref llp/0004-smart-start-and-project-state.rfc.md §Status
//
// `status`: whether the installed build still matches the project — the impact headline, the
// change detail, and the fingerprint cache.
// The tests run it through the CLI it is published as, against the fixture matrix in
// `e2e/fixtures/README.md`. Shared helpers live in `statusFixtures.ts`.

import fs from 'node:fs';
import path from 'node:path';

import {
  clearStubFingerprintInvocations,
  executeAgentCliAsync,
  lastBuildFilePath,
  readStubExpoInvocations,
  readStubFingerprintInvocations,
  linkFixtureToEasAsync,
} from '../utils';
import {
  type StatusReport,
  FIXTURE_FINGERPRINT_HASH,
  setupAsync,
  getUnusedDevServerUrlAsync,
  reportInAsync,
  reportAsync,
  git,
  initGitRepoAsync,
  installEnvFingerprintStubAsync,
} from './statusFixtures';

describe('@expo/agent-cli status', () => {
  describe('dev-client-fresh-app — a recorded build that still matches', () => {
    it('reports the platform of the recorded build as fresh', async () => {
      const report = await reportAsync('dev-client-fresh-app');

      expect(report.freshness?.hash).toBe(FIXTURE_FINGERPRINT_HASH);
      const ios = report.freshness?.platforms.find(
        (platform) => platform.platform === 'ios' && platform.backend === 'local'
      );
      expect(ios).toMatchObject({ state: 'fresh', recordedHash: FIXTURE_FINGERPRINT_HASH });
    });

    it('reports the Expo Go blocker and the dev client dependency', async () => {
      const report = await reportAsync('dev-client-fresh-app');

      expect(report.project?.usesDevClient).toBe(true);
      expect(report.expoGo?.compatible).toBe(false);
      expect(report.expoGo!.reasonCount).toBeGreaterThan(0);
    });

    it('reports a native fingerprint change as stale', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--json', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        { env: { STUB_FINGERPRINT_HASH: 'aaaabbbbccccddddeeeeffff0000111122223333' } }
      );

      expect(result.exitCode).toBe(0);
      const report: StatusReport = JSON.parse(result.stdout);
      // The local axis of both platforms. The EAS axis was not asked on this run and says so.
      expect(
        report.freshness?.platforms
          .filter((platform) => platform.backend === 'local')
          .every((platform) => platform.state === 'stale')
      ).toBe(true);
    });

    it('reports a failing fingerprint tool as an unknown freshness, still exiting 0', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--json', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        { env: { STUB_FINGERPRINT_EXIT_CODE: '1' } }
      );

      // A broken tool is a section note, never a failed command.
      expect(result.exitCode).toBe(0);
      const report: StatusReport = JSON.parse(result.stdout);
      expect(report.freshness?.hash).toBeNull();
      expect(report.freshness?.error).toBeTruthy();
      expect(report.errors).toEqual({});
    });
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Status
  //
  // What a change costs, on every run. The two things worth asserting end to end are the answer
  // and the *cost*: the headline must arrive without `expo config` or `eas` being spawned at all,
  // which is the whole reason it can be always-on.
  describe('the impact headline', () => {
    /** One autolinked native module, in the shape the sourcer emits. */
    const NATIVE_MODULE = {
      type: 'dir',
      filePath: 'node_modules/react-native-mmkv',
      reasons: ['rncoreAutolinkingIos'],
      hash: 'aabb',
    };
    const APP_CONFIG = {
      type: 'file',
      filePath: 'app.json',
      reasons: ['expoConfig'],
      hash: 'ccdd',
    };

    /** Copy the fixture, install the steerable fingerprint stub, and write the v2 build record. */
    async function setupImpactAsync(recorded: unknown): Promise<string> {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      await installEnvFingerprintStubAsync(projectRoot);
      await fs.promises.writeFile(lastBuildFilePath(projectRoot), JSON.stringify(recorded));
      return projectRoot;
    }

    /** The v2 record: the whole fingerprint, which is what makes a diff possible. */
    function v2Record(sources: unknown[]) {
      return {
        ios: { hash: FIXTURE_FINGERPRINT_HASH, sources },
        android: { hash: FIXTURE_FINGERPRINT_HASH, sources },
      };
    }

    function iosImpact(report: StatusReport) {
      return report.freshness!.platforms.find(
        (platform) => platform.platform === 'ios' && platform.backend === 'local'
      )!.impact;
    }

    it('classifies an added native module without spawning anything', async () => {
      const projectRoot = await setupImpactAsync(v2Record([APP_CONFIG]));

      const report = await reportInAsync(projectRoot, [], {
        STUB_FINGERPRINT_HASH: 'ffff1111ffff1111ffff1111ffff1111ffff1111',
        STUB_FP_SOURCES: JSON.stringify([APP_CONFIG, NATIVE_MODULE]),
      });

      expect(iosImpact(report)).toMatchObject({
        class: 'needs-native-build',
        fingerprintChanged: true,
        changedCount: 1,
      });
      expect(iosImpact(report)!.reason).toContain('autolinked native modules changed');
      expect(iosImpact(report)!.changedSources).toEqual([
        expect.objectContaining({ op: 'added', kind: 'native-module' }),
      ]);
    });

    it('classifies an unmoved native surface as js-only', async () => {
      const projectRoot = await setupImpactAsync(v2Record([APP_CONFIG]));

      const report = await reportInAsync(projectRoot, [], {
        STUB_FP_SOURCES: JSON.stringify([APP_CONFIG]),
      });

      expect(iosImpact(report)).toMatchObject({
        class: 'js-only',
        fingerprintChanged: false,
        changedCount: 0,
      });
    });

    it('prints the class and the sentence on an impact line', async () => {
      const projectRoot = await setupImpactAsync(v2Record([APP_CONFIG]));
      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        {
          env: {
            STUB_FINGERPRINT_HASH: 'ffff1111ffff1111ffff1111ffff1111ffff1111',
            STUB_FP_SOURCES: JSON.stringify([APP_CONFIG, NATIVE_MODULE]),
          },
        }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('impact');
      expect(result.stdout).toContain('needs-native-build');
      // Both platforms recorded the same fingerprint, so they agree and the line is printed once.
      expect(result.stdout).toContain('ios, android: needs-native-build');
    });

    // The v1 record is a bare hash string. It can say the surface moved and not what moved, and
    // `status` refuses to name a class it did not establish. See llp/0011 §The classifier reads reasons
    // classifier for why `@expo/agent-cli impact` answers differently for the same project.
    it('refuses to name a class for a record that stored only a hash, and still exits 0', async () => {
      const projectRoot = await setupImpactAsync({ ios: FIXTURE_FINGERPRINT_HASH });
      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        { env: { STUB_FINGERPRINT_HASH: 'ffff1111ffff1111ffff1111ffff1111ffff1111' } }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('impact');

      const report = await reportInAsync(projectRoot, [], {
        STUB_FINGERPRINT_HASH: 'ffff1111ffff1111ffff1111ffff1111ffff1111',
      });
      expect(iosImpact(report)).toMatchObject({ class: null, fingerprintChanged: true });
      expect(iosImpact(report)!.reason).toContain('stored only a hash');
    });

    it('says nothing about impact when there is no fingerprint at all', async () => {
      const report = await reportAsync('go-app');

      expect(report.freshness!.platforms.every((platform) => platform.impact == null)).toBe(true);
    });
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Status
  describe('the change detail: sources, files, and the OTA verdict', () => {
    const NATIVE_MODULE = {
      type: 'dir',
      filePath: 'node_modules/react-native-mmkv',
      reasons: ['rncoreAutolinkingIos'],
      hash: 'aabb',
    };

    /** `dynamic` adds an `app.config.js`, whose runtimeVersion comes from the stub `expo config`. */
    async function setupExplainAsync(
      runtimeVersion: unknown,
      { config = 'static' }: { config?: 'static' | 'dynamic' } = {}
    ): Promise<{
      projectRoot: string;
      env: Record<string, string>;
    }> {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      await installEnvFingerprintStubAsync(projectRoot);
      await fs.promises.writeFile(
        lastBuildFilePath(projectRoot),
        JSON.stringify({ ios: { hash: FIXTURE_FINGERPRINT_HASH, sources: [] } })
      );

      if (config === 'static') {
        const configPath = path.join(projectRoot, 'app.json');
        const app = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
        app.expo.runtimeVersion = runtimeVersion;
        await fs.promises.writeFile(configPath, JSON.stringify(app, null, 2) + '\n');
      } else {
        await fs.promises.writeFile(
          path.join(projectRoot, 'app.config.js'),
          'module.exports = ({ config }) => ({ ...config, runtimeVersion: process.env.RUNTIME_VERSION });\n'
        );
      }

      const payloadPath = path.join(projectRoot, 'stub-expo-config.json');
      await fs.promises.writeFile(
        payloadPath,
        JSON.stringify({ name: 'fresh', slug: 'fresh', runtimeVersion })
      );
      return {
        projectRoot,
        env: {
          STUB_EXPO_CONFIG_JSON: payloadPath,
          STUB_FINGERPRINT_HASH: 'ffff1111ffff1111ffff1111ffff1111ffff1111',
          STUB_FP_SOURCES: JSON.stringify([NATIVE_MODULE]),
        },
      };
    }

    function configSpawns(projectRoot: string) {
      return readStubExpoInvocations(projectRoot).filter(
        (invocation) => invocation.args[0] === 'config'
      );
    }

    it('carries the per-source list and the OTA verdict, and still exits 0', async () => {
      const { projectRoot, env } = await setupExplainAsync({ policy: 'appVersion' });

      const report = await reportInAsync(projectRoot, [], env);

      const ios = report.freshness!.platforms.find(
        (platform) => platform.platform === 'ios' && platform.backend === 'local'
      )!;
      expect(ios.impact!.changedSources).toEqual([
        expect.objectContaining({
          op: 'added',
          path: 'node_modules/react-native-mmkv',
          kind: 'native-module',
        }),
      ]);
      expect(report.freshness!.ota).toMatchObject({
        safe: false,
        runtimeVersion: { policy: 'appVersion', source: 'expo config --type public' },
      });
      expect(report.errors).toEqual({});
    });

    // The policy that makes a native change safe to publish: the runtime version moves with the
    // fingerprint, so an update is only offered to builds that can run it.
    it('reports a fingerprint policy as safe even for a native change', async () => {
      const { projectRoot, env } = await setupExplainAsync({ policy: 'fingerprint' });

      const report = await reportInAsync(projectRoot, [], env);

      expect(report.freshness!.ota).toMatchObject({ safe: true });
    });

    // The config plugins a static app.json lists can set runtimeVersion, so the file alone is not
    // the config the app sees.
    it('evaluates a static app.json with expo config on every run', async () => {
      const { projectRoot, env } = await setupExplainAsync({ policy: 'appVersion' });

      await reportInAsync(projectRoot, [], env);
      await reportInAsync(projectRoot, [], env);

      expect(configSpawns(projectRoot)).toHaveLength(2);
      expect(configSpawns(projectRoot)[0]!.args).toEqual(['config', '--json', '--type', 'public']);
    });

    it('prints the changed sources and the ota verdict for a human', async () => {
      const { projectRoot, env } = await setupExplainAsync({ policy: 'appVersion' });
      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        { env }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('changed');
      expect(result.stdout).toContain('ios: 1 source');
      expect(result.stdout).toContain('node_modules/react-native-mmkv');
      expect(result.stdout).toContain('ota');
      expect(result.stdout).toContain('not safe to publish');
    });

    it('lists eight sources, counts the rest, and prints matching platforms once', async () => {
      const { projectRoot, env } = await setupExplainAsync({ policy: 'appVersion' });
      await fs.promises.writeFile(
        lastBuildFilePath(projectRoot),
        JSON.stringify({
          ios: { hash: FIXTURE_FINGERPRINT_HASH, sources: [] },
          android: { hash: FIXTURE_FINGERPRINT_HASH, sources: [] },
        })
      );
      const sources = Array.from({ length: 10 }, (_, index) => ({
        ...NATIVE_MODULE,
        filePath: `node_modules/native-module-${index}`,
      }));

      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        { env: { ...env, STUB_FP_SOURCES: JSON.stringify(sources) } }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('ios, android: 10 sources');
      expect(result.stdout).toContain('node_modules/native-module-7');
      expect(result.stdout).not.toContain('node_modules/native-module-8');
      expect(result.stdout).toContain('… and 2 more, in --json');
      expect(result.stdout.match(/added\s+node_modules\/native-module-0/g)).toHaveLength(1);
    });

    it('names change-native-build in the follow-ups for a native change', async () => {
      const { projectRoot, env } = await setupExplainAsync({ policy: 'appVersion' });

      const report = await reportInAsync(projectRoot, [], env);

      expect(report.followups.map((followup) => followup.id)).toContain('change-native-build');
    });

    // @ref llp/0011-impact-and-freshness.rfc.md §A fingerprint change is not "OTA-unsafe"
    describe('a dynamic app.config.js', () => {
      it('evaluates it with expo config', async () => {
        const { projectRoot, env } = await setupExplainAsync(
          { policy: 'appVersion' },
          { config: 'dynamic' }
        );

        const report = await reportInAsync(projectRoot, [], env);

        expect(configSpawns(projectRoot)).toHaveLength(1);
        expect(report.freshness!.ota).toMatchObject({
          safe: false,
          runtimeVersion: { policy: 'appVersion', source: 'expo config --type public' },
        });
      });

      // A dynamic config can read environment variables, which no file stamp sees.
      it('evaluates it again on the next run, with nothing changed on disk', async () => {
        const { projectRoot, env } = await setupExplainAsync(
          { policy: 'appVersion' },
          { config: 'dynamic' }
        );
        await reportInAsync(projectRoot, [], env);
        await fs.promises.writeFile(
          env.STUB_EXPO_CONFIG_JSON!,
          JSON.stringify({
            name: 'fresh',
            slug: 'fresh',
            runtimeVersion: { policy: 'fingerprint' },
          })
        );

        const report = await reportInAsync(projectRoot, [], env);

        expect(configSpawns(projectRoot)).toHaveLength(2);
        expect(report.freshness!.ota).toMatchObject({ safe: true });
        expect(fs.existsSync(path.join(projectRoot, '.expo', 'agent-cli-app-config.json'))).toBe(
          false
        );
      });

      // Section isolation: an answer that cannot be had costs one line.
      it('keeps every other fact when the config subprocess fails', async () => {
        const { projectRoot, env } = await setupExplainAsync(
          { policy: 'appVersion' },
          { config: 'dynamic' }
        );
        const result = await executeAgentCliAsync(
          projectRoot,
          ['status', '--json', '--dev-server-url', await getUnusedDevServerUrlAsync()],
          { env: { ...env, STUB_EXPO_EXIT_CODE: '1' } }
        );

        expect(result.exitCode).toBe(0);
        const report: StatusReport = JSON.parse(result.stdout);
        // Nothing resolved the policy, so the verdict is unknown, never "not safe".
        expect(report.freshness!.ota).toMatchObject({
          safe: null,
          runtimeVersion: { source: null },
        });
        expect(report.project).not.toBeNull();
      });
    });
  });

  // @ref llp/0011-impact-and-freshness.rfc.md §When the fingerprint did not move
  describe('the changed files, when the fingerprint did not move', () => {
    const APP_CONFIG = { type: 'file', filePath: 'app.json', reasons: ['expoConfig'], hash: 'cc' };

    /** A committed tree whose fingerprint matches its recorded build. */
    async function setupCommittedAsync(): Promise<string> {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      await installEnvFingerprintStubAsync(projectRoot);
      await fs.promises.writeFile(
        lastBuildFilePath(projectRoot),
        JSON.stringify({
          ios: { hash: FIXTURE_FINGERPRINT_HASH, sources: [APP_CONFIG] },
          android: { hash: FIXTURE_FINGERPRINT_HASH, sources: [APP_CONFIG] },
        })
      );
      await fs.promises.writeFile(
        path.join(projectRoot, '.gitignore'),
        ['node_modules/', '.expo/', '.stub-bin/', 'stub-*.jsonl', ''].join('\n')
      );
      await initGitRepoAsync(projectRoot);
      git(projectRoot, ['add', '-A']);
      git(projectRoot, [
        '-c',
        'user.name=e2e',
        '-c',
        'user.email=e2e@example.com',
        'commit',
        '-q',
        '-m',
        'init',
      ]);
      return projectRoot;
    }

    const env = { STUB_FP_SOURCES: JSON.stringify([APP_CONFIG]) };

    it('counts zero files when nothing changed', async () => {
      const projectRoot = await setupCommittedAsync();

      const report = await reportInAsync(projectRoot, [], env);

      expect(report.freshness!.changedFiles).toEqual({ total: 0, native: 0, js: 0, config: 0 });
      expect(
        report.freshness!.platforms.find(
          (entry) => entry.platform === 'ios' && entry.backend === 'local'
        )!.impact
      ).toMatchObject({ class: 'js-only', fingerprintChanged: false });
    });

    it('counts a JavaScript edit and keeps the class at js-only', async () => {
      const projectRoot = await setupCommittedAsync();
      await fs.promises.writeFile(path.join(projectRoot, 'index.js'), '// edited\n');

      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        { env }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('ios, android: js-only');
      expect(result.stdout).toMatch(/files\s+1 changed · 1 js · 0 config · 0 native/);
    });

    it('raises the class to dev-client-compatible for a metro.config.js edit', async () => {
      const projectRoot = await setupCommittedAsync();
      await fs.promises.writeFile(
        path.join(projectRoot, 'metro.config.js'),
        "const { getDefaultConfig } = require('expo/metro-config');\nmodule.exports = getDefaultConfig(__dirname);\n"
      );

      const report = await reportInAsync(projectRoot, [], env);

      expect(report.freshness!.changedFiles).toMatchObject({ total: 1, js: 1, config: 0 });
      expect(
        report.freshness!.platforms.find(
          (entry) => entry.platform === 'ios' && entry.backend === 'local'
        )!.impact
      ).toMatchObject({ class: 'dev-client-compatible', fingerprintChanged: false });
      expect(report.followups.map((followup) => followup.id)).toContain('change-restart-metro');
    });

    // The file-level view only runs where it can change the answer: a moved fingerprint already has
    // the stronger class, and with no record there is no class to refine.
    it.each([
      [
        'when the fingerprint moved',
        {
          STUB_FINGERPRINT_HASH: 'ffff1111ffff1111ffff1111ffff1111ffff1111',
          STUB_FP_SOURCES: JSON.stringify([
            APP_CONFIG,
            { type: 'dir', filePath: 'node_modules/x', reasons: ['rncoreAutolinkingIos'] },
          ]),
        },
        false,
      ],
      ['when nothing was recorded', env, true],
    ])('looks at no files %s', async (_case, runEnv, dropRecord) => {
      const projectRoot = await setupCommittedAsync();
      if (dropRecord) {
        await fs.promises.rm(lastBuildFilePath(projectRoot));
      }
      await fs.promises.writeFile(
        path.join(projectRoot, 'metro.config.js'),
        'module.exports = {};\n'
      );

      const report = await reportInAsync(projectRoot, [], runEnv);

      expect(report.freshness!.changedFiles).toBeNull();
    });
  });

  // @ref llp/0023-fingerprint-caching.rfc.md
  //
  // The whole subject is a number of subprocesses. A memo hit, a cache hit and a recomputation all
  // print the same hash, so the stub `fingerprint` bin's invocation log is what these assert on —
  // and the report line beside it, because an answer from a record must say so (llp/0021).
  describe('the fingerprint cache', () => {
    /** How many times the fingerprint CLI was spawned, and with which platforms. */
    function spawns(projectRoot: string): string[] {
      return readStubFingerprintInvocations(projectRoot).map((invocation) => {
        const index = invocation.args.indexOf('--platform');
        return index < 0 ? 'all' : invocation.args[index + 1]!;
      });
    }

    it('computes one fingerprint on a first default run', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');

      const report = await reportInAsync(projectRoot);

      expect(spawns(projectRoot)).toEqual(['all']);
      expect(report.freshness?.hashSource.source).toBe('computed');
      expect(report.freshness?.hashSource.revalidatedAgainst).toBeNull();
    });

    it('computes three fingerprints: the project, then one per platform', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      await linkFixtureToEasAsync(projectRoot);

      await reportInAsync(projectRoot, []);

      // The cost this wave is about. The project hash answers freshness; the EAS build lookup needs
      // a per-platform hash, because a build is made for one platform (`src/status/easBuilds.ts`).
      expect(spawns(projectRoot).sort()).toEqual(['all', 'android', 'ios']);
    });

    it('spawns nothing on the next run and says the answer came from a record', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      await reportInAsync(projectRoot, []);
      clearStubFingerprintInvocations(projectRoot);

      const report = await reportInAsync(projectRoot, []);

      expect(spawns(projectRoot)).toEqual([]);
      expect(report.freshness?.hash).toBe(FIXTURE_FINGERPRINT_HASH);
      expect(report.freshness?.hashSource.source).toBe('cache');
      expect(report.freshness!.hashSource.revalidatedAgainst!).toBeGreaterThan(0);
      expect(report.freshness?.hashSource.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // Never silent about what the revalidation could not cover.
      expect(report.freshness!.hashSource.caveats.join('\n')).toMatch(/node_modules/);
    });

    it('says so in the human report too, with the count and the way out', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      await reportInAsync(projectRoot);

      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--dev-server-url',
        await getUnusedDevServerUrlAsync(),
      ]);

      expect(result.exitCode).toBe(0);
      // The kind of check, the count, and the age — the three facts that make a cached answer
      // weighable rather than merely disclosed (llp/0023 §The report says where the answer came from).
      expect(result.stdout).toMatch(
        /from cache, revalidated by mtime\+size of \d+ files?, cached \d+[smh]/
      );
      expect(result.stdout).toContain('--no-fingerprint-cache');
      // Never a stronger claim than the check that ran.
      expect(result.stdout).not.toMatch(/content hash|sha256/i);
    });

    it('recomputes after the app config is touched', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      await reportInAsync(projectRoot);
      clearStubFingerprintInvocations(projectRoot);

      const configPath = path.join(projectRoot, 'app.json');
      const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
      config.expo.orientation = 'landscape';
      await fs.promises.writeFile(configPath, JSON.stringify(config));

      const report = await reportInAsync(projectRoot);

      expect(spawns(projectRoot)).toEqual(['all']);
      expect(report.freshness?.hashSource.source).toBe('computed');
    });

    it('recomputes after a lockfile appears', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      await reportInAsync(projectRoot);
      clearStubFingerprintInvocations(projectRoot);

      // A sentinel the project did not have. A key that *gained* an entry is a miss, because a
      // project that grew a lockfile changed what its node_modules is a function of.
      await fs.promises.writeFile(
        path.join(projectRoot, 'package-lock.json'),
        '{"lockfileVersion":3}'
      );

      await reportInAsync(projectRoot);

      expect(spawns(projectRoot)).toEqual(['all']);
    });

    it('still answers from the record after a file no sentinel names is touched', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      await reportInAsync(projectRoot);
      clearStubFingerprintInvocations(projectRoot);

      // JavaScript is not a fingerprint source, and the whole point of the pinned set is that a
      // change to it costs nothing.
      await fs.promises.writeFile(path.join(projectRoot, 'index.js'), '// edited\n');

      const report = await reportInAsync(projectRoot);

      expect(spawns(projectRoot)).toEqual([]);
      expect(report.freshness?.hashSource.source).toBe('cache');
    });

    it('recomputes after the fingerprint CLI is upgraded', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      await reportInAsync(projectRoot);
      clearStubFingerprintInvocations(projectRoot);

      // A hash from another version of the tool is not comparable with this one
      // (llp/0001 §Constraints item 5), so the entry is dropped rather than believed.
      const manifestPath = path.join(
        projectRoot,
        'node_modules',
        '@expo',
        'fingerprint',
        'package.json'
      );
      const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
      manifest.version = '0.21.0';
      await fs.promises.writeFile(manifestPath, JSON.stringify(manifest));

      const report = await reportInAsync(projectRoot);

      expect(spawns(projectRoot)).toEqual(['all']);
      expect(report.freshness?.hashSource.source).toBe('computed');
    });

    it('recomputes when --no-fingerprint-cache is passed', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      await reportInAsync(projectRoot);
      clearStubFingerprintInvocations(projectRoot);

      const report = await reportInAsync(projectRoot, ['--no-fingerprint-cache']);

      expect(spawns(projectRoot)).toEqual(['all']);
      expect(report.freshness?.hashSource.source).toBe('computed');
    });

    it('recomputes when AGENT_CLI_NO_FINGERPRINT_CACHE is set', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      await reportInAsync(projectRoot);
      clearStubFingerprintInvocations(projectRoot);

      // The variable is for the paths that have no flag of their own — a probe inside another
      // command — so it has to work on the ones that do as well.
      const report = await reportInAsync(projectRoot, [], { AGENT_CLI_NO_FINGERPRINT_CACHE: '1' });

      expect(spawns(projectRoot)).toEqual(['all']);
      expect(report.freshness?.hashSource.source).toBe('computed');
    });

    it('writes the record under .expo, keyed per platform', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      await linkFixtureToEasAsync(projectRoot);

      await reportInAsync(projectRoot, []);

      const record = JSON.parse(
        await fs.promises.readFile(
          path.join(projectRoot, '.expo', 'agent-cli-fingerprint.json'),
          'utf8'
        )
      );
      expect(Object.keys(record.entries).sort()).toEqual([
        'all|default',
        'android|default',
        'ios|default',
      ]);
      expect(Object.keys(record.entries['all|default'].keyManifest.files)).toEqual(
        expect.arrayContaining(['package.json', 'app.json', '.gitignore'])
      );
    });

    // @ref llp/0023-fingerprint-caching.rfc.md §The native directories are not pinned
    //
    // `ios/` and `android/` are outside the key [decided, 2026-08-27], and bare projects are
    // cached like any other. So a nested native edit is **not** seen here, and the record's
    // ten-minute expiry is the whole of what catches it. These cases assert that as intended
    // behaviour, through the published CLI, so the day the TTL or the key changes the tests say
    // which one moved.
    describe('a project with committed native directories', () => {
      /** `dev-client-fresh-app` plus native directories: a fixture with both is not committed. */
      async function setupBareAsync(): Promise<string> {
        const projectRoot = await setupAsync('dev-client-fresh-app');
        await fs.promises.mkdir(path.join(projectRoot, 'ios', 'App'), { recursive: true });
        await fs.promises.writeFile(
          path.join(projectRoot, 'ios', 'App', 'AppDelegate.swift'),
          'import UIKit\n'
        );
        return projectRoot;
      }

      it('answers from the record when the native tree is unchanged', async () => {
        const projectRoot = await setupBareAsync();
        await reportInAsync(projectRoot);
        clearStubFingerprintInvocations(projectRoot);

        const report = await reportInAsync(projectRoot);

        expect(spawns(projectRoot)).toEqual([]);
        expect(report.freshness?.hashSource.source).toBe('cache');
      });

      it('does not see a nested native edit, and says the expiry is what covers it', async () => {
        const projectRoot = await setupBareAsync();
        await reportInAsync(projectRoot);
        clearStubFingerprintInvocations(projectRoot);

        await fs.promises.writeFile(
          path.join(projectRoot, 'ios', 'App', 'AppDelegate.swift'),
          'import UIKit\n// a native change no lockfile records\n'
        );

        const report = await reportInAsync(projectRoot);

        // A hit, on purpose. The honest half is that the report names the gap rather than hiding it.
        expect(spawns(projectRoot)).toEqual([]);
        expect(report.freshness?.hashSource.source).toBe('cache');
        expect(report.freshness!.hashSource.caveats.join('\n')).toMatch(/ios\/ and android\//);
      });

      it('costs a bare project nothing to revalidate, however large its native tree', async () => {
        const projectRoot = await setupBareAsync();
        await reportInAsync(projectRoot);
        clearStubFingerprintInvocations(projectRoot);

        // Nothing under `ios/` is stat-ed, so a Pods tree — tens of thousands of files on a real
        // project — is neither read nor a reason to recompute. That is the saving the decision to
        // leave the native directories out of the key buys, and its cost is the case above.
        await fs.promises.mkdir(path.join(projectRoot, 'ios', 'Pods'), { recursive: true });
        await fs.promises.writeFile(
          path.join(projectRoot, 'ios', 'Pods', 'Manifest.lock'),
          'PODS: []\n'
        );

        expect((await reportInAsync(projectRoot)).freshness?.hashSource.source).toBe('cache');
        expect(spawns(projectRoot)).toEqual([]);
      });
    });
  });
});
