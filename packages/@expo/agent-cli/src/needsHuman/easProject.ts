// @ref llp/0027-everything-on-eas.rfc.md §Check the EAS project before starting the environment
import { parseIntrospectedConfig } from '../config/introspectAsync';
import { easCommandPrefix } from '../utils/easCli';
import { CommandError } from '../utils/errors';
import { resolveExpoCli } from '../utils/expoCli';
import { spawnSubprocessAsync } from '../utils/subprocess';
import { needsHumanError } from './error';

/** Check the evaluated config before starting Metro, building, or detaching a cloud run. */
export async function assertEasProjectConfiguredAsync(projectRoot: string): Promise<void> {
  // Use the project's CLI so dynamic configs and environment-dependent project IDs are respected.
  // `eas project:info` can link a project as part of resolving its context, so it is not this check.
  const cli = resolveExpoCli(projectRoot, ['config', '--json']);
  const result = await spawnSubprocessAsync(cli.command, cli.args, {
    cwd: projectRoot,
    output: 'capture',
    env: { CI: '1' },
    timeoutMs: 30_000,
  });
  let config: { extra?: { eas?: { projectId?: unknown } } };
  try {
    if (result.exitCode !== 0 || result.spawnError || result.timedOut) {
      throw new Error(
        result.spawnError?.message ??
          (result.timedOut
            ? 'config evaluation timed out'
            : result.stderr.trim() || 'expo config failed')
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      // Expo events and user config logging can share stdout with the config object.
      parsed = parseIntrospectedConfig(result.stdout);
    }
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expo config did not return a JSON object');
    }
    config = parsed;
  } catch (cause) {
    const error = new CommandError(
      'EAS_PROJECT_CONFIG_UNREADABLE',
      `Could not check the EAS project before starting: ${cause instanceof Error ? cause.message : String(cause)}. Fix "expo config --json" in this project and retry.`
    );
    error.suggestedCommand = 'npx expo config --json';
    throw error;
  }
  const projectId = config.extra?.eas?.projectId;
  if (typeof projectId === 'string' && projectId.trim()) {
    return;
  }
  throw needsHumanError('eas-project-unlinked', {
    detectedBy: 'preflight',
    message: [
      'This project is not linked to EAS: the evaluated app config has no extra.eas.projectId.',
      'The EAS run was stopped before starting a dev server, native build, or simulator session. An eas.json build profile alone does not link the project.',
      `Link an existing project with "${easCommandPrefix()} init --id <project-id> --non-interactive", or create one with "${easCommandPrefix()} init --account <account-name> --non-interactive", then retry.`,
    ].join('\n'),
  });
}
