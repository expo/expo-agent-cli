// @ref llp/0005-runtime-loop-tools.rfc.md §What proves a reload
import { WebSocket } from 'ws';

import { jsContextReplacedAsync } from '../contextReplaced';
import { serveInspectorApp } from './fakeInspectorApp';

vi.mock('ws', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ws')>();
  return { ...actual, WebSocket: vi.fn() };
});

const TARGET = {
  id: 'page-1',
  deviceName: 'iPhone 17',
  webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=1&page=1',
};

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async () => ({ ok: true, json: async () => [TARGET] })) as never;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('the proof of a Page.reload', () => {
  it.each([
    { name: 'proves the reload once the marker is gone', app: {}, kind: 'replaced', reloads: 1 },
    {
      name: 'reads the marker again over a new connection when the reload drops the old one',
      app: { onReload: 'clears-and-drops' as const },
      kind: 'replaced',
      reloads: 1,
    },
    {
      name: 'reads an error or the old marker as "not yet", and asks again',
      app: { onReload: 'clears-late' as const },
      kind: 'replaced',
      reloads: 1,
    },
    {
      name: 'does not take a read that fails for a new context',
      app: { onReload: 'unreadable' as const },
      kind: 'not-replaced',
      reloads: 1,
    },
    {
      name: 'does not prove a reload the context outlived',
      app: { onReload: 'nothing' as const },
      kind: 'not-replaced',
      reloads: 1,
    },
    {
      name: 'is unprovable, and does not act, when the marker cannot be set',
      app: { evaluate: 'method-not-found' as const },
      kind: 'unmarkable',
      reloads: 0,
    },
  ])('$name', async ({ app, kind, reloads }) => {
    const served = serveInspectorApp(app);

    const outcome = await jsContextReplacedAsync('http://127.0.0.1:8081', TARGET, {
      act: async (client) => {
        await client.sendAsync('Page.reload', {}, 1000);
      },
      timeoutMs: 1500,
    });

    expect(outcome.kind).toBe(kind);
    expect(served.reloaded()).toHaveLength(reloads);
  });

  // Three reads after the reload: the marker poll keeps one connection, and the action has its own.
  it('reads the marker over one connection while that connection stays open', async () => {
    serveInspectorApp({ onReload: 'clears-late' });

    await jsContextReplacedAsync('http://127.0.0.1:8081', TARGET, {
      act: async (client) => {
        await client.sendAsync('Page.reload', {}, 1000);
      },
      timeoutMs: 1500,
    });

    expect(vi.mocked(WebSocket)).toHaveBeenCalledTimes(2);
  });
});
