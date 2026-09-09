import type { Message } from './loop';

export const model = process.env.AGENT_CLI_EVAL_MODEL ?? 'qwen3:4b-instruct';
const host = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
// The digest, not just the mutable tag, identifies the weights used by the default CI driver.
export const defaultDigest = '0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0';

async function request(route: string, signal: AbortSignal, body?: unknown) {
  const response = await fetch(new URL(route, host), {
    method: body ? 'POST' : 'GET',
    signal,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`Ollama ${route}: HTTP ${response.status}`);
  return response.json();
}

export async function identifyModel(signal: AbortSignal) {
  const [tags, version] = await Promise.all([
    request('/api/tags', signal),
    request('/api/version', signal),
  ]);
  const installed = tags.models?.find((entry: { name: string }) => entry.name === model);
  if (!installed) throw new Error(`Ollama model ${model} is not installed`);
  const expected =
    process.env.AGENT_CLI_EVAL_MODEL_DIGEST ??
    (model === 'qwen3:4b-instruct' ? defaultDigest : undefined);
  if (expected && installed.digest !== expected)
    throw new Error(`Ollama model digest mismatch: ${installed.digest}, expected ${expected}`);
  return {
    model,
    digest: installed.digest as string,
    ollamaVersion: version.version as string,
  };
}

/** Translate the internal loop history to Ollama's native tool-call protocol. */
export function nativeMessages(messages: Message[]) {
  let toolPending = false;
  return messages.map((message) => {
    if (message.role === 'assistant') {
      let action;
      try {
        action = JSON.parse(message.content);
      } catch {
        /* preserve malformed output */
      }
      if (action && Object.hasOwn(action, 'run')) {
        toolPending = true;
        return {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'run_cli', arguments: { argv: action.run } } }],
        };
      }
    }
    if (message.role === 'user' && toolPending) {
      toolPending = false;
      return { role: 'tool', tool_name: 'run_cli', content: message.content };
    }
    return message;
  });
}

export async function chat(
  messages: Message[],
  signal: AbortSignal,
  record: (request: unknown, response: unknown) => void
) {
  const body = {
    model,
    messages: nativeMessages(messages),
    stream: false,
    think: false,
    tools: [
      {
        type: 'function',
        function: {
          name: 'run_cli',
          description:
            'Execute @expo/agent-cli in the project directory and return its exit code, stdout and stderr. Use --help to discover commands and flags.',
          parameters: {
            type: 'object',
            properties: {
              argv: { type: 'array', items: { type: 'string' }, minItems: 1 },
            },
            required: ['argv'],
          },
        },
      },
    ],
    options: { temperature: 0, seed: 42, num_predict: 512, num_ctx: 8192 },
    keep_alive: '10m',
  };
  const response = await request('/api/chat', signal, body);
  record(body, response);
  const calls = response.message?.tool_calls;
  if (calls?.length > 1) throw new Error('Expected one CLI call per turn');
  if (calls?.length && calls[0].function?.name !== 'run_cli')
    throw new Error('Unknown tool requested by Ollama');
  if (response.done_reason === 'length') throw new Error('Model exhausted its output token budget');
  if (!calls?.length && !response.message?.content?.trim())
    throw new Error('Ollama returned no tool call or final answer');
  return {
    content: JSON.stringify(
      calls?.length
        ? { run: calls[0].function.arguments?.argv ?? null }
        : { done: true, summary: response.message.content }
    ),
    request: body,
    response,
    usage: {
      inputTokens: Number(response.prompt_eval_count ?? 0),
      outputTokens: Number(response.eval_count ?? 0),
    },
  };
}
