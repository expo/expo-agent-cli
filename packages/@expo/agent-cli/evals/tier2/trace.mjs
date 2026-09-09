/**
 * @typedef {{events: Record<string, number>, tools: Record<string, number>, toolErrors: number,
 * malformedLines: number[], models: string[], results: Array<Record<string, any>>,
 * terminal: Record<string, any> | null}} TraceSummary
 */
/** Claude stream-json diagnostics. No transcript-based outcome grading.
 * @param {string} raw
 * @returns {TraceSummary}
 */
export function summarizeTrace(raw) {
  /** @type {TraceSummary} */
  const summary = {
    events: {},
    tools: {},
    toolErrors: 0,
    malformedLines: [],
    models: [],
    results: [],
    terminal: null,
  };
  const seenTools = new Set();
  const seenResults = new Set();
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
      if (!event || typeof event !== 'object' || typeof event.type !== 'string')
        throw new Error('invalid event');
    } catch {
      summary.malformedLines.push(index + 1);
      continue;
    }
    summary.events[event.type] = (summary.events[event.type] ?? 0) + 1;
    const model = event.model ?? event.message?.model;
    if (typeof model === 'string' && !summary.models.includes(model)) summary.models.push(model);
    const content = event.message?.content;
    for (const block of Array.isArray(content) ? content : []) {
      if (block.type === 'tool_use' && typeof block.name === 'string' && !seenTools.has(block.id)) {
        seenTools.add(block.id);
        summary.tools[block.name] = (summary.tools[block.name] ?? 0) + 1;
      }
      if (
        block.type === 'tool_result' &&
        block.is_error === true &&
        !seenResults.has(block.tool_use_id)
      ) {
        seenResults.add(block.tool_use_id);
        summary.toolErrors++;
      }
    }
    if (event.type === 'result') {
      // Keep only mechanical terminal metadata; the model's prose is in the raw artifact.
      const result = Object.fromEntries(
        [
          'subtype',
          'is_error',
          'num_turns',
          'duration_ms',
          'duration_api_ms',
          'total_cost_usd',
          'usage',
          'permission_denials',
        ]
          .filter((k) => k in event)
          .map((k) => [k, event[k]])
      );
      summary.results.push(result);
      summary.terminal = result;
    }
  }
  return summary;
}

/** Flat vitest-evals events; no stream deltas (complete assistant messages are canonical).
 * @param {string} raw
 * @param {string} prompt
 * @returns {import('vitest-evals').TranscriptEvent[]}
 */
export function normalizeTrace(raw, prompt) {
  /** @type {import('vitest-evals').TranscriptEvent[]} */
  const events = [{ type: 'message', role: 'user', content: prompt }];
  const tools = new Map();
  const seenMessages = new Set();
  const seenResults = new Set();
  for (const line of raw.split('\n')) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || !['assistant', 'user'].includes(event.type)) continue;
    const message = event.message;
    if (!Array.isArray(message?.content)) continue;
    for (const [i, block] of message.content.entries()) {
      if (block.type === 'text' && event.type === 'assistant') {
        const key = `${message.id ?? event.uuid}:${i}:${block.text}`;
        if (seenMessages.has(key)) continue;
        seenMessages.add(key);
        events.push({ type: 'message', role: 'assistant', content: block.text });
      } else if (
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        !tools.has(block.id)
      ) {
        tools.set(block.id, block.name);
        events.push({
          type: 'tool_call',
          id: block.id,
          name: block.name,
          arguments: block.input ?? {},
        });
      } else if (
        block.type === 'tool_result' &&
        tools.has(block.tool_use_id) &&
        !seenResults.has(block.tool_use_id)
      ) {
        seenResults.add(block.tool_use_id);
        events.push({
          type: 'tool_result',
          toolCallId: block.tool_use_id,
          name: tools.get(block.tool_use_id),
          content: block.content ?? '',
          ...(block.is_error === true
            ? { error: { name: 'ToolError', message: 'Claude reported a tool error' } }
            : {}),
        });
      }
    }
  }
  return events;
}
