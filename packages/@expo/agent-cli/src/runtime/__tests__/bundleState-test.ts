// @ref llp/0005-runtime-loop-tools.rfc.md §The bundle state
import type { WebSocket } from 'ws';

import { attachedAppsAsync } from '../bundleState';
import type { CdpTarget } from '../cdpClient';
import { MockWebSocket } from './MockWebSocket';

type Behavior =
  | { kind: 'answer'; result: { type: string; value?: string } }
  | { kind: 'rpcError'; code: number }
  | { kind: 'silent' }
  | { kind: 'refused' };

function probeWith(behavior: Behavior) {
  return (url: string) => {
    if (behavior.kind === 'refused') throw new Error('connect ECONNREFUSED');
    return new MockWebSocket(url, (request, socket) => {
      if (behavior.kind === 'silent') return;
      socket.emit(
        'message',
        JSON.stringify(
          behavior.kind === 'rpcError'
            ? { id: request.id, error: { code: behavior.code, message: 'Method not found' } }
            : { id: request.id, result: { result: behavior.result } }
        )
      );
    }) as unknown as WebSocket;
  };
}

const string = (value: string): Behavior => ({
  kind: 'answer',
  result: { type: 'string', value },
});

describe(attachedAppsAsync, () => {
  it.each<[string, Behavior, 'attached' | 'loading']>([
    ['the bundle ran', string('function'), 'attached'],
    ['the bundle has not run', string('undefined'), 'loading'],
    ['__r is some other type', string('object'), 'loading'],
    ['the page asks to be hidden', string('hidden'), 'attached'],
    ['the answer is not a string', { kind: 'answer', result: { type: 'undefined' } }, 'attached'],
    ['the runtime has no evaluate (-32601)', { kind: 'rpcError', code: -32601 }, 'attached'],
    ['the runtime does not answer in time', { kind: 'silent' }, 'attached'],
    ['the socket cannot open', { kind: 'refused' }, 'attached'],
  ])('%s: the app is %s', async (_, behavior, expected) => {
    const target = { id: 'app', webSocketDebuggerUrl: 'ws://debugger/app' } as CdpTarget;

    const result = await attachedAppsAsync([target], {
      createWebSocket: probeWith(behavior),
      deadline: Date.now(),
    });

    expect(result).toEqual(
      expected === 'attached'
        ? { attached: [target], loading: [] }
        : { attached: [], loading: [target] }
    );
  });
});
