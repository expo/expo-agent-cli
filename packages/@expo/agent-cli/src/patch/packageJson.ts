import fs from 'fs';

/** A change to a `package.json`, applied to its parsed object. */
export type PackageJsonEdit = (pkg: Record<string, any>) => void;

/**
 * Apply edits to a `package.json` in one write, with the file's own indent and key order. Does not
 * write when there is no edit.
 */
export function editPackageJson(file: string, edits: PackageJsonEdit[]): void {
  if (!edits.length) {
    return;
  }
  const text = fs.readFileSync(file, 'utf8');
  const pkg = JSON.parse(text);
  for (const edit of edits) {
    edit(pkg);
  }
  const indent = /^[ \t]+/m.exec(text)?.[0] ?? '  ';
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, indent)}\n`);
}
