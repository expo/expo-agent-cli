import { WebSocket } from 'ws';

import { MockWebSocket } from './MockWebSocket';

/**
 * One app behind the dev server's inspector proxy, served through a mocked `ws`.
 *
 * The test file mocks `ws` (`vi.mock('ws', …)` with `WebSocket` as a `vi.fn`), and this answers the
 * two CDP methods a reload sends: `Runtime.evaluate`, which sets and reads a global, and
 * `Page.reload`. Every other socket, such as the command socket on `/message`, opens and answers
 * nothing.
 */
export function serveInspectorApp({
  onReload = 'clears',
  evaluate = 'answers',
  onPageReload,
}: {
  /**
   * What a `Page.reload` does to the app's globals: a new context at once, a new context that also
   * closes every other debugger connection, a new context after one failed and one stale read, a
   * context that fails every read, or nothing (the context outlived it).
   */
  onReload?: 'clears' | 'clears-and-drops' | 'clears-late' | 'unreadable' | 'nothing';
  /** `method-not-found` is a runtime with no debugger to evaluate in, as Expo Go for Android has. */
  evaluate?: 'answers' | 'method-not-found';
  /** Called on each `Page.reload`, for a test whose dev server list moves when an app reloads. */
  onPageReload?: () => void;
} = {}): { reloaded(): string[] } {
  const globals = new Map<string, unknown>();
  const reloaded: string[] = [];
  let readsAfterReload = 0;
  const sockets: MockWebSocket[] = [];
  vi.mocked(WebSocket).mockImplementation(function (url: string) {
    const opened = new MockWebSocket(url, (request, socket) => {
      if (!url.includes('/inspector/')) {
        return;
      }
      const answer = (body: object) =>
        socket.emit('message', JSON.stringify({ id: request.id, ...body }));
      const value = (result: unknown) =>
        answer({ result: { result: { type: typeof result, value: result } } });
      if (request.method === 'Page.reload') {
        reloaded.push(url);
        if (onReload !== 'nothing') {
          globals.clear();
        }
        onPageReload?.();
        answer({ result: {} });
        if (onReload === 'clears-and-drops') {
          sockets.filter((each) => each !== socket).forEach((each) => each.close());
        }
        return;
      }
      if (evaluate === 'method-not-found') {
        return answer({ error: { code: -32601, message: 'Method not found' } });
      }
      const expression = String(request.params?.expression ?? '');
      const set = /(__expoAgentCli\w*) = "([^"]+)"/.exec(expression);
      if (set) {
        globals.set(set[1]!, set[2]);
        return value(set[2]);
      }
      const read = /(__expoAgentCli\w*) === "([^"]+)"/.exec(expression);
      if (read == null) {
        return value(undefined);
      }
      if (reloaded.length > 0 && onReload === 'unreadable') {
        return answer({ error: { code: -32000, message: 'Execution context was destroyed.' } });
      }
      if (reloaded.length > 0 && onReload === 'clears-late' && readsAfterReload++ < 2) {
        return readsAfterReload === 1
          ? answer({ error: { code: -32000, message: 'Execution context was destroyed.' } })
          : value(true);
      }
      return value(globals.get(read[1]!) === read[2]);
    });
    sockets.push(opened);
    return opened;
  } as never);
  return { reloaded: () => [...reloaded] };
}
