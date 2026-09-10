export const CLAUDE_VERSION = '2.1.267';
export const CLAUDE_MODEL = 'claude-sonnet-5';
/** @param {NodeJS.ProcessEnv} env @param {string} platform */
export function prerequisiteReason(env = process.env, platform = process.platform) {
  if (env.AGENT_CLI_TIER2 !== '1')
    return 'Tier2 skipped: set AGENT_CLI_TIER2=1 to opt into a paid Claude run';
  if (!env.ANTHROPIC_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN)
    return 'Tier2 skipped: ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is missing';
  if (platform === 'win32')
    return 'Tier2 skipped: this file-backed process harness requires POSIX process groups';
  return null;
}
