import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const SOURCE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
// Tab, LF and CR are text. Any other C0 byte, or DEL, makes ripgrep and git read the file as binary
// or hides it from an exact-string edit.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function controlBytes(): string[] {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((file) => SOURCE.test(file));
  return files.flatMap((file) =>
    readFileSync(path.join(ROOT, file), 'utf8')
      .split('\n')
      .flatMap((line, index) => (CONTROL.test(line) ? [`${file}:${index + 1}`] : []))
  );
}

describe('source files', () => {
  it('hold no raw control bytes', () => {
    // Write the byte as an escape, such as \u0000 or \u001b.
    expect(controlBytes()).toEqual([]);
  });
});
