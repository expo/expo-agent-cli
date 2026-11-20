#!/usr/bin/env node
// Verification harness for @expo/agent-cli. Usage is in SKILL.md next to this file.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const skillDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(skillDir, '../../..');
const packageRoot = path.join(repoRoot, 'packages/@expo/agent-cli');
const bin = path.join(packageRoot, 'bin/cli.js');
const bundle = path.join(packageRoot, 'build/cli/index.js');
const artifactsRoot = path.join(skillDir, '.artifacts');
const pointerFile = path.join(artifactsRoot, 'current-run.json');
// The committed Expo Router app with expo-dev-client. The skill drives it in place.
const projectDir = path.join(repoRoot, 'apps/eas-example');
// Native builds are shared by every checkout on this machine, keyed by fingerprint.
const home =
  process.env.AGENT_CLI_VERIFY_HOME ??
  path.join(
    os.homedir(),
    process.platform === 'darwin' ? 'Library/Caches' : '.cache',
    'agent-cli-verify'
  );
const buildCacheDir = path.join(home, 'build-cache');

function fail(message) {
  process.stderr.write(`verify: ${message}\n`);
  process.exit(1);
}

function readRun() {
  if (!fs.existsSync(pointerFile)) {
    fail('no run in progress. Run "verify.mjs launch" first.');
  }
  return JSON.parse(fs.readFileSync(pointerFile, 'utf8'));
}

function childEnv() {
  const {
    npm_config_minimum_release_age,
    NODE_ENV,
    VITEST,
    VITEST_WORKER_ID,
    VITEST_POOL_ID,
    ...env
  } = process.env;
  return {
    ...env,
    // `pod install` fails without a UTF-8 locale.
    LANG: env.LANG ?? 'en_US.UTF-8',
    LC_ALL: env.LC_ALL ?? 'en_US.UTF-8',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    EXPO_NO_TELEMETRY: '1',
  };
}

function newestSourceMtime(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== '__mocks__') {
        newest = Math.max(newest, newestSourceMtime(full));
      }
    } else if (/\.(ts|tsx|json)$/.test(entry.name)) {
      newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  }
  return newest;
}

function buildIsStale() {
  if (!fs.existsSync(bundle)) return true;
  return newestSourceMtime(path.join(packageRoot, 'src')) > fs.statSync(bundle).mtimeMs;
}

/** Run the built CLI in `cwd`, write one evidence file, and return the result. */
async function runCli(run, cwd, argv, label, { echo = true, record = true, killAfter = 600 } = {}) {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [bin, ...argv], {
    cwd,
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { stdout: '', stderr: '' };
  for (const stream of ['stdout', 'stderr']) {
    child[stream].on('data', (chunk) => {
      out[stream] += stripVTControlCharacters(chunk.toString());
      if (echo) process[stream].write(chunk);
    });
  }
  // A command that outlives its own timeout must not hold the proof run. Only the CLI process is
  // killed; a detached dev server that it started stays up.
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    child.kill('SIGKILL');
  }, killAfter * 1000);
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, sig) => resolve({ code: exitCode, signal: sig }));
  });
  clearTimeout(timer);
  if (killed) {
    process.stderr.write(`verify: killed after ${killAfter}s. The command did not exit.\n`);
  }

  if (!record) return { code: code ?? 1, ...out, evidence: null };
  const sequence = fs.readdirSync(run.evidenceDir).filter((name) => /^\d{3}-/.test(name)).length;
  const safeLabel = (label ?? argv.join('_')).replace(/[^\w.:=-]+/g, '_').slice(0, 80);
  const evidence = path.join(
    run.evidenceDir,
    `${String(sequence + 1).padStart(3, '0')}-${safeLabel}.txt`
  );
  fs.writeFileSync(
    evidence,
    [
      `$ expo-agent-cli ${argv.join(' ')}`,
      `cwd: ${cwd}`,
      `exit: ${code} signal: ${signal} in ${Date.now() - startedAt}ms${killed ? ` (killed by verify after ${killAfter}s)` : ''}`,
      '',
      '--- stdout ---',
      out.stdout,
      '--- stderr ---',
      out.stderr,
    ].join('\n')
  );
  process.stderr.write(`verify: exit ${killed ? 'none (killed)' : code} · evidence ${evidence}\n`);
  return { code: killed ? 22 : (code ?? 1), ...out, evidence };
}

function appGit(...args) {
  return spawnSync('git', [...args, '--', 'apps/eas-example'], { cwd: repoRoot, encoding: 'utf8' });
}

/** Put the app back on the committed state. Ignored files (native builds, `.expo`) stay. */
function restoreProject() {
  appGit('checkout');
  appGit('clean', '-fd');
}

async function launch() {
  if (fs.existsSync(pointerFile)) {
    fail(`run ${readRun().id} is in progress. Run "verify.mjs cleanup" first.`);
  }
  // Cleanup restores the app with git. A change that is already there would be lost.
  const dirty = appGit('status', '--porcelain').stdout.trim();
  if (dirty) {
    fail(`apps/eas-example has uncommitted changes. Commit or remove them first:\n${dirty}`);
  }
  if (!fs.existsSync(path.join(projectDir, 'node_modules', 'expo'))) {
    fail('apps/eas-example has no node_modules. Run "bun install" at the repository root.');
  }
  const build = spawnSync('bun', ['run', 'build'], { cwd: packageRoot, stdio: 'inherit' });
  if (build.status !== 0) fail('"bun run build" failed.');

  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const run = {
    id,
    startedAt: Date.now(),
    projectDir,
    evidenceDir: path.join(artifactsRoot, id),
    buildCacheDir,
  };
  fs.mkdirSync(run.evidenceDir, { recursive: true });
  fs.mkdirSync(buildCacheDir, { recursive: true });
  // The build cache provider reads `.expo/build-cache`. Point it at the shared directory.
  const link = path.join(projectDir, '.expo', 'build-cache');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  if (!fs.existsSync(link)) fs.symlinkSync(buildCacheDir, link, 'dir');
  fs.writeFileSync(pointerFile, JSON.stringify(run, null, 2));

  const cachedBuilds = fs.readdirSync(buildCacheDir);
  process.stdout.write(`${JSON.stringify({ ready: true, cachedBuilds, ...run }, null, 2)}\n`);
}

async function runCommand(args) {
  const run = readRun();
  const options = { label: undefined, until: undefined, timeout: 180, 'kill-after': 600 };
  while (['--label', '--until', '--timeout', '--kill-after'].includes(args[0])) {
    options[args[0].slice(2)] = args[1];
    args = args.slice(2);
  }
  if (args[0] === '--') args = args.slice(1);
  if (args.length === 0) {
    fail(
      'usage: verify.mjs run [--label <name>] [--kill-after <seconds>] [--until <regex> [--timeout <seconds>]] -- <cli arguments>'
    );
  }
  if (options.until === undefined) {
    const result = await runCli(run, run.projectDir, args, options.label, {
      killAfter: Number(options['kill-after']),
    });
    process.exit(result.code);
  }
  // Repeat a read-only command until its stdout matches. Only the last attempt is recorded.
  const pattern = new RegExp(options.until);
  const deadline = Date.now() + Number(options.timeout) * 1000;
  for (let attempt = 1; ; attempt++) {
    const probe = await runCli(run, run.projectDir, args, options.label, {
      echo: false,
      record: false,
      killAfter: 60,
    });
    const matched = pattern.test(probe.stdout);
    if (matched || Date.now() > deadline) {
      const result = await runCli(run, run.projectDir, args, options.label, { killAfter: 60 });
      const ok = pattern.test(result.stdout);
      process.stderr.write(
        `verify: ${ok ? 'matched' : 'did not match'} /${options.until}/ after ${attempt} attempts\n`
      );
      process.exit(ok ? result.code : 22);
    }
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
}

async function doctor() {
  const facts = {
    bundleBuilt: fs.existsSync(bundle),
    bundleStale: buildIsStale(),
    version: null,
    run: null,
    projectInstalled: false,
    devServer: null,
    binding: null,
    bootedSimulators: [],
  };
  if (facts.bundleBuilt) {
    facts.version = spawnSync(process.execPath, [bin, '--version'], {
      env: childEnv(),
      encoding: 'utf8',
    }).stdout.trim();
  }
  if (process.platform === 'darwin') {
    const simctl = spawnSync('xcrun', ['simctl', 'list', 'devices', 'booted'], {
      encoding: 'utf8',
    });
    facts.bootedSimulators = (simctl.stdout ?? '')
      .split('\n')
      .filter((line) => line.includes('(Booted)'))
      .map((line) => line.trim());
  }
  if (fs.existsSync(pointerFile)) {
    const run = JSON.parse(fs.readFileSync(pointerFile, 'utf8'));
    facts.run = run;
    facts.projectInstalled = fs.existsSync(path.join(run.projectDir, 'node_modules', 'expo'));
    if (facts.bundleBuilt && facts.projectInstalled) {
      const status = spawnSync(process.execPath, [bin, 'status', '--json', '--no-followups'], {
        cwd: run.projectDir,
        env: childEnv(),
        encoding: 'utf8',
      });
      try {
        const report = JSON.parse(status.stdout);
        facts.devServer = report.devServer;
        facts.binding = report.binding;
      } catch {
        facts.devServer = `status --json did not answer (exit ${status.status})`;
      }
    }
  }
  const ok =
    facts.bundleBuilt && !facts.bundleStale && facts.run !== null && facts.projectInstalled;
  process.stdout.write(`${JSON.stringify({ ok, ...facts }, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
}

/** Poll `status --json` until the project's dev server answers. A native build can take many minutes. */
async function waitServer(args) {
  const run = readRun();
  const minutes = Number(args[0] ?? 25);
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    const status = spawnSync(process.execPath, [bin, 'status', '--json', '--no-followups'], {
      cwd: run.projectDir,
      env: childEnv(),
      encoding: 'utf8',
    });
    let devServer = null;
    try {
      devServer = JSON.parse(status.stdout).devServer;
    } catch {}
    // A server of another project on the same port does not count.
    if (devServer?.running && devServer.projectRootMatched !== false) {
      process.stdout.write(`${JSON.stringify({ running: true, url: devServer.url })}\n`);
      return;
    }
    if (Date.now() > deadline) {
      fail(`no dev server after ${minutes} minutes. Run "verify.mjs run -- dev:logs".`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
}

async function freePort() {
  for (let port = 8600; port < 8650; port++) {
    const free = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      // No host: a dev server listens on every interface, and a loopback-only bind misses it.
      server.listen(port);
    });
    if (free) {
      process.stdout.write(`${port}\n`);
      return;
    }
  }
  fail('no free port between 8600 and 8650.');
}

async function cleanup(args) {
  const purge = args.includes('--purge');
  if (!fs.existsSync(pointerFile)) {
    process.stdout.write('verify: no run in progress. Nothing to clean.\n');
    return;
  }
  const run = JSON.parse(fs.readFileSync(pointerFile, 'utf8'));
  let stopCode = 0;
  if (fs.existsSync(path.join(run.projectDir, 'package.json')) && fs.existsSync(bundle)) {
    const stop = await runCli(
      run,
      run.projectDir,
      ['dev:stop', '--release', '--json', '--no-followups'],
      'cleanup-dev-stop',
      { echo: false }
    );
    stopCode = stop.code;
  }
  if (stopCode !== 0) {
    fail(`dev:stop exit ${stopCode}. Nothing else was changed. Read the evidence.`);
  }
  // The CLI writes screenshots and the dev-server log inside the project. Keep them as evidence.
  for (const dir of ['.expo/agent-cli', '.expo/dev/logs']) {
    const from = path.join(run.projectDir, dir);
    if (!fs.existsSync(from)) continue;
    for (const name of fs.readdirSync(from)) {
      const fresh = fs.statSync(path.join(from, name)).mtimeMs >= (run.startedAt ?? 0);
      if (fresh && /\.(png|log)$/.test(name)) {
        fs.copyFileSync(path.join(from, name), path.join(run.evidenceDir, name));
      }
    }
  }
  restoreProject();
  if (purge) {
    // The generated native projects and the CLI's records. The shared build cache stays.
    for (const dir of ['ios', 'android', '.expo']) {
      fs.rmSync(path.join(run.projectDir, dir), { recursive: true, force: true });
    }
  }
  fs.rmSync(pointerFile);
  process.stdout.write(
    `verify: restored ${run.projectDir}${purge ? ', removed ios, android and .expo' : ''}\nverify: evidence kept at ${run.evidenceDir}\n`
  );
}

const [command, ...rest] = process.argv.slice(2);
const commands = {
  launch,
  run: runCommand,
  doctor,
  port: freePort,
  'wait-server': waitServer,
  cleanup,
};
if (!commands[command]) {
  fail('usage: verify.mjs <launch|doctor|run|port|wait-server|cleanup>');
}
await commands[command](rest);
