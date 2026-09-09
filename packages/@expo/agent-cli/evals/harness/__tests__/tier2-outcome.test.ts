import { describe, expect, it } from 'vitest';
import { assessOutcome, REQUIRED_CHECKS, workflowReport } from '../../tier2/outcome.mjs';
import { summarizeTrace } from '../../tier2/trace.mjs';
const good = () => ({
  process: { exitCode: 0, signal: null, timedOut: false, spawnError: null, pid: 123 },
  trace: summarizeTrace('{"type":"result","subtype":"success","is_error":false}'),
  checks: REQUIRED_CHECKS.map((name) => ({ name, ok: true })),
  errors: [],
});
describe('outcome failure semantics', () => {
  it('requires every independent check plus normal process completion', () => {
    expect(assessOutcome(good()).status).toBe('passed');
  });
  it.each([
    { exitCode: 1 },
    { exitCode: null },
    { signal: 'SIGTERM' },
    { timedOut: true },
    { spawnError: 'ENOENT' },
  ])('cannot hide process failure behind green checks: %j', (patch) => {
    const input = good();
    Object.assign(input.process, patch);
    expect(assessOutcome(input).status).toBe('error');
  });
  it.each([
    '',
    'garbage',
    '{"type":"result","subtype":"error_max_turns","is_error":true}',
    '{"type":"result","subtype":"success","is_error":true}',
    '{"type":"result","subtype":"success"}',
  ])('rejects incomplete/error trace %s', (raw) => {
    const input = good();
    input.trace = summarizeTrace(raw);
    expect(assessOutcome(input).status).toBe('error');
  });
  it('does not let a model success replace missing or failing checks', () => {
    for (const checks of [
      [],
      good().checks.slice(1),
      good().checks.map((c, i) => (i ? c : { ...c, ok: false })),
    ]) {
      expect(assessOutcome({ ...good(), checks }).status).toBe('failed');
    }
  });
  it('does not let a duplicate passing check mask a failed check', () => {
    const input = good();
    input.checks.push({ name: REQUIRED_CHECKS[0], ok: false });
    expect(assessOutcome(input).status).toBe('failed');
  });
  it('reports cleanup/setup exceptions as errors', () => {
    expect(assessOutcome({ ...good(), errors: ['cleanup failed'] }).status).toBe('error');
  });
  it('rejects multiple terminal results', () => {
    const input = good();
    input.trace.results.push(input.trace.terminal!);
    expect(assessOutcome(input).status).toBe('error');
  });
  it('keeps skips explicit and never converts failed/missing output into success', () => {
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
it('fails when browser checks succeed but there is no agent-cli event evidence', () => {
  const input = good();
  input.checks = input.checks.filter((c) => c.name !== 'agent-cli-invocations');
  expect(assessOutcome(input).status).toBe('failed');
});
