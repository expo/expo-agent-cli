import fs from 'node:fs';
import path from 'node:path';

/** The per-case result.json the kit writes into each attempt directory. */
export type CaseResult = {
  id: string;
  attemptId: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  execution: {
    endReason: string;
    metadata?: Record<string, unknown>;
  };
  checks: { name: string; status: string; error?: string }[];
  counts: { passed: number; failed: number; skipped: number };
};

/** Read every case result under the artifact root, oldest attempt first within a case. */
export function readCaseResults(artifactRoot: string): CaseResult[] {
  let attempts: fs.Dirent[];
  try {
    attempts = fs.readdirSync(artifactRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: CaseResult[] = [];
  for (const attempt of attempts) {
    const file = path.join(artifactRoot, attempt.name, 'result.json');
    if (!attempt.isDirectory() || !fs.existsSync(file)) {
      continue;
    }
    results.push(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  return results.sort(
    (left, right) =>
      left.id.localeCompare(right.id) || left.startedAt.localeCompare(right.startedAt)
  );
}

/** A Markdown job summary: one row per case, then the failed checks, then the model identity. */
export function renderSummary(results: CaseResult[]): string {
  if (!results.length) {
    return 'No Tier 1 case results were written.\n';
  }
  const lines = [
    '## Tier 1 agent evals',
    '',
    '| Case | Status | End reason | Turns | Tokens in / out | Checks passed | Duration |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...results.map(tableRow),
  ];
  const failures = results.flatMap((result) =>
    result.checks
      .filter((check) => check.status !== 'passed')
      .map((check) => `- **${result.id}** ${check.status}: ${check.name}${firstLine(check.error)}`)
  );
  if (failures.length) {
    lines.push('', '### Checks not passed', '', ...failures);
  }
  const identity = describeModel(results[0].execution.metadata);
  if (identity) {
    lines.push('', identity);
  }
  return `${lines.join('\n')}\n`;
}

function tableRow(result: CaseResult): string {
  const metadata = result.execution.metadata ?? {};
  const tokens =
    metadata.inputTokens === undefined
      ? '–'
      : `${metadata.inputTokens} / ${metadata.outputTokens ?? '–'}`;
  const checks = `${result.counts.passed} / ${result.checks.length}`;
  return `| ${result.id} | ${result.status} | ${result.execution.endReason} | ${metadata.turns ?? '–'} | ${tokens} | ${checks} | ${duration(result)} |`;
}

function duration(result: CaseResult): string {
  const milliseconds = Date.parse(result.finishedAt) - Date.parse(result.startedAt);
  return Number.isFinite(milliseconds) ? `${Math.round(milliseconds / 1000)} s` : '–';
}

function firstLine(error: string | undefined): string {
  return error ? `: ${error.split('\n')[0]}` : '';
}

/** Model and CLI identity from the runner metadata; absent in dry runs. */
function describeModel(metadata: Record<string, unknown> | undefined): string | null {
  if (!metadata || typeof metadata.model !== 'string') {
    return null;
  }
  const parts = [`Model: \`${metadata.model}\``];
  if (typeof metadata.digest === 'string') {
    parts.push(`digest \`${metadata.digest.slice(0, 12)}\``);
  }
  if (typeof metadata.ollamaVersion === 'string') {
    parts.push(`Ollama ${metadata.ollamaVersion}`);
  }
  if (typeof metadata.cliVersion === 'string') {
    parts.push(`CLI ${metadata.cliVersion}`);
  }
  return parts.join(' · ');
}
