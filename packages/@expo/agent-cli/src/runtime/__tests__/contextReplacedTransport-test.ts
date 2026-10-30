import { createServer, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { runInNewContext } from 'vm';
import { WebSocketServer } from 'ws';

import { jsContextReplacedAsync } from '../contextReplaced';
import { makeTarget } from './targetSelectionFixtures';

/** Far above the proof's 120ms read budget, so a loaded machine does not reach it. */
const HUNG_MS = 10_000;

it.each(['reject-action', 'unwritable', 'held-headers', 'held-body'] as const)(
  'owns and bounds the debugger transport: %s',
  async (mode) => {
    let globals: Record<string, unknown> =
      mode === 'unwritable' ? Object.preventExtensions({}) : {};
    let reloads = 0;
    let evictions = 0;
    const held: ServerResponse[] = [];
    let lists = 0;
    const server = createServer((_request, response) => {
      if (++lists > 1 && mode.startsWith('held-')) {
        held.push(response);
        if (mode === 'held-body') {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.write('[');
        }
        return;
      }
      const port = (server.address() as AddressInfo).port;
      response.end(
        JSON.stringify([makeTarget({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/inspector` })])
      );
    });
    const wss = new WebSocketServer({ server });
    wss.on('connection', (socket) => {
      // The inspector proxy evicts older connections on single-debugger pages.
      for (const peer of wss.clients)
        if (peer !== socket) {
          evictions++;
          peer.close();
        }
      socket.on('message', (data) => {
        const request = JSON.parse(String(data));
        if (request.method === 'Page.reload') {
          reloads++;
          if (mode === 'reject-action') {
            socket.send(
              JSON.stringify({
                id: request.id,
                error: { code: -32601, message: 'Rejected reload' },
              })
            );
          } else {
            socket.send(JSON.stringify({ id: request.id, result: {} }));
            if (mode.startsWith('held-')) {
              globals = {};
              socket.close();
            }
          }
          return;
        }
        const value = runInNewContext(request.params.expression, { globalThis: globals });
        socket.send(
          JSON.stringify({ id: request.id, result: { result: { type: typeof value, value } } })
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    let hungTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = jsContextReplacedAsync(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        { id: '1' },
        {
          timeoutMs: 120,
          act: async (session) => {
            await session.sendAsync('Page.reload', {}, 200);
            // Let the server-side close arrive before attempting reconnect discovery.
            if (mode.startsWith('held-')) await new Promise((resolve) => setTimeout(resolve, 25));
          },
        }
      );
      if (mode === 'reject-action') {
        await expect(result).rejects.toThrow('Rejected reload');
        expect(evictions).toBe(0);
        expect(Object.keys(globals)).toEqual([]);
      } else {
        // The server never finishes a held list, so only the proof's own bound can settle it.
        const hung = new Promise<'hung'>((resolve) => {
          hungTimer = setTimeout(resolve, HUNG_MS, 'hung');
        });
        const settled = await Promise.race([result, hung]);
        expect(settled === 'hung' ? settled : settled.kind).toBe(
          mode === 'unwritable' ? 'unmarkable' : 'not-replaced'
        );
        expect(reloads).toBe(mode === 'unwritable' ? 0 : 1);
        if (mode.startsWith('held-')) {
          expect(held).toHaveLength(1);
          await new Promise((resolve) => setTimeout(resolve, 30));
          expect(held[0]!.destroyed).toBe(true);
        }
      }
    } finally {
      clearTimeout(hungTimer);
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  HUNG_MS * 2
);
