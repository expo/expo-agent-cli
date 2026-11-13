// Decides how much CI a PR runs. `none`: an open PR based on its head branch already holds its head
// commit, and that PR's CI covers this one. `llp`: the PR is based on the default branch and every
// changed path is an agent-cli LLP, so only the jobs that read llp/ run. `all`: anything else,
// including anything the gate cannot prove.
//
// Outputs: `run` for the jobs that also run on `llp`, `full` for the rest. stdout is `full`.

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

export type Scope = 'none' | 'llp' | 'all';

export type GateDecision = { scope: Scope; reason: string };

export const OUTPUTS: Record<Scope, { run: boolean; full: boolean }> = {
  none: { run: false, full: false },
  llp: { run: true, full: false },
  all: { run: true, full: true },
};

export type GateIo = {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
};

type Pull = { number: number; head: { ref: string; sha: string } };

type PullBase = { head: { sha: string }; base: { ref: string; repo: { default_branch: string } } };

type StackCover = { kind: 'covered'; by: number } | { kind: 'uncovered'; note: string };

export const LLP_DIR = 'packages/@expo/agent-cli/llp/';

const POLL_MS = 10_000;
const FILES_PER_PAGE = 100;
// GitHub lists at most 3000 files of a PR.
const MAX_FILE_PAGES = 30;

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

export function onlyLlp(files: readonly string[]): boolean {
  return files.length > 0 && files.every((file) => file.startsWith(LLP_DIR));
}

export async function decide(input: GateInput, io: GateIo): Promise<GateDecision> {
  try {
    return await decideOrThrow(input, io);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { scope: 'all', reason: `Could not read GitHub (${message}). CI runs here.` };
  }
}

async function decideOrThrow(input: GateInput, io: GateIo): Promise<GateDecision> {
  const stack = await stackCover(input, io);
  if (stack.kind === 'covered') {
    return {
      scope: 'none',
      reason: `Covered by #${stack.by}: its head holds this commit. CI runs there.`,
    };
  }
  // A stack layer lists only its own files against the layer below, so an LLP-only top layer could
  // hide the code of a lower layer that it covers.
  const { head, base } = (await github(input, io, `/pulls/${input.prNumber}`)) as PullBase;
  // The file list is the PR's as of now; it must be the event's commit.
  if (head.sha !== input.headSha) {
    return {
      scope: 'all',
      reason: `${stack.note} The PR head ${head.sha} is not the event commit ${input.headSha ?? '(none)'}. CI runs here.`,
    };
  }
  if (base.ref !== base.repo.default_branch) {
    return {
      scope: 'all',
      reason: `${stack.note} Based on ${base.ref}, not the default branch. CI runs here.`,
    };
  }
  const paths = await prPaths(input, io);
  if (onlyLlp(paths)) {
    return {
      scope: 'llp',
      reason: `${stack.note} All ${paths.length} changed paths are under ${LLP_DIR}: only the jobs that read it run.`,
    };
  }
  return { scope: 'all', reason: `${stack.note} CI runs here.` };
}

async function stackCover(input: GateInput, io: GateIo): Promise<StackCover> {
  let { headRef, headSha } = input;
  if (!headRef || !headSha) {
    const pull = (await github(input, io, `/pulls/${input.prNumber}`)) as Pull;
    headRef = pull.head.ref;
    headSha = pull.head.sha;
  }

  // gh stack submit opens the PR above a few seconds after this one, so a fresh PR waits for it.
  const deadline = input.action === 'opened' ? input.waitSeconds * 1000 : 0;
  let waited = 0;
  for (;;) {
    const above = (await github(
      input,
      io,
      `/pulls?state=open&base=${encodeURIComponent(headRef)}&per_page=100`
    )) as Pull[];
    if (above.length > 0) {
      for (const pull of above) {
        const comparison = (await github(input, io, `/compare/${headSha}...${pull.head.sha}`)) as {
          status: string;
        };
        if (comparison.status === 'ahead' || comparison.status === 'identical') {
          return { kind: 'covered', by: pull.number };
        }
      }
      const numbers = above.map((pull) => `#${pull.number}`).join(', ');
      return {
        kind: 'uncovered',
        note: `${numbers} based on this branch, but none holds this commit.`,
      };
    }
    if (waited >= deadline) {
      return { kind: 'uncovered', note: 'No open PR is based on this branch.' };
    }
    await io.sleep(POLL_MS);
    waited += POLL_MS;
  }
}

// A rename lists its old path in previous_filename; a move out of src/ into llp/ is not LLP-only.
async function prPaths(input: GateInput, io: GateIo): Promise<string[]> {
  const paths: string[] = [];
  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const batch = (await github(
      input,
      io,
      `/pulls/${input.prNumber}/files?per_page=${FILES_PER_PAGE}&page=${page}`
    )) as { filename: string; previous_filename?: string }[];
    for (const file of batch) {
      paths.push(file.filename);
      if (file.previous_filename) {
        paths.push(file.previous_filename);
      }
    }
    if (batch.length < FILES_PER_PAGE) {
      return paths;
    }
  }
  throw new Error(`more than ${MAX_FILE_PAGES * FILES_PER_PAGE} files`);
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
  const decision: GateDecision = input
    ? await decide(input, { fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })
    : {
        scope: 'all',
        reason: `Not a pull request (GITHUB_REPOSITORY=${process.env.GITHUB_REPOSITORY ?? ''}, PR_NUMBER=${process.env.PR_NUMBER ?? ''}). CI runs.`,
      };
  console.error(decision.reason);
  const { run, full } = OUTPUTS[decision.scope];
  const { appendFile } = await import('node:fs/promises');
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `run=${run}\nfull=${full}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${decision.reason}\n`);
  }
  // Last, so a throw prints nothing and EAS's `|| echo true` captures only `true`.
  console.log(String(full));
}

if (import.meta.main) {
  await main();
}
