const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const directory = process.env.AGENT_NATIVE_STOP_TRACE_DIR;
if (directory && process.env.__EXPO_AGENT_CLI_DETACHED === '1') {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${process.pid}.jsonl`);
  const write = (event, data = {}) => {
    try {
      fs.appendFileSync(file, JSON.stringify({ time: Date.now(), pid: process.pid, event, ...data }) + '\n');
    } catch {}
  };
  const signal = process.kill.bind(process);
  const alive = (pid) => {
    try { signal(pid, 0); return true; } catch (error) { return error.code === 'ESRCH' ? false : null; }
  };
  write('process', { parent: process.ppid, script: path.basename(process.argv[1] || ''), verb: process.argv[2] });
  const spawn = cp.spawn;
  cp.spawn = function (...args) {
    const child = spawn.apply(this, args);
    write('spawn', { child: child.pid, command: path.basename(String(args[0])), verb: args[1]?.[0], shell: args[2]?.shell });
    child.once('exit', (code, signal) => write('child-exit', { child: child.pid, code, signal }));
    child.once('close', (code, signal) => write('child-close', { child: child.pid, code, signal }));
    return child;
  };
  const spawnSync = cp.spawnSync;
  cp.spawnSync = function (command, args, options) {
    if (!/^taskkill(?:\.exe)?$/i.test(path.basename(String(command)))) return spawnSync.call(this, command, args, options);
    const started = Date.now();
    const target = Number(args?.[args.indexOf('/PID') + 1]);
    const origin = new Error().stack?.split('\n').slice(2, 7);
    write('tree-begin', { target, alive: alive(target), timeout: options?.timeout, origin });
    try {
      const result = spawnSync.call(this, command, args, { ...options, stdio: 'pipe', encoding: 'utf8' });
      write('tree-result', { target, elapsedMs: Date.now() - started, status: result.status, signal: result.signal, error: result.error?.code, stdout: result.stdout, stderr: result.stderr, alive: alive(target) });
      return result;
    } catch (error) {
      write('tree-throw', { target, elapsedMs: Date.now() - started, code: error.code, message: error.message });
      throw error;
    }
  };
  const kill = cp.ChildProcess.prototype.kill;
  cp.ChildProcess.prototype.kill = function (requested) {
    write('direct-kill', { child: this.pid, signal: requested, alive: alive(this.pid) });
    return kill.call(this, requested);
  };
  process.once('exit', (code) => write('process-exit', { code }));
}
