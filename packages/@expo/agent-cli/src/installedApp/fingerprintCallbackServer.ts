// @ref llp/0028-installed-app-check.rfc.md §How the file is read
// The one-shot HTTP server a physical iOS device posts its embedded fingerprint to.

import http from 'http';

import { resolveLanHost } from '../followups/network';
import { CommandError } from '../utils/errors';
import {
  CALLBACK_PATH,
  DEFAULT_RESPONSE_TIMEOUT_MS,
  FINGERPRINT_BODY_KEY,
  NONCE_BODY_KEY,
} from './fingerprintCheckProtocol';

export type FingerprintCallbackResult = { fingerprint: string | null };

/** A real response is a few dozen bytes. The port is open to the whole LAN. */
const MAX_BODY_LENGTH = 4096;

export interface FingerprintCallbackServer {
  /** URL the app posts its response to, reachable from the LAN. */
  callbackUrl: string;
  /** The app's response, or `null` on timeout. Never rejects. */
  result: Promise<FingerprintCallbackResult | null>;
  /** Stop listening and clear the timeout. Safe to call more than once. */
  close(): void;
}

export interface FingerprintCallbackServerOptions {
  nonce: string;
  timeoutMs?: number;
  /** Injected for tests. */
  lanHost?: () => string | null;
}

/**
 * Start listening for the app's response, matched by nonce.
 *
 * @throws {CommandError} `NO_LAN_ADDRESS` when this machine has no address a phone can reach.
 */
export async function startFingerprintCallbackServerAsync({
  nonce,
  timeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS,
  lanHost = resolveLanHost,
}: FingerprintCallbackServerOptions): Promise<FingerprintCallbackServer> {
  const host = lanHost();
  if (!host) {
    throw new CommandError(
      'NO_LAN_ADDRESS',
      [
        `This computer has no LAN address, so a physical device cannot reach it to report its fingerprint.`,
        `Why: the device posts the fingerprint back over Wi-Fi, and only a routable address of this computer can receive it.`,
        `How: connect this computer to the same Wi-Fi network as the device, then run this command again.`,
      ].join('\n')
    );
  }

  let settled = false;
  let resolveResult!: (value: FingerprintCallbackResult | null) => void;
  const result = new Promise<FingerprintCallbackResult | null>((resolve) => {
    resolveResult = resolve;
  });
  const settleOnce = (value: FingerprintCallbackResult | null): void => {
    if (!settled) {
      settled = true;
      resolveResult(value);
    }
  };

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url?.split('?')[0] !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_LENGTH) {
        res.writeHead(413).end();
        req.destroy();
      }
    });
    req.on('end', () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const receivedNonce = parsed?.[NONCE_BODY_KEY];
      const fingerprint = parsed?.[FINGERPRINT_BODY_KEY];
      const valid =
        typeof receivedNonce === 'string' &&
        (fingerprint === null || typeof fingerprint === 'string');
      // A wrong or malformed request must not use up the one chance to hear from the app.
      if (!valid || receivedNonce !== nonce) {
        res.writeHead(400).end();
        return;
      }
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ status: 'ok' }));
      settleOnce({ fingerprint: fingerprint as string | null });
      close();
    });
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  function close(): void {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    // `server.close()` alone waits for keep-alive sockets, and iOS's URLSession keeps them open;
    // that would keep the process alive past the verdict.
    server.closeAllConnections();
    server.close();
    settleOnce(null);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '0.0.0.0' }, resolve);
  });
  timer = setTimeout(close, timeoutMs);

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { callbackUrl: `http://${host}:${port}${CALLBACK_PATH}`, result, close };
}
