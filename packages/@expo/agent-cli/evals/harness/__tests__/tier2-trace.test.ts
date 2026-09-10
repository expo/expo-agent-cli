import { describe, expect, it } from 'vitest';
import { summarizeTrace, normalizeTrace } from '../../tier2/trace.mjs';
const lines = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n');
describe('Claude stream-json diagnostics', () => {
  it('counts tool calls/results without grading assistant claims', () => {
    const result = summarizeTrace(
      lines(
        { type: 'system', subtype: 'init', model: 'pinned-model' },
        {
          type: 'assistant',
          message: {
            id: 'a',
            content: [
              { type: 'text', text: 'Everything passed!' },
              { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'false' } },
            ],
          },
        },
        {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] },
        },
        { type: 'result', subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0.1 }
      )
    );
    expect(result.tools).toEqual({ Bash: 1 });
    expect(result.toolErrors).toBe(1);
    expect(result.models).toEqual(['pinned-model']);
    expect(result.terminal).toMatchObject({ subtype: 'success', num_turns: 2 });
    expect(result).not.toHaveProperty('pass');
    expect(result).not.toHaveProperty('status');
  });
  it('deduplicates repeated tool blocks and tolerates unknown event types', () => {
    const event = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't', name: 'Read' }] },
    };
    const s = summarizeTrace(lines(event, event, { type: 'rate_limit_event' }));
    expect(s.tools).toEqual({ Read: 1 });
    expect(s.events.rate_limit_event).toBe(1);
  });
  it('records malformed JSON and invalid events by line, including a truncated final line', () => {
    const s = summarizeTrace('\nnot json\nnull\n42\n{}\n{"type":');
    expect(s.malformedLines).toEqual([2, 3, 4, 5, 6]);
    expect(s.terminal).toBeNull();
  });
  it('retains all terminal events so a later success cannot hide an earlier error', () => {
    const s = summarizeTrace(
      lines(
        { type: 'result', subtype: 'error_max_turns', is_error: true },
        { type: 'result', subtype: 'success', is_error: false }
      )
    );
    expect(s.results).toHaveLength(2);
  });
  it('handles CRLF and a complete last line without a newline', () => {
    expect(
      summarizeTrace(' {"type":"result","subtype":"success","is_error":false}\r\n').results
    ).toHaveLength(1);
  });
});

// Validate the actual pinned library adapter, rather than a local imitation of its schema.
import { createHarness, toolCalls } from 'vitest-evals';
it('stores normalized Claude calls, errors and final output in the library session', async () => {
  const raw = lines(
    {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'bash1', name: 'Bash', input: { command: 'false' } }],
      },
    },
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'bash1', content: 'exit 1', is_error: true }],
      },
    },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed it' }] } }
  );
  const harness = createHarness({
    name: 'normalization-test',
    run: async () => ({
      events: normalizeTrace(raw, 'repair'),
      output: { status: 'failed' },
    }),
  });
  const result = await harness.run('repair', { artifacts: {}, setArtifact() {} });
  expect(toolCalls(result)).toHaveLength(1);
  expect(result.session.events).toContainEqual(
    expect.objectContaining({
      type: 'tool_result',
      error: expect.objectContaining({ name: 'ToolError' }),
    })
  );
  expect(result.output).toEqual({ status: 'failed' });
});
