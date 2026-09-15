import { describe, expect, it } from 'vitest';

import { assessOutcome, REQUIRED_CHECKS, workflowReport } from '../../tier2/outcome.mjs';
import { summarizeTrace } from '../../tier2/trace.mjs';

const passingInput = () => ({
  process: { exitCode: 0, signal: null, timedOut: false, spawnError: null, pid: 123 },
  trace: summarizeTrace('{"type":"result","subtype":"success","is_error":false}'),
  checks: REQUIRED_CHECKS.map((name) => ({ name, ok: true })),
  errors: [],
});

describe(assessOutcome, () => {
  it('should require every independent check plus normal process completion', () => {
    expect(assessOutcome(passingInput()).status).toBe('passed');
  });

  it.each([
    { exitCode: 1 },
    { exitCode: null },
    { signal: 'SIGTERM' },
    { timedOut: true },
    { spawnError: 'ENOENT' },
  ])('should not hide process failure behind green checks: %j', (patch) => {
    const input = passingInput();
    Object.assign(input.process, patch);
    expect(assessOutcome(input).status).toBe('error');
  });

  it.each([
    '',
    'garbage',
    '{"type":"result","subtype":"error_max_turns","is_error":true}',
    '{"type":"result","subtype":"success","is_error":true}',
    '{"type":"result","subtype":"success"}',
  ])('should reject incomplete/error trace %s', (raw) => {
    const input = passingInput();
    input.trace = summarizeTrace(raw);
    expect(assessOutcome(input).status).toBe('error');
  });

  it('should not let a model success replace missing or failing checks', () => {
    for (const checks of [
      [],
      passingInput().checks.slice(1),
      passingInput().checks.map((check, index) => (index ? check : { ...check, ok: false })),
    ]) {
      expect(assessOutcome({ ...passingInput(), checks }).status).toBe('failed');
    }
  });

  it('should not let a duplicate passing check mask a failed check', () => {
    const input = passingInput();
    input.checks.push({ name: REQUIRED_CHECKS[0], ok: false });
    expect(assessOutcome(input).status).toBe('failed');
  });

  it('should fail when browser checks succeed but there is no agent-cli event evidence', () => {
    const input = passingInput();
    input.checks = input.checks.filter((check) => check.name !== 'agent-cli-invocations');
    expect(assessOutcome(input).status).toBe('failed');
  });

  it('should report cleanup/setup exceptions as errors', () => {
    expect(assessOutcome({ ...passingInput(), errors: ['cleanup failed'] }).status).toBe('error');
  });

  it('should reject multiple terminal results', () => {
    const input = passingInput();
    input.trace.results.push(input.trace.terminal!);
    expect(assessOutcome(input).status).toBe('error');
  });
});

describe(workflowReport, () => {
  it('should keep skips explicit and never convert failed/missing output into success', () => {
    expect(workflowReport({ status: 'skipped', reason: 'No key' }, 0)).toEqual({
      result: 'skipped',
      exitCode: 0,
      summary: 'No key',
    });
    expect(workflowReport(undefined, 0)).toMatchObject({ result: 'error', exitCode: 1 });
    expect(workflowReport({ status: 'passed' }, 1)).toMatchObject({ result: 'error', exitCode: 1 });
    expect(workflowReport({ status: 'error', reason: 'setup' }, 0)).toMatchObject({
      result: 'error',
      exitCode: 1,
    });
    expect(workflowReport({ status: 'failed' }, 0)).toMatchObject({
      result: 'failed',
      exitCode: 1,
    });
  });
});
