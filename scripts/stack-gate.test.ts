import { describe, expect, it } from 'bun:test';

import { decide, inputFromEnv, type GateInput, type GateIo } from './stack-gate';

const input: GateInput = {
  repo: 'expo/expo-agent-cli',
  prNumber: 160,
  headRef: 'kudo/ci-stack-top',
  headSha: 'aaa',
  action: 'synchronize',
  waitSeconds: 60,
  apiUrl: 'https://api.github.com',
  token: null,
};

type Route = (url: URL, init?: RequestInit) => unknown | Response;

function io(
  routes: Record<string, Route | Route[]>
): GateIo & { slept: number[]; calls: string[] } {
  const slept: number[] = [];
  const calls: string[] = [];
  const fetchImpl = async (resource: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(resource));
    const key = url.pathname.replace('/repos/expo/expo-agent-cli', '') + url.search;
    calls.push(key);
    const route = routes[key];
    if (route === undefined) {
      return new Response('not found', { status: 404 });
    }
    const handler = Array.isArray(route) ? (route.shift() ?? route[0]) : route;
    const body = handler(url, init);
    return body instanceof Response ? body : Response.json(body);
  };
  return {
    fetch: fetchImpl as typeof fetch,
    sleep: async (ms) => {
      slept.push(ms);
    },
    slept,
    calls,
  };
}

const basedOnHead = '/pulls?state=open&base=kudo%2Fci-stack-top&per_page=100';
const above = { number: 161, head: { ref: 'kudo/ci-stack-top-test', sha: 'bbb' } };

describe('Deciding whether a PR runs CI', () => {
  it('should run when no open PR is based on this branch', async () => {
    const decision = await decide(input, io({ [basedOnHead]: () => [] }));
    expect(decision).toEqual({
      run: true,
      reason: 'No open PR is based on this branch. CI runs here.',
    });
  });

  it('should skip when a PR above holds this commit', async () => {
    const decision = await decide(
      input,
      io({ [basedOnHead]: () => [above], '/compare/aaa...bbb': () => ({ status: 'ahead' }) })
    );
    expect(decision).toEqual({
      run: false,
      reason: 'Covered by #161: its head holds this commit. CI runs there.',
    });
  });

  it('should skip when the PR above has the same head', async () => {
    const decision = await decide(
      input,
      io({ [basedOnHead]: () => [above], '/compare/aaa...bbb': () => ({ status: 'identical' }) })
    );
    expect(decision.run).toBe(false);
  });

  it('should run when the PR above does not hold this commit', async () => {
    const decision = await decide(
      input,
      io({ [basedOnHead]: () => [above], '/compare/aaa...bbb': () => ({ status: 'diverged' }) })
    );
    expect(decision).toEqual({
      run: true,
      reason: '#161 based on this branch, but none holds this commit. CI runs here.',
    });
  });

  it('should pick the PR above that holds the commit when several are based on this branch', async () => {
    const other = { number: 170, head: { ref: 'other', sha: 'ccc' } };
    const decision = await decide(
      input,
      io({
        [basedOnHead]: () => [other, above],
        '/compare/aaa...ccc': () => ({ status: 'diverged' }),
        '/compare/aaa...bbb': () => ({ status: 'ahead' }),
      })
    );
    expect(decision.run).toBe(false);
    expect(decision.reason).toContain('#161');
  });

  it('should load the head from the PR when the caller gives none', async () => {
    const gate = io({
      '/pulls/160': () => ({ number: 160, head: { ref: 'kudo/ci-stack-top', sha: 'aaa' } }),
      [basedOnHead]: () => [],
    });
    const decision = await decide({ ...input, headRef: null, headSha: null }, gate);
    expect(decision.run).toBe(true);
    expect(gate.calls[0]).toBe('/pulls/160');
  });

  it('should wait for the PR above on an opened event and then skip', async () => {
    const gate = io({
      [basedOnHead]: [() => [], () => [], () => [above]],
      '/compare/aaa...bbb': () => ({ status: 'ahead' }),
    });
    const decision = await decide({ ...input, action: 'opened' }, gate);
    expect(decision.run).toBe(false);
    expect(gate.slept).toEqual([10_000, 10_000]);
  });

  it('should stop waiting at the deadline and run', async () => {
    const gate = io({ [basedOnHead]: () => [] });
    const decision = await decide({ ...input, action: 'opened', waitSeconds: 30 }, gate);
    expect(decision.run).toBe(true);
    expect(gate.slept).toEqual([10_000, 10_000, 10_000]);
  });

  it('should not wait on a synchronize event', async () => {
    const gate = io({ [basedOnHead]: () => [] });
    await decide(input, gate);
    expect(gate.slept).toEqual([]);
  });

  it('should send the token when one is given', async () => {
    let authorization: string | undefined;
    const gate = io({
      [basedOnHead]: (_url, init) => {
        authorization = (init?.headers as Record<string, string>).Authorization;
        return [];
      },
    });
    await decide({ ...input, token: 'secret' }, gate);
    expect(authorization).toBe('Bearer secret');
  });

  it('should run when GitHub answers with an error', async () => {
    const decision = await decide(
      input,
      io({ [basedOnHead]: () => new Response('rate limited', { status: 403 }) })
    );
    expect(decision).toEqual({
      run: true,
      reason: `Could not read GitHub (403 on ${basedOnHead}). CI runs here.`,
    });
  });

  it('should run when the request itself fails', async () => {
    const gate = io({});
    gate.fetch = (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch;
    const decision = await decide(input, gate);
    expect(decision).toEqual({
      run: true,
      reason: 'Could not read GitHub (ECONNRESET). CI runs here.',
    });
  });
});

describe('Reading the gate input from the environment', () => {
  const env = {
    GITHUB_REPOSITORY: 'expo/expo-agent-cli',
    PR_NUMBER: '160',
    PR_HEAD_REF: 'kudo/ci-stack-top',
    PR_HEAD_SHA: 'aaa',
    EVENT_ACTION: 'opened',
    GITHUB_TOKEN: 'secret',
  };

  it('should read every field', () => {
    expect(inputFromEnv(env)).toEqual({ ...input, action: 'opened', token: 'secret' });
  });

  it('should return null without a PR number', () => {
    expect(inputFromEnv({ ...env, PR_NUMBER: '' })).toBeNull();
    expect(inputFromEnv({ ...env, PR_NUMBER: undefined })).toBeNull();
  });

  it('should return null without a repository', () => {
    expect(inputFromEnv({ ...env, GITHUB_REPOSITORY: undefined })).toBeNull();
  });

  it('should default the wait, the API URL, and the missing head', () => {
    const parsed = inputFromEnv({ GITHUB_REPOSITORY: 'o/r', PR_NUMBER: '7' });
    expect(parsed).toEqual({
      repo: 'o/r',
      prNumber: 7,
      headRef: null,
      headSha: null,
      action: '',
      waitSeconds: 60,
      apiUrl: 'https://api.github.com',
      token: null,
    });
  });
});
