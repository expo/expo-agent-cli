// The debugger socket to one target, through the dev server's inspector proxy. Kept apart from
// `./cdpClient`, which imports target selection, so that selection can probe a target.
import { WebSocket } from 'ws';

/**
 * Metro's inspector proxy rejects WebSocket handshakes without a same-origin `Origin`
 * header (HTTP 401), so every connection must present the dev server's own origin.
 * Derive it from the `ws://`/`wss://` debugger URL.
 */
export function deriveInspectorOrigin(webSocketDebuggerUrl: string): string {
  const url = new URL(webSocketDebuggerUrl);
  return `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`;
}

export function createInspectorWebSocket(webSocketDebuggerUrl: string): WebSocket {
  return new WebSocket(webSocketDebuggerUrl, {
    headers: { origin: deriveInspectorOrigin(webSocketDebuggerUrl) },
  });
}
