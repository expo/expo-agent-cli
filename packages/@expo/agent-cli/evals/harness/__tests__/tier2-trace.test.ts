import { describe, expect, it } from 'vitest';

import { normalizeTrace, summarizeTrace } from '../../tier2/trace.mjs';

const lines = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join('\n');

describe(summarizeTrace, () => {
  it('should count tool calls/results without grading assistant claims', () => {
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

  it('should deduplicate repeated tool blocks and tolerate unknown event types', () => {
    const event = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't', name: 'Read' }] },
    };
    const summary = summarizeTrace(lines(event, event, { type: 'rate_limit_event' }));
    expect(summary.tools).toEqual({ Read: 1 });
    expect(summary.events.rate_limit_event).toBe(1);
  });

  it('should handle CRLF and a complete last line without a newline', () => {
    expect(
      summarizeTrace(' {"type":"result","subtype":"success","is_error":false}\r\n').results
    ).toHaveLength(1);
  });

  it('should retain all terminal events so a later success cannot hide an earlier error', () => {
    const summary = summarizeTrace(
      lines(
        { type: 'result', subtype: 'error_max_turns', is_error: true },
        { type: 'result', subtype: 'success', is_error: false }
      )
    );
    expect(summary.results).toHaveLength(2);
  });

  it('should record malformed JSON and invalid events by line, including a truncated final line', () => {
    const summary = summarizeTrace('\nnot json\nnull\n42\n{}\n{"type":');
    expect(summary.malformedLines).toEqual([2, 3, 4, 5, 6]);
    expect(summary.terminal).toBeNull();
  });
});

describe(normalizeTrace, () => {
  it('should retain normalized Claude calls, errors and the final answer for diagnostics', () => {
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
          content: [
            { type: 'tool_result', tool_use_id: 'bash1', content: 'exit 1', is_error: true },
          ],
        },
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed it' }] } }
    );
    const events = normalizeTrace(raw, 'repair');
    expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        error: expect.objectContaining({ name: 'ToolError' }),
      })
    );
    expect(events.at(-1)).toMatchObject({
      type: 'message',
      role: 'assistant',
      content: 'Fixed it',
    });
  });
});
