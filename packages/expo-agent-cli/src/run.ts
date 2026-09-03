import { spawn, type ChildProcess } from 'node:child_process';

import { readAliasVersion } from './readAliasVersion';
import { resolveNpxRunner, resolveRunner, type Runner } from './resolveRunner';
import { resolveSpawnTarget } from './windowsShim';

export type RunIo = {
  spawn: typeof spawn;
  platform: NodeJS.Platform;
  exit: (code: number) => void;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  error: (message: string) => void;
  pid: number;
  bunRuntime: boolean;
};

function defaultIo(): RunIo {
  return {
    spawn,
    platform: process.platform,
    exit: (code) => process.exit(code),
    kill: (pid, signal) => process.kill(pid, signal),
    error: (message) => console.error(message),
    pid: process.pid,
    bunRuntime: typeof process.versions.bun === 'string',
  };
}

export function run(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
  io: Partial<RunIo> = {}
): void {
  const resolved = { ...defaultIo(), ...io };

  let version: string;
  try {
    version = readAliasVersion();
  } catch (error) {
    resolved.error(error instanceof Error ? error.message : String(error));
    resolved.exit(1);
    return;
  }

  const runner = resolveRunner(
    {
      userAgent: env.npm_config_user_agent,
      execPath: env.npm_execpath,
      bunRuntime: resolved.bunRuntime,
    },
    version,
    argv
  );

  spawnRunner(runner, resolved, () => {
    if (runner.command === 'npx') {
      return false;
    }
    resolved.error(`expo-agent-cli: cannot find ${runner.command}; falling back to npx`);
    spawnRunner(resolveNpxRunner(version, argv), resolved);
    return true;
  });
}

function spawnRunner(
  runner: Runner,
  io: RunIo,
  onMissing?: () => boolean
): void {
  const command =
    io.platform === 'win32' && !/\.(cmd|bat|exe)$/i.test(runner.command)
      ? `${runner.command}.cmd`
      : runner.command;
  const target = resolveSpawnTarget(command, runner.args, io.platform);
  const child = io.spawn(target.command, target.args, {
    stdio: 'inherit',
    shell: target.shell,
  }) as ChildProcess;

  child.on('exit', (code, signal) => {
    if (signal) {
      io.kill(io.pid, signal);
    } else {
      io.exit(code ?? 1);
    }
  });
  child.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' && onMissing?.()) {
      return;
    }
    io.error(error.message);
    io.exit(1);
  });
}
