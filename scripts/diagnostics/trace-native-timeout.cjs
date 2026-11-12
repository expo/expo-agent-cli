const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');

const directory = process.env.AGENT_NATIVE_TIMEOUT_TRACE_DIR;
if (!directory) return;

const root = process.env.OWNED_STOP_ROOT;
const detached = process.env.__EXPO_AGENT_CLI_DETACHED === '1';
const script = path.basename(process.argv[1] ?? '');
const owner = detached && script === 'cli.js';
const traceFlag = '--require "' + __filename.replace(/\\/g, '/') + '"';
const traceFile = path.join(directory, process.pid + '.jsonl');
const append = fs.appendFileSync;
let sequence = 0;
function record(event, fields = {}) {
  try {
    append(traceFile, JSON.stringify({ time: Date.now(), pid: process.pid, seq: ++sequence, event, ...fields }) + '\n');
  } catch {}
}

function errorFields(error) {
  if (!error) return null;
  const clean = (value) =>
    typeof value === 'string' ? value.replace(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/gi, '<uuid>') : undefined;
  return {
    code: error.code,
    errno: error.errno,
    syscall: error.syscall,
    name: error.name,
    message: clean(error.message),
    stack: clean(error.stack),
  };
}

const verbs = new Set(['dev', 'dev:stop', 'start', 'build', 'build:list', 'simulator', 'simulator:start', 'simulator:list', 'owned-leaf']);
function nodeOptions(value) {
  return {
    set: value !== undefined,
    empty: value === '',
    trace: value?.includes(traceFlag) ?? false,
    fixture: /owned-stop\.cjs/i.test(value ?? ''),
  };
}

function envValue(envPairs, key) {
  const prefix = key.toLowerCase() + '=';
  const pair = envPairs?.find((value) => value.toLowerCase().startsWith(prefix));
  return pair?.slice(prefix.length);
}

const logNames = new Set(['owned-stop.jsonl', 'control.jsonl', 'spawned.jsonl']);
function logName(file) {
  if (typeof file !== 'string') return;
  const name = path.basename(file);
  if (logNames.has(name)) return name;
}

fs.mkdirSync(directory, { recursive: true });
record('process-start', {
  ppid: process.ppid,
  node: process.version,
  script,
  verb: verbs.has(process.argv[2]) ? process.argv[2] : undefined,
  detached,
  root,
  nodeOptions: nodeOptions(process.env.NODE_OPTIONS),
});
process.on('uncaughtExceptionMonitor', (error, origin) => {
  record('uncaught', { error: errorFields(error), origin });
});
process.once('exit', (code) => record('process-exit', { code }));

const spawn = cp.ChildProcess.prototype.spawn;
cp.ChildProcess.prototype.spawn = function (options) {
  const childRoot = envValue(options.envPairs, 'OWNED_STOP_ROOT');
  let childNodeOptions = envValue(options.envPairs, 'NODE_OPTIONS');
  const firstFixtureLaunch = !root && childRoot && nodeOptions(childNodeOptions).fixture;
  if (firstFixtureLaunch && !nodeOptions(childNodeOptions).trace) {
    // The test supplies its own NODE_OPTIONS. Prepend the tracer so the fixture captures the wrapped spawnSync.
    childNodeOptions = traceFlag + ' ' + childNodeOptions;
    options = {
      ...options,
      envPairs: options.envPairs.map((entry) =>
        entry.toLowerCase().startsWith('node_options=')
          ? entry.slice(0, entry.indexOf('=') + 1) + childNodeOptions
          : entry
      ),
    };
  }
  if (!firstFixtureLaunch && !root) return spawn.call(this, options);

  const command = path.basename(options.file);
  const args = options.args ?? [];
  const selected = owner && args.join(' ').includes('expo') && /\bstart\b/.test(args.join(' '));
  const data = {
    command,
    verb: args.find((arg) => verbs.has(arg)),
    selected,
    root: childRoot ?? root,
    detached: options.detached,
    childDetachedFlag: envValue(options.envPairs, '__EXPO_AGENT_CLI_DETACHED') === '1',
    nodeOptions: nodeOptions(childNodeOptions),
  };
  record(firstFixtureLaunch ? 'fixture-launch' : 'spawn-begin', data);
  const emit = this.emit;
  this.emit = function (event, ...values) {
    if (event === 'error') record('child-error', { ...data, child: this.pid, error: errorFields(values[0]) });
    if (event === 'exit' || event === 'close') {
      record('child-' + event, { ...data, child: this.pid, code: values[0], signal: values[1] });
    }
    return emit.call(this, event, ...values);
  };
  try {
    const result = spawn.call(this, options);
    record('spawn-result', { ...data, child: this.pid });
    return result;
  } catch (error) {
    record('spawn-throw', { ...data, error: errorFields(error) });
    throw error;
  }
};

if (!root) {
  const read = fs.readFileSync;
  const snapshots = new Map();
  fs.readFileSync = function (file, options) {
    const name = logName(file);
    if (!name) return read.apply(this, arguments);
    try {
      const result = read.apply(this, arguments);
      const bytes = Buffer.from(result).toString('base64');
      if (snapshots.get(file) !== bytes) {
        snapshots.set(file, bytes);
        record('fixture-read', { file, bytes });
      }
      return result;
    } catch (error) {
      record('fixture-read-error', { file, error: errorFields(error) });
      throw error;
    }
  };
} else {
  fs.appendFileSync = function (file, value, options) {
    const name = logName(file);
    if (!name) return append.apply(this, arguments);
    const bytes = Buffer.from(value, typeof options === 'string' ? options : options?.encoding).toString('base64');
    try {
      const result = append.apply(this, arguments);
      record('fixture-append', { file, bytes });
      return result;
    } catch (error) {
      record('fixture-append-error', { file, bytes, error: errorFields(error) });
      throw error;
    }
  };

  const spawnSync = cp.spawnSync;
  cp.spawnSync = function (command, args, options) {
    const argv = Array.isArray(args) ? args : [];
    const settings = Array.isArray(args) ? options : args;
    const taskkill = /^taskkill(?:\.exe)?$/i.test(path.basename(command));
    const nativeWaiter = path.resolve(command) === path.resolve(process.execPath) &&
      argv[0] === '-e' &&
      argv[1]?.startsWith("require('node:fs').appendFileSync(") &&
      argv[1]?.endsWith("+'\\n');setInterval(()=>{},1000);");
    const childEnv = settings?.env ?? process.env;
    const data = {
      command,
      args: taskkill || nativeWaiter ? argv : undefined,
      argCount: argv.length,
      nativeWaiter,
      timeout: settings?.timeout,
      killSignal: settings?.killSignal,
      stdio: typeof settings?.stdio === 'string' ? settings.stdio : undefined,
      childDetachedFlag: childEnv.__EXPO_AGENT_CLI_DETACHED === '1',
      nodeOptions: nodeOptions(childEnv.NODE_OPTIONS),
    };
    const started = performance.now();
    record('spawn-sync-begin', data);
    try {
      const result = spawnSync.apply(this, arguments);
      record('spawn-sync-result', {
        ...data,
        elapsedMs: performance.now() - started,
        child: result.pid,
        code: result.status,
        signal: result.signal,
        error: errorFields(result.error),
        stdout: taskkill || nativeWaiter ? result.stdout?.toString() ?? null : undefined,
        stderr: taskkill || nativeWaiter ? result.stderr?.toString() ?? null : undefined,
      });
      return result;
    } catch (error) {
      record('spawn-sync-throw', { ...data, elapsedMs: performance.now() - started, error: errorFields(error) });
      throw error;
    }
  };
}

if (owner) {
  const http = require('node:http');
  const routes = new Set(['/', '/stop', '/cancel', '/release']);
  const requests = new WeakMap();
  const controls = new WeakSet();
  let requestNumber = 0;
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, ...args) {
    if (event === 'request' && routes.has(args[0].url)) {
      const [request, response] = args;
      const data = { request: ++requestNumber, method: request.method, route: request.url };
      requests.set(response, data);
      controls.add(this);
      record('http-dispatch', {
        ...data,
        timeout: Number(request.headers['x-detached-timeout']) || undefined,
      });
      response.once('finish', () => record('http-finish', { ...data, status: response.statusCode }));
      response.once('close', () => {
        record('http-close', {
          ...data,
          status: response.statusCode,
          headersSent: response.headersSent,
          ended: response.writableEnded,
        });
      });
    }
    if (event === 'close' && controls.has(this)) record('http-listener-close');
    return emit.call(this, event, ...args);
  };
  const close = http.Server.prototype.close;
  http.Server.prototype.close = function (...args) {
    if (controls.has(this)) record('http-listener-close-call');
    return close.apply(this, args);
  };
  const response = http.ServerResponse.prototype;
  for (const method of ['writeHead', 'flushHeaders', 'end']) {
    const original = response[method];
    response[method] = function (...args) {
      const data = requests.get(this);
      if (data) {
        record('http-' + method, {
          ...data,
          status: method === 'writeHead' ? args[0] : this.statusCode,
          destroyed: this.destroyed,
        });
      }
      return original.apply(this, args);
    };
  }
}

syncBuiltinESMExports();
