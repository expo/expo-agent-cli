/** @typedef {{name: string, ok: boolean, detail?: unknown}} Check */
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
  if (!proc || proc.exitCode !== 0 || proc.signal || proc.timedOut || proc.spawnError) {
    problems.push('Claude did not complete normally');
  }
  if (
    !trace ||
    trace.malformedLines.length ||
    trace.results.length !== 1 ||
    trace.terminal?.subtype !== 'success' ||
    trace.terminal?.is_error !== false
  ) {
    problems.push('Claude trace is incomplete or has a terminal error');
  }
  const missing = REQUIRED_CHECKS.filter((name) => !checks.some((check) => check.name === name));
  const failed = checks.filter((check) => check.ok !== true).map((check) => check.name);
  let status = 'passed';
  if (problems.length) {
    status = 'error';
  } else if (missing.length || failed.length) {
    status = 'failed';
  }
  return {
    status,
    reason: [
      ...problems,
      ...missing.map((name) => `missing check: ${name}`),
      ...failed.map((name) => `failed check: ${name}`),
    ].join('; '),
    checks,
    errors: problems,
  };
}

export function workflowReport(outcome, runnerExitCode) {
  if (!outcome || !['passed', 'failed', 'error', 'skipped'].includes(outcome.status)) {
    return {
      result: 'error',
      exitCode: runnerExitCode || 1,
      summary: 'No valid outcome.json; inspect setup/test logs',
    };
  }
  if (runnerExitCode && ['passed', 'skipped'].includes(outcome.status)) {
    return {
      result: 'error',
      exitCode: runnerExitCode,
      summary: `Vitest/pipeline exited ${runnerExitCode}; outcome was ${outcome.status}`,
    };
  }
  return {
    result: outcome.status,
    exitCode: runnerExitCode || (['passed', 'skipped'].includes(outcome.status) ? 0 : 1),
    summary: outcome.reason || outcome.status,
  };
}
