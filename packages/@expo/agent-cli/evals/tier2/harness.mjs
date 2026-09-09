// @ref llp/0002-testing-and-evals.plan.md; llp/0022-live-tier.plan.md
import { createHarness } from 'vitest-evals';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { captureProcess, killGroup } from './process.mjs';
import { summarizeTrace, normalizeTrace } from './trace.mjs';
import { assessOutcome } from './outcome.mjs';
import { checkCart, serveExport } from './browser.mjs';
import { assertBrokenBaseline, isolatedEnvironment } from './fixture-tools.mjs';
import { assertCliEvidence } from './cli-evidence.mjs';
import { CLAUDE_VERSION, CLAUDE_MODEL, prerequisiteReason } from './settings.mjs';

async function sourceSnapshot(workspace) {
  const files = ['App.js'];
  for (const file of await readdir(join(workspace, 'src'), { recursive: true })) {
    try {
      await readFile(join(workspace, 'src', file));
      files.push(`src/${file}`);
    } catch (error) {
      if (error.code !== 'EISDIR') throw error;
    }
  }
  return JSON.stringify(
    await Promise.all(
      files.sort().map(async (file) => [file, await readFile(join(workspace, file), 'utf8')])
    )
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '../../bin/cli.js');
const artifactRoot = resolve(here, '../artifacts/tier2'); // Stable from any command cwd.
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const text = async (path) => readFile(path, 'utf8').catch(() => '');
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function freePort() {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const port = server.address().port;
  await new Promise((accept) => server.close(accept));
  return port;
}

/** @type {import('vitest-evals').Harness<string, import('./outcome.mjs').Outcome>} */
export const tier2Harness = createHarness({
  name: 'claude-code-tier2-web',
  run: async ({ input, signal, setArtifact }) => {
    const artifacts = join(artifactRoot, 'runs', randomUUID());
    const persistOutcome = async (output) => {
      await json(join(artifacts, 'outcome.json'), output);
      await json(join(artifactRoot, 'outcome.json'), { ...output, artifactDirectory: artifacts });
    };
    await mkdir(artifacts, { recursive: true });
    setArtifact('artifactDirectory', artifacts);
    for (const name of [
      'claude.stream.jsonl',
      'claude.stderr.log',
      'workspace.diff',
      'agent-cli.events.jsonl',
    ])
      await writeFile(join(artifacts, name), '');
    const skipReason = prerequisiteReason();
    if (skipReason) {
      const output = { status: 'skipped', reason: skipReason, checks: [] };
      await persistOutcome(output);
      await json(join(artifacts, 'trace-summary.json'), summarizeTrace(''));
      return {
        output,
        events: [{ type: 'message', role: 'user', content: input }],
        artifacts: { directory: artifacts },
      };
    }
    await persistOutcome({ status: 'error', reason: 'Run interrupted before completion' });
    const deadline = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(27 * 60_000),
    ]);
    let env;
    let workspace,
      browser,
      baselineReady = false,
      claudeProcess = null,
      prompt = '';
    const checks = [],
      errors = [],
      cleanups = [];
    const startedAt = Date.now();
    const record = async (name, fn) => {
      try {
        checks.push({ name, ok: true, detail: await fn() });
      } catch (error) {
        checks.push({ name, ok: false, detail: String(error) });
      }
      await json(join(artifacts, 'checks.json'), checks);
    };
    const command = async (name, bin, args, options = {}) => {
      const result = await captureProcess(bin, args, {
        cwd: workspace,
        env,
        signal: AbortSignal.any([deadline, AbortSignal.timeout(5 * 60_000)]),
        stdoutPath: join(artifacts, `${name}.stdout.log`),
        stderrPath: join(artifacts, `${name}.stderr.log`),
        ...options,
      });
      await json(join(artifacts, `${name}.process.json`), result);
      if (result.exitCode !== 0 || result.timedOut || result.spawnError || result.signal)
        throw new Error(`${name} did not complete: ${JSON.stringify(result)}`);
      return result;
    };
    try {
      if (input !== 'broken-web-cart') throw new Error(`Unknown scenario: ${input}`);
      await access(resolve(here, '../../build/cli/index.js'));
      const runRoot = await mkdtemp(join(tmpdir(), 'agent-cli-tier2-'));
      workspace = join(runRoot, 'app');
      const home = join(runRoot, 'home');
      await mkdir(home);
      env = isolatedEnvironment(home);
      await cp(join(here, 'fixture'), workspace, { recursive: true });
      await writeFile(
        join(workspace, '.gitignore'),
        'node_modules/\ndist/\nverification-dist/\n.expo/\n.claude/\n'
      );
      await json(join(artifacts, 'run.json'), {
        workspace,
        home,
        model: CLAUDE_MODEL,
        claudeVersion: CLAUDE_VERSION,
        startedAt: new Date(startedAt).toISOString(),
      });
      const version = await command('claude-version', 'claude', ['--version']);
      if (
        !(await text(join(artifacts, 'claude-version.stdout.log'))).startsWith(`${CLAUDE_VERSION} `)
      )
        throw new Error(
          `Install @anthropic-ai/claude-code@${CLAUDE_VERSION} (version process exited ${version.exitCode})`
        );
      // Browser is harness-only: a separate pinned tool install, never supplied by the agent's app.
      const require = createRequire(
        process.env.TIER2_PLAYWRIGHT_ROOT
          ? join(resolve(process.env.TIER2_PLAYWRIGHT_ROOT), 'package.json')
          : import.meta.url
      );
      if (require('playwright/package.json').version !== '1.55.0')
        throw new Error('Tier2 requires playwright@1.55.0');
      browser = await require('playwright').chromium.launch({ headless: true });
      const cancelBrowser = () => {
        void browser.close().catch(() => {});
      };
      deadline.addEventListener('abort', cancelBrowser, { once: true });
      cleanups.push(async () => {
        deadline.removeEventListener('abort', cancelBrowser);
        await browser.close();
      });
      await command('install', 'npm', ['ci', '--no-audit', '--no-fund']);
      // Stage a baseline index without creating any commit.
      await command('git-init', 'git', ['init', '--quiet']);
      await command('git-baseline', 'git', ['add', '.']);
      await cp(join(workspace, '.git/index'), join(artifacts, 'baseline.index'));
      baselineReady = true;
      const expoBin = join(workspace, 'node_modules/expo/bin/cli');
      const baseline = await captureProcess(
        process.execPath,
        [expoBin, 'export', '--platform', 'web', '--output-dir', 'dist'],
        {
          cwd: workspace,
          env,
          signal: AbortSignal.any([deadline, AbortSignal.timeout(5 * 60_000)]),
          stdoutPath: join(artifacts, 'baseline.stdout.log'),
          stderrPath: join(artifacts, 'baseline.stderr.log'),
        }
      );
      await json(join(artifacts, 'baseline.process.json'), baseline);
      const baselineLog =
        (await text(join(artifacts, 'baseline.stdout.log'))) +
        (await text(join(artifacts, 'baseline.stderr.log')));
      assertBrokenBaseline(baseline, baselineLog);
      checks.push({
        name: 'broken-baseline',
        ok: true,
        detail: 'Real Expo web export failed resolving src/total',
      });
      await rm(join(workspace, 'dist'), { recursive: true, force: true });
      const immutable = [
        'package.json',
        'package-lock.json',
        'app.json',
        'index.js',
        'src/items.json',
        '.gitignore',
      ];
      const before = new Map(
        await Promise.all(
          immutable.map(async (file) => [file, await readFile(join(workspace, file), 'utf8')])
        )
      );
      const originalSources = await sourceSnapshot(workspace);
      const port = await freePort();
      cleanups.push(async () => {
        // Cleanup has its own deadline: the run signal may already have expired.
        await command('dev-stop', process.execPath, [cli, 'dev:stop', '--json'], {
          signal: AbortSignal.timeout(30_000),
        });
        try {
          await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1500) });
        } catch {
          return;
        }
        throw new Error(`Port ${port} still answers after dev:stop`);
      });
      prompt = `Repair this Expo web coffee cart in the current directory. Diagnose its build failure, fix the source, and preserve its UI and item data. The total must multiply each price by quantity: initially $18.00, then $25.50 after Add Coffee, then $28.50 after Add Tea. Keep the heading, controls, and cart-total testID.\nUse the built @expo/agent-cli with: ${quote(process.execPath)} ${quote(cli)} <command>. Read --help to discover flags. Run CLI commands one at a time. Use it to diagnose, export the repaired app for web to dist/, and use its dev command to start the web dev server on port ${port}. Leave that server running when you finish. Verify your work before stopping.\nOnly edit App.js and source files under src/ except src/items.json. Dependencies are installed; do not change manifests, item data, entrypoint, or configuration. Do not deploy, build native apps, use EAS, or change files outside this scratch project. Stop after completing the full task and summarize briefly.`;
      await writeFile(join(artifacts, 'prompt.txt'), prompt);
      const agentEnv = {
        ...env,
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        LOG_EVENTS: join(artifacts, 'agent-cli.events.jsonl'),
      };
      for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'])
        if (process.env[key]) agentEnv[key] = process.env[key];
      claudeProcess = await captureProcess(
        'claude',
        [
          '-p',
          prompt,
          '--output-format',
          'stream-json',
          '--verbose',
          '--model',
          CLAUDE_MODEL,
          '--max-turns',
          '40',
          '--max-budget-usd',
          '5',
          '--tools',
          'Bash,Read,Edit,Write',
          '--allowedTools',
          'Bash,Read,Edit,Write',
          '--setting-sources',
          '',
          '--strict-mcp-config',
          '--mcp-config',
          '{"mcpServers":{}}',
        ],
        {
          cwd: workspace,
          env: agentEnv,
          signal: AbortSignal.any([deadline, AbortSignal.timeout(15 * 60_000)]),
          stdoutPath: join(artifacts, 'claude.stream.jsonl'),
          stderrPath: join(artifacts, 'claude.stderr.log'),
        }
      );
      await json(join(artifacts, 'claude.process.json'), claudeProcess);
      await record('source-changed', async () => {
        if ((await sourceSnapshot(workspace)) === originalSources)
          throw new Error('No source changed');
        return 'App/source differs from broken baseline';
      });
      await record('fixture-contract', async () => {
        for (const [file, contents] of before)
          if ((await readFile(join(workspace, file), 'utf8')) !== contents)
            throw new Error(`${file} changed`);
        return 'Dependency lock, configuration, entrypoint and item data unchanged';
      });
      await record('agent-export', async () => {
        const server = await serveExport(join(workspace, 'dist'));
        try {
          return await checkCart(browser, server.url, join(artifacts, 'agent-export.png'));
        } finally {
          await server.close();
        }
      });
      await record('metro-status', async () => {
        const response = await fetch(`http://127.0.0.1:${port}/status`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok || (await response.text()).trim() !== 'packager-status:running')
          throw new Error('Metro /status did not confirm a running packager');
        return { port, status: response.status };
      });
      await record('metro-browser', () =>
        checkCart(browser, `http://127.0.0.1:${port}`, join(artifacts, 'metro.png'))
      );
      await rm(join(workspace, 'verification-dist'), { recursive: true, force: true });
      await record('fresh-export', async () => {
        await command('fresh-export', process.execPath, [
          expoBin,
          'export',
          '--platform',
          'web',
          '--output-dir',
          'verification-dist',
          '--clear',
        ]);
        return 'Independent Expo subprocess exported current source into an empty output directory';
      });
      await record('export-browser', async () => {
        const server = await serveExport(join(workspace, 'verification-dist'));
        try {
          return await checkCart(browser, server.url, join(artifacts, 'fresh-export.png'));
        } finally {
          await server.close();
        }
      });
      await record('agent-cli-invocations', async () => {
        const evidence = assertCliEvidence(
          await text(join(artifacts, 'agent-cli.events.jsonl')),
          port
        );
        await json(join(artifacts, 'cli-event-summary.json'), evidence);
        setArtifact('cliEventEvidence', evidence);
        return evidence;
      });
    } catch (error) {
      errors.push(String(error));
    } finally {
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(`Cleanup: ${error}`);
        }
      }
      if (claudeProcess?.pid) {
        try {
          killGroup(claudeProcess.pid, 'SIGKILL');
        } catch (error) {
          errors.push(`Claude process cleanup: ${error}`);
        }
      }
      if (workspace && baselineReady) {
        try {
          // Use the saved index so agent-side git staging cannot hide its diff.
          const diffEnv = { ...env, GIT_INDEX_FILE: join(artifacts, 'baseline.index') };
          await command('git-new-files', 'git', ['add', '--intent-to-add', '.'], {
            env: diffEnv,
            signal: AbortSignal.timeout(15_000),
          });
          await command('git-diff', 'git', ['diff', '--no-ext-diff', '--no-textconv', '--binary'], {
            env: diffEnv,
            signal: AbortSignal.timeout(15_000),
          });
          await cp(join(artifacts, 'git-diff.stdout.log'), join(artifacts, 'workspace.diff'));
        } catch (error) {
          errors.push(`Diff capture: ${error}`);
        }
      }
    }
    const raw = await text(join(artifacts, 'claude.stream.jsonl'));
    const trace = summarizeTrace(raw);
    const output = {
      ...assessOutcome({ process: claudeProcess, trace, checks, errors }),
      elapsedMs: Date.now() - startedAt,
    };
    await json(join(artifacts, 'trace-summary.json'), trace);
    await persistOutcome(output);
    setArtifact('traceSummary', trace);
    return {
      output,
      events: normalizeTrace(raw, prompt || String(input)),
      usage: {
        provider: 'anthropic',
        model: CLAUDE_MODEL,
        metadata: {
          reportedUsage: trace.terminal?.usage ?? {},
          reportedCostUSD: trace.terminal?.total_cost_usd ?? null,
        },
      },
      artifacts: { directory: artifacts, workspace: workspace ?? null },
    };
  },
});
