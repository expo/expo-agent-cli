import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { runInNewContext } from 'vm';
import { WebSocketServer } from 'ws';

import {
  makeDeviceInventory,
  makeTarget,
  makeTargetSelection,
} from '../../__tests__/targetSelectionFixtures';
import { prepareRungOne, runRungOneAsync } from '../rungOne';

const BUDGET_MS = 3000;

/**
 * Rung 1 against a fake inspector: each own id answers `Page.reload`, and the ids in `replaces` get
 * a new context. `holdUntil` holds every answer until that many `Page.reload`s arrived. The ids in
 * `dropOnReload` close their socket instead of answering, and keep their context.
 */
async function runRungOneBesideForeignAsync(
  ids: string[],
  {
    replaces,
    holdUntil = 0,
    budgetMs = BUDGET_MS,
    dropOnReload = [],
  }: { replaces: string[]; holdUntil?: number; budgetMs?: number; dropOnReload?: string[] }
) {
  const globals = new Map<string, Record<string, unknown>>();
  const held: (() => void)[] = [];
  const actions: string[] = [];
  const server = createServer((_request, response) => response.end(JSON.stringify(targets)));
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, request) => {
    const id = new URL(request.url!, 'http://stub').pathname.slice(1);
    socket.on('message', (data) => {
      const message = JSON.parse(String(data));
      if (message.method === 'Page.reload') {
        actions.push(id);
        if (dropOnReload.includes(id)) {
          socket.terminate();
          return;
        }
        held.push(() => {
          if (replaces.includes(id)) globals.set(id, {});
          socket.send(JSON.stringify({ id: message.id, result: {} }));
        });
        if (held.length >= holdUntil) held.splice(0).forEach((answer) => answer());
        return;
      }
      const context = globals.get(id) ?? {};
      globals.set(id, context);
      const value = runInNewContext(message.params.expression, { globalThis: context });
      socket.send(
        JSON.stringify({ id: message.id, result: { result: { type: typeof value, value } } })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const targets = [...ids, 'foreign'].map((id) =>
    makeTarget({
      id,
      deviceName: id,
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/${id}`,
      reactNative: { capabilities: { nativePageReloads: true }, logicalDeviceId: id },
    })
  );
  const targetSelection = makeTargetSelection();
  const deviceInventory = makeDeviceInventory({
    booted: [{ name: 'foreign', udid: 'FOREIGN' }],
    iosBindings: [{ udid: 'FOREIGN', name: 'foreign', own: false, projectRoot: '/other' }],
  });
  try {
    const started = Date.now();
    const outcome = await runRungOneAsync(`http://127.0.0.1:${port}`, {
      prepared: prepareRungOne(targets, targetSelection, deviceInventory),
      budgetMs,
    });
    return { outcome, elapsed: Date.now() - started, actions, globals };
  } finally {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

it('sends Page.reload to every own target at once, and the first proof stops the others', async () => {
  // A serial rung never gets every answer: each is held until all three were sent.
  const { outcome, elapsed, actions, globals } = await runRungOneBesideForeignAsync(
    ['a', 'b', 'c'],
    { replaces: ['a'], holdUntil: 3 }
  );
  expect(elapsed).toBeLessThan(BUDGET_MS / 2);
  expect(actions.sort()).toEqual(['a', 'b', 'c']);
  expect(outcome.kind).toBe('proved');
  expect(outcome.attempt).toMatchObject({
    method: 'page-reload',
    outcomes: [
      { targetId: 'a', outcome: 'context-replaced' },
      { targetId: 'b', outcome: 'not-needed' },
      { targetId: 'c', outcome: 'not-needed' },
    ],
  });
  expect(outcome.attempt.reason).toMatch(/^"a" answered from a new JavaScript context/);
  // A stopped check still removes its marker.
  expect(Object.keys(globals.get('b')!)).toEqual([]);
  expect(Object.keys(globals.get('c')!)).toEqual([]);
});

it('watches an own target that keeps its context until the deadline, cleanup included', async () => {
  const { outcome, elapsed, globals } = await runRungOneBesideForeignAsync(['a'], {
    replaces: [],
  });
  expect(elapsed).toBeGreaterThan(BUDGET_MS - 400);
  expect(elapsed).toBeLessThan(BUDGET_MS * 2);
  expect(outcome.kind).toBe('delivered');
  expect(outcome.attempt).toMatchObject({
    outcomes: [{ targetId: 'a', outcome: 'delivered-unproved' }],
  });
  expect(Object.keys(globals.get('a')!)).toEqual([]);
});

it('reports a mark the spent budget stopped as not delivered, not as unprovable', async () => {
  const { outcome, actions } = await runRungOneBesideForeignAsync(['a'], {
    replaces: ['a'],
    budgetMs: 0,
  });
  expect(actions).toEqual([]);
  expect(outcome.kind).toBe('not-delivered');
  expect(outcome.attempt).toMatchObject({
    outcomes: [{ targetId: 'a', outcome: 'not-delivered' }],
  });
  expect(outcome.attempt.reason).not.toContain('could carry the marker');
});

it('reports a Page.reload whose answer was lost as not delivered, not as answered', async () => {
  const { outcome, actions } = await runRungOneBesideForeignAsync(['a'], {
    replaces: [],
    dropOnReload: ['a'],
    budgetMs: 1500,
  });
  expect(actions).toEqual(['a']);
  expect(outcome.kind).toBe('not-delivered');
  expect(outcome.attempt).toMatchObject({
    delivered: false,
    outcomes: [{ targetId: 'a', outcome: 'not-delivered' }],
  });
  expect(outcome.attempt.reason).toContain('the answer to the action was lost');
});
