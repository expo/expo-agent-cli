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
  const env = { ...process.env, PROBE_PARITY: 'env value Ž 🧪', ...options.env };
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
    check(observed.created && observed.wait === 258, 'observer must hold the known live process');
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
          if (command === 'T') check(state.event('terminate')?.ok && ack.active === 0 && ack.rootWait === 0, 'stop acknowledgement lacks native evidence');
          return true;
        }
        if (state.exit !== undefined && !ack) { result = { kind: 'uncertain', reason: 'helper-exit' }; return true; }
        return false;
      }, `${name} terminal result`, Math.max(0, deadline - Date.now()) + 300);
    } catch (error) { result = { kind: 'uncertain', reason: String(error) }; }
    finally { clearTimeout(timer); }
    if (result.kind === 'uncertain' && state.exit === undefined) child.kill();
    log('terminal-result', { name, ...result, elapsedBeyondDeadlineMs: Date.now() - deadline });
    return result;
  }
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
      if (state.exit === undefined) state.child.kill();
      state.save();
    }
    await delay(60);
  }
}

if (process.platform !== 'win32') throw new Error('Native Windows is required; do not interpret a non-Windows run as mechanism evidence');
check(Number(process.versions.node.split('.')[0]) === 24, 'Run with actual Node 24');
log('environment', { platform: process.platform, release: os.release(), version: os.version(), architecture: process.arch, node: process.version, execPath: process.execPath, versions: process.versions, helper, helperSha256: sha256(helper), controllerSha256: sha256(fileURLToPath(import.meta.url)) });

await run('transport-and-handle-exclusion', async () => {
  const s = session('transport'); await s.wait('hello'); s.send('P'); await s.wait('pong');
  const ready = await s.launch('unused', { target: direct(helper, ['--inspect-handles']) });
  check(ready.member, 'creation-time JOB_LIST membership missing');
  await s.start(); await natural(s);
  const handles = JSON.parse(Buffer.concat(s.stdout).toString('utf8'));
  log('numeric-handle-probe', { name: s.name, ...handles, interpretation: handles.controlPresent || handles.jobPresent ? 'inconclusive-handle-value-reuse-possible' : 'parent-handle-values-absent' });
});
await run('suspended-cancel', async () => {
  const s = session('suspended'); await s.launch('active');
  const stop = s.stop(); check(stop === s.stop(20000), 'repeated stop must join the original deadline');
  const result = await stop; check(result.kind === 'stopped' && result.ack.knownUnsignaled === 0, 'suspended stop failed');
  await delay(150); check(!readMarker(s.dir, 'active-first'), 'suspended root executed its first marker');
});
await run('selected-job-and-held-eas', async () => {
  const selected = session('selected'); const eas = session('eas');
  await Promise.all([selected.launch('active', { batch: true }), eas.launch('eas')]);
  await Promise.all([selected.start(), eas.start()]);
  const leaf = await marker(selected.dir, 'leaf'); const root = await marker(selected.dir, 'active-first');
  const easIdentity = await marker(eas.dir, 'eas-ready');
  await selected.observe(root, 'root-node'); await selected.observe(leaf, 'leaf'); await eas.observe(easIdentity, 'fake-eas');
  await confirmedStop(selected);
  check(!eas.event('root-exited') && eas.exit === undefined, 'selected stop killed EAS sibling');
  fs.writeFileSync(path.join(eas.dir, 'release-eas'), 'go');
  await natural(eas);
  check(JSON.parse(Buffer.concat(eas.stdout).toString()).id === easIdentity.id, 'held EAS ID changed');
  let reachable = true; try { await socketIdentity(leaf); } catch { reachable = false; }
  check(!reachable, 'selected leaf responder survived confirmed stop');
});
for (const milliseconds of [0, 13]) {
  await run(`cmd-early-${milliseconds}ms`, async () => {
    for (let i = 0; i < 8; ++i) {
      const s = session(`early-${milliseconds}-${i}`); await s.launch('active', { batch: true });
      s.send('S'); if (milliseconds) await delay(milliseconds);
      await confirmedStop(s);
      const before = fs.readdirSync(s.dir).filter((name) => name.endsWith('.json')).sort();
      await delay(80);
      const after = fs.readdirSync(s.dir).filter((name) => name.endsWith('.json')).sort();
      check(JSON.stringify(before) === JSON.stringify(after), 'new fixture marker appeared after stop verdict');
      log('early-marker-snapshot', { name: s.name, milliseconds, before, after, nativeRoot: s.event('ready') });
    }
  });
}
await run('root-exit-with-pipe-holder', async () => {
  const s = session('pipe-holder'); await s.launch('pipe'); await s.start();
  const leaf = await marker(s.dir, 'leaf'); await s.observe(leaf, 'pipe-leaf'); await s.wait('root-exited');
  check(!s.stdoutEnded && !s.stderrEnded && s.exit === undefined, 'root exit incorrectly closed inherited output or helper');
  await confirmedStop(s);
});
for (const code of [0, 17]) {
  await run(`natural-daemon-${code}`, async () => {
    const s = session(`daemon-${code}`, { env: { PROBE_ROOT_CODE: String(code) } }); await s.launch('daemon'); await s.start();
    const leaf = await marker(s.dir, 'leaf'); await s.observe(leaf, 'daemon');
    await natural(s); check(s.event('root-exited').code === code, 'natural root code changed');
    check((await socketIdentity(leaf)).token === s.token, 'daemon died on natural release');
    check((await s.stop()).kind === 'already-completed', 'release-first stop claimed termination');
    fs.writeFileSync(path.join(s.dir, 'spawn-next'), 'go');
    const descendant = await marker(s.dir, 'grandchild');
    check((await socketIdentity(descendant)).token === s.token, 'released daemon could not spawn a child');
  });
}
await run('delayed-assignment-negative-control', async () => {
  const s = session('negative'); const ready = await s.launch('active', { negative: true, batch: true });
  check(!ready.member, 'negative was already assigned'); await s.start();
  const leaf = await marker(s.dir, 'leaf'); await s.observe(await marker(s.dir, 'active-first'), 'uncontained-root-node');
  const observed = await s.observe(leaf, 'escaped-leaf');
  check(!observed.member, 'negative leaf was contained before delayed assignment');
  s.send('A'); const assigned = await s.wait('assigned-late'); check(assigned.ok, 'late assignment control failed');
  const verdict = await s.stop(); check(verdict.kind === 'stopped', 'negative did not reach proposed witness');
  check(verdict.ack.knownUnsignaled > 0, 'negative control failed to expose surviving leaf');
  log('negative-control-detected', { name: s.name, verdict });
});
for (const fault of ['job', 'attributes', 'create', 'crash-before', 'crash-ready']) {
  await run(`setup-${fault}`, async () => {
    const s = session(`setup-${fault}`);
    try { await s.launch('active', { fault }); } catch {}
    await until(() => s.exit !== undefined, 'failed setup helper exit');
    await delay(100); check(!readMarker(s.dir, 'active-first'), 'failed setup executed target');
    check(!s.event('stopped') && !s.event('released'), 'setup loss claimed terminal success');
    if (['job', 'attributes', 'create'].includes(fault)) check(s.event('native-error')?.error > 0, 'missing native error');
  });
}
for (const fault of ['terminate', 'query', 'deadline', 'withhold-stop', 'malformed-stop', 'invalid-ack']) {
  await run(`stop-${fault}`, async () => {
    const s = session(`stop-${fault}`); await s.launch('active', { fault }); await s.start();
    if (fault === 'terminate') await marker(s.dir, 'leaf');
    const result = await s.stop(500);
    check(result.kind === 'uncertain', 'fault was promoted to stop success');
  });
}
await run('active-helper-crash', async () => {
  const s = session('active-crash'); await s.launch('active'); await s.start(); await marker(s.dir, 'leaf');
  s.send('X'); const result = await s.stop(500); check(result.kind === 'uncertain', 'helper crash was promoted to proof');
});
await run('release-failure', async () => {
  const s = session('release-failure'); await s.launch('daemon', { fault: 'release' }); await s.start(); await s.completed();
  const result = await s.release(500); check(result.kind === 'uncertain', 'release failure was ignored');
});
await run('raw-output-burst', async () => {
  const s = session('burst'); await s.launch('burst'); await s.start(); s.send('P'); await s.wait('pong'); await natural(s);
  const expected = Buffer.alloc(512 * 1024); for (let i = 0; i < expected.length; ++i) expected[i] = i % 251;
  check(Buffer.concat(s.stdout).equals(expected), 'stdout bytes changed under burst');
  check(Buffer.concat(s.stderr).equals(Buffer.from(expected).reverse()), 'stderr bytes changed under burst');
});
const parityArgs = ['', 'a b', 'Žluťoučký 🧪', 'one"two', 'a&b', 'a%b', 'a^b', 'a!b', 'tail\\', 'two\\\\"q', '(x)|<>'];
for (const batch of [false, true]) {
  await run(`argv-output-parity-${batch ? 'cmd' : 'direct'}`, async () => {
    const s = session(`parity-${batch ? 'cmd' : 'direct'}`);
    await s.launch('args', { batch, args: parityArgs });
    const target = s.target;
    const baseline = spawn(batch ? target.command : target.image, target.args, { cwd: s.dir, env: { ...process.env, PROBE_PARITY: 'env value Ž 🧪' }, shell: batch, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = []; baseline.stdout.on('data', (b) => stdout.push(b)); baseline.stderr.on('data', (b) => stderr.push(b));
    const baselineCode = await new Promise((resolve, reject) => { baseline.once('error', reject); baseline.once('close', resolve); });
    await s.start(); await natural(s);
    check(Buffer.concat(s.stdout).equals(Buffer.concat(stdout)), 'stdout argv/cwd/env/binary parity mismatch');
    check(Buffer.concat(s.stderr).equals(Buffer.concat(stderr)), 'stderr byte parity mismatch');
    check(s.event('root-exited').code === baselineCode && baselineCode === 17, 'exit code parity mismatch');
    const decoded = JSON.parse(Buffer.concat(s.stdout).toString().split('\n')[0]);
    check(JSON.stringify(decoded.args) === JSON.stringify(parityArgs), 'existing launch does not preserve requested argv');
  });
}
for (const state of sessions) state.save();
const summary = { finishedAt: new Date().toISOString(), passed: results.every((result) => result.passed), results };
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.passed ? 0 : 1;
