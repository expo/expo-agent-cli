// @ref llp/0001-agentic-cli-on-expo-cli.rfc.md §Constraints
// The child process `evaluateExpoConfigAsync` runs: it loads the env files the app would see
// through `@expo/env`, then evaluates the config with the project's own `expo/config`, and
// answers over IPC so nothing the config prints can reach the caller's stdout. The shape is
// `@expo/fingerprint`'s ExpoConfigLoader (expo/expo#48839).
import { consumeConfigEnvMode, loadProjectEnv } from '@expo/env';
import { createRequire } from 'module';
import path from 'path';

const USAGE =
  'Usage: configLoader <projectRoot> --mode <development|production> [--public] [--skip-plugins]';

/** What the loader sends back: the evaluated config and the files it came from. */
export interface ConfigLoaderMessage {
  exp: Record<string, any>;
  staticConfigPath: string | null;
  dynamicConfigPath: string | null;
}

function run(args: string[]): ConfigLoaderMessage {
  const projectRoot = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : null;
  const modeIndex = args.indexOf('--mode');
  const mode = modeIndex >= 0 ? args[modeIndex + 1] : undefined;
  if (projectRoot == null || (mode !== 'development' && mode !== 'production')) {
    throw new Error(USAGE);
  }

  consumeConfigEnvMode();
  (globalThis as { __DEV__?: boolean }).__DEV__ = mode === 'development';
  loadProjectEnv(projectRoot, { mode });

  // The project's copy, resolved from the project: the SDK's own reading of its config.
  const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
  const { getConfig } = projectRequire('expo/config') as typeof import('@expo/config');
  const config = getConfig(projectRoot, {
    skipSDKVersionRequirement: true,
    isPublicConfig: args.includes('--public'),
    skipPlugins: args.includes('--skip-plugins'),
  });
  return {
    exp: config.exp,
    staticConfigPath: config.staticConfigPath,
    dynamicConfigPath: config.dynamicConfigPath,
  };
}

if (require.main === module) {
  try {
    const message = JSON.stringify(run(process.argv.slice(2)));
    if (process.send) {
      process.send(message, () => process.disconnect());
    } else {
      process.stdout.write(`${message}\n`);
    }
  } catch (error: unknown) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  }
}
