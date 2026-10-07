// @ref llp/0030-one-device-per-agent.rfc.md §The registry
//
// Two worktrees of one app get two devices and never share one, against real backends. The stub
// tier (`e2e/__tests__/device-claims-test.ts`) proves the claim crosses processes against a stub
// `simctl`; this proves it against real simulators, a real `expo run:ios`, and real EAS Simulator
// sessions.
//
// Each block copies the committed `apps/eas-example` (a dev-client app linked to `expo-ci`) into two
// scratch worktrees and runs `bun install` in each. A copy inside the workspace could not build: its
// `node_modules` are symlinks into the root. Each block points `__UNSAFE_EXPO_HOME_DIRECTORY` at a
// fresh directory, so the registry it reads and asserts on is its own and the machine's `~/.expo` is
// untouched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  allOf,
  assertEasEnabled,
  builtBinGate,
  claimsOptInGate,
  cloudOptInGate,
  describeLive,
  easCiGate,
  easProjectGate,
  iphoneSimulatorsGate,
  EAS_EXAMPLE_APP,
  networkGate,
  packageRunnerGate,
  registryGate,
} from '../prereq';
import {
  LiveRun,
  type LiveChild,
  copyTreeAsync,
  execAsync,
  expectExit,
  looksLikeUncaughtException,
  parseJson,
  runLiveAsync,
  spawnLive,
  stopProcessTreeAsync,
  waitForAsync,
} from '../utils';

/** The fields of a registry file this suite reads (`src/deviceClaims/types.ts` §DeviceClaim). */
type Claim = {
  backend: 'local-ios' | 'local-android' | 'eas';
  id: string;
  projectRoot: string;
  created: boolean;
  booted: boolean;
};

/** Two concurrent local dev-client builds take 5–10 minutes; the bound is double that. */
const LOCAL_BUILD_MS = 1_200_000;

/** The first EAS build takes 10–15 minutes and a session start a few more; the bound is generous. */
const EAS_SESSION_MS = 2_400_000;

/**
 * The gap between the two `dev --eas` starts.
 *
 * A workaround for a real finding, not a fix: two `bunx eas-cli@latest` started at once race for the
 * shared bunx install directory, and one of them fails [observed — 2026-10-05, by hand].
 * `src/utils/runnerLock.ts` serializes the runner inside one process only, and these are two.
 */
const EAS_STAGGER_MS = 20_000;

/**
 * The bounds inside the EAS `afterAll`, whose own timeout is 900 s.
 *
 * A step that hangs is killed at its bound, so the sweep that stops every session always runs. Two
 * `dev:stop` at 120 s, the foreground runs at 60 s, then the leak check and one stop per session at
 * 120 s each add up to 660 s for two sessions.
 */
const CLEANUP_DEV_STOP_MS = 120_000;
const CLEANUP_DEV_EXIT_MS = 60_000;
const CLEANUP_EAS_CALL_MS = 120_000;

type Worktrees = {
  /** Canonical roots, the form a claim's `projectRoot` takes. */
  roots: [string, string];
  expoHome: string;
  env: Record<string, string>;
};

/** The two worktrees of `app`, their shared machine registry, and the env every run in them gets. */
async function setUpWorktreesAsync(
  run: LiveRun,
  { app, eas }: { app: string; eas: boolean }
): Promise<Worktrees> {
  run.prepare();
  run.onCleanup('scratch worktrees', () => {
    if (!process.env.AGENT_CLI_LIVE_KEEP) {
      fs.rmSync(run.tempDir, { recursive: true, force: true });
    }
  });

  const expoHome = path.join(run.tempDir, 'expo-home');
  fs.mkdirSync(expoHome, { recursive: true });
  // The fresh home also moves the EAS login, which lives in `state.json` beside the registry.
  const state = path.join(os.homedir(), '.expo', 'state.json');
  if (eas && !process.env.EXPO_TOKEN && fs.existsSync(state)) {
    fs.copyFileSync(state, path.join(expoHome, 'state.json'));
  }

  const bun = (await execAsync('bun', ['--version'])).stdout.trim();
  const roots = await Promise.all(
    ['worktree-a', 'worktree-b'].map(async (name) => {
      const root = path.join(run.tempDir, name);
      fs.cpSync(app, root, {
        recursive: true,
        filter: (source) => !NOT_COPIED.has(path.relative(app, source)),
      });
      const installed = await execAsync('bun', ['install'], { cwd: root });
      if (installed.exitCode !== 0) {
        throw new Error(`bun install in ${root} exited ${installed.exitCode}: ${installed.stderr}`);
      }
      pinBuilderBun(root, bun);
      return fs.realpathSync(root);
    })
  );

  return {
    roots: roots as [string, string],
    expoHome,
    env: {
      __UNSAFE_EXPO_HOME_DIRECTORY: expoHome,
      AGENT_CLI_NO_DEVICE: '0',
      // The copies are not git repositories, and eas-cli otherwise prompts for `git init`.
      ...(eas ? { EAS_NO_VCS: '1' } : {}),
    },
  };
}

/**
 * What a worktree copy leaves out: installs, native projects, the dev server state, and the session
 * dotenv. A copy that carried the source app's `.env.eas-simulator` would put a session this suite
 * did not start on the list of sessions it stops.
 */
const NOT_COPIED = new Set(['node_modules', '.expo', 'ios', 'android', '.env.eas-simulator']);

/**
 * Add the simulator profile `dev --eas` builds, with the EAS builder's bun pinned to the local one.
 *
 * The copy's own `bun install` writes a v2 `bun.lock`, and bun 1.3.14, the builder's default, cannot
 * read it [observed — 2026-10-06, `bun@1.3.14 install --frozen-lockfile` in a copy]. `dev --eas`
 * adds this profile itself when it is missing, but without a `bun` key.
 */
function pinBuilderBun(root: string, bun: string): void {
  const easJsonPath = path.join(root, 'eas.json');
  const easJson = JSON.parse(fs.readFileSync(easJsonPath, 'utf8'));
  easJson.build['development-simulator'] = {
    developmentClient: true,
    distribution: 'internal',
    ios: { simulator: true },
    bun,
  };
  fs.writeFileSync(easJsonPath, `${JSON.stringify(easJson, null, 2)}\n`);
}

function readClaims(expoHome: string): Claim[] {
  const directory = path.join(expoHome, 'agent-cli', 'devices');
  return fs.existsSync(directory)
    ? fs
        .readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')))
    : [];
}

/**
 * The session `eas simulator` named in a worktree's `.env.eas-simulator`.
 *
 * It writes the id the moment the session exists [observed — eas-cli 24.11.0 `simulator/index.js`],
 * minutes before `dev` binds a claim to it.
 */
function readSessionIdFromDotenv(root: string): string | null {
  try {
    const text = fs.readFileSync(path.join(root, '.env.eas-simulator'), 'utf8');
    return /^EAS_SIMULATOR_SESSION_ID=['"]?([^'"\s]+)/m.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Wait for `work` at most `ms`, then `abandon` it and go on.
 *
 * A hung step must not keep the cleanup from its sweep. A failure of `work` is printed and does not
 * stop the cleanup either.
 */
async function boundedAsync(
  what: string,
  work: Promise<unknown>,
  ms: number,
  abandon: () => void
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<true>((resolve) => {
    timer = setTimeout(resolve, ms, true);
  });
  try {
    if ((await Promise.race([work.then(() => false), expired])) === true) {
      console.log(`[live] ${what} still running after ${ms} ms; killing it and going on`);
      abandon();
    }
  } catch (error: any) {
    console.log(`[live] ${what} failed (continuing): ${error?.message ?? error}`);
  } finally {
    clearTimeout(timer);
  }
}

/** The one claim of `backend` per root, once both roots hold one and their ids differ. */
function claimPerRoot(worktrees: Worktrees, backend: Claim['backend']): Map<string, Claim> | null {
  const claims = readClaims(worktrees.expoHome).filter((claim) => claim.backend === backend);
  const byRoot = new Map(claims.map((claim) => [claim.projectRoot, claim]));
  const ok =
    claims.length === 2 &&
    worktrees.roots.every((root) => byRoot.has(root)) &&
    new Set(claims.map((claim) => claim.id)).size === 2;
  return ok ? byRoot : null;
}

describeLive(
  'live-claims (local iOS)',
  allOf(claimsOptInGate(), builtBinGate(), iphoneSimulatorsGate(2), registryGate())
)('live-claims: two worktrees, two local simulators', () => {
  const run = new LiveRun('live-claims-local');
  let worktrees: Worktrees | null = null;
  let claims = new Map<string, Claim>();

  const cli = (root: string, argv: string[], label: string) =>
    runLiveAsync(run, root, argv, { env: worktrees!.env, label });

  beforeAll(
    async () => {
      worktrees = await setUpWorktreesAsync(run, { app: EAS_EXAMPLE_APP, eas: false });
      const { roots } = worktrees;

      // The parent exits 1 after its 120 s `--detach` budget while the child still builds. That
      // budget is pre-existing and not this suite's subject, so the registry and the dev-server lock
      // are what this waits on.
      const started = await Promise.all(
        roots.map((root, index) =>
          cli(root, ['dev', '--ios', '--detach', '--json'], `dev-detach-${index}`)
        )
      );
      for (const result of started) {
        expect(looksLikeUncaughtException(result), result.artifact).toBe(false);
        console.log(`[live] dev --detach exited ${result.exitCode} — ${result.artifact}`);
      }

      expect(
        await waitForAsync(
          () => claimPerRoot(worktrees!, 'local-ios') != null,
          LOCAL_BUILD_MS,
          5_000
        ),
        `two local-ios claims with different ids for ${roots.join(' and ')}: ${JSON.stringify(readClaims(worktrees.expoHome))}`
      ).toBe(true);
      claims = claimPerRoot(worktrees, 'local-ios')!;

      const ready = await Promise.all(
        roots.map((root, index) =>
          waitForAsync(
            async () => {
              const status = await cli(root, ['status', '--json'], `status-wait-${index}`);
              const devServer = parseJson(status).devServer;
              return devServer?.running === true && devServer?.source === 'lock';
            },
            LOCAL_BUILD_MS,
            15_000
          )
        )
      );
      expect(ready, 'both dev servers running from their own lock').toEqual([true, true]);
    },
    LOCAL_BUILD_MS * 2 + 600_000
  );

  afterAll(async () => {
    try {
      if (worktrees) {
        for (const [index, root] of worktrees.roots.entries()) {
          await cli(root, ['dev:stop', '--json'], `cleanup-dev-stop-${index}`);
        }
        expect(readClaims(worktrees.expoHome), 'claims left in the registry').toEqual([]);
      }
    } finally {
      await run.cleanUpAsync();
      console.log(run.costLine());
    }
  }, 300_000);

  it('gives each worktree its own simulator', () => {
    const [a, b] = worktrees!.roots;
    expect(claims.get(a)!.id).not.toBe(claims.get(b)!.id);
  });

  it("runs each worktree's Metro on its own port, serving its own project", async () => {
    const ports: string[] = [];
    for (const [index, root] of worktrees!.roots.entries()) {
      const status = await cli(root, ['status', '--json'], `status-${index}`);
      expectExit(status, 0);
      const { devServer } = parseJson(status);
      // Red when another project's Metro holds `*:8081`: `isPortBindableAsync` binds 127.0.0.1
      // only, which succeeds beside an IPv6 wildcard listener, so both worktrees were given 8081
      // and the first one's lock pointed at the other project's server [observed — 2026-10-05].
      expect(devServer.projectRootMatched, status.artifact).toBe(true);
      ports.push(new URL(devServer.url).port);
    }
    expect(ports[0]).not.toBe(ports[1]);
  });

  it("navigate drives the worktree's own simulator", async () => {
    for (const [index, root] of worktrees!.roots.entries()) {
      const result = await cli(root, ['navigate', '/', '--json'], `navigate-${index}`);
      const report = parseJson(result);
      expect(report.deviceBackend).toBe('local-ios');
      expect(report.deviceId, result.artifact).toBe(claims.get(root)!.id);
    }
  });

  it('dev:stop gives each simulator back, and shuts down only one this CLI booted', async () => {
    for (const [index, root] of worktrees!.roots.entries()) {
      const claim = claims.get(root)!;
      const result = await cli(root, ['dev:stop', '--json'], `dev-stop-${index}`);
      expectExit(result, 0);
      expect(parseJson(result).devices).toEqual([
        {
          id: claim.id,
          backend: 'local-ios',
          released: true,
          shutDown: claim.booted || claim.created,
          reason: null,
        },
      ]);
    }
  });
});

const easCi = easCiGate();
const easProject = easProjectGate();

describeLive(
  'live-claims (EAS)',
  allOf(
    claimsOptInGate(),
    builtBinGate(),
    cloudOptInGate(),
    easCi.gate,
    easProject.gate,
    packageRunnerGate(),
    networkGate(),
    registryGate()
  )
)('live-claims: two worktrees, two EAS Simulator sessions', () => {
  const run = new LiveRun('live-claims-eas');
  let worktrees: Worktrees | null = null;
  let claims = new Map<string, Claim>();
  const devs: LiveChild[] = [];
  /** Every session this suite learned of, so the cleanup can name exactly these. */
  const sessionIds = new Set<string>();

  const cli = (root: string, argv: string[], label: string) => {
    assertEasEnabled(`@expo/agent-cli ${argv.join(' ')}`);
    return runLiveAsync(run, root, argv, { env: worktrees!.env, label });
  };

  async function easAsync(label: string, args: string[], timeoutMs = 300_000) {
    assertEasEnabled(`eas ${args.join(' ')}`);
    const result = await execAsync('npx', ['--yes', 'eas-cli@latest', ...args], {
      cwd: worktrees!.roots[0],
      env: { EAS_NO_VCS: '1' },
      timeoutMs,
    });
    run.writeArtifact(
      `eas-${label}.txt`,
      `$ eas ${args.join(' ')}\nexit ${result.exitCode}\n\n${result.stdout}\n${result.stderr}`
    );
    return result;
  }

  /**
   * Record each session id the suite can name, and the stop that ends it, the moment it is first seen.
   *
   * Two sources, because a claim is bound only after `eas simulator` returns, which waits minutes for
   * the session to be ready, and a session that bills from its creation has no claim until then. The
   * dotenv has the id from the creation on. Each id gets its own cleanup, so one stop that fails does
   * not skip the next.
   */
  function recordSessionIds(): void {
    const { expoHome, roots } = worktrees!;
    const learned = [
      ...readClaims(expoHome)
        .filter((claim) => claim.backend === 'eas')
        .map((claim) => claim.id),
      ...roots.flatMap((root) => readSessionIdFromDotenv(root) ?? []),
    ];
    for (const id of learned) {
      if (sessionIds.has(id)) {
        continue;
      }
      sessionIds.add(id);
      run.spend.cloudSessions += 1;
      run.onCleanup(`eas simulator:stop ${id}`, async () => {
        await easAsync(
          `cleanup-stop-${id}`,
          ['simulator:stop', '--id', id, '--non-interactive'],
          CLEANUP_EAS_CALL_MS
        );
      });
    }
  }

  /**
   * The sessions of this project that bill: `new` and `in-progress`, and `queued` and `starting`,
   * which eas-cli 24.10 added [observed — eas-cli 24.11.0 `simulator/list.js`]. This suite runs
   * `eas-cli@latest`, which is 24.11.0 [observed — `npm view eas-cli dist-tags`]. `--limit 100` is
   * the most one page returns.
   */
  async function billingSessionIdsAsync(label: string, timeoutMs?: number): Promise<string[]> {
    const listed = await easAsync(
      label,
      [
        'simulator:list',
        ...['new', 'queued', 'starting', 'in-progress'].flatMap((status) => ['--status', status]),
        '--limit',
        '100',
        '--non-interactive',
        '--json',
      ],
      timeoutMs
    );
    if (listed.exitCode !== 0) {
      throw new Error(
        `eas simulator:list exited ${listed.exitCode}: ${listed.stderr.slice(-1000)}`
      );
    }
    const { sessions } = JSON.parse(listed.stdout) as { sessions: { id: string }[] };
    return sessions.map((session) => session.id);
  }

  beforeAll(async () => {
    worktrees = await setUpWorktreesAsync(run, { app: easProject.source!, eas: true });

    for (const [index, root] of worktrees.roots.entries()) {
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, EAS_STAGGER_MS));
      }
      assertEasEnabled('@expo/agent-cli dev --ios --eas');
      const dev = spawnLive(run, root, ['dev', '--ios', '--eas', '--json'], {
        env: worktrees.env,
        label: `dev-eas-${index}`,
      });
      dev.done.catch(() => {});
      devs.push(dev);
    }

    const bound = await waitForAsync(
      () => {
        recordSessionIds();
        const exited = devs.find(
          ({ child }) => child.exitCode !== null || child.signalCode !== null
        );
        if (exited) {
          throw new Error(
            `a foreground "dev --ios --eas" exited (${exited.child.exitCode ?? exited.child.signalCode}) before both sessions were claimed`
          );
        }
        return claimPerRoot(worktrees!, 'eas') != null;
      },
      EAS_SESSION_MS,
      15_000
    );
    expect(
      bound,
      `two eas claims with different ids for both worktrees: ${JSON.stringify(readClaims(worktrees.expoHome))}`
    ).toBe(true);
    claims = claimPerRoot(worktrees, 'eas')!;
  }, EAS_SESSION_MS + 600_000);

  afterAll(async () => {
    try {
      if (worktrees) {
        assertEasEnabled('@expo/agent-cli dev:stop --eas');
        recordSessionIds();
        for (const [index, root] of worktrees.roots.entries()) {
          const stop = spawnLive(run, root, ['dev:stop', '--eas', '--json'], {
            env: worktrees.env,
            label: `cleanup-dev-stop-eas-${index}`,
          });
          await boundedAsync(
            `dev:stop --eas in worktree ${index}`,
            stop.done,
            CLEANUP_DEV_STOP_MS,
            () => {
              void stopProcessTreeAsync(stop.child, 'SIGKILL');
            }
          );
        }
        await boundedAsync(
          'the foreground dev --eas runs',
          Promise.all(devs.map(({ child }) => stopProcessTreeAsync(child))),
          CLEANUP_DEV_EXIT_MS,
          () => devs.forEach(({ child }) => void stopProcessTreeAsync(child, 'SIGKILL'))
        );
        recordSessionIds();
        const leaked = (await billingSessionIdsAsync('cleanup-list', CLEANUP_EAS_CALL_MS)).filter(
          (id) => sessionIds.has(id)
        );
        expect(leaked, 'sessions this suite started, still billing after dev:stop --eas').toEqual(
          []
        );
        expect(readClaims(worktrees.expoHome), 'claims left in the registry').toEqual([]);
      }
    } finally {
      await run.cleanUpAsync();
      console.log(run.costLine());
    }
  }, 900_000);

  it('gives each worktree its own session', () => {
    const [a, b] = worktrees!.roots;
    expect(claims.get(a)!.id).not.toBe(claims.get(b)!.id);
  });

  it("navigate --eas drives the worktree's own session", async () => {
    for (const [index, root] of worktrees!.roots.entries()) {
      const result = await cli(
        root,
        ['navigate', '/', '--eas', '--ios', '--no-wait-attach', '--json'],
        `navigate-eas-${index}`
      );
      expectExit(result, 0);
      const report = parseJson(result);
      expect(report.deviceBackend).toBe('cloud');
      expect(report.deviceId).toBe(claims.get(root)!.id);
    }
  });

  it("a worktree with another worktree's .env.eas-simulator does not adopt its session", async () => {
    const [a] = worktrees!.roots;
    const listed = await billingSessionIdsAsync('list-both');
    expect(listed).toEqual(expect.arrayContaining([...claims.values()].map((claim) => claim.id)));

    // A third worktree cloned from A, so A's dotenv travels with the files around it, and with no
    // session of its own. Not a third billed session: the probe must skip a dotenv whose session
    // another live worktree claims.
    expect(
      await waitForAsync(() => fs.existsSync(path.join(a, '.env.eas-simulator')), 60_000, 2_000),
      `${a}/.env.eas-simulator`
    ).toBe(true);
    const copied = path.join(run.tempDir, 'worktree-c');
    await copyTreeAsync(a, copied);
    fs.rmSync(path.join(copied, '.expo'), { recursive: true, force: true });
    const c = fs.realpathSync(copied);

    const result = await cli(c, ['dev:stop', '--eas', '--json'], 'dev-stop-eas-copied-dotenv');
    expectExit(result, 0);
    expect(parseJson(result).session).toMatchObject({ id: null, stopped: false });
    expect(readClaims(worktrees!.expoHome).filter((claim) => claim.projectRoot === c)).toEqual([]);
    expect(await billingSessionIdsAsync('list-after-copied-dotenv')).toEqual(
      expect.arrayContaining([...claims.values()].map((claim) => claim.id))
    );
  });

  it("dev:stop --eas ends each worktree's session", async () => {
    for (const [index, root] of worktrees!.roots.entries()) {
      const claim = claims.get(root)!;
      const result = await cli(root, ['dev:stop', '--eas', '--json'], `dev-stop-eas-${index}`);
      expectExit(result, 0);
      // The foreground `dev` stops its own session when it exits, so this stop may find none.
      const { session } = parseJson(result);
      expect([claim.id, null]).toContain(session.id);
      expect(session.stopped).toBe(session.id === claim.id);
    }
    expect(
      await waitForAsync(
        async () =>
          (await billingSessionIdsAsync('list-after-stop')).every((id) => !sessionIds.has(id)),
        180_000,
        15_000
      ),
      'the sessions this suite started are no longer billing'
    ).toBe(true);
  });
});
