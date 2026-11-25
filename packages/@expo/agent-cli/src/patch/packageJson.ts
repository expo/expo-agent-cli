import fs from 'fs';

/** A change to a `package.json`, applied to its parsed object. */
export type PackageJsonEdit = (pkg: Record<string, any>) => void;

/**
 * Apply edits to a `package.json` in one write, with the file's own indent and key order. Does not
 * write when there is no edit.
 */
export async function editPackageJsonAsync(file: string, edits: PackageJsonEdit[]): Promise<void> {
  if (!edits.length) {
    return;
  }
  const text = await fs.promises.readFile(file, 'utf8');
  const pkg = JSON.parse(text);
  for (const edit of edits) {
    edit(pkg);
  }
  const indent = /^[ \t]+/m.exec(text)?.[0] ?? '  ';
  await fs.promises.writeFile(file, `${JSON.stringify(pkg, null, indent)}\n`);
}
