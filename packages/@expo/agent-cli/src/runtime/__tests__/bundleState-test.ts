// @ref llp/0005-runtime-loop-tools.rfc.md §The bundle state
import type { WebSocket } from 'ws';

import { attachedAppsAsync, bundleStateOf, BUNDLE_STATE_EXPRESSION } from '../bundleState';
import type { CdpTarget } from '../cdpClient';
import { MockWebSocket } from './MockWebSocket';

describe(bundleStateOf, () => {
  it.each([
    ['function', 'ran'],
    ['undefined', 'not-run'],
    ['object', 'not-run'],
    [undefined, 'unknown'],
  ] as const)('maps %s to %s', (answer, state) => {
    expect(bundleStateOf(answer)).toBe(state);
  });
});

type Behavior =
  | { kind: 'type'; value: string }
  | { kind: 'rpcError'; code: number }
  | { kind: 'silent' };

function target(id: string): CdpTarget {
  return { id, webSocketDebuggerUrl: `ws://debugger/${id}` } as CdpTarget;
}

function probeWith(behaviors: Record<string, Behavior>) {
  const expressions: string[] = [];
  const createWebSocket = (url: string) =>
    new MockWebSocket(url, (request, socket) => {
      expressions.push(request.params.expression);
      const behavior = behaviors[url.split('/').pop()!]!;
      if (behavior.kind === 'silent') return;
      socket.emit(
        'message',
        JSON.stringify(
          behavior.kind === 'rpcError'
            ? { id: request.id, error: { code: behavior.code, message: 'Method not found' } }
            : { id: request.id, result: { result: { type: 'string', value: behavior.value } } }
        )
      );
    }) as unknown as WebSocket;
  return { createWebSocket, expressions };
}

describe(attachedAppsAsync, () => {
  it('splits the own targets into attached and loading', async () => {
    const { createWebSocket, expressions } = probeWith({
      ran: { kind: 'type', value: 'function' },
      loading: { kind: 'type', value: 'undefined' },
      noDebugger: { kind: 'rpcError', code: -32601 },
      silent: { kind: 'silent' },
    });
    const ran = target('ran');
    const loading = target('loading');
    const noDebugger = target('noDebugger');
    const silent = target('silent');

    const result = await attachedAppsAsync([ran, loading, noDebugger, silent], {
      createWebSocket,
      timeoutMs: 50,
    });

    expect(result).toEqual({ attached: [ran, noDebugger, silent], loading: [loading] });
    expect(new Set(expressions)).toEqual(new Set([BUNDLE_STATE_EXPRESSION]));
  });

  it('counts a target whose socket cannot open as attached', async () => {
    const broken = target('broken');
    const result = await attachedAppsAsync([broken], {
      createWebSocket: () => {
        throw new Error('connect ECONNREFUSED');
      },
    });

    expect(result).toEqual({ attached: [broken], loading: [] });
  });
});
