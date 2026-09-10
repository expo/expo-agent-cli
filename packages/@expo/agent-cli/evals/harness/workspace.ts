import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const cliBin = path.join(packageRoot, 'bin/cli.js');
export const artifactRoot = path.resolve(
  process.env.AGENT_CLI_EVAL_ARTIFACTS ?? path.join(packageRoot, 'evals/.artifacts')
);

export function copyWorkspace(fixture: string, linkDependencies = false) {
  const source = path.resolve(packageRoot, fixture);
  if (!source.startsWith(`${packageRoot}${path.sep}`) || !fs.statSync(source).isDirectory()) {
    throw new Error(`Invalid fixture: ${fixture}`);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-eval-'));
  try {
    fs.cpSync(source, root, {
      recursive: true,
      dereference: true,
      filter: (p) =>
        path.basename(p) !== '.git' &&
        !(linkDependencies && p === path.join(source, 'node_modules')),
    });
    if (linkDependencies) {
      const dependencies = path.join(source, 'node_modules');
      if (!fs.existsSync(path.join(dependencies, 'expo/package.json')))
        throw new Error('Real fixture dependencies are missing; run bun install');
      fs.symlinkSync(
        dependencies,
        path.join(root, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
    }
    return root;
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Hash project-owned files, including generated files, without following skill links. */
export function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (entry.isSymbolicLink()) files[relative] = `link:${fs.readlinkSync(full)}`;
      else if (entry.isDirectory()) walk(full);
      // Live dev-server locks can create Unix sockets. They are not project file contents.
      else if (entry.isFile())
        files[relative] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  }
  walk(root);
  return files;
}
