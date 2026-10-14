import { nextFence } from '../markdownFence';

function fenceStates(lines: string[]): (string | null)[] {
  let fence: string | null = null;
  return lines.map((line) => (fence = nextFence(line, fence)));
}

describe(nextFence, () => {
  it('opens on a marker with an info string and closes on a bare marker', () => {
    expect(fenceStates(['```ts', 'code', '```', 'prose'])).toEqual(['```', '```', null, null]);
  });

  it('keeps a block open on a marker with text after it', () => {
    expect(fenceStates(['```markdown', '```ts', '# not a heading', '```'])).toEqual([
      '```',
      '```',
      '```',
      null,
    ]);
  });

  it('needs the same character and at least the same length to close', () => {
    expect(fenceStates(['````', '```', '~~~~', '````'])).toEqual(['````', '````', '````', null]);
  });

  it('ignores a marker indented four spaces', () => {
    expect(fenceStates(['    ```', 'prose'])).toEqual([null, null]);
  });
});
