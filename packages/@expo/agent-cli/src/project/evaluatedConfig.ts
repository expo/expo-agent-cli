// @ref llp/0001-agentic-cli-on-expo-cli.rfc.md §Constraints
// The config the app itself sees: a dynamic `app.config.js`/`.ts` evaluated by the project's own
// `expo/config`, with its env files loaded, in a child process. The project's code never runs in
// this process, and `expo/config` is the project's version, not the one this CLI bundles.
import type { ExpoConfig } from '@expo/config';
import { getOriginalEnv, setNodeEnv } from '@expo/env';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import path from 'path';

import type { ConfigLoaderMessage } from './configLoader';

/**
 * The mode the env files are read in, which decides which `.env.*` files apply.
 *
 * `development` is what `expo start` serves, so the dev loop (`dev`, `navigate`, `runtime:*`)
 * reads the config the running app sees. `production` is what a release build and `deploy` see.
 */
export type ConfigEnvMode = 'development' | 'production';

/** How long an evaluation may take. The EAS preflight gives `expo config` the same. */
export const EVALUATE_CONFIG_TIMEOUT_MS = 30_000;

export type EvaluatedExpoConfig =
  | {
      ok: true;
      exp: ExpoConfig;
      /** Name of the static config file, relative to the project root, if any. */
      staticConfigFile: string | null;
      /** Name of the dynamic config file, relative to the project root, if any. */
      dynamicConfigFile: string | null;
    }
  | { ok: false; error: string };

export interface EvaluateExpoConfigOptions {
  /** Which env files the config is evaluated with. Every caller says which build it is about. */
  mode: ConfigEnvMode;
  /** Drop the private keys, the way `expo config --type public` does. */
  isPublicConfig?: boolean;
  /** Evaluate the config without running its config plugins. */
  skipPlugins?: boolean;
  timeoutMs?: number;
}

/**
 * Evaluate the project's config the way the app and `expo config` see it.
 *
 * `ok: false` is an answer about the evaluation, never about the config: a project whose
 * `expo/config` cannot be resolved, or whose config throws, has not said what its config is.
 */
export async function evaluateExpoConfigAsync(
  projectRoot: string,
  {
    mode,
    isPublicConfig,
    skipPlugins,
    timeoutMs = EVALUATE_CONFIG_TIMEOUT_MS,
  }: EvaluateExpoConfigOptions
): Promise<EvaluatedExpoConfig> {
  if (!resolvesExpoConfig(projectRoot)) {
    return { ok: false, error: 'expo/config is not installed in the project' };
  }

  const args = [configLoaderPath(), projectRoot, '--mode', mode];
  if (isPublicConfig) {
    args.push('--public');
  }
  if (skipPlugins) {
    args.push('--skip-plugins');
  }
  // The child's env is this process's own, with the mode set the way the Expo CLI sets it. The
  // child loads the project's env files on top; nothing of that reaches this process.
  const env = setNodeEnv(mode, { systemEnv: getOriginalEnv() });
  env.__EXPO_CONFIG_MODE = mode;

  const run = await spawnLoaderAsync(args, { cwd: projectRoot, env, timeoutMs });
  if (run.spawnError) {
    return {
      ok: false,
      error: `node could not be started (${run.spawnError.code ?? run.spawnError.message})`,
    };
  }
  if (run.timedOut) {
    return {
      ok: false,
      error: `expo/config did not answer within ${Math.round(timeoutMs / 1000)}s`,
    };
  }
  if (run.exitCode !== 0) {
    const said = lastLine(run.stderr);
    return {
      ok: false,
      error: said || `expo/config exited with code ${run.exitCode ?? run.signal}`,
    };
  }
  const message = parseMessage(run.message);
  if (message == null) {
    return { ok: false, error: 'expo/config printed no config' };
  }
  return {
    ok: true,
    exp: message.exp as ExpoConfig,
    staticConfigFile: relativeTo(projectRoot, message.staticConfigPath),
    dynamicConfigFile: relativeTo(projectRoot, message.dynamicConfigPath),
  };
}

/** Whether the project can resolve `expo/config`, which the loader requires from it. */
function resolvesExpoConfig(projectRoot: string): boolean {
  try {
    createRequire(path.join(projectRoot, 'package.json')).resolve('expo/config');
    return true;
  } catch {
    return false;
  }
}

/** ncc emits the CLI in build/cli and the loader in build/configLoader. */
function configLoaderPath(): string {
  return path.join(__dirname, '..', 'configLoader', 'index.js');
}

interface LoaderRun {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  /** What the child sent over IPC, joined. */
  message: string;
  timedOut: boolean;
  spawnError: NodeJS.ErrnoException | null;
}

function spawnLoaderAsync(
  args: string[],
  { cwd, env, timeoutMs }: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<LoaderRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    const chunks: string[] = [];
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();
    const settle = (run: Omit<LoaderRun, 'stderr' | 'message' | 'timedOut'>) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ...run, stderr, message: chunks.join(''), timedOut });
    };
    child.on('message', (message) => {
      chunks.push(typeof message === 'string' ? message : JSON.stringify(message));
    });
    child.stderr?.on('data', (data: Buffer | string) => {
      stderr += data.toString();
    });
    child.on('error', (error: NodeJS.ErrnoException) =>
      settle({ exitCode: null, signal: null, spawnError: error })
    );
    child.on('close', (exitCode, signal) => settle({ exitCode, signal, spawnError: null }));
  });
}

function parseMessage(message: string): ConfigLoaderMessage | null {
  if (!message.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(message);
    return parsed && typeof parsed === 'object' && parsed.exp && typeof parsed.exp === 'object'
      ? (parsed as ConfigLoaderMessage)
      : null;
  } catch {
    return null;
  }
}

/** The last line a failing evaluation wrote, which is where a thrown config says why. */
function lastLine(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !/^\s*at\s/.test(line));
  return lines[lines.length - 1] ?? '';
}

function relativeTo(projectRoot: string, file: string | null): string | null {
  return file ? path.relative(projectRoot, file) || path.basename(file) : null;
}
