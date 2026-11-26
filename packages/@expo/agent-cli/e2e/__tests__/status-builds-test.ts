// @ref llp/0004-smart-start-and-project-state.rfc.md §Status
//
// `status`: `status --build <id>` and the EAS build lookup.
// The tests run it through the CLI it is published as, against the fixture matrix in
// `e2e/fixtures/README.md`. Shared helpers live in `statusFixtures.ts`.

import fs from 'node:fs';
import path from 'node:path';

import {
  installStubEasAsync as installSharedStubEasAsync,
  STUB_EAS_LOG_NAME,
  stubEasCommands,
} from '../stubEas';
import { executeAgentCliAsync, lastBuildFilePath } from '../utils';
import {
  type StatusReport,
  FIXTURE_FINGERPRINT_HASH,
  setupAsync,
  getUnusedDevServerUrlAsync,
  reportInAsync,
  pinEasCliAsync,
  installEnvFingerprintStubAsync,
} from './statusFixtures';

describe('@expo/agent-cli status', () => {
  // @ref llp/0011-impact-and-freshness.rfc.md §The three comparisons
  // @ref llp/0021-honest-reports.rfc.md §The rules
  describe('status --build <id>', () => {
    const BUILD_ID = '21d7d434-6495-4e74-b8c7-68ecd0dff489';
    const NATIVE_MODULE = {
      type: 'dir',
      filePath: 'node_modules/react-native-mmkv',
      reasons: ['rncoreAutolinkingIos'],
      hash: 'aabb',
    };
    const APP_CONFIG = { type: 'file', filePath: 'app.json', reasons: ['expoConfig'], hash: 'cc' };

    /** `fingerprint1` is the build's fingerprint, `fingerprint2` the working tree's. */
    function comparePayload(buildSources: unknown[], headSources: unknown[]) {
      return JSON.stringify({
        fingerprint1: { hash: 'build-hash-1111', sources: buildSources },
        fingerprint2: {
          hash:
            JSON.stringify(buildSources) === JSON.stringify(headSources)
              ? 'build-hash-1111'
              : 'head-hash-2222',
          sources: headSources,
        },
      });
    }

    async function setupCompareAsync(): Promise<string> {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      await installEnvFingerprintStubAsync(projectRoot, { diff: true });
      await fs.promises.writeFile(
        lastBuildFilePath(projectRoot),
        JSON.stringify({
          ios: { hash: FIXTURE_FINGERPRINT_HASH, sources: [APP_CONFIG] },
          android: { hash: FIXTURE_FINGERPRINT_HASH, sources: [APP_CONFIG] },
        })
      );
      await installSharedStubEasAsync(projectRoot);
      await pinEasCliAsync(projectRoot);
      return projectRoot;
    }

    async function runBuildAsync(
      projectRoot: string,
      args: string[],
      env: Record<string, string> = {}
    ) {
      return executeAgentCliAsync(
        projectRoot,
        [
          'status',
          '--build',
          BUILD_ID,
          ...args,
          '--dev-server-url',
          await getUnusedDevServerUrlAsync(),
        ],
        { env: { STUB_FP_SOURCES: JSON.stringify([APP_CONFIG]), ...env }, reject: false }
      );
    }

    function easAxis(report: StatusReport, platform: 'ios' | 'android') {
      return report.freshness!.platforms.find(
        (entry) => entry.platform === platform && entry.backend === 'eas'
      )!;
    }

    it("compares against the named build, on that build's platform only", async () => {
      const projectRoot = await setupCompareAsync();

      const result = await runBuildAsync(projectRoot, ['--json'], {
        STUB_EAS_COMPARE_JSON: comparePayload([APP_CONFIG], [APP_CONFIG]),
      });

      expect(result.exitCode).toBe(0);
      const report: StatusReport = JSON.parse(result.stdout);
      expect(report.freshness!.comparison).toEqual({
        kind: 'eas-build',
        label: `EAS build ${BUILD_ID}`,
        buildId: BUILD_ID,
        platform: 'ios',
      });
      expect(easAxis(report, 'ios')).toMatchObject({
        state: 'fresh',
        buildId: BUILD_ID,
        detail: `matches EAS build ${BUILD_ID}`,
        impact: { class: 'js-only', fingerprintChanged: false, changedCount: 0 },
      });
      expect(easAxis(report, 'android')).toMatchObject({ state: 'unknown', buildId: null });
      expect(easAxis(report, 'android').detail).toContain('not compared');
      expect(easAxis(report, 'android').impact?.class).toBeNull();
      expect(
        report.freshness!.platforms.find(
          (entry) => entry.platform === 'ios' && entry.backend === 'local'
        )
      ).toMatchObject({ state: 'fresh', buildId: null });
      expect(report.errors).toEqual({});
    });

    it('reports what differs from the named build, and what that costs', async () => {
      const projectRoot = await setupCompareAsync();

      const result = await runBuildAsync(projectRoot, ['--json'], {
        STUB_EAS_COMPARE_JSON: comparePayload([APP_CONFIG], [APP_CONFIG, NATIVE_MODULE]),
      });

      expect(result.exitCode).toBe(0);
      const report: StatusReport = JSON.parse(result.stdout);
      expect(easAxis(report, 'ios')).toMatchObject({
        state: 'stale',
        detail: `differs from EAS build ${BUILD_ID}`,
        impact: { class: 'needs-native-build', fingerprintChanged: true, changedCount: 1 },
      });
      expect(easAxis(report, 'ios').impact!.changedSources).toEqual([
        expect.objectContaining({ op: 'added', path: 'node_modules/react-native-mmkv' }),
      ]);
    });

    it('says which build the headline was measured against, for a human', async () => {
      const projectRoot = await setupCompareAsync();

      const result = await runBuildAsync(projectRoot, [], {
        STUB_EAS_COMPARE_JSON: comparePayload([APP_CONFIG], [APP_CONFIG, NATIVE_MODULE]),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`vs EAS build ${BUILD_ID}`);
      expect(result.stdout).toContain('ios (eas): needs-native-build');
      expect(result.stdout).toContain(`differs from EAS build ${BUILD_ID}`);
    });

    it('judges only the eas axis under --assert', async () => {
      const projectRoot = await setupCompareAsync();

      const differs = await runBuildAsync(projectRoot, ['--assert', 'js-only'], {
        STUB_EAS_COMPARE_JSON: comparePayload([APP_CONFIG], [APP_CONFIG, NATIVE_MODULE]),
      });
      expect(differs.exitCode).toBe(20);
      expect(differs.stdout).toContain('the change costs needs-native-build');

      // A native change in the working tree: only the local axis would fail the gate. The hash the
      // run above remembered would hide it, so it is computed again.
      const matches = await runBuildAsync(
        projectRoot,
        ['--json', '--assert', 'js-only', '--no-fingerprint-cache'],
        {
          STUB_EAS_COMPARE_JSON: comparePayload([APP_CONFIG], [APP_CONFIG]),
          STUB_FP_SOURCES: JSON.stringify([APP_CONFIG, NATIVE_MODULE]),
          STUB_FINGERPRINT_HASH: 'f'.repeat(40),
        }
      );
      expect(matches.exitCode).toBe(0);
      const report: StatusReport = JSON.parse(matches.stdout);
      expect(
        report.freshness!.platforms.find((entry) => entry.backend === 'local')?.impact?.class
      ).toBe('needs-native-build');
    });

    it('attributes the comparison to no platform when the build platform is unknown', async () => {
      const projectRoot = await setupCompareAsync();

      const result = await runBuildAsync(projectRoot, ['--json', '--assert', 'js-only'], {
        STUB_EAS_COMPARE_JSON: comparePayload([APP_CONFIG], [APP_CONFIG]),
        STUB_EAS_BUILD_VIEW_EXIT: '1',
      });

      expect(result.exitCode).toBe(22);
      const report: StatusReport = JSON.parse(result.stdout);
      expect(report.freshness!.comparison.platform).toBeNull();
      for (const platform of ['ios', 'android'] as const) {
        expect(easAxis(report, platform).detail).toContain('not compared');
        expect(easAxis(report, platform).impact?.class).toBeNull();
      }
    });

    it('notes the failure and names the build when the comparison fails', async () => {
      const projectRoot = await setupCompareAsync();

      const result = await runBuildAsync(projectRoot, [], { STUB_EAS_COMPARE_EXIT: '1' });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('freshness note');
      expect(result.stdout).toContain(BUILD_ID);
      expect(result.stdout).toContain('project     dev-client-fresh-app');

      const json = await runBuildAsync(projectRoot, ['--json'], { STUB_EAS_COMPARE_EXIT: '1' });
      expect(json.exitCode).toBe(0);
      const report: StatusReport = JSON.parse(json.stdout);
      expect(report.errors.freshness).toContain(BUILD_ID);
      // F66: the comparison is named before the call, so a failed call still says which build.
      expect(report.freshness!.comparison).toMatchObject({ kind: 'eas-build', buildId: BUILD_ID });
    });
  });

  // @ref llp/0011-impact-and-freshness.rfc.md §The build-cache lookup
  //
  // A remembered answer and an unlinked project spawn no `eas build:list`; a cold run of a linked
  // project spawns it once per platform. Pinned by counting what crossed the process boundary.
  describe('the EAS build lookup', () => {
    /** The per-platform hashes the stub prints, which is what an EAS build carries. */
    const IOS_HASH = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';
    const ANDROID_HASH = 'ffff6666eeee7777dddd8888cccc9999bbbb0000';
    const BUILD_ID = '21d7d434-6495-4e74-b8c7-68ecd0dff489';

    /** One finished build, in the shape the recorded `build:list` payload has. */
    const FINISHED_BUILD = {
      id: BUILD_ID,
      status: 'FINISHED',
      platform: 'IOS',
      buildProfile: 'simulator',
      createdAt: '2026-08-19T17:37:12.674Z',
      artifacts: { buildUrl: 'https://expo.dev/artifacts/eas/abc.tar.gz' },
    };

    /** Copy the fixture and install both stubs over the ones `setupAsync` put there. */
    async function setupWithEasAsync(
      fixture = 'dev-client-fresh-app',
      { linked = true }: { linked?: boolean } = {}
    ): Promise<string> {
      const projectRoot = await setupAsync(fixture);
      // A different hash per platform, the way the real bin answers. This is the fact the whole
      // design turns on: the project hash covers both platforms and is not a hash any build carries.
      // Live, on one working tree: `031f6b0c…` for the project and `8ce1acfb…` for iOS [observed —
      // apps/observe-tester, 2026-08-26].
      await installEnvFingerprintStubAsync(projectRoot, {
        platformHashes: { ios: IOS_HASH, android: ANDROID_HASH },
      });
      // The shared stub `eas` (`e2e/stubs/eas.js`; the `STUB_EAS_*` variables below are documented
      // there), behind one runner because there is one rung; and the pin, so the EAS CLI is what
      // answers `whoami`.
      await installSharedStubEasAsync(projectRoot, { linked });
      await pinEasCliAsync(projectRoot);
      return projectRoot;
    }

    /** The commands the stub `eas` was asked for, in order. */
    const easCommands = stubEasCommands;

    function iosOf(report: StatusReport) {
      return report.builds!.platforms.find((platform) => platform.platform === 'ios')!;
    }

    it('asks EAS about both platforms on a plain run, and says it did', async () => {
      const projectRoot = await setupWithEasAsync();

      const report = await reportInAsync(projectRoot);

      expect(report.builds?.askedEas).toBe(true);
      expect(report.builds?.platforms.map((platform) => platform.state)).toEqual(['none', 'none']);
      expect(easCommands(projectRoot).filter((command) => command === 'build:list')).toHaveLength(
        2
      );
    });

    it('prints the eas build line with the answer, even when it is none', async () => {
      const projectRoot = await setupWithEasAsync();
      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--dev-server-url',
        await getUnusedDevServerUrlAsync(),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('eas build');
      expect(result.stdout).toContain('ios: none');
    });

    // The freshness rows already carry the reason; a line of two `unknown`s would repeat it.
    it('leaves the eas build line out of the human report of an unlinked project', async () => {
      const projectRoot = await setupWithEasAsync('dev-client-fresh-app', { linked: false });
      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--dev-server-url',
        await getUnusedDevServerUrlAsync(),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('eas build');
      expect(result.stdout).toContain('not linked to an EAS project');
    });

    it('asks EAS about the per-platform fingerprint, and reports the hit', async () => {
      const projectRoot = await setupWithEasAsync();

      const report = await reportInAsync(projectRoot, [], {
        STUB_EAS_BUILD_LIST: JSON.stringify([FINISHED_BUILD]),
      });

      expect(report.builds?.askedEas).toBe(true);
      expect(iosOf(report)).toMatchObject({
        state: 'found',
        source: 'eas',
        buildId: BUILD_ID,
        buildProfile: 'simulator',
        createdAt: '2026-08-19T17:37:12.674Z',
        buildUrl: 'https://expo.dev/artifacts/eas/abc.tar.gz',
        // The per-platform hash, not `freshness.hash`, which is the project's and is unchanged.
        fingerprintHash: IOS_HASH,
      });
      expect(report.freshness?.hash).toBe(FIXTURE_FINGERPRINT_HASH);
      expect(
        report.builds!.platforms.find((platform) => platform.platform === 'android')
          ?.fingerprintHash
      ).toBe(ANDROID_HASH);
    });

    // @ref llp/0021-honest-reports.rfc.md §The rules — K7(b) and K7(d). The report
    // called this project `ios: stale (no recorded build)` while EAS held a development-simulator
    // build made from this exact fingerprint [observed — cloud loop, 2026-08-27].
    it('reports a matching EAS build as fresh on the eas axis, and names it', async () => {
      const projectRoot = await setupWithEasAsync();

      const report = await reportInAsync(projectRoot, [], {
        STUB_EAS_BUILD_LIST: JSON.stringify([FINISHED_BUILD]),
      });

      const axis = (platform: string, backend: string) =>
        report.freshness!.platforms.find(
          (entry) => entry.platform === platform && entry.backend === backend
        )!;

      expect(axis('ios', 'eas')).toMatchObject({
        state: 'fresh',
        buildId: BUILD_ID,
        buildProfile: 'simulator',
      });
      expect(axis('ios', 'eas').detail).toContain('simulator build');
      // The local axis answers its own question, from this project's own record, and never carries
      // an EAS build: the two are reported apart, which is the whole point of the split.
      expect(axis('ios', 'local').buildId).toBeNull();
      expect(axis('ios', 'local').detail).not.toContain('simulator');
      // The stub answers the same list for both platforms, so android's axis is fresh too; what
      // matters is that the two axes are reported apart.
      expect(axis('android', 'eas').state).toBe('fresh');
    });

    it('says on the eas axis when EAS was asked and has nothing', async () => {
      const projectRoot = await setupWithEasAsync();

      const report = await reportInAsync(projectRoot, [], {
        STUB_EAS_BUILD_LIST: '[]',
      });

      const iosEas = report.freshness!.platforms.find(
        (entry) => entry.platform === 'ios' && entry.backend === 'eas'
      )!;
      expect(iosEas).toMatchObject({ state: 'stale', buildId: null });
      expect(iosEas.detail).toContain('no finished build');
    });

    it('pins the argv of the lookup that crossed the process boundary', async () => {
      const projectRoot = await setupWithEasAsync();
      await reportInAsync(projectRoot, []);

      const invocations = fs
        .readFileSync(path.join(projectRoot, STUB_EAS_LOG_NAME), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { args: string[] }).args);

      expect(invocations).toContainEqual([
        'build:list',
        '--platform',
        'ios',
        '--fingerprint-hash',
        IOS_HASH,
        '--status',
        'finished',
        '--limit',
        '1',
        '--json',
        '--non-interactive',
      ]);
    });

    // A saved `dev --eas` request makes the plan ask for a simulator build. The builds section
    // already asked EAS, so the plan asks again only when that answer cannot settle it: a build of
    // another profile, where a simulator build may still exist.
    it.each([
      [
        'a simulator build the section found',
        [{ ...FINISHED_BUILD, buildProfile: 'development-simulator' }],
        2,
      ],
      ['no build', [], 2],
      ['a build of another profile', [FINISHED_BUILD], 3],
    ])(
      'asks EAS once per platform for a saved --eas request beside %s',
      async (_case, builds, lookups) => {
        const projectRoot = await setupWithEasAsync('dev-client-app');
        await fs.promises.mkdir(path.join(projectRoot, '.expo'), { recursive: true });
        await fs.promises.writeFile(
          path.join(projectRoot, '.expo', 'agent-cli-last-dev.json'),
          JSON.stringify({
            version: 1,
            platform: 'ios',
            port: null,
            buildBackend: 'eas',
            runTarget: null,
          })
        );

        await reportInAsync(projectRoot, [], { STUB_EAS_BUILD_LIST: JSON.stringify(builds) });

        expect(easCommands(projectRoot).filter((command) => command === 'build:list')).toHaveLength(
          lookups
        );
      }
    );

    // The other half of the decision: a hit is written against the *project* fingerprint, so the
    // next run answers it for free. A cache that still spawned would be no cache at all.
    it('answers a second run from the cache, spawning no lookup at all', async () => {
      const projectRoot = await setupWithEasAsync();
      await reportInAsync(projectRoot, [], {
        STUB_EAS_BUILD_LIST: JSON.stringify([FINISHED_BUILD]),
      });
      await fs.promises.rm(path.join(projectRoot, STUB_EAS_LOG_NAME));

      const report = await reportInAsync(projectRoot);

      expect(iosOf(report)).toMatchObject({ state: 'found', source: 'cache', buildId: BUILD_ID });
      expect(easCommands(projectRoot)).toEqual(['whoami']);
    });

    it('stops trusting the cached answer once the project fingerprint moves', async () => {
      const projectRoot = await setupWithEasAsync();
      await reportInAsync(projectRoot, [], {
        STUB_EAS_BUILD_LIST: JSON.stringify([FINISHED_BUILD]),
      });

      // Two changes, and both are the point. `STUB_FINGERPRINT_HASH` is what makes the stub print a
      // different hash, and `app.json` is what makes the *fingerprint* cache recompute at all: an
      // environment variable is not a file, so a run that only set it would be answered out of
      // `.expo/agent-cli-fingerprint.json` with the old hash and this section's cache would still
      // match (llp/0023 §What invalidates an answer). A real project moves its hash by changing a
      // file, which is what the second line stands in for.
      const configPath = path.join(projectRoot, 'app.json');
      const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
      config.expo.orientation = 'landscape';
      await fs.promises.writeFile(configPath, JSON.stringify(config));

      const report = await reportInAsync(projectRoot, [], {
        STUB_FINGERPRINT_HASH: 'aaaabbbbccccddddeeeeffff0000111122223333',
      });

      // Asked again, rather than answered from a record keyed on a hash the project no longer has.
      expect(iosOf(report)).toMatchObject({ state: 'none', source: 'eas' });
      expect(easCommands(projectRoot)).toContain('build:list');
    });

    it('reports none when EAS answered and has no build for the fingerprint', async () => {
      const projectRoot = await setupWithEasAsync();

      const report = await reportInAsync(projectRoot, []);

      expect(iosOf(report)).toMatchObject({
        state: 'none',
        source: 'eas',
        reason: expect.any(String),
      });
    });

    // The live case: `notesapp` has no EAS link, and the CLI refuses on stdout with exit 1.
    it('reports a project with no EAS link as unknown, and still exits 0', async () => {
      const projectRoot = await setupWithEasAsync();
      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--json', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        {
          env: {
            STUB_EAS_BUILD_LIST_EXIT: '1',
            STUB_EAS_BUILD_LIST_STDOUT:
              'EAS project not configured. This command cannot configure it in non-interactive mode.',
          },
        }
      );

      expect(result.exitCode).toBe(0);
      const report: StatusReport = JSON.parse(result.stdout);
      // @ref llp/0027-everything-on-eas.rfc.md §What EAS said — in this CLI's words, with the fix,
      // rather than the first line of the EAS CLI's explanation with the rest cut off.
      expect(iosOf(report)).toMatchObject({ state: 'unknown' });
      expect(iosOf(report).reason).toContain('not linked to an EAS project');
      expect(iosOf(report).reason).toContain('npx --yes eas-cli init --account');
      expect(report.errors).toEqual({});
    });

    // The auth section already answered this, so the lookup asks nobody a second time.
    it('reports a signed-out machine as unknown without calling eas build:list', async () => {
      const projectRoot = await setupWithEasAsync();

      const report = await reportInAsync(projectRoot, [], { STUB_EAS_WHOAMI_EXIT: '1' });

      expect(report.auth?.loggedIn).toBe(false);
      expect(iosOf(report)).toMatchObject({ state: 'unknown' });
      expect(iosOf(report).reason).toContain('not signed in');
      expect(easCommands(projectRoot)).toEqual(['whoami']);
    });

    it('names the download command on the human line and in the follow-ups when the build is stale', async () => {
      const projectRoot = await setupWithEasAsync();
      const env = {
        STUB_EAS_BUILD_LIST: JSON.stringify([FINISHED_BUILD]),
        // The project's own recorded build no longer matches, so a rebuild was the alternative.
        STUB_FINGERPRINT_HASH: 'aaaabbbbccccddddeeeeffff0000111122223333',
      };
      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        { env }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('eas build');
      expect(result.stdout).toContain(`npx --yes eas-cli build:download --build-id ${BUILD_ID}`);

      const report = await reportInAsync(projectRoot, [], env);
      expect(report.followups.map((followup) => followup.id)).toContain('cached-build');
    });

    // @ref llp/0011-impact-and-freshness.rfc.md §What `status` remembers of the answer
    it('remembers a none for a while, and says how old it is', async () => {
      const projectRoot = await setupWithEasAsync();
      await reportInAsync(projectRoot, []);
      await fs.promises.rm(path.join(projectRoot, STUB_EAS_LOG_NAME));

      const report = await reportInAsync(projectRoot, []);

      expect(iosOf(report)).toMatchObject({ state: 'none', source: 'cache' });
      expect(iosOf(report).checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(iosOf(report).ageMs).toBeGreaterThanOrEqual(0);
      // The auth section still asks `whoami`; the lookup asks nothing.
      expect(easCommands(projectRoot)).toEqual(['whoami']);

      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--dev-server-url',
        await getUnusedDevServerUrlAsync(),
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/none \(as of \d+[smh]/);
    });

    it('asks EAS again once the remembered none is older than its bound', async () => {
      const projectRoot = await setupWithEasAsync();
      await reportInAsync(projectRoot, []);
      await fs.promises.rm(path.join(projectRoot, STUB_EAS_LOG_NAME));

      const recordPath = path.join(projectRoot, '.expo', 'agent-cli-eas-builds.json');
      const record = JSON.parse(await fs.promises.readFile(recordPath, 'utf8'));
      const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      for (const platform of Object.keys(record)) {
        record[platform].checkedAt = old;
      }
      await fs.promises.writeFile(recordPath, JSON.stringify(record));

      const report = await reportInAsync(projectRoot, []);

      expect(iosOf(report)).toMatchObject({ state: 'none', source: 'eas' });
      expect(easCommands(projectRoot)).toContain('build:list');
    });

    // @ref llp/0023-fingerprint-caching.rfc.md §Every consumer can turn it off
    it('asks EAS again under --no-fingerprint-cache, whatever the record remembers', async () => {
      const projectRoot = await setupWithEasAsync();
      await reportInAsync(projectRoot, [], {
        STUB_EAS_BUILD_LIST: JSON.stringify([FINISHED_BUILD]),
      });
      await fs.promises.rm(path.join(projectRoot, STUB_EAS_LOG_NAME));

      const report = await reportInAsync(projectRoot, ['--no-fingerprint-cache'], {
        STUB_EAS_BUILD_LIST: JSON.stringify([FINISHED_BUILD]),
      });

      expect(iosOf(report)).toMatchObject({ state: 'found', source: 'eas' });
      expect(easCommands(projectRoot)).toContain('build:list');
    });

    it('skips the lookup for a project whose app.json names no EAS project, and names eas init', async () => {
      const projectRoot = await setupWithEasAsync('dev-client-fresh-app', { linked: false });

      const report = await reportInAsync(projectRoot, []);

      expect(report.builds?.platforms.map((platform) => platform.state)).toEqual([
        'unknown',
        'unknown',
      ]);
      expect(iosOf(report).reason).toContain('not linked to an EAS project');
      expect(iosOf(report).reason).toContain('app.json names no extra.eas.projectId');
      expect(iosOf(report).reason).toContain('eas-cli init --account e2e-user --non-interactive');
      expect(easCommands(projectRoot)).toEqual(['whoami']);
      expect(report.errors).toEqual({});
    });

    // The dynamic config is evaluated with the project's env files, so its answer is believed.
    it.each([
      { env: 'EAS_PROJECT_ID=proj-from-env\n', state: 'none', commands: ['whoami', 'build:list'] },
      { env: null, state: 'unknown', commands: ['whoami'] },
    ])(
      'reads the EAS project a dynamic config evaluates to (.env: $env)',
      async ({ env, state, commands }) => {
        const projectRoot = await setupWithEasAsync('dev-client-fresh-app', { linked: false });
        await fs.promises.writeFile(
          path.join(projectRoot, 'app.config.js'),
          'module.exports = ({ config }) => ({ ...config, extra: { eas: { projectId: process.env.EAS_PROJECT_ID } } });\n'
        );
        if (env != null) {
          await fs.promises.writeFile(path.join(projectRoot, '.env'), env);
        }

        const report = await reportInAsync(projectRoot, []);

        expect(iosOf(report).state).toBe(state);
        expect([...new Set(easCommands(projectRoot))]).toEqual(commands);
      }
    );
  });
});
