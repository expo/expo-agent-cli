const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = process.env.OWNED_STOP_ROOT;
const log = (event, extra = {}) =>
  fs.appendFileSync(
    path.join(root, 'owned-stop.jsonl'),
    JSON.stringify({ event, pid: process.pid, ...extra }) + '\n'
  );
if (process.argv[2] === 'owned-leaf') {
  process.on('SIGTERM', () => {});
  log('leaf');
  setInterval(() => {}, 1000);
} else if (root) {
  const script = process.argv[1] ? fs.realpathSync.native(process.argv[1]) : '';
  if (
    script.startsWith(root) &&
    (process.argv[2] === 'start' ||
      (process.argv[2] === 'build' && process.env.OWNED_STOP_PLAN_BOUNDARY === 'build'))
  ) {
    cp.spawn(process.execPath, [__filename, 'owned-leaf'], {
      stdio: 'ignore',
      detached: process.platform === 'win32',
      env: { ...process.env, NODE_OPTIONS: '' },
    }).unref();
    log(process.argv[2] === 'start' ? 'expo' : 'build');
    if (process.argv[2] === 'build') {
      while (!fs.existsSync(path.join(root, 'release-plan')))
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  if (
    script.startsWith(root) &&
    process.argv[2] === 'build:list' &&
    !process.argv.includes('--fingerprint-hash') &&
    process.env.OWNED_STOP_PLAN_BOUNDARY === 'lookup'
  ) {
    log('lookup');
    while (!fs.existsSync(path.join(root, 'release-plan')))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  if (script.startsWith(root) && ['simulator:start', 'simulator'].includes(process.argv[2])) {
    log('eas-start');
    while (!fs.existsSync(path.join(root, 'release-session')))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  if (
    script.startsWith(root) &&
    process.argv[2] === 'simulator:list' &&
    process.env.OWNED_STOP_HOLD_INVENTORY === '1'
  ) {
    log('inventory');
    while (!fs.existsSync(path.join(root, 'release-inventory')))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  if (process.env.__EXPO_AGENT_CLI_DETACHED === '1' && !script.startsWith(root)) {
    let selected;
    const spawn = cp.spawn;
    cp.spawn = function (command, args, options) {
      const child = spawn(command, args, options);
      if (
        [command, ...(args ?? [])].join(' ').includes('expo') &&
        /\bstart\b/.test((args ?? []).join(' '))
      )
        selected = child;
      if (selected === child && process.env.OWNED_STOP_DELAY_CLOSE === '1') {
        const emit = child.emit;
        child.emit = function (event, ...values) {
          if (event === 'close') {
            setTimeout(() => emit.call(child, event, ...values), 200);
            return true;
          }
          return emit.call(child, event, ...values);
        };
      }
      return child;
    };
    const kill = process.kill;
    process.kill = function (pid, signal) {
      if (process.env.OWNED_STOP_FAILURE === '1' && pid === -selected?.pid)
        throw Object.assign(new Error('fixture denied selected group'), { code: 'EPERM' });
      return kill.call(process, pid, signal);
    };
    const spawnSync = cp.spawnSync;
    cp.spawnSync = function (command, args, options) {
      if (
        process.env.OWNED_STOP_FAILURE === 'timeout' &&
        args?.[0] === '/PID' &&
        args[1] === String(selected?.pid)
      ) {
        const script = `require('node:fs').appendFileSync(${JSON.stringify(path.join(root, 'owned-stop.jsonl'))}, JSON.stringify({event:'native-waiter',pid:process.pid})+'\\n');setInterval(()=>{},1000);`;
        const result = spawnSync(process.execPath, ['-e', script], options);
        log('native-timeout', { timeout: options.timeout, error: result.error?.code });
        return result;
      }

      if (
        process.env.OWNED_STOP_FAILURE === '1' &&
        args?.[0] === '/PID' &&
        args[1] === String(selected?.pid)
      )
        return { status: 1, signal: null, error: undefined };
      return spawnSync(command, args, options);
    };
    const response = require('node:http').ServerResponse.prototype;
    const flush = response.flushHeaders;
    response.flushHeaders = function () {
      if (['/stop', '/cancel'].includes(this.req.url) && [200, 202].includes(this.statusCode))
        log('grant');
      return flush.call(this);
    };
    const end = response.end;
    response.end = function (body, ...args) {
      if (['/stop', '/cancel'].includes(this.req.url) && [200, 202].includes(this.statusCode))
        log('receipt', { body: body ?? '' });
      return end.call(this, body, ...args);
    };
  }
}
