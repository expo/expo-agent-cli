const childProcess = require('node:child_process');
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const path = require('node:path');

const traceDirectory = process.env.AGENT_CLI_STOP_PROBE_TRACE;
if (traceDirectory) {
  const script = (process.argv[1] ?? '').replaceAll('\\', '/').toLowerCase();
  const [verb, ...args] = process.argv.slice(2);
  const role =
    script.endsWith('/node_modules/expo/bin/cli') && verb === 'start'
      ? 'expo-stub'
      : script.endsWith('/agent-cli/bin/cli.js') && process.env.__EXPO_AGENT_CLI_DETACHED === '1'
        ? 'detached-wrapper'
        : script.endsWith('/agent-cli/bin/cli.js') && verb === 'dev' && args.includes('--detach')
          ? 'start-cli'
          : script.endsWith('/agent-cli/bin/cli.js') && verb === 'dev:stop'
            ? 'stop-cli'
            : null;

  if (role) {
    const file = path.join(traceDirectory, role + '-' + process.pid + '.jsonl');
    function write(event) {
      try {
        fs.appendFileSync(file, JSON.stringify({ time: Date.now(), ...event }) + '\n');
      } catch {
        // Missing evidence fails the probe assertions without changing the observed CLI result.
      }
    }
    write({
      type: 'process',
      role,
      pid: process.pid,
      parentPid: process.ppid,
      ...(role === 'expo-stub' ? { stubDelayMs: process.env.STUB_EXPO_DELAY_MS } : {}),
    });

    if (role === 'expo-stub') {
      process.once('exit', (code) => write({ type: 'stub-exit', pid: process.pid, code }));
    }

    const originalSpawn = childProcess.spawn;
    childProcess.spawn = function spawn(command, argv) {
      const startedAt = Date.now();
      const isTaskkill = role === 'stop-cli' && /(?:^|[\\/])taskkill\.exe$/i.test(command);
      let child;
      try {
        child = Reflect.apply(originalSpawn, this, arguments);
      } catch (error) {
        if (isTaskkill) {
          write({
            type: 'taskkill-error',
            command,
            argv,
            callerPid: process.pid,
            pid: null,
            startedAt,
            elapsedMs: Date.now() - startedAt,
            spawnError: { message: error.message, code: error.code, errno: error.errno },
          });
        }
        throw error;
      }

      if (
        role === 'detached-wrapper' &&
        /(?:^|[\\/])expo\.cmd"?$/i.test(command) &&
        argv?.[0]?.replace(/["^]/g, '') === 'start'
      ) {
        write({
          type: 'process',
          role: 'expo-cmd',
          pid: child.pid ?? null,
          parentPid: process.pid,
          command: child.spawnfile,
          argv: child.spawnargs,
        });
        child.once('exit', (code, signal) => {
          write({ type: 'shim-exit', pid: child.pid, code, signal });
        });
      }

      if (isTaskkill) {
        const invocation = { command, argv, callerPid: process.pid, pid: child.pid ?? null };
        let stdout = '';
        let stderr = '';
        let spawnError = null;
        write({ type: 'taskkill-spawn', ...invocation, startedAt });
        child.stdout?.on('data', (chunk) => {
          stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        child.once('error', (error) => {
          spawnError = { message: error.message, code: error.code, errno: error.errno };
          write({ type: 'taskkill-error', ...invocation, spawnError });
        });
        child.once('close', (exitCode, signal) => {
          write({
            type: 'taskkill-close',
            ...invocation,
            startedAt,
            elapsedMs: Date.now() - startedAt,
            exitCode,
            signal,
            stdout,
            stderr,
            spawnError,
          });
        });
      }

      return child;
    };
    syncBuiltinESMExports();
  }
}
