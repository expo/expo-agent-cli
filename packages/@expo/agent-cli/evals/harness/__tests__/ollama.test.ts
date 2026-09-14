import { expect, it } from 'vitest';
import { nativeMessages } from '../ollama';

it('replays the CLI result as a tool response, not a new user instruction', () => {
  expect(
    nativeMessages([
      { role: 'system', content: 'Use the CLI' },
      { role: 'user', content: 'Sync skills' },
      { role: 'assistant', content: '{"run":["skills:sync","--agent","codex"]}' },
      { role: 'user', content: '{"exitCode":0,"stdout":"linked","stderr":""}' },
    ])
  ).toEqual([
    { role: 'system', content: 'Use the CLI' },
    { role: 'user', content: 'Sync skills' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { function: { name: 'run_cli', arguments: { argv: ['skills:sync', '--agent', 'codex'] } } },
      ],
    },
    { role: 'tool', tool_name: 'run_cli', content: '{"exitCode":0,"stdout":"linked","stderr":""}' },
  ]);
});
it('keeps malformed-action correction as user feedback when no tool ran', () => {
  const feedback = { role: 'user' as const, content: 'Invalid action' };
  expect(nativeMessages([{ role: 'assistant', content: 'oops' }, feedback])[1]).toEqual(feedback);
});

it('replays a native batch with one tool result per invocation', () => {
  const messages = nativeMessages([
    { role: 'assistant', content: '{"runs":[["status"],["skills:list"]]}' },
    { role: 'user', content: 'status output' },
    { role: 'user', content: 'skills output' },
    { role: 'user', content: 'next user task' },
  ]);
  expect(messages[0]).toMatchObject({
    tool_calls: [
      { function: { name: 'run_cli', arguments: { argv: ['status'] } } },
      { function: { name: 'run_cli', arguments: { argv: ['skills:list'] } } },
    ],
  });
  expect(messages.slice(1).map((m) => m.role)).toEqual(['tool', 'tool', 'user']);
});
