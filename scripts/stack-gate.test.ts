import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { type GateInput, type GateIo, LLP_DIR, OUTPUTS, decide, onlyLlp } from './stack-gate';

const input: GateInput = {
  repo: 'o/r',
  prNumber: 1,
  headRef: 'feature',
  headSha: 'aaa',
  action: 'synchronize',
  waitSeconds: 0,
  apiUrl: 'https://api',
  token: null,
};

type Route = (path: string) => unknown;

function fakeIo(route: Route): GateIo & { paths: string[] } {
  const paths: string[] = [];
  const fakeFetch = async (url: string | URL | Request) => {
    const path = String(url).replace('https://api/repos/o/r', '');
    paths.push(path);
    const body = route(path);
    return typeof body === 'number'
      ? new Response('{}', { status: body })
      : new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetch: fakeFetch as typeof fetch, sleep: async () => {}, paths };
}

const llpFiles = [{ filename: `${LLP_DIR}0015-a.rfc.md` }, { filename: `${LLP_DIR}0027-b.rfc.md` }];

function stack(
  above: unknown[],
  files: unknown,
  compare = 'diverged',
  base = 'main',
  head = 'aaa'
): Route {
  return (path) => {
    if (path.startsWith('/pulls?')) return above;
    if (path.startsWith('/compare/')) return { status: compare };
    if (path.startsWith('/pulls/1/files')) return files;
    if (path === '/pulls/1') {
      return { head: { sha: head }, base: { ref: base, repo: { default_branch: 'main' } } };
    }
    throw new Error(`unexpected ${path}`);
  };
}

describe('onlyLlp', () => {
  it.each([
    [[`${LLP_DIR}0015-a.rfc.md`, `${LLP_DIR}0027-b.rfc.md`], true],
    [[`${LLP_DIR}0015-a.rfc.md`, 'packages/@expo/agent-cli/src/index.ts'], false],
    [['packages/@expo/agent-cli/AGENTS.md'], false],
    [['packages/@expo/agent-cli/llp-notes.md'], false],
    [[], false],
  ])('%j -> %p', (files, expected) => {
    expect(onlyLlp(files)).toBe(expected);
  });
});

describe('decide', () => {
  it('runs nothing when a PR above holds the head commit, even for an LLP-only PR', async () => {
    const io = fakeIo(stack([{ number: 2, head: { ref: 'up', sha: 'bbb' } }], llpFiles, 'ahead'));
    expect(await decide(input, io)).toEqual({
      scope: 'none',
      reason: 'Covered by #2: its head holds this commit. CI runs there.',
    });
    expect(io.paths.some((path) => path.includes('/files'))).toBe(false);
  });

  it('runs the LLP scope when every file is an LLP', async () => {
    expect(await decide(input, fakeIo(stack([], llpFiles)))).toEqual({
      scope: 'llp',
      reason: `No open PR is based on this branch. All 2 changed paths are under ${LLP_DIR}: only the jobs that read it run.`,
    });
  });

  it('runs everything for an LLP-only stack layer, whose files omit the layers below', async () => {
    expect(await decide(input, fakeIo(stack([], llpFiles, 'diverged', 'feature')))).toEqual({
      scope: 'all',
      reason:
        'No open PR is based on this branch. Based on feature, not the default branch. CI runs here.',
    });
  });

  it('runs everything when the PR head moved past the event commit', async () => {
    expect(await decide(input, fakeIo(stack([], llpFiles, 'diverged', 'main', 'bbb')))).toEqual({
      scope: 'all',
      reason:
        'No open PR is based on this branch. The PR head bbb is not the event commit aaa. CI runs here.',
    });
  });

  it('runs everything when the event names no head commit', async () => {
    const decision = await decide({ ...input, headSha: null }, fakeIo(stack([], llpFiles)));
    expect(decision.scope).toBe('all');
  });

  it('runs everything when a file moves into llp/ from outside it', async () => {
    const renamed = [
      { filename: `${LLP_DIR}foo.md`, previous_filename: 'packages/@expo/agent-cli/src/foo.ts' },
    ];
    expect((await decide(input, fakeIo(stack([], renamed)))).scope).toBe('all');
  });

  it('runs everything when a PR above does not hold the head commit and a file is code', async () => {
    const io = fakeIo(
      stack([{ number: 2, head: { ref: 'up', sha: 'bbb' } }], [{ filename: 'src/x.ts' }])
    );
    expect(await decide(input, io)).toEqual({
      scope: 'all',
      reason: '#2 based on this branch, but none holds this commit. CI runs here.',
    });
  });

  it('reads every page of files', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `${LLP_DIR}${i}.md` }));
    const io = fakeIo((path) => {
      if (path.startsWith('/pulls?')) return [];
      if (path === '/pulls/1') {
        return { head: { sha: 'aaa' }, base: { ref: 'main', repo: { default_branch: 'main' } } };
      }
      return path.endsWith('page=1') ? page1 : [{ filename: 'src/x.ts' }];
    });
    expect((await decide(input, io)).scope).toBe('all');
    expect(io.paths.some((path) => path.includes('page=2'))).toBe(true);
  });

  it('runs everything when GitHub refuses', async () => {
    const decision = await decide(input, fakeIo(stack([], 403)));
    expect(decision).toEqual({
      scope: 'all',
      reason: 'Could not read GitHub (403 on /pulls/1/files?per_page=100&page=1). CI runs here.',
    });
  });
});

describe('workflow conditions', () => {
  const root = path.join(import.meta.dir, '..');
  const GATE = /needs\.stack\.outputs\.\w+\s*[!=]=\s*'\w+'/g;
  // GitHub jobs compare with != so an empty output runs them; EAS relies on `|| echo true`.
  const expected: Record<string, Record<string, string[]>> = {
    '.github/workflows/agent-cli.yml': {
      'tier0-linux': ["needs.stack.outputs.run == 'true'"],
      'tier0-e2e': ["needs.stack.outputs.full != 'false'"],
      'tier0-e2e-macos': ["needs.stack.outputs.full != 'false'"],
      'tier0-windows': ["needs.stack.outputs.full != 'false'"],
      'tier1-agent-eval': ["needs.stack.outputs.full != 'false'"],
    },
    '.github/workflows/format.yml': { oxfmt: ["needs.stack.outputs.run == 'true'"] },
    'packages/@expo/agent-cli/.eas/workflows/agent-cli-cloud-e2e.yml': {
      'cloud-e2e-expo-go-ios': ["needs.stack.outputs.full == 'true'"],
      'cloud-e2e-expo-go-android': ["needs.stack.outputs.full == 'true'"],
      'cloud-e2e-dev-build-ios': ["needs.stack.outputs.full == 'true'"],
      'cloud-e2e-dev-build-android': ["needs.stack.outputs.full == 'true'"],
    },
  };

  it.each(Object.keys(expected))('%s gates each job on the stack outputs', (file) => {
    const workflow = Bun.YAML.parse(readFileSync(path.join(root, file), 'utf8')) as {
      jobs: Record<string, { if?: string }>;
    };
    const gates = Object.fromEntries(
      Object.entries(workflow.jobs)
        .map(([job, { if: condition }]) => [job, String(condition ?? '').match(GATE) ?? []])
        .filter(([, found]) => found.length > 0)
    );
    expect(gates).toEqual(expected[file]);
  });

  it('EAS runs every job when the gate fails', () => {
    const eas = readFileSync(
      path.join(root, 'packages/@expo/agent-cli/.eas/workflows/agent-cli-cloud-e2e.yml'),
      'utf8'
    );
    expect(eas).toContain('set-output full "$(bun scripts/stack-gate.ts || echo true)"');
  });
});

describe('outputs', () => {
  // EAS reads stdout as `full`; GitHub jobs read `run` and `full` from GITHUB_OUTPUT.
  it('map each scope to the jobs it runs', () => {
    expect(OUTPUTS).toEqual({
      none: { run: false, full: false },
      llp: { run: true, full: false },
      all: { run: true, full: true },
    });
  });

  it('print full and write run and full for an LLP-only PR', async () => {
    const route = stack([], llpFiles);
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        const body = route((url.pathname + url.search).replace('/repos/o/r', ''));
        return Response.json(body);
      },
    });
    const output = path.join(mkdtempSync(path.join(tmpdir(), 'stack-gate-')), 'output');
    try {
      const child = Bun.spawn(['bun', path.join(import.meta.dir, 'stack-gate.ts')], {
        env: {
          PATH: process.env.PATH,
          GITHUB_OUTPUT: output,
          GITHUB_API_URL: server.url.origin,
          GITHUB_REPOSITORY: 'o/r',
          PR_NUMBER: '1',
          PR_HEAD_REF: 'feature',
          PR_HEAD_SHA: 'aaa',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await new Response(child.stdout).text()).toBe('false\n');
      expect(await child.exited).toBe(0);
      expect(readFileSync(output, 'utf8')).toBe('run=true\nfull=false\n');
    } finally {
      server.stop(true);
    }
  });
});
