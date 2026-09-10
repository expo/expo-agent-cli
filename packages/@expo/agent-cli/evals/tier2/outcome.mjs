/** @typedef {{name: string, ok: boolean, detail?: import('vitest-evals').JsonValue}} Check */
/** @typedef {{status: 'passed'|'failed'|'error'|'skipped', reason: string, checks: Check[], errors?: string[], elapsedMs?: number}} Outcome */
export const REQUIRED_CHECKS = [
  'agent-cli-invocations',
  'broken-baseline',
  'source-changed',
  'fixture-contract',
  'agent-export',
  'metro-status',
  'metro-browser',
  'fresh-export',
  'export-browser',
];

/**
 * @param {{process: import('./process.mjs').ProcessResult | null, trace: import('./trace.mjs').TraceSummary | null, checks?: Check[], errors?: string[]}} input
 * @returns {Outcome}
 */
export function assessOutcome({ process: proc, trace, checks = [], errors = [] }) {
  const problems = [...errors];
  if (!proc || proc.exitCode !== 0 || proc.signal || proc.timedOut || proc.spawnError)
    problems.push('Claude did not complete normally');
  if (
    !trace ||
    trace.malformedLines.length ||
    trace.results.length !== 1 ||
    trace.terminal?.subtype !== 'success' ||
    trace.terminal?.is_error !== false
  )
    problems.push('Claude trace is incomplete or has a terminal error');
  const missing = REQUIRED_CHECKS.filter((name) => !checks.some((c) => c.name === name));
  const failed = checks.filter((c) => c.ok !== true).map((c) => c.name);
  const status = problems.length ? 'error' : missing.length || failed.length ? 'failed' : 'passed';
  return {
    status,
    reason: [
      ...problems,
      ...missing.map((n) => `missing check: ${n}`),
      ...failed.map((n) => `failed check: ${n}`),
    ].join('; '),
    checks,
    errors: problems,
  };
}

export function workflowReport(outcome, runnerExitCode) {
  if (!outcome || !['passed', 'failed', 'error', 'skipped'].includes(outcome.status))
    return {
      result: 'error',
      exitCode: runnerExitCode || 1,
      summary: 'No valid outcome.json; inspect setup/test logs',
    };
  if (runnerExitCode && ['passed', 'skipped'].includes(outcome.status))
    return {
      result: 'error',
      exitCode: runnerExitCode,
      summary: `Vitest/pipeline exited ${runnerExitCode}; outcome was ${outcome.status}`,
    };
  return {
    result: outcome.status,
    exitCode: runnerExitCode || (['passed', 'skipped'].includes(outcome.status) ? 0 : 1),
    summary: outcome.reason || outcome.status,
  };
}
