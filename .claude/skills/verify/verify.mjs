#!/usr/bin/env node
// Verification harness for @expo/agent-cli. Usage is in SKILL.md next to this file.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, stripVTControlCharacters } from 'node:util';

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
const buildCacheDir = path.join(
  process.env.AGENT_CLI_VERIFY_HOME ??
    path.join(
      os.homedir(),
      process.platform === 'darwin' ? 'Library/Caches' : '.cache',
      'agent-cli-verify'
    ),
  'build-cache'
);
// The helper's own "no result" exit code. It is outside the exit codes of the CLI.
const NO_RESULT = 124;
const STATUS = ['status', '--json', '--no-followups'];

function fail(message) {
  process.stderr.write(`verify: ${message}\n`);
  process.exit(1);
}

/** The run in progress, or null. */
function currentRun() {
  if (!fs.existsSync(pointerFile)) return null;
  const run = JSON.parse(fs.readFileSync(pointerFile, 'utf8'));
  return { ...run, evidenceDir: path.join(artifactsRoot, run.id) };
}

function requireRun() {
  return currentRun() ?? fail('no run in progress. Run "verify.mjs launch" first.');
}

function seconds(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) fail(`${name} needs a number above 0.`);
  return number;
}

function appStatus() {
  return spawnSync('git', ['status', '--porcelain', '--', 'apps/eas-example'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).stdout.trimEnd();
}

function childEnv() {
  const { npm_config_minimum_release_age, NODE_ENV, ...env } = process.env;
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

/**
 * Run the built CLI in the app. A command that does not exit within `killAfter` seconds is killed:
 * only the CLI process, so a detached dev server that it started stays up.
 */
async function execCli(argv, { echo = false, killAfter = 600 } = {}) {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [bin, ...argv], {
    cwd: projectDir,
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
  return {
    argv,
    ...out,
    signal,
    killedAfter: killed ? killAfter : null,
    code: killed ? NO_RESULT : (code ?? 1),
    durationMs: Date.now() - startedAt,
  };
}

/** Write one evidence file for a result of `execCli`. */
function record(run, result, label, note) {
  const sequence = fs.readdirSync(run.evidenceDir).filter((name) => /^\d{3}-/.test(name)).length;
  const safeLabel = (label ?? result.argv.join('_')).replace(/[^\w.:=-]+/g, '_').slice(0, 80);
  const evidence = path.join(
    run.evidenceDir,
    `${String(sequence + 1).padStart(3, '0')}-${safeLabel}.txt`
  );
  const exit =
    result.killedAfter === null
      ? `exit: ${result.code}`
      : `exit: none. verify killed the command after ${result.killedAfter}s`;
  fs.writeFileSync(
    evidence,
    [
      `$ expo-agent-cli ${result.argv.join(' ')}`,
      `cwd: ${projectDir}`,
      `${exit} in ${result.durationMs}ms`,
      ...(note ? [note] : []),
      '',
      '--- stdout ---',
      result.stdout,
      '--- stderr ---',
      result.stderr,
    ].join('\n')
  );
  process.stderr.write(`verify: ${exit} · evidence ${evidence}\n`);
}

/** Repeat a read-only command until `accept(result)` is true. Returns the last result. */
async function poll(argv, accept, { timeout, interval, killAfter = 60 }) {
  const deadline = Date.now() + timeout * 1000;
  for (let attempts = 1; ; attempts++) {
    const result = await execCli(argv, { killAfter });
    const matched = accept(result);
    if (matched || Date.now() > deadline) return { result, matched, attempts };
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Make `.expo/build-cache` of the app a link to the shared cache. Builds already there move over. */
function linkBuildCache() {
  fs.mkdirSync(buildCacheDir, { recursive: true });
  const link = path.join(projectDir, '.expo', 'build-cache');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const stat = fs.lstatSync(link, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) {
    if (fs.readlinkSync(link) === buildCacheDir) return;
    fs.rmSync(link);
  } else if (stat) {
    for (const name of fs.readdirSync(link)) {
      const target = path.join(buildCacheDir, name);
      if (!fs.existsSync(target)) fs.cpSync(path.join(link, name), target, { recursive: true });
    }
    fs.rmSync(link, { recursive: true });
  }
  fs.symlinkSync(buildCacheDir, link, 'dir');
}

async function launch() {
  const previous = currentRun();
  if (previous) fail(`run ${previous.id} is in progress. Run "verify.mjs cleanup" first.`);
  if (!fs.existsSync(path.join(projectDir, 'node_modules', 'expo'))) {
    fail('apps/eas-example has no node_modules. Run "bun install" at the repository root.');
  }
  const build = spawnSync('bun', ['run', 'build'], { cwd: packageRoot, stdio: 'inherit' });
  if (build.status !== 0) fail('"bun run build" failed.');
  linkBuildCache();

  const id = new Date().toISOString().replace(/[:.]/g, '-');
  // `appStatus` lets cleanup tell a leftover recipe edit from a change that was there before.
  const run = { id, startedAt: Date.now(), appStatus: appStatus() };
  fs.mkdirSync(path.join(artifactsRoot, id), { recursive: true });
  fs.writeFileSync(pointerFile, JSON.stringify(run, null, 2));
  process.stdout.write(
    `${JSON.stringify({ ready: true, ...currentRun(), projectDir, buildCacheDir, cachedBuilds: fs.readdirSync(buildCacheDir) }, null, 2)}\n`
  );
}

async function runCommand(args) {
  const run = requireRun();
  const usage =
    'usage: verify.mjs run [--label <name>] [--kill-after <seconds>] [--until <regex> [--timeout <seconds>]] -- <cli arguments>';
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        label: { type: 'string' },
        until: { type: 'string' },
        timeout: { type: 'string', default: '180' },
        'kill-after': { type: 'string' },
      },
    });
  } catch (error) {
    fail(`${error.message}\n${usage}`);
  }
  const { values, positionals: argv } = parsed;
  if (argv.length === 0) fail(usage);
  const killAfter = values['kill-after'] && seconds(values['kill-after'], '--kill-after');

  if (values.until === undefined) {
    const result = await execCli(argv, { echo: true, killAfter: killAfter || 600 });
    record(run, result, values.label);
    process.exit(result.code);
  }
  const pattern = new RegExp(values.until);
  const { result, matched, attempts } = await poll(argv, ({ stdout }) => pattern.test(stdout), {
    timeout: seconds(values.timeout, '--timeout'),
    interval: 4,
    killAfter: killAfter || 60,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  const outcome = `${matched ? 'matched' : 'did not match'} /${values.until}/ after ${attempts} attempts`;
  record(run, result, values.label, `until: ${outcome}`);
  process.stderr.write(`verify: ${outcome}\n`);
  process.exit(matched ? result.code : NO_RESULT);
}

async function doctor() {
  const run = currentRun();
  const facts = {
    bundleBuilt: fs.existsSync(bundle),
    bundleStale: buildIsStale(),
    version: null,
    run,
    projectInstalled: fs.existsSync(path.join(projectDir, 'node_modules', 'expo')),
    appStatus: appStatus(),
    statusError: null,
    devServer: null,
    binding: null,
    bootedSimulators: [],
  };
  if (process.platform === 'darwin') {
    const simctl = spawnSync('xcrun', ['simctl', 'list', 'devices', 'booted'], {
      encoding: 'utf8',
    });
    facts.bootedSimulators = (simctl.stdout ?? '')
      .split('\n')
      .filter((line) => line.includes('(Booted)'))
      .map((line) => line.trim());
  }
  if (facts.bundleBuilt && facts.projectInstalled) {
    facts.version = (await execCli(['--version'], { killAfter: 60 })).stdout.trim();
    const status = await execCli(STATUS, { killAfter: 60 });
    const report = parseJson(status.stdout);
    if (report) {
      facts.devServer = report.devServer;
      facts.binding = report.binding;
    } else {
      facts.statusError = `status --json did not answer (exit ${status.code})`;
    }
  }
  const ok =
    facts.bundleBuilt &&
    !facts.bundleStale &&
    run !== null &&
    facts.projectInstalled &&
    !facts.statusError;
  process.stdout.write(`${JSON.stringify({ ok, ...facts }, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
}

/** Wait until the project's dev server answers. A native build can take many minutes. */
async function waitServer(args) {
  const run = requireRun();
  const minutes = seconds(args[0] ?? 25, 'wait-server');
  // A server of another project on the same port does not count.
  const serverOf = ({ stdout }) => {
    const devServer = parseJson(stdout)?.devServer;
    return devServer?.running && devServer.projectRootMatched !== false ? devServer : null;
  };
  const { result, matched } = await poll(STATUS, (status) => serverOf(status) !== null, {
    timeout: minutes * 60,
    interval: 15,
  });
  record(run, result, 'wait-server');
  if (!matched) fail(`no dev server after ${minutes} minutes. Run "verify.mjs run -- dev:logs".`);
  process.stdout.write(`${JSON.stringify({ running: true, url: serverOf(result).url })}\n`);
}

async function cleanup() {
  const run = currentRun();
  if (!run) {
    process.stdout.write('verify: no run in progress. Nothing to clean.\n');
    return;
  }
  if (!fs.existsSync(bundle)) fail('the CLI bundle is missing. Run "bun run build", then cleanup.');
  const stop = await execCli(['dev:stop', '--release', '--json', '--no-followups']);
  record(run, stop, 'cleanup-dev-stop');
  if (stop.code !== 0) {
    fail(`dev:stop exit ${stop.code}. Nothing else was changed. Read the evidence.`);
  }
  // The CLI writes screenshots and the dev-server log inside the project. Keep them as evidence.
  for (const dir of ['.expo/agent-cli', '.expo/dev/logs']) {
    const from = path.join(projectDir, dir);
    if (!fs.existsSync(from)) continue;
    for (const name of fs.readdirSync(from)) {
      const fresh = fs.statSync(path.join(from, name)).mtimeMs >= run.startedAt;
      if (fresh && /\.(png|log)$/.test(name)) {
        fs.copyFileSync(path.join(from, name), path.join(run.evidenceDir, name));
      }
    }
  }
  fs.rmSync(pointerFile);
  process.stdout.write(`verify: evidence kept at ${run.evidenceDir}\n`);
  const status = appStatus();
  if (status !== run.appStatus) {
    fail(
      `apps/eas-example changed during the run. Cleanup does not touch it. Undo a recipe edit by hand:\n${status}`
    );
  }
}

/** Delete the generated native projects and the CLI's records. The shared build cache stays. */
async function purge() {
  if (currentRun()) fail('a run is in progress. Run "verify.mjs cleanup" first.');
  for (const dir of ['ios', 'android', '.expo']) {
    fs.rmSync(path.join(projectDir, dir), { recursive: true, force: true });
  }
  process.stdout.write(`verify: removed ios, android and .expo of ${projectDir}\n`);
}

const [command, ...rest] = process.argv.slice(2);
const commands = {
  launch,
  run: runCommand,
  doctor,
  'wait-server': waitServer,
  cleanup,
  purge,
};
if (!commands[command]) {
  fail(`usage: verify.mjs <${Object.keys(commands).join('|')}>`);
}
await commands[command](rest);
