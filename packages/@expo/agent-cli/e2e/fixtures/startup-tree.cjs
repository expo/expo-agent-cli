const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const [role, root, mode, runnerName] = process.argv.slice(2);
const log = (event, extra = {}) =>
  fs.appendFileSync(
    path.join(root, 'tree.jsonl'),
    JSON.stringify({ event, pid: process.pid, ...extra }) + '\n'
  );
const wait = (name) =>
  new Promise((resolve) => {
    const timer = setInterval(() => {
      if (fs.existsSync(path.join(root, name))) {
        clearInterval(timer);
        resolve();
      }
    }, 10);
  });

if (role === 'leaf') {
  process.on('SIGTERM', () => {});
  log('leaf');
  setInterval(() => {}, 1000);
} else if (role === 'tool') {
  cp.spawn(process.execPath, [__filename, 'leaf', root], {
    stdio: 'ignore',
    detached: process.platform === 'win32',
  }).unref();
  log('tool');
  setInterval(() => {}, 1000);
} else {
  const ts = require('typescript');
  require.extensions['.ts'] = (module, file) =>
    module._compile(
      ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      }).outputText,
      file
    );
  let tool;
  const spawn = cp.spawn;
  cp.spawn = function (command, args, options) {
    const child = spawn(command, args, options);
    if (args?.includes('tool')) {
      tool = child;
      child.once('close', () => log('direct-close'));
    }
    return child;
  };
  const kill = process.kill;
  process.kill = function (pid, signal) {
    if (mode.includes('failure') && pid === -tool?.pid)
      throw Object.assign(new Error('fixture group denied'), { code: 'EPERM' });
    return kill.call(process, pid, signal);
  };
  const spawnSync = cp.spawnSync;
  cp.spawnSync = function (command, args, options) {
    if (mode.includes('failure') && args?.[0] === '/PID' && args[1] === String(tool?.pid))
      return { status: 1, signal: null, error: undefined };
    return spawnSync(command, args, options);
  };
  const response = require('node:http').ServerResponse.prototype;
  const flush = response.flushHeaders;
  response.flushHeaders = function () {
    if (this.statusCode === 202) log('accepted');
    return flush.call(this);
  };
  const end = response.end;
  response.end = function (body, ...args) {
    if (this.statusCode === 202) log('receipt', { body: body ?? '' });
    return end.call(this, body, ...args);
  };
  const source = path.resolve(__dirname, '../../src');
  const { withDetachedOwnerAsync, DETACHED_ATTEMPT_ENV } = require(
    path.join(source, 'dev/detachedOwner')
  );
  const { resolveDevOptions } = require(path.join(source, 'dev/resolveOptions'));
  const { withSubprocessDeadlineAsync } = require(path.join(source, 'utils/subprocessDeadline'));
  const { trackStartupTask } = require(path.join(source, 'utils/startupTasks'));
  const { spawnSubprocessAsync } = require(path.join(source, 'utils/subprocess'));
  const { spawnCaptureAsync } = require(path.join(source, 'utils/spawnCapture'));
  process.env[DETACHED_ATTEMPT_ENV] = require('node:crypto').randomUUID();
  fs.mkdirSync(path.join(root, '.expo/dev/logs'), { recursive: true });
  const runner = runnerName === 'capture' ? spawnCaptureAsync : spawnSubprocessAsync;
  withDetachedOwnerAsync(root, resolveDevOptions(['--ios', '--detach']), async () => {
    const work = async () => {
      try {
        await runner(process.execPath, [__filename, 'tool', root], {
          timeoutMs: mode === 'timeout' ? 1500 : undefined,
        });
      } finally {
        await wait('release-tree-task');
      }
    };
    if (mode === 'deadline-failure')
      await withSubprocessDeadlineAsync(1500, 'fixture deadline', work).catch(() => {});
    else await trackStartupTask(work());
  }).then(
    () => log('settled'),
    (error) => log('settled', { code: error.code })
  );
}
