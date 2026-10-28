import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { runInNewContext } from 'vm';
import { WebSocketServer } from 'ws';

import {
  makeDeviceInventory,
  makeTarget,
  makeTargetSelection,
} from '../../__tests__/targetSelectionFixtures';
import { classifyTargets } from '../../targetSelection';
import { rungOnePolicy, runRungOneAsync } from '../rungOne';

const BUDGET_MS = 1500;

it('shares one deadline across targets and retains each target’s proof', async () => {
  const globals = new Map<string, Record<string, unknown>>();
  // Page.reload is answered only once every own target has sent it: a serial rung never gets there.
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
        held.push(() => {
          if (id === 'a') globals.set(id, {});
          socket.send(JSON.stringify({ id: message.id, result: {} }));
        });
        if (held.length === 3) held.forEach((answer) => answer());
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
  const targets = ['a', 'b', 'c', 'foreign'].map((id) =>
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
  const classifiedTargets = classifyTargets(targets, targetSelection, deviceInventory);
  try {
    const started = Date.now();
    const outcome = await runRungOneAsync(`http://127.0.0.1:${port}`, {
      prepared: {
        targets,
        targetSelection,
        deviceInventory,
        classifiedTargets,
        policy: rungOnePolicy(classifiedTargets, targetSelection, deviceInventory),
      },
      budgetMs: BUDGET_MS,
    });
    // The rung ends at its one deadline, cleanup included.
    expect(Date.now() - started).toBeLessThan(BUDGET_MS * 2);
    expect(actions.sort()).toEqual(['a', 'b', 'c']);
    expect(outcome.kind).toBe('proved');
    expect(outcome.attempt).toMatchObject({
      method: 'page-reload',
      outcomes: [
        { targetId: 'a', outcome: 'context-replaced' },
        { targetId: 'b', outcome: 'delivered-unproved' },
        { targetId: 'c', outcome: 'delivered-unproved' },
      ],
    });
    expect(outcome.attempt.reason).toMatch(/^"a" answered from a new JavaScript context/);
  } finally {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
