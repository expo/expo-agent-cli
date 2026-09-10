// Free, explicit fixture verification. Never imports or invokes the Claude harness.
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { captureProcess } from './process.mjs';
import { assertBrokenBaseline, isolatedEnvironment } from './fixture-tools.mjs';
import { checkCart, serveExport } from './browser.mjs';
import { assertCliEvidence } from './cli-evidence.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const artifacts = resolve(here, '../artifacts/tier2/fixture-check', randomUUID());
await mkdir(artifacts, { recursive: true });
const runRoot = await mkdtemp(join(tmpdir(), 'tier2-fixture-check-'));
const workspace = join(runRoot, 'app'),
  home = join(runRoot, 'home');
await mkdir(home);
await cp(join(here, 'fixture'), workspace, { recursive: true });
const env = isolatedEnvironment(home);
const cliFlag = process.argv.indexOf('--agent-cli');
const cli = cliFlag < 0 ? null : resolve(process.argv[cliFlag + 1]);
const cliEvents = join(artifacts, 'agent-cli.events.jsonl');
let cliPort = null;
// npm and every child use the same Node major as this verifier.
env.PATH = `${dirname(process.execPath)}:${env.PATH ?? ''}`;
const cliEnv = { ...env, LOG_EVENTS: cliEvents };
const report = {
  node: process.version,
  platform: process.platform,
  workspace,
  checks: [],
  error: null,
};
const json = (name, value) =>
  writeFile(join(artifacts, name), JSON.stringify(value, null, 2) + '\n');
const text = (path) => readFile(path, 'utf8');
async function command(name, bin, args, childEnv = env) {
  const result = await captureProcess(bin, args, {
    cwd: workspace,
    env: childEnv,
    signal: AbortSignal.timeout(5 * 60_000),
    stdoutPath: join(artifacts, `${name}.stdout.log`),
    stderrPath: join(artifacts, `${name}.stderr.log`),
  });
  await json(`${name}.process.json`, result);
  return result;
}
function requireSuccess(name, result) {
  if (result.exitCode !== 0 || result.signal || result.timedOut || result.spawnError)
    throw new Error(`${name} failed: ${JSON.stringify(result)}`);
}
let browser, metroAbort, metroResult;
try {
  const lockBefore = await text(join(workspace, 'package-lock.json'));
  requireSuccess('npm ci', await command('npm-ci', 'npm', ['ci', '--no-audit', '--no-fund']));
  if ((await text(join(workspace, 'package-lock.json'))) !== lockBefore)
    throw new Error('npm ci changed the lockfile');
  report.checks.push('clean npm ci; lock unchanged');
  const pkg = JSON.parse(await text(join(workspace, 'package.json')));
  await json(
    'installed-versions.json',
    Object.fromEntries(
      await Promise.all(
        Object.keys(pkg.dependencies).map(async (name) => [
          name,
          JSON.parse(await text(join(workspace, 'node_modules', name, 'package.json'))).version,
        ])
      )
    )
  );
  const expo = join(workspace, 'node_modules/expo/bin/cli');
  const exportArgs = [expo, 'export', '--platform', 'web', '--output-dir', 'dist', '--clear'];
  const broken = await command('baseline', process.execPath, exportArgs);
  assertBrokenBaseline(
    broken,
    (await text(join(artifacts, 'baseline.stdout.log'))) +
      (await text(join(artifacts, 'baseline.stderr.log')))
  );
  report.checks.push('baseline fails only at the intended missing ./src/total import');
  await writeFile(
    join(workspace, 'App.js'),
    (await text(join(workspace, 'App.js'))).replace("'./src/total'", "'./src/totals'")
  );
  requireSuccess(
    'import-only repair export',
    await command('import-repair-export', process.execPath, exportArgs)
  );
  report.checks.push('repairing only the import makes the real Expo export succeed');
  const wantsBrowser = process.argv.includes('--browser');
  if (wantsBrowser) {
    const require = createRequire(
      process.env.TIER2_PLAYWRIGHT_ROOT
        ? join(resolve(process.env.TIER2_PLAYWRIGHT_ROOT), 'package.json')
        : import.meta.url
    );
    if (require('playwright/package.json').version !== '1.55.0')
      throw new Error('Install playwright@1.55.0');
    browser = await require('playwright').chromium.launch({ headless: true });
    const server = await serveExport(join(workspace, 'dist'));
    const page = await browser.newPage();
    try {
      await page.goto(server.url);
      await page.getByTestId('cart-total').waitFor();
      const total = await page.getByTestId('cart-total').textContent();
      if (total !== '$10.50')
        throw new Error(`Expected remaining arithmetic bug ($10.50), got ${total}`);
      await page.screenshot({ path: join(artifacts, 'import-only-arithmetic-bug.png') });
      report.checks.push(
        'browser confirms arithmetic remains broken after import-only repair ($10.50)'
      );
    } finally {
      await page.close();
      await server.close();
    }
  }
  await writeFile(
    join(workspace, 'src/totals.js'),
    (await text(join(workspace, 'src/totals.js'))).replace(
      'sum + item.priceCents',
      'sum + item.priceCents * item.quantity'
    )
  );
  requireSuccess(
    'full repair export',
    await command('repaired-export', process.execPath, exportArgs)
  );
  report.checks.push('reference repair exports successfully');
  if (cli) {
    requireSuccess(
      'agent-cli export',
      await command(
        'agent-cli-export',
        process.execPath,
        [cli, 'export', '--platform', 'web', '--output-dir', 'dist', '--clear'],
        cliEnv
      )
    );
    report.checks.push('real agent-cli export succeeds and emits its passthrough event');
  }
  if (browser) {
    const server = await serveExport(join(workspace, 'dist'));
    try {
      await checkCart(browser, server.url, join(artifacts, 'repaired-export.png'));
    } finally {
      await server.close();
    }
    report.checks.push('reference export passes independent browser totals and button checks');
    const reservation = createServer();
    await new Promise((accept) => reservation.listen(0, '127.0.0.1', accept));
    const port = reservation.address().port;
    await new Promise((accept) => reservation.close(accept));
    cliPort = port;
    if (cli) {
      requireSuccess(
        'agent-cli dev',
        await command(
          'agent-cli-dev',
          process.execPath,
          [cli, 'dev', '--web', '--detach', '--wait-ready', '--port', String(port), '--json'],
          cliEnv
        )
      );
    } else {
      metroAbort = new AbortController();
      metroResult = captureProcess(
        process.execPath,
        [expo, 'start', '--web', '--port', String(port)],
        {
          cwd: workspace,
          env,
          signal: AbortSignal.any([metroAbort.signal, AbortSignal.timeout(120_000)]),
          stdoutPath: join(artifacts, 'metro.stdout.log'),
          stderrPath: join(artifacts, 'metro.stderr.log'),
        }
      );
    }
    const until = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < until) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/status`, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok && (await response.text()).trim() === 'packager-status:running') {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((accept) => setTimeout(accept, 250));
    }
    if (!ready) throw new Error('Metro did not become ready');
    await checkCart(browser, `http://127.0.0.1:${port}`, join(artifacts, 'metro.png'));
    report.checks.push('real Metro status and browser totals/button checks pass');
    if (cli) {
      await json('agent-cli-evidence.json', assertCliEvidence(await text(cliEvents), port));
      report.checks.push('mechanical agent-cli export + executing dev + server events verified');
    }
  }
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  if (cli && cliPort !== null) {
    const stopped = await command('agent-cli-stop', process.execPath, [cli, 'dev:stop', '--json']);
    if (stopped.exitCode !== 0) {
      report.error ??= 'agent-cli dev:stop failed';
      process.exitCode = 1;
    }
  }
  metroAbort?.abort();
  if (metroResult) await json('metro.process.json', await metroResult);
  if (browser) await browser.close();
  await json('fixture-verification.json', report);
  console.log(JSON.stringify({ artifacts, ...report }, null, 2));
}
