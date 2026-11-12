import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
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
    let newline;
    while ((newline = text.indexOf('\n')) >= 0) {
      const line = text.slice(0, newline); text = text.slice(newline + 1);
      if (Buffer.byteLength(line, 'utf8') > 65536) {
        state.malformed = 'oversized response frame';
        log('malformed-control', { name, error: state.malformed });
        continue;
      }
      try { const event = JSON.parse(line); if (!event || typeof event.event !== 'string') throw new Error('missing event'); record(event); }
      catch (error) { state.malformed = line; log('malformed-control', { name, line, error: String(error) }); }
    }
    if (Buffer.byteLength(text, 'utf8') > 65536) state.malformed = 'oversized incomplete response frame';
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
    state.send('L', u32(settings.negative ? 1 : 0), wide(target.image), wide(target.line), wide(settings.cwd || dir), wide(settings.fault || ''));
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
    const deadline = Date.now() + timeout;
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
          if (command === 'T') {
            check(state.event('terminate')?.ok && ack.rootWait === 0, 'stop acknowledgement lacks native termination evidence');
            if (ack.witness !== 'rejected-count-only-comparison') check(ack.witness === 'retained-lifetime-census' && ack.healthy && ack.covered === ack.totalProcesses && ack.retainedUnsignaled === 0, 'stop acknowledgement lacks valid complete lifetime coverage');
          }
          return true;
        }
        if (state.exit !== undefined && !ack) { result = { kind: 'uncertain', reason: 'helper-exit' }; return true; }
        return false;
      }, `${name} terminal result`, Math.max(0, deadline - Date.now()) + 300);
    } catch (error) { result = { kind: 'uncertain', reason: String(error) }; }
    finally { clearTimeout(timer); }
    if (result.kind === 'uncertain' && state.exit === undefined && !state.event('uncertain')) child.kill();
    log('terminal-result', { name, ...result, elapsedBeyondDeadlineMs: Date.now() - deadline });
    return result;
  }
  state.settlement = async () => { state.send('V'); await state.wait('settlement-observed'); await until(() => state.exit !== undefined, 'settlement helper exit'); };
  state.completed = (timeout = 6000) => until(() => state.event('root-exited') && state.stdoutEnded && state.stderrEnded, `${name} target completion`, timeout);
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
const birthRecords = (state) => fs.readdirSync(state.dir).filter((name) => /^birth-.*\.jsonl$/.test(name)).flatMap((name) => readLines(path.join(state.dir, name)));
const observations = [];
async function nativeFixture(name, nested, mode, fault = '') {
  const state = session(name, { env: { PROBE_NESTED: nested ? 'nested' : 'plain' } });
  const ready = await state.launch(mode, { fault });
  check(ready.member && ready.stdioCopiesClosed, 'root must be contained while suspended');
  check(!readMarker(state.dir, `${mode}-first`), 'user code executed before start permit');
  state.send('P'); await state.wait('pong'); await state.start();
  await state.observe(await marker(state.dir, 'leaf'), 'leaf');
  const creator = await until(() => creatorLog(state).find((event) => event.event === 'creator-ready'), 'native creator ready');
  const heldCreator = await state.observe(creator, 'creator');
  check(heldCreator.created === creator.created, 'native creator identity changed');
  for (const attempt of creatorLog(state).filter((event) => event.event === 'create-attempt' && event.phase === 'initial')) {
    check(attempt.ok && attempt.creationError === 0, 'initial native child failed');
    const held = await state.observe({ pid: attempt.childPid }, `initial-${attempt.attempt}`);
    check(held.created === attempt.created, 'initial native child identity changed');
  }
  if (mode.startsWith('pipe')) {
    await state.wait('root-exited');
    check(!state.stdoutEnded && !state.stderrEnded, 'independent descendant must still hold both output pipes');
  }
  return state;
}
async function retireChurn(state) {
  fs.writeFileSync(path.join(state.dir, 'churn'), 'eight natural exits');
  await until(() => creatorLog(state).some((event) => event.event === 'churn-done'), 'eight retired children');
  const retired = creatorLog(state).filter((event) => event.event === 'retired-child');
  check(retired.length === 8 && retired.every((event) => event.wait === 0 && event.creationError === 0), 'fixture must retain and wait eight exact retired identities');
  state.send('I'); await state.wait('inspection-complete');
  return retired;
}
function assertCompleteCensus(state, result) {
  check(result.kind === 'stopped' && result.ack.witness === 'retained-lifetime-census', 'candidate failed to produce a lifetime-census verdict');
  const captures = state.events.filter((event) => event.event === 'captured');
  const identities = new Set(captures.map((event) => `${event.pid}:${event.created}`));
  check(identities.size === captures.length && captures.length === result.ack.covered, 'captured identities must be distinct and cover the result');
  const ready = state.event('ready');
  check(captures.filter((event) => event.pid === ready.pid && event.created === ready.created).length === 1, 'original root must count exactly once');
  const waits = state.events.filter((event) => event.event === 'retained-wait' && event.phase === 'stop-verdict');
  check(waits.length === captures.length && waits.every((event) => event.wait === 0), 'every covered handle must be signaled at the verdict');
  check(result.ack.healthy && result.ack.totalProcesses === captures.length && result.ack.knownUnsignaled === 0, 'coverage validity and cardinality must both hold');
}
async function assertLaterSettlement(state) {
  await state.settlement();
  const captures = state.events.filter((event) => event.event === 'captured');
  const waits = state.events.filter((event) => event.event === 'retained-wait' && event.phase === 'node-settlement');
  check(waits.length === captures.length && waits.every((event) => event.wait === 0), 'later settlement must retain and wait every exact candidate identity');
  check(state.events.filter((event) => event.event === 'observer' && event.phase === 'node-settlement').every((event) => event.wait === 0), 'later independent observer wait must be signaled');
}

for (const nested of [false, true]) {
  for (const mode of ['active-native', 'pipe-native']) {
    const name = `lifetime-${nested ? 'nested' : 'ordinary'}-${mode}`;
    await run(name, async () => {
      const state = await nativeFixture(name, nested, mode);
      const retired = await retireChurn(state);
      const captured = state.events.filter((event) => event.event === 'captured');
      for (const retiredChild of retired) check(captured.some((event) => event.pid === retiredChild.childPid && event.created === retiredChild.created), 'lifetime collector missed an independently retired identity');
      const current = state.events.filter((event) => event.event === 'listed-member' && event.phase === 'inspect');
      check(retired.some((event) => !current.some((member) => member.pid === event.childPid)), 'retired identities must exercise the historical current-list gap');
      check(captured.some((event) => event.source === 'completion-discovery' && retired.some((child) => child.childPid === event.pid) && event.wait === 258), 'at least one retired identity must be captured while alive');
      const result = await confirmedStop(state); assertCompleteCensus(state, result);
      await assertLaterSettlement(state);
      observations.push({ name, kind: 'retired-coverage', outcome: result.kind, covered: result.ack.covered, totalProcesses: result.ack.totalProcesses, retiredIdentities: retired.length });
    });
  }
}

await run('missing-notification-refuses-empty-job-success', async () => {
  const state = await nativeFixture('missing-notification', false, 'pipe-native', 'missing-notification');
  const retired = await retireChurn(state);
  const result = await state.stop();
  check(result.kind === 'uncertain' && !state.event('stopped'), 'missing identities must never become a successful stop');
  await state.completed();
  const final = state.events.filter((event) => event.event === 'lifetime-accounting').at(-1);
  check(final.healthy && final.totalProcesses > final.covered, 'the missing-notification control must fail actual lifetime equality without a synthetic validity fault');
  check(state.events.some((event) => event.event === 'discovery-suppressed'), 'negative control did not suppress any notification');
  await assertLaterSettlement(state);
  const late = state.events.find((event) => event.event === 'lifetime-accounting' && event.phase === 'node-settlement');
  check(late.active === 0 && late.totalProcesses > late.covered, 'empty current job must retain its historical coverage gap');
  observations.push({ name: state.name, kind: 'negative', outcome: result.kind, covered: late.covered, totalProcesses: late.totalProcesses, missingRetired: retired.length });
});

await run('identity-fault-stays-uncertain-despite-count-equality', async () => {
  const state = session('identity-fault'); await state.launch('active', { fault: 'identity' }); await state.start();
  await state.observe(await marker(state.dir, 'leaf'), 'leaf');
  await state.wait('identity-negative-control');
  const result = await state.stop();
  check(result.kind === 'uncertain' && !state.event('stopped'), 'an identity fault must remain uncertain');
  await state.completed();
  const final = state.events.find((event) => event.event === 'lifetime-accounting' && event.phase === 'uncertain-verdict');
  check(!final.healthy && final.totalProcesses === final.covered, 'identity control must demonstrate that raw equality does not erase an earlier identity failure');
  await assertLaterSettlement(state);
  observations.push({ name: state.name, kind: 'negative', outcome: result.kind, covered: final.covered, totalProcesses: final.totalProcesses, healthy: final.healthy });
});

for (const nested of [false, true]) {
  for (let repeat = 0; repeat < 3; ++repeat) {
    const name = `creation-race-${nested ? 'nested' : 'ordinary'}-${repeat}`;
    await run(name, async () => {
      const state = await nativeFixture(name, nested, 'active-native');
      fs.writeFileSync(path.join(state.dir, 'race'), 'continue creating until killed');
      await until(() => creatorLog(state).filter((event) => event.event === 'create-begin' && event.phase === 'racing').length >= 4, 'overlapping creation stimulus');
      const result = await state.stop();
      check(result.kind === 'stopped' || result.kind === 'uncertain', 'creation race lost its bounded terminal classification');
      await state.completed();
      if (result.kind === 'stopped') assertCompleteCensus(state, result);
      if (state.event('stopped') || state.event('uncertain')) await assertLaterSettlement(state);
      await delay(100);
      const begins = creatorLog(state).filter((event) => event.event === 'create-begin');
      const attempts = creatorLog(state).filter((event) => event.event === 'create-attempt');
      const stopTick = state.event('stop-selected').tickMs;
      const overlapCandidates = begins.filter((begin) => begin.tickMs <= stopTick && !attempts.some((attempt) => attempt.attempt === begin.attempt));
      const independentHandles = state.events.filter((event) => event.event === 'observed').map(({ pid, created }) => ({ pid, created }));
      const births = birthRecords(state).map((event) => ({ ...event, independentHandleRetained: independentHandles.some((held) => held.pid === event.pid && held.created === event.created) }));
      const laterBirths = result.kind === 'stopped' ? births.filter((event) => event.tickMs > result.ack.tickMs) : [];
      const record = { name, kind: 'creation-race', outcome: result.kind, stopTick, verdictTick: result.ack?.tickMs, overlapCandidates, laterBirths, independentHandles, births, attempts, interpretation: 'A missing result identifies a possible overlapping call, not proof that CreateProcess was still executing. Absent birth markers do not prove absence of a child. The later sample is a bounded stress observation.' };
      fs.writeFileSync(path.join(state.dir, 'race-observation.json'), JSON.stringify(record, null, 2) + '\n'); observations.push(record);
      check(laterBirths.length === 0, 'COUNTEREXAMPLE: native child executed after the lifetime stop verdict');
    });
  }
}

await run('pipe-holder-rejected-predicate-and-exact-later-waits', async () => {
  for (const comparison of [true, false]) {
    for (let repeat = 0; repeat < 4; ++repeat) {
      const state = session(`pipe-${comparison ? 'count-only' : 'census'}-${repeat}`);
      await state.launch('pipe', { fault: comparison ? 'count-only' : '' }); await state.start();
      await state.observe(await marker(state.dir, 'leaf'), 'pipe-holder'); await state.wait('root-exited');
      const result = await state.stop(); check(result.kind === 'stopped', 'pipe comparison did not reach a candidate');
      if (!comparison) assertCompleteCensus(state, result);
      await state.settlement();
      const later = state.events.filter((event) => event.event === 'observer' && event.phase === 'node-settlement');
      check(later.length === 1, 'pipe observer must remain retained through later settlement');
      if (!comparison) check(later[0].wait === 0, 'COUNTEREXAMPLE: census candidate left its exact pipe holder live after adapter settlement');
      observations.push({ name: state.name, kind: 'pipe-holder', rejectedComparison: comparison, outcome: result.kind, pendingAtCandidate: result.ack.knownUnsignaled, laterExactWait: later[0].wait, identity: { pid: later[0].pid, created: later[0].created } });
    }
  }
});

for (const fault of ['deadline', 'withhold-stop', 'terminate', 'lost-control']) {
  await run(`fault-${fault}`, async () => {
    const state = session(`fault-${fault}`); await state.launch('active', { fault: fault === 'lost-control' ? '' : fault }); await state.start();
    await state.observe(await marker(state.dir, 'leaf'), 'leaf');
    if (fault === 'lost-control') state.child.stdio[3].destroy();
    const first = state.stop(350); const second = state.stop(10000);
    check(first === second, 'a repeated stop must reuse the first decision and deadline');
    const result = await first;
    check(result.kind === 'uncertain', `${fault} must not produce a successful stop`);
    check(state.events.filter((event) => event.event === 'stop-selected').length <= 1, 'a repeated stop must not select another native deadline');
    observations.push({ name: state.name, kind: 'fault', outcome: result.kind, reason: result.reason });
  });
}

await run('natural-release-keeps-independent-daemon', async () => {
  const state = session('natural-release'); await state.launch('natural', { fault: 'missing-notification' }); await state.start();
  const leaf = await marker(state.dir, 'leaf'); await state.observe(leaf, 'daemon');
  const released = await natural(state);
  const identity = await socketIdentity(leaf);
  check(identity.token === state.token && identity.pid === leaf.pid, 'natural release must preserve the same daemon');
  check(!state.event('terminate') && !state.event('stopped') && released.ack.terminationClaim === false, 'natural release must make no descendant termination claim');
  const coverage = state.events.find((event) => event.event === 'lifetime-accounting' && event.phase === 'natural-release');
  check(coverage.totalProcesses > coverage.covered, 'natural release control must preserve its explicit incomplete census');
  observations.push({ name: state.name, kind: 'release', outcome: released.kind, daemonSurvived: true });
});

await run('selected-stop-preserves-held-eas-sibling', async () => {
  const selected = session('selected-command'); await selected.launch('active'); await selected.start();
  await selected.observe(await marker(selected.dir, 'leaf'), 'selected-leaf');
  const sibling = session('held-eas-sibling'); await sibling.launch('eas'); await sibling.start();
  await marker(sibling.dir, 'eas-ready');
  const result = await confirmedStop(selected); assertCompleteCensus(selected, result); await assertLaterSettlement(selected);
  check(!sibling.event('root-exited') && !sibling.stdoutEnded && !sibling.stderrEnded, 'selected stop must leave the independent EAS sibling held');
  fs.writeFileSync(path.join(sibling.dir, 'release-eas'), 'finish independently');
  await natural(sibling);
  check(Buffer.concat(sibling.stdout).toString('utf8').includes(`fake-eas-${sibling.token}`), 'independent EAS sibling lost its finishing result');
  observations.push({ name: 'selected-stop-preserves-held-eas-sibling', kind: 'selection', outcome: result.kind, siblingFinishedIndependently: true });
});

const toolchain = path.join(directory, 'toolchain');
const safeToolEnv = { CI: '1', EXPO_NO_TELEMETRY: '1', EXPO_OFFLINE: '1', EAS_NO_VCS: '1', NO_UPDATE_NOTIFIER: '1', npm_config_offline: 'true', npm_config_registry: 'http://127.0.0.1:9', EXPO_TOKEN: '', EAS_ACCESS_TOKEN: '' };
const expoShim = path.join(toolchain, 'node_modules', '.bin', 'expo.cmd');
const easPackage = path.join(toolchain, 'node_modules', 'eas-cli', 'package.json');
const npxShim = path.join(path.dirname(process.execPath), 'npx.cmd');
const toolcases = [
  { name: 'expo', expected: '58.0.5', manifest: path.join(toolchain, 'node_modules', 'expo', 'package.json'), shim: expoShim, args: [] },
  { name: 'eas-project-runner', expected: '22.4.0', manifest: easPackage, shim: npxShim, args: ['--offline', '--yes', 'eas-cli'] },
];
for (const tool of toolcases) {
  for (const operation of ['version-census', 'help-release']) {
    const name = `${tool.name}-${operation}`;
    await run(name, async () => {
      const manifest = JSON.parse(fs.readFileSync(tool.manifest, 'utf8'));
      check(manifest.version === tool.expected, 'installed package differs from the evidence-based exact pin');
      const target = batchTarget(tool.shim, [...tool.args, operation.startsWith('version') ? '--version' : '--help']);
      const state = session(name, { env: safeToolEnv });
      log('installed-tool-provenance', { name, manifest, manifestSha256: sha256(tool.manifest), shim: tool.shim, shimSha256: sha256(tool.shim), commandLine: target.line, packageLockSha256: sha256(path.join(toolchain, 'package-lock.json')) });
      await state.launch('unused', { target, cwd: toolchain }); await state.start(); await state.completed(15000);
      check(state.event('root-exited').code === 0, `installed ${tool.name} command failed`);
      check(Buffer.concat(state.stdout).length + Buffer.concat(state.stderr).length > 0, 'installed tool did not produce its own output');
      if (operation.startsWith('version')) {
        const result = await state.stop(); assertCompleteCensus(state, result); await assertLaterSettlement(state);
        observations.push({ name, kind: 'installed-tool', package: manifest.name, version: manifest.version, outcome: result.kind, covered: result.ack.covered, totalProcesses: result.ack.totalProcesses });
      } else {
        const released = await natural(state);
        observations.push({ name, kind: 'installed-tool', package: manifest.name, version: manifest.version, outcome: released.kind, terminationClaim: false });
      }
    });
  }
}

await run('expo-config-real-path-stops-config-created-descendant', async () => {
  const state = session('expo-config-active-descendant', { env: safeToolEnv });
  const project = path.join(toolchain, 'config-project'); fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'windows-job-audit-local-config', version: '1.0.0', private: true }) + '\n');
  fs.writeFileSync(path.join(project, 'app.config.js'), `const { spawn } = require('node:child_process');\nconst child = spawn(process.execPath, [${JSON.stringify(fixture)}, 'leaf', ${JSON.stringify(state.dir)}, ${JSON.stringify(state.token)}], { detached: true, stdio: 'ignore' });\nchild.unref();\nmodule.exports = { name: 'Local lifetime audit', slug: 'local-lifetime-audit' };\n`);
  const target = batchTarget(expoShim, ['config', '--json', '--type', 'public']);
  await state.launch('unused', { target, cwd: project }); await state.start();
  const leaf = await marker(state.dir, 'leaf'); await state.observe(leaf, 'config-descendant'); await state.completed();
  check(state.event('root-exited').code === 0, 'real Expo config subprocess failed');
  check((await socketIdentity(leaf)).token === state.token, 'config-created descendant must still be live before stop');
  const result = await confirmedStop(state); assertCompleteCensus(state, result); await assertLaterSettlement(state);
  observations.push({ name: state.name, kind: 'installed-tool-active-descendant', package: 'expo', version: '58.0.5', outcome: result.kind, covered: result.ack.covered, totalProcesses: result.ack.totalProcesses, descendantIsAuditConfigFixture: true });
});

for (const state of sessions) state.save();
const summary = {
  productionWitnessProven: false,
  nonWrappingLifetimeCountProven: false,
  inFlightCreatorOrderingProven: false,
  finishedAt: new Date().toISOString(),
  passed: results.every((result) => result.passed),
  candidateObservationSuccess: observations.some((item) => item.kind === 'retired-coverage' && item.outcome === 'stopped'),
  installedToolCensusSuccess: observations.filter((item) => item.kind === 'installed-tool' && item.outcome === 'stopped').length === 2,
  observations,
  results,
  interpretation: 'Audit-only conditional lifetime coverage. Native identity validity, all retained handle waits, and fresh count equality are separate requirements. Counter wrap and in-flight creator ordering remain explicit premises. Natural release never certifies daemon termination.',
};
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.passed ? 0 : 1;

