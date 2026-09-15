// @ref llp/0005-runtime-loop-tools.rfc.md §How the file is read
// The one-shot HTTP server a physical iOS device posts its embedded fingerprint to.

import crypto from 'crypto';
import http from 'http';

import { resolveLanHost } from '../followups/network';
import { CommandError } from '../utils/errors';
import {
  CALLBACK_PATH,
  DEFAULT_RESPONSE_TIMEOUT_MS,
  FINGERPRINT_BODY_KEY,
  FINGERPRINT_VERSION_BODY_KEY,
  NONCE_BODY_KEY,
} from './fingerprintCheckProtocol';

export type FingerprintCallbackResult = {
  fingerprint: string | null;
  fingerprintVersion: string | null;
};

/** A real response is a few dozen bytes. The port is open to the whole LAN. */
const MAX_BODY_BYTES = 4096;

/** Constant time, because the nonce is the only thing authenticating the response. */
function nonceMatches(received: string, expected: string): boolean {
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface FingerprintCallbackServer {
  /** URL the app posts its response to, reachable from the LAN. */
  callbackUrl: string;
  /** The app's response, or `null` on timeout. Never rejects. */
  result: Promise<FingerprintCallbackResult | null>;
  /** Stop listening and clear the timeout. Safe to call more than once. */
  close(): void;
  /** Start the response budget after delivering the trigger. Idempotent. */
  armTimeout(): void;
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
    // Buffered rather than concatenated as a string: the cap is a byte budget, and a chunk can
    // split a multi-byte character.
    const chunks: Buffer[] = [];
    let bodyBytes = 0;
    req.on('data', (chunk: Buffer) => {
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400).end();
        return;
      }
      const receivedNonce = parsed?.[NONCE_BODY_KEY];
      const fingerprint = parsed?.[FINGERPRINT_BODY_KEY];
      // A responder built before the version was added sends no key at all, which reads as null.
      const fingerprintVersion = parsed?.[FINGERPRINT_VERSION_BODY_KEY] ?? null;
      const valid =
        typeof receivedNonce === 'string' &&
        (fingerprint === null || typeof fingerprint === 'string') &&
        (fingerprintVersion === null || typeof fingerprintVersion === 'string');
      // A wrong or malformed request must not use up the one chance to hear from the app.
      if (!valid || !nonceMatches(receivedNonce as string, nonce)) {
        res.writeHead(400).end();
        return;
      }
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ status: 'ok' }));
      settleOnce({
        fingerprint: fingerprint as string | null,
        fingerprintVersion: fingerprintVersion as string | null,
      });
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
  function armTimeout(): void {
    if (!settled && !timer) timer = setTimeout(close, timeoutMs);
  }

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { callbackUrl: `http://${host}:${port}${CALLBACK_PATH}`, result, close, armTimeout };
}
