import { parsePage, searchRegex, searchTerms, type DocPage } from '../search';

const camera: DocPage = {
  path: 'versions/v57.0.0/sdk/camera',
  content: [
    '---',
    'title: Camera',
    'description: barcode everywhere in the frontmatter',
    '---',
    '# Camera',
    '',
    'A React component that renders a preview of the camera.',
    '',
    '## Barcode scanning',
    '',
    'Pass `barcodeScannerSettings` to enable barcode scanning.',
    'Call launchScanner() to open the scanner.',
  ].join('\n'),
};

const overview: DocPage = {
  path: 'guides/overview',
  content: [
    '---',
    'title: Overview',
    '---',
    '# Overview',
    '',
    'The camera is mentioned once.',
  ].join('\n'),
};

const barcodeGuide: DocPage = {
  path: 'guides/barcode',
  content: [
    '---',
    'title: Barcode scanning guide',
    '---',
    '# Barcode scanning guide',
    '',
    'Use the camera for barcode scanning.',
  ].join('\n'),
};

const noFrontmatter: DocPage = {
  path: 'index',
  content: '# Home\n\n## Get started\n\nInstall the camera package.',
};

const pages = [camera, overview, barcodeGuide, noFrontmatter];

describe(parsePage, () => {
  it('reads the title from the frontmatter, and numbers lines as the file does', () => {
    const page = parsePage(camera);
    expect(page.title).toBe('Camera');
    expect(page.slug).toBe('sdk/camera');
    expect(page.body[0]).toEqual({ number: 5, text: '# Camera', heading: true });
  });

  it('does not read a # line inside a code block as a heading', () => {
    const page: DocPage = {
      path: 'guides/install',
      content: [
        '# Install',
        '',
        '## Steps',
        '',
        '```sh',
        '# install the CLI',
        'npm i',
        '```',
        'Done.',
      ].join('\n'),
    };
    expect(
      parsePage(page)
        .body.filter((line) => line.heading)
        .map((line) => line.text)
    ).toEqual(['# Install', '## Steps']);
    expect(searchRegex([page], /npm i/, 5)[0]!.heading).toBe('Steps');
  });

  it('keeps a block open past a fence that carries an info string', () => {
    const page: DocPage = {
      path: 'guides/nested',
      content: [
        '# Nested',
        '````markdown',
        '```ts',
        '# Not a heading',
        '```',
        '````',
        '## Real heading',
        'After the block.',
      ].join('\n'),
    };
    expect(
      parsePage(page)
        .body.filter((line) => line.heading)
        .map((line) => line.text)
    ).toEqual(['# Nested', '## Real heading']);
  });

  it('falls back to the first heading for a page without frontmatter', () => {
    expect(parsePage(noFrontmatter).title).toBe('Home');
  });
});

describe(searchTerms, () => {
  it('needs every term on the page', () => {
    const hits = searchTerms(pages, 'barcode scanning', 10);
    expect(hits.map((hit) => hit.path).sort()).toEqual(['guides/barcode', camera.path]);
  });

  it('ranks a title match over a heading match', () => {
    const hits = searchTerms(pages, 'barcode scanning', 10);
    expect(hits[0]!.path).toBe('guides/barcode');
  });

  it('ranks a title over a slug over a body mention', () => {
    const hits = searchTerms(pages, 'camera', 10);
    expect(hits[0]!.path).toBe(camera.path);
    expect(hits.at(-1)!.path).toMatch(/^(guides\/overview|index)$/);
  });

  it('points at the first line with the highest-weight match, and its heading', () => {
    const [hit] = searchTerms([camera], 'barcode', 10);
    expect(hit).toEqual({
      path: camera.path,
      title: 'Camera',
      heading: 'Barcode scanning',
      line: 9,
      snippet: '## Barcode scanning',
    });
  });

  it('reports the heading above a body line', () => {
    const [hit] = searchTerms([noFrontmatter], 'install', 10);
    expect(hit).toMatchObject({ heading: 'Get started', line: 5 });
  });

  it('ignores the frontmatter for body matches', () => {
    expect(searchTerms([camera], 'everywhere', 10)).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(searchTerms([camera], 'LAUNCHSCANNER', 10)).toHaveLength(1);
  });

  it('keeps to the limit', () => {
    expect(searchTerms(pages, 'camera', 2)).toHaveLength(2);
  });

  it('finds nothing for an empty query', () => {
    expect(searchTerms(pages, '   ', 10)).toEqual([]);
  });
});

describe(searchRegex, () => {
  it('returns one hit per matching line, by path then line', () => {
    const hits = searchRegex(pages, /barcode/i, 10);
    expect(hits.map((hit) => [hit.path, hit.line])).toEqual([
      ['guides/barcode', 4],
      ['guides/barcode', 6],
      [camera.path, 9],
      [camera.path, 11],
    ]);
  });

  it('matches the pattern as a regular expression', () => {
    const [hit] = searchRegex(pages, /launchScanner\(/i, 10);
    expect(hit).toMatchObject({ line: 12, heading: 'Barcode scanning' });
  });

  it('keeps to the limit', () => {
    expect(searchRegex(pages, /./, 3)).toHaveLength(3);
  });
});
