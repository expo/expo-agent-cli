// @ref llp/0030-one-device-per-worktree.rfc.md §Contracts every verb honors
import fs from 'fs';
import path from 'path';

// This suite reads the repository, which the suite-wide memfs mock has none of.
vi.unmock('fs');
vi.unmock('node:fs');

const MODULE_DIR = path.resolve(__dirname, '..');
const FORBIDDEN = ['navigate', 'smoke', 'dev', 'installedApp'];
const MAX_FILE_LINES = 250;
const MAX_FUNCTION_LINES = 60;

const sources = fs
  .readdirSync(MODULE_DIR)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => ({ name, text: fs.readFileSync(path.join(MODULE_DIR, name), 'utf8') }));

describe('src/deviceBinding/', () => {
  // deviceBinding-imports-nothing-from-verbs (Contract 10)
  it('imports nothing from navigate, smoke, dev or installedApp', () => {
    const offending = sources.flatMap(({ name, text }) =>
      [...text.matchAll(/from '([^']+)'/g)]
        .map((match) => match[1]!)
        .filter((spec) =>
          FORBIDDEN.some((verb) => spec.includes(`/${verb}/`) || spec.endsWith(`/${verb}`))
        )
        .map((spec) => `${name}: ${spec}`)
    );
    expect(offending).toEqual([]);
  });

  it(`keeps every file under ${MAX_FILE_LINES} lines`, () => {
    const over = sources
      .map(({ name, text }) => ({ name, lines: text.split(/\r?\n/).length }))
      .filter(({ lines }) => lines >= MAX_FILE_LINES);
    expect(over).toEqual([]);
  });

  it(`keeps every function under ${MAX_FUNCTION_LINES} lines`, () => {
    const over: string[] = [];
    for (const { name, text } of sources) {
      const lines = text.split(/\r?\n/);
      lines.forEach((line, index) => {
        const match = /^(?:export )?(?:async )?function (\w+)/.exec(line);
        if (!match) {
          return;
        }
        const end = lines.findIndex((candidate, at) => at > index && candidate === '}');
        const length = (end === -1 ? lines.length : end) - index + 1;
        if (length > MAX_FUNCTION_LINES) {
          over.push(`${name}: ${match[1]} (${length} lines)`);
        }
      });
    }
    expect(over).toEqual([]);
  });
});
