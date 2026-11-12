import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const [mode, directory, token, ...args] = process.argv.slice(2);
const marker = (name, value) => {
  const target = path.join(directory, `${name}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ token, pid: process.pid, timeMs: Date.now(), ...value }));
  fs.renameSync(temporary, target);
};
const exists = (name) => fs.existsSync(path.join(directory, name));
fs.mkdirSync(directory, { recursive: true });
marker(`${mode}-first`, { mode });
setTimeout(() => process.exit(77), 20000).unref();

if (mode === 'args') {
  const output = JSON.stringify({ args, cwd: process.cwd(), environment: process.env.PROBE_PARITY, selected: process.env.PROBE_LOCAL_SELECTION });
  process.stdout.write(output + '\n');
  process.stdout.write(Buffer.from([0, 255, 13, 10, 226, 130, 172]));
  process.stderr.write(Buffer.from([255, 0, 13, 10, 65]));
  process.exitCode = 17;
} else if (mode === 'burst') {
  const bytes = Buffer.alloc(512 * 1024);
  for (let i = 0; i < bytes.length; ++i) bytes[i] = i % 251;
  process.stdout.write(bytes);
  process.stderr.write(Buffer.from(bytes).reverse());
} else if (mode === 'leaf' || mode === 'grandchild') {
  let spawned = false;
  const server = net.createServer((socket) => socket.end(JSON.stringify({ token, pid: process.pid, mode })));
  server.listen(0, '127.0.0.1', () => marker(mode, { mode, port: server.address().port }));
  setInterval(() => {
    if (exists('shutdown')) process.exit(0);
    if (mode === 'leaf' && exists('spawn-next') && !spawned) {
      spawned = true;
      const child = spawn(process.execPath, [self, 'grandchild', directory, token], { stdio: 'ignore', detached: true });
      child.unref();
      marker('spawn-next-result', { childPid: child.pid });
    }
  }, 10);
} else if (mode === 'eas') {
  marker('eas-ready', { id: `fake-eas-${token}` });
  const timer = setInterval(() => {
    if (exists('release-eas')) {
      clearInterval(timer);
      process.stdout.write(JSON.stringify({ id: `fake-eas-${token}` }) + '\n');
    }
  }, 10);
} else {
  if (mode.endsWith('-native')) {
    const creator = spawn(process.env.PROBE_HELPER, ['--native-creator', directory, 'one', process.env.PROBE_NESTED || 'plain'], { stdio: 'ignore', detached: true });
    creator.unref();
    marker('creator-spawned', { childPid: creator.pid });
  }
  const child = spawn(process.execPath, [self, 'leaf', directory, token], {
    stdio: mode.startsWith('pipe') ? ['ignore', process.stdout, process.stderr] : 'ignore',
    detached: true,
  });
  child.unref();
  marker('spawned-leaf', { childPid: child.pid });
  const timer = setInterval(() => {
    if (!exists('leaf.json')) return;
    if (mode.startsWith('active')) return;
    clearInterval(timer);
    process.stdout.write(`root-output-${token}\n`);
    process.stderr.write(`root-error-${token}\n`);
    process.exitCode = Number(process.env.PROBE_ROOT_CODE || 0);
  }, 5);
}
