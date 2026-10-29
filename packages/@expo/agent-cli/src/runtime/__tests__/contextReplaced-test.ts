// @ref llp/0005-runtime-loop-tools.rfc.md §What proves a reload
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
    {
      name: 'reads the marker when the socket drops before Page.reload answers',
      app: { reloadAnswer: 'drops' as const },
      kind: 'replaced',
      reloads: 1,
      reason: null,
    },
    {
      name: 'does not prove a reload whose answer was lost and whose context stayed',
      app: { reloadAnswer: 'drops' as const, onReload: 'nothing' as const },
      kind: 'not-replaced',
      reloads: 1,
      reason:
        /^the answer to the action was lost \(.+\), and the marker set before it was still there/,
    },
    {
      name: 'reads the marker again over a new connection when the reload drops the old one',
      app: { onReload: 'clears-and-drops' as const },
      kind: 'replaced',
      reloads: 1,
      reason: null,
    },
    {
      name: 'reads an error or the old marker as "not yet", and asks again',
      app: { onReload: 'clears-late' as const },
      kind: 'replaced',
      reloads: 1,
      reason: null,
    },
    {
      name: 'does not take a read that fails for a new context',
      app: { onReload: 'unreadable' as const },
      kind: 'not-replaced',
      reloads: 1,
      reason: /^the last read of the marker failed: .*Execution context was destroyed/,
    },
    {
      name: 'names both the lost answer and the failed read',
      app: { reloadAnswer: 'drops' as const, onReload: 'unreadable' as const },
      kind: 'not-replaced',
      reloads: 1,
      reason:
        /^the answer to the action was lost \(.+\), and the last read of the marker failed: .*destroyed/,
    },
    {
      name: 'does not prove a reload the context outlived',
      app: { onReload: 'nothing' as const },
      kind: 'not-replaced',
      reloads: 1,
      reason: /^the marker set before it was still there/,
    },
    {
      name: 'is unprovable, and does not act, when the marker cannot be set',
      app: { evaluate: 'method-not-found' as const },
      kind: 'unmarkable',
      reloads: 0,
      reason: /Method not found/,
    },
  ])('$name', async ({ app, kind, reloads, reason }) => {
    const served = serveInspectorApp(app);

    const outcome = await jsContextReplacedAsync('http://127.0.0.1:8081', TARGET, {
      act: async (client) => {
        await client.sendAsync('Page.reload', {}, 1000);
      },
      timeoutMs: 1500,
    });

    expect(outcome).toEqual(reason ? { kind, reason: expect.stringMatching(reason) } : { kind });
    expect(served.reloaded()).toHaveLength(reloads);
  });

  it('reads once more without sleeping when less than a poll interval is left', async () => {
    serveInspectorApp({ onReload: 'clears-late' });

    // Reads at 0 ms (fails) and 250 ms (old marker) leave about 150 ms: no sleep, one more read.
    const outcome = await jsContextReplacedAsync('http://127.0.0.1:8081', TARGET, {
      act: async (client) => {
        await client.sendAsync('Page.reload', {}, 1000);
      },
      timeoutMs: 400,
    });

    expect(outcome).toEqual({ kind: 'replaced' });
  });

  it('throws an action that failed before its answer could be lost', async () => {
    const served = serveInspectorApp();

    const outcome = jsContextReplacedAsync('http://127.0.0.1:8081', TARGET, {
      act: async () => {
        throw new Error('Page.reload was never sent');
      },
      timeoutMs: 1500,
    });

    await expect(outcome).rejects.toThrow('Page.reload was never sent');
    expect(served.reloaded()).toHaveLength(0);
  });

  it('does not mistake another concurrent check for a replaced context', async () => {
    const served = serveInspectorApp({ onReload: 'nothing' });
    let releaseFirst!: () => void;
    let firstMarked!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      firstMarked = resolve;
    });
    const bothMarked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = jsContextReplacedAsync('http://127.0.0.1:8081', TARGET, {
      act: async (client) => {
        firstMarked();
        await bothMarked;
        await client.sendAsync('Page.reload', {}, 1000);
      },
      timeoutMs: 1,
    });
    await firstReady;
    const second = jsContextReplacedAsync('http://127.0.0.1:8081', TARGET, {
      act: async (client) => {
        releaseFirst();
        await client.sendAsync('Page.reload', {}, 1000);
      },
      timeoutMs: 1,
    });

    const outcomes = await Promise.all([first, second]);
    expect(outcomes.map(({ kind }) => kind)).toEqual(['not-replaced', 'not-replaced']);
    expect(served.reloaded()).toHaveLength(2);
  });
});
