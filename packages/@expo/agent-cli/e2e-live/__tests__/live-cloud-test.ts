// @ref llp/0022-live-tier.plan.md §live-cloud
//
// The cloud-simulator half of the live tier. Runs against a real EAS Simulator session on the
// expo-ci CI account. There is no macOS gate — the device is remote — so it also runs on a Linux CI
// runner: the `agent-cli-cloud-e2e` EAS workflow runs it for both platforms and both modes, one
// billed session per job, over the dev server's own tunnel.
//
// Every expectation in this file comes from wave 19's live run rather than from the type definitions:
// `wave19-live/` holds the JSON each assertion below was written against, and the sequence it proved is
// the sequence `beforeAll` performs. Four facts decide the whole shape of this suite — the first three
// from that run, the fourth from this suite's own first live run:
//
//  1. **The dev server needs a public origin, and since 2026-09-05 the tunnel is how it gets one.**
//     `exp://127.0.0.1:<port>` names the loopback of the machine that opens it, and that machine is in
//     a datacenter. `--tunnel` is the documented answer and its **v1 does not work**: `@expo/ngrok`
//     logs `Tunnel URL not found … falling back to LAN URL` twelve times and then exits 1 on
//     `TypeError: Cannot read properties of undefined (reading 'body')` [observed — wave19-live,
//     `01-dev-tunnel.err`]. Its v2 does: under `EXPO_UNSTABLE_TUNNEL_V2=1`, `expo start --tunnel` uses
//     `@expo/ws-tunnel` on the Expo account — no ngrok anywhere — and advertises an `….on.expo.app`
//     origin that serves `packager-status:running` to the world [verified live — 2026-09-05, through
//     this CLI's own `dev --tunnel`]. So the suite's default is the server's own tunnel, which also
//     makes the tunnel part of the tested surface instead of harness plumbing. The proxy path is kept
//     as the `AGENT_CLI_LIVE_PUBLIC_ORIGIN` hatch — a reverse proxy the caller already has, advertised
//     via `EXPO_PACKAGER_PROXY_URL` — because the v2 flag is `UNSTABLE`-prefixed and a suite with one
//     way to reach the world stops running the day that way changes. Wave 19 taught `advertisedUrl` to
//     read the origin out of the manifest rather than the log, which is what makes both modes one code
//     path: a proxied run prints `Waiting on http://localhost:<port>` and puts the real origin only in
//     `launchAsset.url`, and a tunnel run is read the same way.
//  2. **A bare cloud session has no app on it.** A session started without `--expo-go` comes up with
//     nothing installed, `apps --platform ios` lists only the controller's own test runner, and every
//     `open` of an `exp://` URL fails with `LSApplicationWorkspaceErrorDomain error 115` [observed —
//     wave19-live, `08-open-plain.json`]. The command is `eas simulator … --expo-go`, and it is
//     `eas simulator` rather than `eas simulator:start` — that is the name in the CLI's own manifest
//     and the one that carries the flag.
//  3. **A cloud reload is a relaunch, proved on the dev server.** Wave 19: `method: "device"`,
//     `verifiedBy: "dev-server-bundle"`, and `commandSocketClients` reported beside `appsConnected`
//     because the two disagree exactly here — an app bundling over a proxy is in the debugger list and
//     holds **zero** clients on the command socket, so a broadcast reaches nobody. The `dev-server`
//     attempt is therefore *not tried* on a cloud session, with a reason that says so.
//  4. **A session started bare has an app that has never launched, and that is not the same thing as
//     a session with an app on it.** `--expo-go` installs and launches Expo Go; nothing has opened
//     the *project* in it. The first `exp://` URL then goes to the **system**, which asks
//     "Open in 'Expo Go'?" — and nobody is there [S10; and this suite's own first run,
//     2026-08-27: `navigate --cloud` exit 22 after 60.9 s, then two 180 s reloads with zero bundles
//     served]. So the session is started with `--open-url`, which is the runner opening the URL in
//     the app it just launched. Wave 19's working session was in exactly that state before any
//     @expo/agent-cli command touched it.
//
// **S11 is amended, and this is where it was amended.** It said a cloud simulator registers zero CDP
// targets over both origins, so `navigate --cloud` could assert the link was opened and nothing more.
// With the session started on the project (fact 4) the app registers a debugger target *and* a
// command-socket client, and `navigate --cloud` confirmed the attach in 206 ms [observed —
// 2026-08-27]. S11 was a session whose app had never loaded. So `attached` is still not *required* —
// a cold first bundle over a proxy can outlive the wait, and 22 with `attached: false` stays honest —
// but the run that does not attach now has to have looked at the screen for the dialog (S10), which is
// what the branch below asserts.
//
// The wall that is left is narrower and upstream: the `/message` reload broadcast does not reload Expo
// Go on a cloud simulator over a proxied origin, and it takes the app's command-socket client with it.
// There is deliberately no `runtime:eval --cloud` test, because the flag does not exist — correctly.
// What this suite pins is that the CLI reaches the rung that works and is honest about what it saw.
//
// Cost: an EAS Simulator session bills from start to stop. Hence two opt-ins — `test:live:cloud` and
// `AGENT_CLI_LIVE_CLOUD=1` — one session started in `beforeAll`, reused by every test, and stopped in
// `afterAll` whatever happened.

import fs from 'node:fs';
import path from 'node:path';

import {
  allOf,
  builtBinGate,
  cloudOptInGate,
  describeLive,
  EAS_EXAMPLE_APP,
  networkGate,
  packageRunnerGate,
  easCiGate,
  writeLivecheckLink,
} from '../prereq';
import {
  LiveRun,
  execAsync,
  expectExit,
  findFreePortAsync,
  fixturesDir,
  parseJson,
  runLiveEasAsync,
  waitForAsync,
} from '../utils';

const easCi = easCiGate();
const gate = allOf(
  builtBinGate(),
  cloudOptInGate(),
  easCi.gate,
  packageRunnerGate(),
  networkGate()
);

/**
 * How long a cloud step gets.
 *
 * Wave 19's successful reload reported `waitedMs: 89913`, and a later one `15179` — two runs of the
 * same command an order of magnitude apart, which is what a datacenter round trip plus a cold Expo Go
 * plus a bundle over a proxy costs. So the bound is generous and the command is given a matching
 * `--timeout`; nothing here asserts how long anything took.
 */
const BOUND_MS = 300_000;

/**
 * How long the session start alone gets.
 *
 * Creating the session is fast; what varies is the wait for the agent-device to become **ready** —
 * the same command's create→ready span was 3.3 minutes at one point on 2026-09-06 and past five at
 * another, on an account with nothing else running. Under {@link BOUND_MS} that variance became a
 * suite failure with a killed `eas simulator` and a session the `catch` had to stop. The device
 * boot is EAS's to pace (Android support is declared in-development by the CLI itself), so the
 * start gets double the bound rather than an assertion about how long a datacenter takes.
 */
const SESSION_START_MS = 600_000;

/** What `--timeout` is set to on a cloud reload, spelled the way that option parses. */
const RELOAD_TIMEOUT = '180s';

/** The route the lab screen lives at, for the reload that names one. */
const LAB_ROUTE = '/lab';

/**
 * Which platform the cloud session runs on. A session has one platform (llp/0022 §Limits), so the
 * suite is run once per platform — the EAS workflow sets `AGENT_CLI_LIVE_CLOUD_PLATFORM=android` for
 * the second pass. Everything platform-specific reads this; the mismatch test uses {@link OTHER_PLATFORM}.
 */
const CLOUD_PLATFORM = process.env.AGENT_CLI_LIVE_CLOUD_PLATFORM === 'android' ? 'android' : 'ios';
const OTHER_PLATFORM = CLOUD_PLATFORM === 'ios' ? 'android' : 'ios';

/**
 * What the cloud session runs. `expo-go` (the default) scaffolds a fresh app and starts the session
 * with `--expo-go`. `dev-build` reads the committed `apps/eas-example` in place — already linked to the
 * CI project, with an installed dev client — and starts the session on a real build via `--build-id`.
 * The build id is `AGENT_CLI_LIVE_CLOUD_BUILD_ID`, or the newest finished development build for the
 * platform. `eas-example` is minimal (root route, no `/lab`), so the route-reload test is expo-go only.
 */
const CLOUD_MODE = process.env.AGENT_CLI_LIVE_CLOUD_MODE === 'dev-build' ? 'dev-build' : 'expo-go';

/**
 * A public origin the caller already has, which switches the suite to proxy mode (fact 1's hatch).
 * Empty means the default: the dev server's own tunnel, v2.
 */
const PROXY_ORIGIN = (process.env.AGENT_CLI_LIVE_PUBLIC_ORIGIN ?? '').replace(/\/+$/, '');
const CLOUD_BUILD_ID = process.env.AGENT_CLI_LIVE_CLOUD_BUILD_ID ?? '';
/** The dev-build app's URL scheme, declared in `apps/eas-example/app.json`. */
const EAS_EXAMPLE_SCHEME = 'easexample';
const onExpoGo = CLOUD_MODE === 'expo-go' ? it : it.skip;

/** The `id` of an `eas simulator --json` payload, or null when the output is not that object. */
function jsonSessionId(stdout: string): string | null {
  try {
    return JSON.parse(stdout)?.id ?? null;
  } catch {
    return null;
  }
}

describeLive('live-cloud', gate)('live-cloud: an EAS Simulator session, on expo-ci', () => {
  const run = new LiveRun('live-cloud');
  let projectRoot = '';
  let port = 0;
  /** The origin the dev server advertises, e.g. `https://c-….on.expo.app`. Known up front in proxy
   *  mode; read back from the server's own advertisement in tunnel mode. */
  let origin = '';
  /** Host and port of {@link origin}, which is what an `exp://` link carries. */
  let publicHost = '';
  let sessionId: string | null = null;

  /** `eas` through the same package runner this CLI uses, with the evidence kept. */
  async function easAsync(label: string, args: string[], timeoutMs: number = BOUND_MS) {
    const result = await execAsync('npx', ['--yes', 'eas-cli@latest', ...args], {
      cwd: projectRoot || run.tempDir,
      timeoutMs,
    });
    run.writeArtifact(
      `eas-${label}.txt`,
      `$ eas ${args.join(' ')}\nexit ${result.exitCode}\n\n${result.stdout}\n${result.stderr}`
    );
    return result;
  }

  /**
   * Wait until the cloud app is settled on the dev server: at least one debugger target listed, and
   * the same set of target ids across two polls five seconds apart.
   *
   * The reload ladder's dev-server rung watches the command socket for a drop-and-reconnect, and a
   * relaunch from the *previous* test that is still landing produces exactly that signature: the
   * broadcast is declared acted-on for an app that never reloaded, the run never climbs, and the
   * verification honestly reports 22 three minutes later [observed — 2026-09-06, iOS Expo Go over
   * the ws-tunnel: `reload --route` right after `reload`, churn `reconnected: 1` from the earlier
   * relaunch, then no new target for 180s]. The same race, and the same fix, as `live-android`'s
   * settle before its own second reload.
   */
  async function waitForCloudAppSettledAsync(label: string): Promise<boolean> {
    let previous = '';
    let stable = false;
    await waitForAsync(
      async () => {
        const listed = await execAsync('curl', ['-sS', '-m', '10', `http://127.0.0.1:${port}/json/list`], {
          timeoutMs: 30_000,
        });
        let ids: string[] = [];
        try {
          ids = (JSON.parse(listed.stdout) as { id?: string }[]).map((t) => t.id ?? '').sort();
        } catch {
          return false;
        }
        const now = ids.join(',');
        stable = ids.length > 0 && now === previous;
        previous = now;
        run.writeArtifact(`settle-${label}.txt`, `targets: ${now || '(none)'} stable: ${stable}`);
        return stable;
      },
      120_000,
      5_000
    );
    return stable;
  }

  /**
   * The environment every command in this suite runs with. Proxy mode advertises the caller's
   * origin; tunnel mode opts `expo start --tunnel` into v2. One env for the whole run, because the
   * command that reads it (the dev server start) and the commands that merely inherit it are not
   * worth telling apart here.
   */
  function suiteEnv() {
    return PROXY_ORIGIN ? { EXPO_PACKAGER_PROXY_URL: origin } : { EXPO_UNSTABLE_TUNNEL_V2: '1' };
  }

  beforeAll(async () => {
    run.prepare();
    port = await findFreePortAsync();

    if (CLOUD_MODE === 'dev-build') {
      // The committed dev-build app, read in place. Its installed dev client is what the session runs,
      // and its app.json is already linked to the CI project — so nothing is scaffolded or linked, and
      // there is no lab route to add (it has none; the route-reload test is skipped in this mode).
      projectRoot = EAS_EXAMPLE_APP;
    } else {
      const created = await runLiveEasAsync(
        run,
        run.tempDir,
        ['new', 'cloudapp', '--name', 'Cloud App', '--json'],
        { label: 'new' }
      );
      run.spend.scaffolds += 1;
      expectExit(created, 0);
      projectRoot = parseJson(created).projectRoot;

      // `eas simulator` refuses a project EAS has never heard of, and a scratch scaffold is exactly
      // that. Link it to the suite's standing CI project (the same one `live-eas` deploys to)
      // instead of creating one per run: `eas init --id` is what the refusal itself suggests, but it
      // stops on the slug mismatch in non-interactive mode, so the link is written the way `eas init`
      // would have written it. Identity comes from the livecheck fixture, or from
      // AGENT_CLI_LIVE_EAS_OWNER / AGENT_CLI_LIVE_EAS_PROJECT_ID.
      writeLivecheckLink(projectRoot);

      // The lab screen, so the `--route` reload has somewhere to go that is not the root. Same fixture
      // and same tab-trigger insertion as `live-local`; see that file for why it is an insertion.
      fs.writeFileSync(
        path.join(projectRoot, 'src', 'app', 'lab.tsx'),
        fs.readFileSync(path.join(fixturesDir, 'lab', 'lab.tsx'), 'utf8')
      );
      const tabsFile = path.join(projectRoot, 'src', 'components', 'app-tabs.tsx');
      const tabs = fs.readFileSync(tabsFile, 'utf8');
      const anchor = '</NativeTabs>';
      if (!tabs.includes(anchor)) {
        throw new Error(
          `the scaffold's ${tabsFile} has no ${anchor} to insert the lab tab trigger before — the template ` +
            `changed shape, so this harness needs updating (not a finding about the CLI)`
        );
      }
      fs.writeFileSync(
        tabsFile,
        tabs.replace(
          anchor,
          `  <NativeTabs.Trigger name="lab">\n` +
            `        <NativeTabs.Trigger.Label>Lab</NativeTabs.Trigger.Label>\n` +
            `      </NativeTabs.Trigger>\n    ${anchor}`
        )
      );
    }

    // Cleanups run newest-first, so these are registered cheapest-first: the session that bills is
    // registered last and therefore ends first, and the directory the others run in is deleted last.
    run.onCleanup('scratch project', () => {
      if (process.env.AGENT_CLI_LIVE_KEEP) {
        return;
      }
      if (CLOUD_MODE === 'dev-build') {
        // Read in place: remove only what this run wrote into the committed app, never the app itself.
        for (const artifact of ['.expo', '.env.eas-simulator', 'dist']) {
          fs.rmSync(path.join(projectRoot, artifact), { recursive: true, force: true });
        }
      } else {
        fs.rmSync(run.tempDir, { recursive: true, force: true });
      }
    });
    run.onCleanup('dev:stop', async () => {
      await runLiveEasAsync(run, projectRoot, ['dev:stop', '--json'], {
        label: 'cleanup-dev-stop',
      });
    });
    run.onCleanup('eas simulator:stop', async () => {
      // Unconditional, and it deliberately does not check `sessionId` first: the failure worth guarding
      // is a session that started and whose id this process never learned. `--id` when there is one,
      // because a project can have several and stopping somebody else's is not this suite's to do.
      const args = ['simulator:stop', '--non-interactive'];
      await easAsync('simulator-stop', sessionId ? [...args, '--id', sessionId] : args);
    });

    // A public origin, when the caller brought one (fact 1's hatch). The default is the dev
    // server's own tunnel, whose origin does not exist yet — it is read back after the start below.
    if (PROXY_ORIGIN) {
      origin = PROXY_ORIGIN;
      publicHost = new URL(origin).host;
      console.log(
        `[live] using AGENT_CLI_LIVE_PUBLIC_ORIGIN (${origin}); it has to already forward to port ${port}`
      );
    }

    // In dev-build mode the dev client is installed on the remote cloud sim, not this machine — but
    // `dev` decides serve-vs-build from the *local* last-build record and would try to build one here.
    // Record the project's current fingerprint (what `status` computes) as the last build, so
    // `dev --dev-client --no-open` serves the metro the remote client loads rather than rebuilding.
    // The hash is read at runtime, so it matches whatever machine runs the suite.
    if (CLOUD_MODE === 'dev-build') {
      const status = await runLiveEasAsync(run, projectRoot, ['status', '--json'], {
        label: 'status-fingerprint',
      });
      const hash = parseJson(status)?.freshness?.hash;
      if (!hash) {
        throw new Error(
          `could not read the project fingerprint from "status --json" (harness, not a finding): ${status.artifact}`
        );
      }
      fs.mkdirSync(path.join(projectRoot, '.expo'), { recursive: true });
      fs.writeFileSync(
        path.join(projectRoot, '.expo', 'agent-cli-last-build.json'),
        JSON.stringify({ [CLOUD_PLATFORM]: { hash, sources: null } }) + '\n'
      );
    }

    // The dev server. In tunnel mode `--tunnel` (v2, via suiteEnv) is what makes the origin; in
    // proxy mode the origin is advertised through EXPO_PACKAGER_PROXY_URL instead (fact 1).
    // `--no-open` serves without opening a local device — the device is the cloud sim — and in
    // dev-build mode `--dev-client` serves the installed dev client instead of Expo Go.
    const devArgs = [
      'dev',
      `--${CLOUD_PLATFORM}`,
      ...(CLOUD_MODE === 'dev-build' ? ['--dev-client'] : []),
      ...(PROXY_ORIGIN ? [] : ['--tunnel']),
      '--no-open',
      '--detach',
      '--wait-ready',
      '--port',
      String(port),
      '--json',
    ];
    const dev = await runLiveEasAsync(run, projectRoot, devArgs, {
      label: 'dev-public',
      env: suiteEnv(),
    });
    expectExit(dev, 0);
    expect(parseJson(dev).port).toBe(port);

    // The origin the server actually advertises, read through the CLI itself. In tunnel mode this
    // is the only place the origin exists at all; in proxy mode the same read verifies the caller's
    // origin is the one being advertised. `--print-url` needs no device and is the cheapest question
    // with this answer for Expo Go; a dev build's route link carries no host, so there the launcher
    // URL in `status` is what names the origin.
    if (CLOUD_MODE === 'expo-go') {
      const printed = await runLiveEasAsync(run, projectRoot, ['navigate', '/', '--print-url', '--json'], {
        label: 'print-url',
        env: suiteEnv(),
      });
      expectExit(printed, 0);
      const printedReport = parseJson(printed);
      const advertisedHost = String(printedReport.url).match(/^exp:\/\/([^/]+)/)?.[1] ?? '';
      if (printedReport.hostType !== 'tunnel' || !advertisedHost) {
        throw new Error(
          `the dev server is not advertising a public origin: navigate --print-url reported ` +
            `hostType ${printedReport.hostType} and url ${printedReport.url}. A cloud simulator cannot ` +
            `reach it, so no session is worth starting. Evidence: ${printed.artifact}`
        );
      }
      if (PROXY_ORIGIN && advertisedHost !== publicHost) {
        throw new Error(
          `the dev server advertises ${advertisedHost}, not the supplied origin ${origin}. ` +
            `Evidence: ${printed.artifact}`
        );
      }
      if (!PROXY_ORIGIN) {
        publicHost = advertisedHost;
        // The ws-tunnel host serves https; the launch URL below carries only the host, so the
        // scheme matters only to this suite's own reachability check.
        origin = `https://${advertisedHost}`;
      }
    } else {
      const status = await runLiveEasAsync(run, projectRoot, ['status', '--json'], {
        label: 'status-origin',
        env: suiteEnv(),
      });
      expectExit(status, 0);
      const launcher: string =
        (parseJson(status)?.devServer?.openUrls ?? []).find(
          (entry: any) => entry.target === 'dev-build'
        )?.url ?? '';
      const advertised = launcher.match(/[?&]url=([^&]+)/)?.[1] ?? '';
      const advertisedOrigin = decodeURIComponent(advertised).replace(/\/+$/, '');
      if (!advertisedOrigin) {
        throw new Error(
          `the dev server advertises no dev-build launcher URL to read the origin from ` +
            `(got "${launcher}"). Evidence: ${status.artifact}`
        );
      }
      if (PROXY_ORIGIN && new URL(advertisedOrigin).host !== publicHost) {
        throw new Error(
          `the dev server advertises ${advertisedOrigin}, not the supplied origin ${origin}. ` +
            `Evidence: ${status.artifact}`
        );
      }
      if (!PROXY_ORIGIN) {
        origin = advertisedOrigin;
        publicHost = new URL(origin).host;
      }
    }

    // That the origin actually reached the world, checked before a session is billed to find out:
    // `packager-status:running` through the public origin proves it forwards to the server the
    // cloud sim will load the bundle from — whichever of the two modes made it.
    const reached = await execAsync('curl', ['-sSL', '-m', '20', `${origin}/status`], {
      timeoutMs: 40_000,
    });
    run.writeArtifact(
      'origin-status.txt',
      `GET ${origin}/status\n\n${reached.stdout}\n${reached.stderr}`
    );
    if (!reached.stdout.includes('packager-status:running')) {
      throw new Error(
        `the dev server is not reachable over the public origin ${origin}: "GET ${origin}/status" ` +
          `answered "${reached.stdout.slice(0, 200)}". A cloud simulator cannot reach it, so no ` +
          `session is worth starting.`
      );
    }

    // The session, with `--expo-go` **and `--open-url`**. `eas simulator`, not
    // `eas simulator:start` — see fact 2.
    //
    // `--open-url` is fact 4, and the first live-cloud run is what taught it. A session started bare
    // comes up with Expo Go installed and **never launched**, so the first thing to send it an
    // `exp://` URL hands that URL to the *system* — and iOS answers with "Open in 'Expo Go'?", a
    // modal nothing on an unattended device presses [S10; and live, 2026-08-27: `navigate --cloud`
    // exit 22 after 60.9 s with the `open` verb having exited 0, then two 180 s reloads that served
    // no bundle]. Wave 19's session, the one that reached exit 0, had Expo Go launched *before* any
    // URL reached it (`wave19-live/12-open-session.json`, `open host.exp.Exponent`), and the flag is
    // the EAS runner's own way to arrive in that state: "Expo or development-client URL to open in
    // the installed application **after it launches**" [observed — `eas simulator --help`,
    // eas-cli@latest, 2026-08-27].
    //
    // So the session comes up with the project already loaded, which is what the rest of this suite
    // is about — a reload of an app that is running, not a first launch. The CLI's own answer to the
    // dialog is not what is relied on here: `navigate --cloud` reads and accepts it
    // (`src/navigate/openRoute.ts §resolveOpenDialogAsync`), and this harness gets the session into
    // the state a person following the `eas-simulator` skill would have.
    // `eas simulator` creates the session **before** it waits for the agent-device to be ready, so a
    // start that hangs on readiness — seen on 2 of 3 runs, 2026-09-05 — still bills one. The
    // readiness wait hangs the full timeout, which `execAsync` reports by killing the process and
    // rejecting, so the id has to be pulled from the error too, not only the resolved result. The
    // `simulator:stop` cleanup can only stop what it can name; a bare stop does not reach it.
    const findSessionId = (stdout: string, stderr: string): string | null =>
      jsonSessionId(stdout) ?? `${stdout}\n${stderr}`.match(/id: ([0-9a-f-]{36})/i)?.[1] ?? null;

    // In dev-build mode the session installs and runs a real dev client, named by its build id — the
    // AGENT_CLI_LIVE_CLOUD_BUILD_ID override, or the newest finished development build for this platform.
    // Its launch URL is the dev-launcher form (`<scheme>://expo-development-client/?url=<origin>`), which
    // `--open-url` accepts, rather than Expo Go's `exp://<host>`.
    let appFlags: string[];
    if (CLOUD_MODE === 'dev-build') {
      let buildId = CLOUD_BUILD_ID;
      if (!buildId) {
        const listed = await easAsync('build-list', [
          'build:list',
          '--platform',
          CLOUD_PLATFORM,
          '--build-profile',
          'development',
          '--status',
          'finished',
          '--limit',
          '1',
          '--json',
          '--non-interactive',
        ]);
        buildId = JSON.parse(listed.stdout)?.[0]?.id ?? '';
      }
      if (!buildId) {
        throw new Error(
          `no finished development build for ${CLOUD_PLATFORM}: build one with ` +
            `"eas build --profile development --platform ${CLOUD_PLATFORM}" in apps/eas-example, or set ` +
            `AGENT_CLI_LIVE_CLOUD_BUILD_ID (harness, not a finding)`
        );
      }
      const launchUrl = `${EAS_EXAMPLE_SCHEME}://expo-development-client/?url=${encodeURIComponent(origin)}`;
      appFlags = ['--build-id', buildId, '--open-url', launchUrl];
    } else {
      appFlags = ['--expo-go', '--open-url', `exp://${publicHost}`];
    }

    let started: Awaited<ReturnType<typeof easAsync>>;
    try {
      started = await easAsync(
        'simulator-start',
        [
          'simulator',
          '--platform',
          CLOUD_PLATFORM,
          '--type',
          'agent-device',
          ...appFlags,
          '--non-interactive',
          '--name',
          'agent-cli-live',
          '--json',
        ],
        SESSION_START_MS
      );
    } catch (error: any) {
      sessionId = findSessionId(String(error?.stdout ?? ''), String(error?.stderr ?? ''));
      if (sessionId) {
        run.spend.cloudSessions += 1;
      }
      throw error;
    }
    sessionId = findSessionId(started.stdout, started.stderr);
    if (sessionId) {
      run.spend.cloudSessions += 1;
    }
    if (started.exitCode !== 0) {
      throw new Error(
        `eas simulator failed (exit ${started.exitCode}): ${started.stderr.slice(-2000)}`
      );
    }
    if (!sessionId) {
      throw new Error(
        `eas simulator --json printed no session id: ${started.stdout.slice(0, 500)}`
      );
    }
    // Scaffold, install, a tunnel, a detached dev server and a billed simulator session: minutes.
    // Without its own bound this hook hit vitest's 10s default and the suite never reached a test —
    // which is why it had never been seen run.
  }, 900_000);

  afterAll(async () => {
    await run.cleanUpAsync();
    console.log(run.costLine());
  });

  it('the session this suite started is the one the CLI finds', async () => {
    expect(sessionId).toBeTruthy();
    // The CLI reads the session out of `.env.eas-simulator`, which `eas simulator` writes into the
    // project. That file is the handshake between the two CLIs, so its absence is the first thing to
    // know about rather than something to discover three tests later.
    const envFile = path.join(projectRoot, '.env.eas-simulator');
    expect(await waitForAsync(() => fs.existsSync(envFile), 60_000, 2_000)).toBe(true);
    expect(fs.readFileSync(envFile, 'utf8')).toContain(sessionId as string);
  });

  it('navigate --cloud opens the route on the cloud simulator, over the public origin', async () => {
    const result = await runLiveEasAsync(run, projectRoot, ['navigate', '/', '--cloud', '--json'], {
      label: 'navigate-cloud',
      env: suiteEnv(),
    });
    const report = parseJson(result);
    // `DeviceBackend` is `'cloud'` — one value for both platforms, with `platform` carrying the rest.
    expect(report.deviceBackend).toBe('cloud');
    expect(report.platform).toBe(CLOUD_PLATFORM);
    // The URL has to name where the app really is. In Expo Go that is the public origin (a localhost URL
    // here is the S3 failure, opened onto an error screen rather than refused); in a dev build it is the
    // app's own scheme — `easexample://<route>` — which the dev client resolves against the origin the
    // launcher already handed it.
    if (CLOUD_MODE === 'dev-build') {
      expect(report.url.startsWith(`${EAS_EXAMPLE_SCHEME}://`)).toBe(true);
    } else {
      expect(report.url).toContain(publicHost);
      expect(report.hostType).toBe('tunnel');
    }
    // The `open` itself succeeded: this is the half `--expo-go` fixed, and the half that answered
    // `LSApplicationWorkspaceErrorDomain error 115` without it.
    expect(report.exitCode).toBe(0);
    // `attached` is **not** asserted true: S11 says a cloud simulator registers zero CDP targets, so 22
    // with `attached: false` is the honest outcome today. If this ever becomes 0-and-attached, the wall
    // has moved and the branch below is what will say so.
    expect([0, 22]).toContain(result.exitCode);
    if (result.exitCode === 22) {
      expect(report.attached).toBe(false);
      // And when nothing attached, the run has to have **looked at the screen** before saying so.
      // S10 is the cause this exit code hid for two rounds: the link went to the system, iOS asked
      // "Open in 'Expo Go'?", and the modal was the whole story. `attachAlert` is that look, and it
      // carries which of the three states it found. `found: false` is the expected one here — the
      // session was started with `--open-url`, so Expo Go was already running when the link arrived.
      expect(report.attachAlert).not.toBeNull();
      expect(report.attachAlert.checked).toBe(true);
      expect(typeof report.attachAlert.reason).toBe('string');
    }
  });

  // @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads, and §The
  // ladder climbs.
  //
  // **What this asserts is the ladder, not the state of one session**, and three live runs between
  // them forced that. Written against wave 19, it read as "a cloud session holds no client on the
  // command socket, so the relaunch is the rung". Then the session was started on the project
  // (fact 4) and the same command reported `commandSocketClients: 1` — the app does register on that
  // socket through the proxy. The broadcast then reached that client and **nothing happened**: no
  // fresh debugger target and no bundle for the whole 180 s budget, while the very next command
  // found the socket empty, climbed to the relaunch, and exited 0 in 18.5 s
  // [observed — 2026-08-27, artifacts 005 and 006 of `live-cloud-…T19-17-35-037Z`]. That pair is
  // F99: `auto` used to stop at a rung it had tried.
  //
  // So both entry states are real and the reload is the relaunch from either. That the broadcast
  // does not reload Expo Go on a cloud simulator is upstream of this CLI; what is asserted here is
  // that the command reaches the rung that works and proves what it did.
  it('runtime:reload --cloud reloads the app and proves it, climbing to the rung that works', async () => {
    const result = await runLiveEasAsync(
      run,
      projectRoot,
      ['runtime:reload', '--cloud', '--timeout', RELOAD_TIMEOUT, '--json'],
      { label: 'reload-cloud', env: suiteEnv() }
    );
    expectExit(result, 0);
    const report = parseJson(result);

    expect(report.reloaded).toBe(true);
    // Never a bare success: `reloaded` is `verifiedBy != null` by construction, and this asserts the
    // label is one of the three that can show its own evidence (F95).
    expect([
      'message-socket-peers',
      'app-relaunch',
      'fresh-debugger-target',
      'dev-server-bundle',
    ]).toContain(report.verifiedBy);
    expect(report.bundle.ok).toBe(true);
    expect(report.bundle.url).toContain(publicHost);

    // The two lists, reported side by side because they can disagree here (llp/0005 §What proves a reload
    // question). `commandSocketClients` has to be a number rather than null: "nobody asked" and "nobody
    // is registered" are the two answers this field exists to keep apart.
    expect(typeof report.commandSocketClients).toBe('number');

    // **Rung 1 is always taken, and it is always the socket that says what it found.** The rung is
    // never skipped on the strength of `--cloud` — wave 21's correction — so this attempt exists on
    // every run, whichever state the session is in.
    const attempts = Object.fromEntries(report.attempts.map((a: any) => [a.method, a]));
    // **Rung 1 is always taken** — never skipped on the strength of `--cloud` (wave 21) — so this
    // attempt exists on every run, whichever state the session is in.
    expect(attempts['dev-server']).toBeTruthy();

    // **Which rung reloads a cloud session is the platform's to decide** [observed — 2026-09-05, both
    // platforms live in one workflow run]. On an Android cloud Expo Go the command-socket broadcast
    // reaches the app and it acts on it, so rung 1 is enough and the ladder never climbs. On iOS it
    // does not take — zero clients, or one that took the broadcast and did nothing with it (F97, F99,
    // 2026-08-27) — so the ladder climbs to the device relaunch. The CLI reloads at the cheapest rung
    // that works; this asserts whichever one that was, rather than a platform it guessed.
    if (attempts['dev-server'].ok) {
      expect(report.method).toBe('dev-server');
    } else {
      expect(attempts['dev-server'].reason).toContain(
        report.commandSocketClients > 0 ? 'did not act on it' : 'nothing to broadcast to'
      );
      expect(report.method).toBe('device');
      expect(attempts.device.ok).toBe(true);
      // The cloud relaunch is two verbs, and the reason names both — that is the mechanism, quoted.
      expect(attempts.device.reason).toContain('--relaunch');
      expect(attempts.device.reason).toContain('open');
      // The relaunch costs the app's JavaScript state only when an app was there to lose it. The cloud
      // rung shares `withRelaunchCost` with the local rung, which names the cost only for a pre-relaunch
      // app count above zero — so a session that relaunched a not-running app says nothing about a cost
      // that was not spent, and it would be a lie to demand the sentence here. When the cost IS named,
      // the reason it was reached for has to agree with the socket count in the same object (F99).
      if (attempts.device.reason.includes("costs the app's JavaScript state")) {
        expect(attempts.device.reason).toContain(
          (report.commandSocketClients ?? 0) > 0
            ? 'nothing was seen to come of it'
            : 'no client was registered'
        );
      }
    }
  });

  // Expo Go only: the route reload needs the `/lab` screen, which the scaffold has and the minimal
  // dev-build app (`apps/eas-example`, root route only) does not.
  onExpoGo('runtime:reload --cloud --route puts the app on the route it names', async () => {
    // The reload above may have relaunched the app, and a broadcast into that landing is mistaken
    // for its own answer — see waitForCloudAppSettledAsync, which this wait exists for.
    expect(await waitForCloudAppSettledAsync('before-reload-route')).toBe(true);

    const result = await runLiveEasAsync(
      run,
      projectRoot,
      ['runtime:reload', '--cloud', '--route', LAB_ROUTE, '--timeout', RELOAD_TIMEOUT, '--json'],
      { label: 'reload-cloud-route', env: suiteEnv() }
    );
    expectExit(result, 0);
    const report = parseJson(result);
    expect(report.reloaded).toBe(true);
    expect(report.route).toBe(LAB_ROUTE);
    expect(report.routeCheck.ok).toBe(true);
    // The link that was opened, on the public origin. A flag that names a target *is* the target
    // (llp/0021), so a route reload that opened the root would be a wrong report, not a slow one.
    expect(report.url).toBe(`exp://${publicHost}/--${LAB_ROUTE}`);
  });

  it('smoke --cloud reports the phases it could reach, and stays on the backend it was given', async () => {
    const result = await runLiveEasAsync(
      run,
      projectRoot,
      ['smoke', '--cloud', `--${CLOUD_PLATFORM}`, '--json'],
      {
        label: 'smoke-cloud',
        env: suiteEnv(),
      }
    );
    const report = parseJson(result);
    // 20 and 22 are both possible and both honest: S11 means the runtime phase has nothing to read, and
    // "could not decide" is the answer for that. What is asserted is which device it was about.
    expect([0, 20, 22]).toContain(result.exitCode);
    expect(report.deviceBackend).toBe('cloud');
    // A `--cloud` follow-up names which cloud simulator by platform, so a follow-up on the session's
    // own platform is right — the CLI builds it on purpose and its own hermetic test asserts it
    // (followups reload-test.ts). What a cloud run must never do is send you to the *other* platform,
    // which this session is not: that follow-up would open nothing.
    const otherFlag = new RegExp(`--${OTHER_PLATFORM}\\b`);
    for (const followup of report.followups ?? []) {
      if (followup.command.includes('@expo/agent-cli')) {
        expect(followup.command).not.toMatch(otherFlag);
      }
    }
  });

  it('runtime:stop --cloud ends the app without ending the session', async () => {
    const result = await runLiveEasAsync(run, projectRoot, ['runtime:stop', '--cloud', '--json'], {
      label: 'stop-cloud',
      env: suiteEnv(),
    });
    expectExit(result, 0);
    const report = parseJson(result);
    expect(report.deviceBackend).toBe('cloud');
    // S13: the follow-up asserted "the app was not running" while `wasRunning` was null — which is the
    // one thing the cloud backend cannot know, because its verb succeeds for any app id. Null is the
    // honest value here; a `false` would be a claim.
    expect([true, null]).toContain(report.wasRunning);

    // S12: a failed cloud verb used to close the controller session and leave the device unusable
    // without saying so. Stopping the app is not stopping the session, and the service is the witness.
    const listed = await easAsync('simulator-list', [
      'simulator:list',
      '--status',
      'in-progress',
      '--non-interactive',
      '--json',
    ]);
    expect(listed.stdout).toContain(sessionId as string);
  });

  it('a --cloud run against a platform the session is not is refused, not opened', async () => {
    // llp/0022-live-tier.plan.md §Limits — "a session has one platform" was the unasserted row. This
    // session is one platform, so a run for the other one has to be refused rather than opened onto
    // nothing.
    //
    // The refusal names the platform only once the CLI has read the session from the service. That
    // read is a cold `bunx eas-cli@latest`, which the registry can leave half-resolved and killed —
    // whose honest answer is `CLOUD_SIMULATOR_SESSION_UNKNOWN`, a transient rather than the platform
    // fact under test. A run that lands there is tried once more; a mismatch opens nothing, so the
    // retry bills no session.
    const attempt = () =>
      runLiveEasAsync(run, projectRoot, ['navigate', '/', '--cloud', `--${OTHER_PLATFORM}`, '--json'], {
        label: 'navigate-cloud-mismatch',
        env: suiteEnv(),
      });
    let result = await attempt();
    let report = parseJson(result);
    if (report?.error?.code === 'CLOUD_SIMULATOR_SESSION_UNKNOWN') {
      result = await attempt();
      report = parseJson(result);
    }
    expect(result.exitCode).not.toBe(0);
    expect(JSON.stringify(report)).toMatch(/platform/i);
  });
});
