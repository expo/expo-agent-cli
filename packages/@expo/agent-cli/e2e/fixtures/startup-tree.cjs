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
} else if (role === 'late') {
  log('late');
  wait('release-late').then(() => log('late-exit'));
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
    if (['/stop', '/cancel'].includes(this.req.url) && [200, 202].includes(this.statusCode))
      log('accepted');
    return flush.call(this);
  };
  const end = response.end;
  response.end = function (body, ...args) {
    if (['/stop', '/cancel'].includes(this.req.url) && [200, 202].includes(this.statusCode))
      log('receipt', { body: body ?? '' });
    return end.call(this, body, ...args);
  };
  const source = path.resolve(__dirname, '../../src');
  const { withDetachedOwnerAsync, DETACHED_ATTEMPT_ENV } = require(
    path.join(source, 'dev/detachedOwner')
  );
  const { resolveDevOptions } = require(path.join(source, 'dev/resolveOptions'));
  const { withSubprocessDeadlineAsync } = require(path.join(source, 'utils/subprocessDeadline'));
  const { trackStartupTask, recordStartupSession } = require(
    path.join(source, 'utils/startupTasks')
  );
  const { spawnSubprocessAsync } = require(path.join(source, 'utils/subprocess'));
  const { spawnCaptureAsync } = require(path.join(source, 'utils/spawnCapture'));
  process.env[DETACHED_ATTEMPT_ENV] = require('node:crypto').randomUUID();
  fs.mkdirSync(path.join(root, '.expo/dev/logs'), { recursive: true });
  const runner = runnerName === 'capture' ? spawnCaptureAsync : spawnSubprocessAsync;
  const { withRunAsync } = require(path.join(source, 'dev/runSteps'));
  const { RunLock } = require(path.join(source, 'devLock/runLock'));
  const { tryAcquireRunnerLock, runnerSpawnKey } = require(path.join(source, 'utils/runnerLock'));
  const port = Number(process.env.STUB_EXPO_DEV_SERVER_PORT);
  let liveLock;
  if (mode === 'locked-handoff') {
    const publish = RunLock.prototype.publishAsync;
    RunLock.prototype.publishAsync = async function (event) {
      await publish.call(this, event);
      log('boundary');
      await wait('release-boundary');
    };
  }
  if (mode === 'locked-port-move') {
    const http = require('node:http');
    const create = http.createServer;
    http.createServer = function (listener) {
      return create.call(this, (request, response) => {
        if (request.url === '/stop') {
          liveLock.apply({ type: 'port-reported', port: port + 1 });
          log('port-moved');
        }
        listener(request, response);
      });
    };
  }
  const options = resolveDevOptions(['--ios', '--detach', '--port', String(port)]);
  withDetachedOwnerAsync(root, options, async () => {
    if (mode.startsWith('locked-')) {
      const plan = {
        steps: [{ argv: ['eas', 'build'] }, { argv: ['expo', 'start'] }],
        devServerPort: { port },
      };
      return await withRunAsync(root, plan, 'ios', async (lock, steps) => {
        liveLock = lock;
        const runTool = () =>
          steps.stepAsync((cancellation) =>
            spawnSubprocessAsync(process.execPath, [__filename, 'tool', root], cancellation)
          );
        try {
          if (mode === 'locked-helper-failure') {
            await spawnCaptureAsync(process.execPath, [__filename, 'tool', root], {
              timeoutMs: 1500,
            });
            await spawnCaptureAsync(process.execPath, [__filename, 'late', root]);
            recordStartupSession('late-helper', 'ios');
          } else if (mode === 'locked-queued') {
            const command = path.join(root, process.platform === 'win32' ? 'npx.cmd' : 'npx');
            const args = ['owned-queued'];
            const held = tryAcquireRunnerLock(runnerSpawnKey(command, args));
            const queued = steps.stepAsync((cancellation) =>
              spawnSubprocessAsync(command, args, cancellation)
            );
            log('boundary');
            try {
              await queued;
            } finally {
              held.release();
              log('queue-ended');
            }
          } else if (mode === 'locked-between') {
            await steps.stepAsync(() =>
              spawnSubprocessAsync(process.execPath, ['-e', 'process.exit(0)'])
            );
            log('boundary');
            await wait('release-boundary');
            await runTool();
          } else if (mode === 'locked-handoff') {
            await runTool();
          } else {
            await runTool();
          }
          steps.assertNotInterrupted();
        } finally {
          await wait('release-tree-task');
        }
      });
    }
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
