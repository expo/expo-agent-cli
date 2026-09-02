import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function readAliasVersion(from = import.meta.url): string {
  const fromPath = from.startsWith('file:') ? fileURLToPath(from) : from;
  let packageJsonPath: string;
  try {
    packageJsonPath = path.join(path.dirname(fs.realpathSync(fromPath)), '..', 'package.json');
  } catch {
    throw new Error(`expo-agent-cli: cannot resolve package.json from ${fromPath}`);
  }

  let parsed: { version?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`expo-agent-cli: cannot read version from ${packageJsonPath} (${reason})`);
  }

  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error(`expo-agent-cli: missing version in ${packageJsonPath}`);
  }
  return parsed.version;
}
