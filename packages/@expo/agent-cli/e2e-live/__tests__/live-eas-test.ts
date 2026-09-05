// @ref llp/0022-live-tier.plan.md §live-eas
//
// The EAS half of the live tier, against the **expo-ci** CI account. Every invocation goes through
// `runLiveEasAsync`, which asserts the `AGENT_CLI_LIVE_EAS=1` opt-in at the call site — see
// `prereq.ts` §assertEasEnabled. The account is pinned in the committed `apps/eas-example` owner and
// asserted by `easProjectGate`, which is the safety that replaced the staging sandbox.
//
// @ref llp/0022-live-tier.plan.md §Limits — its EAS bugs were all in code with a passing unit test
// one call frame away, and this is the tier that runs the real service.
//
// The budget this suite spends:
//
//  - **Reads are free and repeated.** `whoami`, `status --explain`, `inspect:build-log`.
//  - **One write per run, and it is idempotent.** `deploy --web`. EAS Hosting gives each deploy its
//    own preview URL, so re-running adds a deployment and changes nothing that existed.
//  - **No native build.** The suite reads builds; it does not make them (that is the
//    `agent-cli-eas-build` EAS workflow's job).
//
// It reads `apps/eas-example` **in place** — a committed, expo-ci-linked app with a seeded FINISHED
// build (matched by fingerprint) and a seeded ERRORED build (for `inspect:build-log`). The CLI only
// writes gitignored `.expo/` and `dist/` there, so there is nothing to copy and no external asset.

import fs from 'node:fs';
import path from 'node:path';

import {
  allOf,
  builtBinGate,
  describeLive,
  easCiGate,
  easProjectGate,
  networkGate,
  packageRunnerGate,
} from '../prereq';
import {
  LiveRun,
  downloadBuildLogAsync,
  execAsync,
  expectExit,
  httpBodyAsync,
  httpStatusAsync,
  parseJson,
  runLiveEasAsync,
} from '../utils';

const easCi = easCiGate();
const easProject = easProjectGate();
const gate = allOf(
  builtBinGate(),
  easCi.gate,
  packageRunnerGate(),
  networkGate(),
  easProject.gate
);

describeLive('live-eas', gate)('live-eas: the real service, on expo-ci', () => {
  const run = new LiveRun('live-eas');
  // Read and deploy both run against the committed example, in place.
  const projectRoot = easProject.source ?? '';
  const readProjectRoot = projectRoot;
  const deployProjectRoot = projectRoot;

  beforeAll(async () => {
    run.prepare();
    // Nothing to scaffold or install: the example is a committed app with node_modules from the
    // workspace. The CLI writes only `.expo/` and `dist/`, both gitignored, so cleanup removes those
    // rather than a scratch tree.
    run.onCleanup('scratch state', () => {
      if (!process.env.AGENT_CLI_LIVE_KEEP) {
        fs.rmSync(path.join(projectRoot, '.expo'), { recursive: true, force: true });
        fs.rmSync(path.join(projectRoot, 'dist'), { recursive: true, force: true });
      }
    });
  }, 600_000);

  afterAll(async () => {
    await run.cleanUpAsync();
    console.log(run.costLine());
  });

  it('reads a CI-owned app, and never a personal account', () => {
    // The safety that replaced the staging sandbox: the gate only resolved a source whose committed
    // owner is the CI account, so every EAS op below is pinned to it.
    const owner = JSON.parse(fs.readFileSync(path.join(projectRoot, 'app.json'), 'utf8')).expo.owner;
    expect(owner).toBe('expo-ci');
  });

  // --- identity -----------------------------------------------------------------------------------

  it('whoami answers logged in, as the account the run authenticates with', async () => {
    const result = await runLiveEasAsync(run, readProjectRoot, ['whoami', '--json'], {
      label: 'whoami',
    });
    expectExit(result, 0);
    const report = parseJson(result);
    expect(report.loggedIn).toBe(true);
    // Locally the gate read the session's username; under EXPO_TOKEN in CI it is not knowable ahead
    // of time, so it is only asserted when the gate had it.
    if (easCi.user) {
      expect(report.user).toBe(easCi.user);
    }
  });

  it('status reports the same identity its own whoami does', async () => {
    const result = await runLiveEasAsync(run, readProjectRoot, ['status', '--json'], {
      label: 'status-auth',
    });
    expectExit(result, 0);
    const report = parseJson(result);
    // F65: `status` said "auth unknown (nothing could answer)" on a machine whose session was on
    // disk and whose own `whoami` read it. Two commands, one answer.
    expect(report.auth.loggedIn).toBe(true);
    if (easCi.user) {
      expect(report.auth.user).toBe(easCi.user);
    }
  });

  // --- the build read side ------------------------------------------------------------------------

  it('status --explain asks EAS, and every row it comes back with keeps its contract', async () => {
    const result = await runLiveEasAsync(run, readProjectRoot, ['status', '--explain', '--json'], {
      label: 'status-explain',
    });
    // Never fails a command: every way of not getting an answer is an `unknown` with a reason, and
    // the section costs one line of the report rather than the exit code.
    expectExit(result, 0);
    const report = parseJson(result);
    expect(report.builds.askedEas).toBe(true);
    expect(report.builds.platforms.map((p: any) => p.platform).sort()).toEqual(['android', 'ios']);

    for (const platform of report.builds.platforms) {
      // Whatever the service said, the hash asked about is a real per-platform fingerprint hash from
      // the real @expo/fingerprint the project resolved — which is what llp/0002's published-binary
      // rule is about, and the one thing here that no stub can be wrong about.
      expect(platform.fingerprintHash).toMatch(/^[0-9a-f]{40}$/);
      expect(['found', 'none', 'unknown']).toContain(platform.state);
      if (platform.state === 'found') {
        expect(platform.buildId).toMatch(/^[0-9a-f-]{36}$/);
        expect(typeof platform.buildProfile).toBe('string');
        expect(platform.source).toBe('eas');
      }
    }
    // Every platform reaches an answer, which until wave 22 held on about half the runs — see F93
    // below for what was in the way.
    expect(report.builds.platforms.every((p: any) => p.state !== 'unknown')).toBe(true);
  });

  it('the lookup does find the real build this project was made from', async () => {
    // The claim the row in llp/0022-live-tier.plan.md was missing. One run and no retry: the retry that used to be here
    // was scaffolding for F93, and it went with the fix.
    const result = await runLiveEasAsync(run, readProjectRoot, ['status', '--explain', '--json'], {
      label: 'status-explain-found',
    });
    expectExit(result, 0);
    const found = parseJson(result).builds.platforms.find((p: any) => p.state === 'found') ?? null;

    expect(found).not.toBeNull();
    expect(found.buildId).toMatch(/^[0-9a-f-]{36}$/);
    expect(found.buildUrl).toMatch(/^https:\/\//);
    // The build the service returned was made from the hash that was asked about, which is the
    // exactness the whole lookup design rests on ([[0011-impact-and-freshness]] §The build-cache
    // lookup) and which a stub cannot put at risk.
    expect(found.fingerprintHash).toMatch(/^[0-9a-f]{40}$/);
  });

  // F93 — MAJOR, found by this suite on 2026-08-27, **fixed in wave 22**.
  //
  // What it was: `status --explain` runs its two per-platform lookups concurrently (`Promise.all` in
  // `src/status/easBuilds.ts` §readEasBuildsStatusAsync). In a project that does not pin `eas-cli` —
  // the common case, and the case wave 18 made the only rung — each lookup spawns
  // `bunx eas-cli@latest`, and both shared one per-spec scratch directory
  // (`$TMPDIR/bunx-501-eas-cli@latest`). Started milliseconds apart they collided: the loser exited 1
  // with empty stdout, and `describeLookupFailure` (src/impact/buildCache.ts) then reported the first
  // line of its stderr — **bun's own progress output** — as what the service said about the caller's
  // builds.
  //
  // Observed, six runs against a fresh copy of the same project with no `.expo` cache:
  //   both platforms poisoned 2/6, one platform poisoned 1/6, clean 3/6.
  //   reason: "Resolving dependencies"   ← bun installing, not EAS answering
  // The identical argv run on its own exited 0 with the correct payload every time, and inserting a
  // ~50 ms skew between the two spawns made the collision disappear.
  //
  // llp/0022-live-tier.plan.md, one process boundary further out: there a wrapper's panic was reported as EAS's
  // answer; here the package runner's progress line was. The difference is that the runner is this
  // CLI's own choice rather than the machine's, so the reason was not even untrusted output from
  // somebody else's binary — it was noise from a tool this CLI decided to use.
  //
  // The fix is a per-spec mutex in the spawn layer (`src/utils/runnerLock.ts`) plus a guard that will
  // not let a runner's line be quoted as the service's answer even when the two do collide
  // (`looksLikeRunnerNoise`). This test asserts both halves against the real runner.
  it("F93: a build lookup never reports the package runner's progress line as EAS's answer", async () => {
    // **The cache has to go first**, and this is the whole reason the test says so out loud: by the
    // time this runs, the tests above have written `.expo/agent-cli-eas-builds.json`, and a cache hit
    // costs one `readFileSync` — so iOS answers without a spawn and the concurrent pair the defect
    // needs never exists [observed — 2026-08-27: `source: "cache"` for ios, `"eas"` for android, so
    // this test was asserting one lookup]. Deleting it puts both platforms back on the network path,
    // started milliseconds apart, which is the state F93 was found in.
    fs.rmSync(path.join(readProjectRoot, '.expo', 'agent-cli-eas-builds.json'), { force: true });

    const result = await runLiveEasAsync(run, readProjectRoot, ['status', '--explain', '--json'], {
      label: 'f93-status-explain',
    });
    expectExit(result, 0);
    const report = parseJson(result);
    for (const platform of report.builds.platforms) {
      // The guard: whatever went wrong, the runner's vocabulary is never the reason on its own.
      expect(platform.reason ?? '').not.toMatch(
        /^(Resolving dependencies|Saved lockfile|Resolved, downloaded and extracted)/
      );
      // Asked, and answered by the service rather than out of the record this test just removed.
      expect(platform.source).toBe('eas');
    }
    // And the stronger half, which is the mutex: with both platforms asked at once, both get an
    // answer. This is the assertion that was a coin toss before the fix.
    expect(report.builds.platforms.every((p: any) => p.state !== 'unknown')).toBe(true);
  });

  it('status --explain --build against a build that does not exist says so, in text and in JSON', async () => {
    const result = await runLiveEasAsync(
      run,
      readProjectRoot,
      ['status', '--explain', '--build', 'not-a-real-build-id', '--json'],
      { label: 'status-explain-build' }
    );
    expectExit(result, 0);
    const report = parseJson(result);
    // F66: the flag's target has to be echoed somewhere. A caller who passed `--build` and got an
    // ordinary report back believed the comparison happened.
    const serialized = JSON.stringify(report);
    expect(serialized).toContain('not-a-real-build-id');
  });

  // --- a real EAS build log -----------------------------------------------------------------------

  describe('inspect:build-log on a log EAS actually served', () => {
    let rawPath = '';
    let decodedPath = '';

    beforeAll(async () => {
      // The log URL comes from the service, through the same package runner this CLI uses, because
      // an EAS build's log URL is signed and expires — a committed URL would be a test that rots.
      const listed = await execAsync(
        'npx',
        ['--yes', 'eas-cli@latest', 'build:list', '--limit', '20', '--json', '--non-interactive'],
        {
          cwd: readProjectRoot,
          timeoutMs: 300_000,
        }
      );
      run.writeArtifact('build-list.json', listed.stdout);
      const builds = JSON.parse(listed.stdout);
      // An ERRORED build is the stable input: it has a failure to locate, and unlike a FINISHED one
      // its log is guaranteed to contain something for the rules to match.
      const errored = builds.find(
        (build: any) => build.status === 'ERRORED' && build.logFiles?.length
      );
      if (!errored) {
        throw new Error(
          `no ERRORED build with a log was found for ${readProjectRoot} — this suite reads one as its ` +
            `fixture, so either the project changed or the builds were deleted (harness, not a finding)`
        );
      }
      ({ rawPath, decodedPath } = await downloadBuildLogAsync(run, errored.logFiles[0]));
    });

    it('refuses the bytes as served, because EAS serves a build log brotli-encoded', async () => {
      const result = await runLiveEasAsync(
        run,
        run.tempDir,
        ['inspect:build-log', '--file', rawPath, '--json'],
        {
          label: 'build-log-raw',
        }
      );
      // S8: undecoded input used to be exit 0 with control characters in `logTail`, and "no error
      // located" for binary reads as a build that passed. 22 is the honest answer.
      expectExit(
        result,
        22,
        'a brotli-encoded log is not text, and must not be reported as a passing build'
      );
      const report = parseJson(result);
      expect(report.error.code).toBe('LOG_NOT_TEXT');
      expect(report.error.message).toContain('brotli');
    });

    it('locates the failing phase in the decoded log', async () => {
      const result = await runLiveEasAsync(
        run,
        run.tempDir,
        ['inspect:build-log', '--file', decodedPath, '--json'],
        { label: 'build-log-decoded' }
      );
      expectExit(result, 0);
      const report = parseJson(result);
      expect(report.source.bytes).toBeGreaterThan(1000);
      expect(report.failure).not.toBeNull();
      // The claim is a located line in a real log, not a particular signature: the rules are a capped
      // table and which one matches is a property of the build, so pinning the signature would make
      // this a test of one historical build rather than of the extraction.
      expect(typeof report.failure.signature).toBe('string');
      expect(report.failure.line).toBeGreaterThan(0);
      expect(report.failure.matchedLine.length).toBeGreaterThan(0);
      const phase = report.phases.find((p: any) => p.name === report.failure.phase);
      expect(phase).toBeDefined();
      expect(phase.status).toBe('failed');
      // Every answer carries the line it came from, so it can be checked against the file.
      const lines = fs.readFileSync(decodedPath, 'utf8').split('\n');
      expect(lines[report.failure.line - 1]).toContain(report.failure.matchedLine.slice(0, 40));
    });
  });

  // --- the one write ------------------------------------------------------------------------------

  it('deploy --web ships the example, and the URL serves the bytes it produced', async () => {
    const result = await runLiveEasAsync(run, deployProjectRoot, ['deploy', '--web', '--json'], {
      label: 'deploy-web',
    });
    run.spend.deploys += 1;
    expectExit(result, 0);
    const report = parseJson(result);
    expect(report.targets).toEqual(['web']);
    expect(report.web.url).toMatch(/^https:\/\/.+\.expo\.app$/);
    expect(fs.existsSync(path.join(deployProjectRoot, report.web.exportDir))).toBe(true);

    // The assertion is not "something answered": it is that the address serves the bundle this
    // export produced. The HTML is a shell under `web.output: single`, so the marker lives in the
    // entry bundle the HTML points at, and both halves are checked.
    expect(await httpStatusAsync(report.web.url)).toBe(200);
    const html = await httpBodyAsync(report.web.url);
    run.writeArtifact('deployed-page.html', html);
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    const bundleSrc = /src="([^"]*\/_expo\/static\/js\/web\/[^"]+)"/.exec(html)?.[1];
    expect(bundleSrc).toBeTruthy();
    const bundleUrl = new URL(bundleSrc as string, report.web.url).toString();
    expect(await httpStatusAsync(bundleUrl)).toBe(200);
    expect(await httpBodyAsync(bundleUrl)).toContain('@expo/agent-cli live-eas deploy marker');
  });
});
