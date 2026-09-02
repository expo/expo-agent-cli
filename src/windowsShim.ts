export type SpawnTarget = {
  command: string;
  args: string[];
  shell: boolean;
};

const BATCH_FILE = /\.(cmd|bat)$/i;
const CMD_META_CHARS = /([()[\]%!^"`<>&|;, *?])/g;

/**
 * Node rejects spawn of `.cmd` without a shell after CVE-2024-27980. Quote and
 * caret-escape args so cmd.exe cannot treat user argv as syntax.
 */
export function resolveSpawnTarget(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform
): SpawnTarget {
  if (platform !== 'win32' || !BATCH_FILE.test(command)) {
    return { command, args, shell: false };
  }

  return {
    command: `"${command}"`,
    args: args.map(escapeArgumentForCmd),
    shell: true,
  };
}

function escapeArgumentForCmd(value: string): string {
  const forProgram = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  return `"${forProgram}"`.replace(CMD_META_CHARS, '^$1');
}
