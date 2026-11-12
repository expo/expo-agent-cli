import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const helper = path.resolve(process.argv[2] || path.join(directory, 'job-helper.exe'));
const output = path.resolve(process.argv[3] || path.join(directory, 'results'));
const fixture = path.join(directory, 'fixture.mjs');
fs.mkdirSync(output, { recursive: true });
const trace = path.join(output, 'events.jsonl');
const log = (event, fields = {}) => fs.appendFileSync(trace, JSON.stringify({ event, timeMs: Date.now(), ...fields }) + '\n');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (condition, message) => { if (!condition) throw new Error(message); };
check(!fs.existsSync(trace), 'Use a fresh result directory; an earlier events trace already exists');
const until = async (predicate, message, timeout = 6000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await delay(2); }
  throw new Error(`Timed out waiting for ${message}`);
};
const readMarker = (dir, name) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
};
const marker = (dir, name) => until(() => readMarker(dir, name), name);
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const u32 = (x) => { const b = Buffer.alloc(4); b.writeUInt32LE(x); return b; };
const u64 = (x) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(x)); return b; };
const wide = (text) => { const b = Buffer.from(text, 'utf16le'); return Buffer.concat([u32(b.length), b]); };

export function quoteWindowsArgument(value) {
  if (value.length && !/[ \t"]/u.test(value)) return value;
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1') + '"';
}
export function escapeArgumentForCmd(value) {
  const forProgram = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  return `"${forProgram}"`.replace(/([()[\]%!^"`<>&|;, *?])/g, '^$1');
}
const direct = (image, args) => ({ image, args, line: [image, ...args].map(quoteWindowsArgument).join(' '), shell: false });
function batchTarget(shim, args) {
  const command = /[\\/]/.test(shim) ? `"${shim}"` : shim;
  const escaped = args.map(escapeArgumentForCmd);
  const shell = process.env.comspec || process.env.ComSpec || 'cmd.exe';
  check(/(?:^|[\\/])cmd(?:\.exe)?$/i.test(shell), 'This first probe requires the cmd ComSpec branch');
  return { image: shell, line: `${shell} /d /s /c "${[command, ...escaped].join(' ')}"`, command, args: escaped, shell: true };
}
function socketIdentity(info) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: info.port });
    let data = '';
    socket.setTimeout(1000, () => socket.destroy(new Error('fixture identity timeout')));
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
    socket.on('error', reject);
  });
}
const sessions = [];
function session(name, options = {}) {
  const dir = path.join(output, name);
  fs.mkdirSync(dir, { recursive: true });
  const token = crypto.randomUUID();
  const env = { ...process.env, PROBE_HELPER: helper, PROBE_PARITY: 'env value Ž 🧪', ...options.env };
  const child = spawn(helper, [], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe', 'overlapped'] });
  const state = { name, dir, token, child, events: [], stdout: [], stderr: [], stdoutEnded: false, stderrEnded: false, exit: undefined, choice: undefined, malformed: undefined };
  sessions.push(state);
  const record = (event) => { state.events.push(event); log('native', { name, native: event }); };
  let text = '';
  for (const channel of ['stdout', 'stderr']) {
    child[channel].on('data', (data) => state[channel].push(data));
    child[channel].on('end', () => { state[`${channel}Ended`] = true; log('raw-output-eof', { name, channel, helperStillAlive: state.exit === undefined }); });
    child[channel].on('error', (error) => log('raw-output-error', { name, channel, error: String(error) }));
  }
  child.stdio[3].on('data', (chunk) => {
    text += chunk.toString('utf8');
    if (text.length > 65536) state.malformed = 'oversized response';
    let newline;
    while ((newline = text.indexOf('\n')) >= 0) {
      const line = text.slice(0, newline); text = text.slice(newline + 1);
      try { const event = JSON.parse(line); if (!event || typeof event.event !== 'string') throw new Error('missing event'); record(event); }
      catch (error) { state.malformed = line; log('malformed-control', { name, line, error: String(error) }); }
    }
  });
  child.stdio[3].on('end', () => { if (text) { state.malformed = text; log('truncated-control', { name, text }); } log('control-eof', { name }); });
  child.stdio[3].on('error', (error) => { state.controlError = String(error); log('control-error', { name, error: String(error) }); });
  child.on('error', (error) => { state.spawnError = String(error); log('helper-spawn-error', { name, error: String(error) }); });
  child.on('exit', (code, signal) => { state.exit = { code, signal }; log('helper-exit', { name, code, signal }); });
  state.send = (kind, ...parts) => {
    const payload = Buffer.concat([Buffer.from(kind), ...parts]);
    log('command', { name, kind, bytes: payload.length });
    child.stdio[3].write(Buffer.concat([u32(payload.length), payload]), (error) => { if (error) { state.inputError = String(error); log('control-write-error', { name, error: String(error) }); } });
  };
  state.event = (kind) => state.events.find((event) => event.event === kind);
  state.wait = (kind, timeout = 6000) => until(() => {
    const found = state.event(kind); if (found) return found;
    if (state.malformed || state.spawnError || state.exit !== undefined || state.event('native-error')) throw new Error(`${name} lost ${kind}: ${JSON.stringify(state.events.at(-1))} ${JSON.stringify(state.exit)}`);
    return undefined;
  }, `${name} ${kind}`, timeout);
  state.launch = async (mode, settings = {}) => {
    const args = [fixture, mode, dir, token, ...(settings.args || [])];
    let target = direct(process.execPath, args);
    if (settings.batch) {
      const shim = path.join(dir, 'package runner.cmd');
      fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);
      target = batchTarget(shim, args.slice(1));
    }
    if (settings.target) target = settings.target;
    state.target = target;
    state.send('L', u32(settings.negative ? 1 : 0), wide(target.image), wide(target.line), wide(dir), wide(settings.fault || ''));
    return state.wait('ready');
  };
  state.start = async () => { state.send('S'); return state.wait('started'); };
  state.observe = async (info, label) => {
    if (info.port) { const identity = await socketIdentity(info); check(identity.token === token && identity.pid === info.pid, 'fixture identity challenge mismatch'); }
    state.send('O', u32(info.pid), wide(`${token}-${label}`));
    const observed = await until(() => state.events.find((event) => event.event === 'observed' && event.token === `${token}-${label}`), `${name} retained ${label}`);
    check(observed.created && observed.wait === 258 && observed.member, 'observer must hold a known live member of the selected job');
    return observed;
  };
  state.stop = (timeout = 4000) => {
    if (state.choice === 'release') return Promise.resolve({ kind: 'already-completed' });
    if (state.stopPromise) return state.stopPromise;
    state.choice = 'stop';
    const deadline = state.boundDeadline || Date.now() + timeout;
    state.stopPromise = terminal('T', 'stopped', deadline);
    return state.stopPromise;
  };
  state.release = async (timeout = 3000) => {
    check(!state.choice, 'terminal action already selected');
    check(state.event('root-exited') && state.stdoutEnded && state.stderrEnded, 'release requires actual root exit and raw output EOF');
    state.choice = 'release';
    return terminal('R', 'released', Date.now() + timeout);
  };
  async function terminal(command, expected, deadline) {
    let watchdog = false;
    const timer = setTimeout(() => { watchdog = true; log('node-watchdog', { name, deadline }); child.kill(); }, Math.max(0, deadline - Date.now()));
    state.send(command, u64(deadline));
    let result;
    try {
      await until(() => {
        const ack = state.event(expected);
        if (state.malformed || state.event('uncertain') || state.event('native-error') || watchdog) { result = { kind: 'uncertain', reason: state.malformed ? 'malformed' : watchdog ? 'watchdog' : 'native' }; return true; }
        if (ack && (command === 'R' || (state.event('root-exited') && state.stdoutEnded && state.stderrEnded))) {
          check(ack.deadlineMs === deadline && Date.now() <= deadline, 'terminal acknowledgement has a missing, different, or expired deadline');
          if (command === 'R') check(ack.killOnClose === false, 'release acknowledgement lacks cleared kill-on-close');
          if (command === 'T') check(Number.isInteger(ack.knownUnsignaled) && ack.knownUnsignaled >= 0, 'stop acknowledgement lacks observer verdict');
          result = { kind: expected, ack, deadline, settledMs: Date.now() };
          if (command === 'T') check(state.event('terminate')?.ok && ack.active === 0 && ack.rootWait === 0, 'stop acknowledgement lacks native evidence');
          return true;
        }
        if (state.exit !== undefined && !ack) { result = { kind: 'uncertain', reason: 'helper-exit' }; return true; }
        return false;
      }, `${name} terminal result`, Math.max(0, deadline - Date.now()) + 300);
    } catch (error) { result = { kind: 'uncertain', reason: String(error) }; }
    finally { clearTimeout(timer); clearTimeout(state.sealWatchdog); }
    if (result.kind === 'uncertain' && state.exit === undefined) child.kill();
    log('terminal-result', { name, ...result, elapsedBeyondDeadlineMs: Date.now() - deadline });
    return result;
  }
  state.armSeal = async (limit, timeout = 6000) => {
    state.choice = 'stop'; state.boundDeadline = Date.now() + timeout;
    state.sealWatchdog = setTimeout(() => { log('node-seal-watchdog', { name, deadline: state.boundDeadline }); child.kill(); }, timeout);
    state.send('B', u32(limit), u64(state.boundDeadline));
    const sealed = await state.wait('seal-result'); await state.wait('seal-observations-complete'); return sealed;
  };
  state.bind = () => { state.send('Q', u64(state.boundDeadline)); return state.wait('bound-ready'); };
  state.settlement = async () => { state.send('V'); await state.wait('settlement-observed'); await until(() => state.exit !== undefined, 'settlement helper exit'); };
  state.completed = () => until(() => state.event('root-exited') && state.stdoutEnded && state.stderrEnded, `${name} target completion`);
  state.save = () => { fs.writeFileSync(path.join(dir, 'stdout.bin'), Buffer.concat(state.stdout)); fs.writeFileSync(path.join(dir, 'stderr.bin'), Buffer.concat(state.stderr)); };
  return state;
}
async function confirmedStop(state, timeout) {
  const result = await state.stop(timeout);
  check(result.kind === 'stopped', `expected stopped, got ${JSON.stringify(result)}`);
  check(result.ack.knownUnsignaled === 0, 'COUNTEREXAMPLE: native candidate had an unsignaled known process');
  for (const event of state.events.filter((event) => event.event === 'observer' && event.phase === 'stop-verdict')) check(event.wait === 0, 'retained process was not signaled at stop verdict');
  return result;
}
async function natural(state) {
  await state.completed();
  check(state.exit === undefined, 'helper must still be alive at tool EOF');
  const released = await state.release(); check(released.kind === 'released', `release failed ${JSON.stringify(released)}`);
  await until(() => state.exit !== undefined, 'released helper exit');
  return released;
}
const results = [];
async function run(name, action) {
  const start = Date.now();
  try { await action(); results.push({ name, passed: true, elapsedMs: Date.now() - start }); log('scenario-pass', { name }); }
  catch (error) { results.push({ name, passed: false, error: error.stack, elapsedMs: Date.now() - start }); log('scenario-fail', { name, error: error.stack }); }
  finally {
    for (const state of sessions) {
      fs.writeFileSync(path.join(state.dir, 'shutdown'), 'stop');
      clearTimeout(state.sealWatchdog);
      if (state.exit === undefined) state.child.kill();
      state.save();
    }
    await delay(60);
  }
}

if (process.platform !== 'win32') throw new Error('Native Windows is required; do not interpret a non-Windows run as mechanism evidence');
check(Number(process.versions.node.split('.')[0]) === 24, 'Run with actual Node 24');
log('environment', { platform: process.platform, release: os.release(), version: os.version(), architecture: process.arch, node: process.version, execPath: process.execPath, versions: process.versions, helper, helperSha256: sha256(helper), nodeSha256: sha256(process.execPath), controllerSha256: sha256(fileURLToPath(import.meta.url)) });

const readLines = (filename) => {
  try { return fs.readFileSync(filename, 'utf8').split('\n').slice(0, -1).map((line) => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const creatorLog = (state) => readLines(path.join(state.dir, 'creator-one.jsonl'));
const candidateOutcomes = [];

for (const limit of [1, 0]) {
  for (const nested of [false, true]) {
    for (const mode of ['active-native', 'pipe-native']) {
      await run(`seal-${limit}-${nested ? 'nested' : 'plain'}-${mode}`, async () => {
        const s = session(`seal-${limit}-${nested ? 'nested' : 'plain'}-${mode}`, { env: { PROBE_NESTED: nested ? 'nested' : 'plain' } });
        await s.launch(mode, { fault: 'bound' }); await s.start();
        const leaf = await marker(s.dir, 'leaf'); await s.observe(leaf, 'leaf');
        const ready = await until(() => creatorLog(s).find((event) => event.event === 'creator-ready'), 'native creator ready');
        const creatorObserved = await s.observe(ready, 'native-creator');
        check(creatorObserved.created === ready.created, 'native creator exact creation identity mismatch');
        for (const event of creatorLog(s).filter((event) => event.event === 'create-attempt' && event.phase === 'initial')) {
          check(event.ok && event.created, 'initial native child creation failed before seal');
          const observed = await s.observe({ pid: event.childPid }, `initial-${event.attempt}`);
          check(observed.created === event.created, 'native child exact creation identity mismatch');
        }
        if (mode === 'pipe-native') {
          await s.wait('root-exited'); check(!s.stdoutEnded && !s.stderrEnded, 'pipe-holder fixture did not hold output');
        }
        fs.writeFileSync(path.join(s.dir, 'churn'), 'go');
        await until(() => creatorLog(s).some((event) => event.phase === 'churn' && event.ok), 'pre-seal native creation');
        const sealed = await s.armSeal(limit);
        log('seal-experiment', { name: s.name, sealed });
        if (!sealed.ok) {
          candidateOutcomes.push({ name: s.name, observationPassed: false, reason: 'SetInformationJobObject rejected limit', sealed });
          return;
        }
        const readback = s.event('seal-readback');
        check(readback?.ok && readback.activeProcessLimit === limit && (readback.limitFlags & 0x2008) === 0x2008, 'seal readback must preserve the requested active-process limit and kill-on-close');
        fs.writeFileSync(path.join(s.dir, 'post-seal'), 'attempt eight births');
        await until(() => creatorLog(s).some((event) => event.event === 'post-seal-done'), 'post-seal native attempts');
        const attempts = creatorLog(s);
        const postSeal = attempts.filter((event) => event.phase === 'post-seal');
        const observersAfterSeal = s.events.filter((event) => event.event === 'observer' && event.phase === 'after-seal');
        log('seal-admission-observations', { name: s.name, sealed, attempts, postSeal, observersAfterSeal });
        check(postSeal.length === 8, 'incomplete post-seal native attempt evidence');
        check(observersAfterSeal.length === 4, 'incomplete existing-member observer evidence');
        const membershipsAfterSeal = s.events.filter((event) => event.event === 'observer-membership' && event.phase === 'after-seal');
        check(membershipsAfterSeal.length === 4 && membershipsAfterSeal.every((event) => event.membershipOk && event.currentMember && event.memberAtObservation), 'seal observers must remain members of the selected job');
        if (postSeal.some((event) => event.ok) || observersAfterSeal.some((event) => event.wait !== 258)) {
          candidateOutcomes.push({ name: s.name, observationPassed: false, reason: 'new admission succeeded or a held existing process was removed', sealed, postSeal, observersAfterSeal });
          return;
        }
        if (limit === 0 && !nested && mode === 'pipe-native') {
          s.send('D', u32(2)); await s.wait('audit-retirement-observed');
          check(s.event('audit-external-termination')?.ok, 'controlled audit handle termination failed');
        }
        let binding;
        try { binding = await s.bind(); }
        catch (error) {
          candidateOutcomes.push({ name: s.name, observationPassed: false, reason: 'binding uncertain', error: String(error), native: s.events.at(-1) });
          return;
        }
        const result = await s.stop();
        check(result.kind === 'stopped', `bound candidate remained uncertain ${JSON.stringify(result)}`);
        check(result.ack.witness === 'sealed-bound-handles' && result.ack.boundMembers === binding.members, 'missing complete bound-set verdict');
        check(result.ack.knownUnsignaled === 0, 'COUNTEREXAMPLE: independent test observer remains unsignaled after bound-set waits');
        const boundVerdict = s.events.filter((event) => event.event === 'bound-wait' && event.phase === 'stop-verdict');
        check(boundVerdict.length === binding.members && boundVerdict.every((event) => event.wait === 0), 'bound handle wait set incomplete');
        await s.settlement();
        const lateObservers = s.events.filter((event) => event.event === 'observer' && event.phase === 'node-settlement');
        check(lateObservers.length === observersAfterSeal.length && lateObservers.every((event) => event.wait === 0), 'known observer unsignaled at later Node settlement');
        candidateOutcomes.push({ name: s.name, observationPassed: true, binding, result });
      });
    }
  }
}

await run('count-only-pipe-holder-negative-comparison', async () => {
  for (let i = 0; i < 8; ++i) {
    const s = session(`count-only-${i}`); await s.launch('pipe', { fault: 'count-only' }); await s.start();
    await s.observe(await marker(s.dir, 'leaf'), 'pipe-leaf'); await s.wait('root-exited');
    const result = await s.stop();
    check(result.kind === 'stopped', 'original count-only comparison did not reach its candidate');
    log('count-only-negative-comparison', { name: s.name, knownUnsignaledAtCandidate: result.ack.knownUnsignaled, result, interpretation: 'historical rejected predicate, never production stop proof' });
    await s.settlement();
  }
});

async function npmShim(from, to) {
  const npmDirectory = path.join(path.dirname(process.execPath), 'node_modules', 'npm');
  const requireFromNpm = createRequire(path.join(npmDirectory, 'package.json'));
  const shimSource = requireFromNpm.resolve('cmd-shim');
  const shimPackage = path.join(path.dirname(path.dirname(shimSource)), 'package.json');
  const installedShim = requireFromNpm('cmd-shim');
  await installedShim(from, to);
  log('npm-shim-provenance', { source: shimSource, sourceSha256: sha256(shimSource), npm: JSON.parse(fs.readFileSync(path.join(npmDirectory, 'package.json'), 'utf8')).version, package: JSON.parse(fs.readFileSync(shimPackage, 'utf8')), generatedShim: to + '.cmd', generatedShimSha256: sha256(to + '.cmd') });
  fs.copyFileSync(shimSource, path.join(output, 'installed-cmd-shim-source.js'));
  return to + '.cmd';
}
function decodedOutput(chunks) {
  const text = Buffer.concat(chunks).toString('utf8');
  try { return { observed: JSON.parse(text.split('\n')[0]), rawText: text }; }
  catch (error) { return { observed: null, rawText: text, decodeError: String(error) }; }
}
const parityArgs = ['', 'a b', 'Žluťoučký 🧪', 'one"two', 'a&b', 'a%b', 'a^b', 'a!b', 'tail\\', 'two\\\\"q', '(x)|<>'];
for (const variant of ['direct', 'v1-stub', 'installed-npm-shim']) {
  await run(`argv-instrument-${variant}`, async () => {
    const s = session(`parity-${variant}`);
    let target = direct(process.execPath, [fixture, 'args', s.dir, s.token, ...parityArgs]);
    if (variant === 'v1-stub') {
      const shim = path.join(s.dir, 'package runner.cmd');
      fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);
      target = batchTarget(shim, ['args', s.dir, s.token, ...parityArgs]);
    }
    if (variant === 'installed-npm-shim') {
      const script = path.join(s.dir, 'real-shim-target.cjs');
      fs.writeFileSync(script, '#!/usr/bin/env node\n' + `process.argv = [process.execPath, ${JSON.stringify(fixture)}, 'args', ${JSON.stringify(s.dir)}, ${JSON.stringify(s.token)}, ...process.argv.slice(2)];\nimport(${JSON.stringify(new URL('./fixture.mjs', import.meta.url).href)});\n`);
      const shim = await npmShim(script, path.join(s.dir, 'npm-generated-shim'));
      target = batchTarget(shim, parityArgs);
    }
    await s.launch('unused', { target });
    const baseline = spawn(target.shell ? target.command : target.image, target.args, { cwd: s.dir, env: { ...process.env, PROBE_PARITY: 'env value Ž 🧪' }, shell: target.shell, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = []; baseline.stdout.on('data', (b) => stdout.push(b)); baseline.stderr.on('data', (b) => stderr.push(b));
    const baselineCode = await new Promise((resolve, reject) => { baseline.once('error', reject); baseline.once('close', resolve); });
    await s.start(); await natural(s);
    const helperCode = s.event('root-exited').code;
    fs.writeFileSync(path.join(s.dir, 'baseline-stdout.bin'), Buffer.concat(stdout));
    fs.writeFileSync(path.join(s.dir, 'baseline-stderr.bin'), Buffer.concat(stderr));
    const baselineDecoded = decodedOutput(stdout), helperDecoded = decodedOutput(s.stdout);
    const record = { variant, requestedArgv: parityArgs, baseline: { exitCode: baselineCode, ...baselineDecoded }, helper: { exitCode: helperCode, ...helperDecoded }, stdoutEqual: Buffer.concat(s.stdout).equals(Buffer.concat(stdout)), stderrEqual: Buffer.concat(s.stderr).equals(Buffer.concat(stderr)), intendedArgvPreserved: JSON.stringify(helperDecoded.observed?.args) === JSON.stringify(parityArgs) };
    fs.writeFileSync(path.join(s.dir, 'parity.json'), JSON.stringify(record, null, 2) + '\n'); log('argv-parity-instrument', record);
    check(record.stdoutEqual && record.stderrEqual && helperCode === baselineCode, 'helper differs from actual Node baseline');
    if (variant !== 'v1-stub') check(record.intendedArgvPreserved && helperCode === 17, 'faithful executable/shim launch does not preserve intended argv and exit code');
  });
}
for (const state of sessions) state.save();
const summary = { productionWitnessProven: false, candidateObservationSuccess: candidateOutcomes.length === 8 && candidateOutcomes.every((outcome) => outcome.observationPassed), finishedAt: new Date().toISOString(), passed: results.every((result) => result.passed), candidateOutcomes, results, interpretation: 'Experimental admission and current-member binding only; no universal historical-tree proof is claimed' };
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.passed ? 0 : 1;
