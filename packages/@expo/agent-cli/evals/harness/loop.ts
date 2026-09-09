// @ref llp/0002-testing-and-evals.plan.md
import type { ProcessResult } from './process';
export type Message = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};
export type CommandResult = ProcessResult & { argv: string[] };
export type LoopEvent =
  | { type: 'message'; role: 'user' | 'assistant'; content: string }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      arguments: { argv: string[] };
    }
  | {
      type: 'tool_result';
      toolCallId: string;
      name: string;
      content: CommandResult;
    };

/** Only the model chooses argv. The adapter supplies the public help, not scenario answers. */
export async function runLoop(options: {
  prompt: string;
  help: string;
  signal: AbortSignal;
  maxTurns?: number;
  chat: (messages: Message[]) => Promise<string>;
  execute: (argv: string[]) => Promise<ProcessResult>;
  record: (event: LoopEvent) => void;
}) {
  const messages: Message[] = [
    {
      role: 'system',
      content: `You complete tasks in the current Expo project using the run_cli tool.
Call the CLI with argv (command and flags). Read each result before deciding the next step.
Use --help to discover flags, and prefer --json when available. Do not invent flags.
Execute the requested work yourself. If a command fails, use its error and help to recover; do not merely tell the user which command to run.
Do not start, build, install or deploy unless the user requests it.
Public CLI help:\n${options.help}
When the requested task is complete, stop calling tools. Your final answer must be one short sentence (at most 30 words); do not repeat command output.
Suggested next commands are optional, not additional tasks. /no_think`,
    },
    { role: 'user', content: options.prompt },
  ];
  options.record({ type: 'message', role: 'user', content: options.prompt });
  const commands: CommandResult[] = [];
  for (let turn = 0; turn < (options.maxTurns ?? 6); turn++) {
    options.signal.throwIfAborted();
    const content = await options.chat([...messages]);
    messages.push({ role: 'assistant', content });
    options.record({ type: 'message', role: 'assistant', content });
    let action;
    try {
      action = JSON.parse(content);
    } catch {
      /* let the agent correct its syntax */
    }
    if (
      action?.done === true &&
      (action.run === undefined || (Array.isArray(action.run) && action.run.length === 0))
    ) {
      if (!commands.length) throw new Error('Agent finished without calling the CLI');
      return {
        commands,
        summary: typeof action.summary === 'string' ? action.summary : '',
        turns: turn + 1,
      };
    }
    if (
      !action ||
      (action.done !== undefined && action.done !== false) ||
      !Array.isArray(action.run) ||
      !action.run.length ||
      !action.run.every((part: unknown) => typeof part === 'string' && !part.includes('\0'))
    ) {
      messages.push({
        role: 'user',
        content: 'Invalid run_cli arguments. Call run_cli with a nonempty argv array of strings.',
      });
      continue;
    }
    const id = `command-${commands.length + 1}`;
    options.record({
      type: 'tool_call',
      id,
      name: 'expo-agent-cli',
      arguments: { argv: action.run },
    });
    const result = {
      argv: action.run as string[],
      ...(await options.execute(action.run)),
    };
    commands.push(result);
    options.record({
      type: 'tool_result',
      toolCallId: id,
      name: 'expo-agent-cli',
      content: result,
    });
    if (result.timedOut) throw new Error('CLI command timed out');
    const clip = (text: string) =>
      text.length > 8000 ? `${text.slice(0, 8000)}\n[output truncated]` : text;
    messages.push({
      role: 'user',
      content: JSON.stringify({
        exitCode: result.exitCode,
        stdout: clip(compactJson(result.stdout)),
        stderr: clip(result.stderr),
      }),
    });
  }
  throw new Error('Agent exhausted its turn budget without completing the task');
}

/** Preserve every JSON field while avoiding pretty-print whitespace in model context. */
function compactJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}
