import fs from 'node:fs';
import path from 'node:path';

/**
 * Stop the e2e run before it starts when the bundle is missing or older than `src/`.
 *
 * Every e2e test runs `bin/cli.js`, which loads `build/cli/index.js`, not `src/`. After an edit to
 * `src/` and no `bun run build`, the suite tests the old code and its result says nothing about the
 * edit. The rule is the one `.claude/skills/verify/verify.mjs` uses for its `run` step.
 */
const packageRoot = path.resolve(__dirname, '..');
const bundle = path.join(packageRoot, 'build/cli/index.js');

function newestSourceMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== '__mocks__') {
        newest = Math.max(newest, newestSourceMtime(full));
      }
    } else if (/\.(ts|tsx|json)$/.test(entry.name)) {
      newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  }
  return newest;
}

export default function buildGuard(): void {
  if (!fs.existsSync(bundle)) {
    throw new Error(
      `e2e runs the bundle, and ${bundle} does not exist. Run "bun run build" first.`
    );
  }
  if (newestSourceMtime(path.join(packageRoot, 'src')) > fs.statSync(bundle).mtimeMs) {
    throw new Error(
      `e2e runs the bundle, and ${bundle} is older than src/. Run "bun run build" first.`
    );
  }
}
