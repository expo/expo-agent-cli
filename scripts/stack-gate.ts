// Decides whether a PR runs CI. A PR skips only when an open PR based on its head branch
// already holds its head commit; that PR's CI covers this one. Anything else runs.

export type GateInput = {
  repo: string;
  prNumber: number;
  headRef: string | null;
  headSha: string | null;
  action: string;
  waitSeconds: number;
  apiUrl: string;
  token: string | null;
};

export type GateDecision = { run: boolean; reason: string };

export type GateIo = {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
};

type Pull = { number: number; head: { ref: string; sha: string } };

const POLL_MS = 10_000;

export function inputFromEnv(env: NodeJS.ProcessEnv): GateInput | null {
  const prNumber = Number(env.PR_NUMBER);
  if (!env.GITHUB_REPOSITORY || !Number.isInteger(prNumber) || prNumber <= 0) {
    return null;
  }
  return {
    repo: env.GITHUB_REPOSITORY,
    prNumber,
    headRef: env.PR_HEAD_REF || null,
    headSha: env.PR_HEAD_SHA || null,
    action: env.EVENT_ACTION ?? '',
    waitSeconds: Number(env.STACK_GATE_WAIT_SECONDS ?? 60),
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    token: env.GITHUB_TOKEN || null,
  };
}

export async function decide(input: GateInput, io: GateIo): Promise<GateDecision> {
  try {
    return await decideOrThrow(input, io);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { run: true, reason: `Could not read GitHub (${message}). CI runs here.` };
  }
}

async function decideOrThrow(input: GateInput, io: GateIo): Promise<GateDecision> {
  const api = (path: string) => github(input, io, path);
  let { headRef, headSha } = input;
  if (!headRef || !headSha) {
    const pull = (await api(`/pulls/${input.prNumber}`)) as Pull;
    headRef = pull.head.ref;
    headSha = pull.head.sha;
  }

  // gh stack submit opens the PR above a few seconds after this one, so a fresh PR waits for it.
  const deadline = input.action === 'opened' ? input.waitSeconds * 1000 : 0;
  let waited = 0;
  for (;;) {
    const above = (await api(
      `/pulls?state=open&base=${encodeURIComponent(headRef)}&per_page=100`
    )) as Pull[];
    if (above.length > 0) {
      for (const pull of above) {
        const comparison = (await api(`/compare/${headSha}...${pull.head.sha}`)) as {
          status: string;
        };
        if (comparison.status === 'ahead' || comparison.status === 'identical') {
          return {
            run: false,
            reason: `Covered by #${pull.number}: its head holds this commit. CI runs there.`,
          };
        }
      }
      const numbers = above.map((pull) => `#${pull.number}`).join(', ');
      return {
        run: true,
        reason: `${numbers} based on this branch, but none holds this commit. CI runs here.`,
      };
    }
    if (waited >= deadline) {
      return { run: true, reason: 'No open PR is based on this branch. CI runs here.' };
    }
    await io.sleep(POLL_MS);
    waited += POLL_MS;
  }
}

async function github(input: GateInput, io: GateIo, path: string): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'expo-agent-cli-stack-gate',
  };
  if (input.token) {
    headers.Authorization = `Bearer ${input.token}`;
  }
  const response = await io.fetch(`${input.apiUrl}/repos/${input.repo}${path}`, { headers });
  if (!response.ok) {
    throw new Error(`${response.status} on ${path}`);
  }
  return await response.json();
}

async function main(): Promise<void> {
  const input = inputFromEnv(process.env);
  const decision = input
    ? await decide(input, { fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })
    : { run: true, reason: 'Not a pull request. CI runs.' };
  console.error(decision.reason);
  console.log(String(decision.run));
  const { appendFile } = await import('node:fs/promises');
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `run=${decision.run}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${decision.reason}\n`);
  }
}

if (import.meta.main) {
  await main();
}
