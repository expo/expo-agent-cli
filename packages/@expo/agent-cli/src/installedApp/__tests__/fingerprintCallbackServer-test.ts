// @ref llp/0028-installed-app-check.rfc.md §Proof
// Real HTTP over loopback: the advertised host is an injected LAN address, and every request
// here connects to 127.0.0.1 on the port the server picked.
import http from 'http';
import net from 'net';

import { startFingerprintCallbackServerAsync } from '../fingerprintCallbackServer';
import { CALLBACK_PATH } from '../fingerprintCheckProtocol';

const lanHost = () => '192.168.1.50';

function loopbackUrl(callbackUrl: string): string {
  const url = new URL(callbackUrl);
  return `http://127.0.0.1:${url.port}${url.pathname}`;
}

function post(url: string, body: string) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
}

describe(startFingerprintCallbackServerAsync, () => {
  it(`advertises the LAN host, and resolves with the fingerprint when the nonce matches`, async () => {
    const server = await startFingerprintCallbackServerAsync({ nonce: 'abc', lanHost });
    try {
      expect(server.callbackUrl).toMatch(/^http:\/\/192\.168\.1\.50:\d+\/fingerprint-callback$/);
      const response = await post(
        loopbackUrl(server.callbackUrl),
        JSON.stringify({ nonce: 'abc', fingerprint: 'hash-1' })
      );
      expect(response.status).toBe(200);
      await expect(server.result).resolves.toEqual({ fingerprint: 'hash-1' });
    } finally {
      server.close();
    }
  });

  it(`passes a null fingerprint through unchanged`, async () => {
    const server = await startFingerprintCallbackServerAsync({ nonce: 'abc', lanHost });
    try {
      await post(
        loopbackUrl(server.callbackUrl),
        JSON.stringify({ nonce: 'abc', fingerprint: null })
      );
      await expect(server.result).resolves.toEqual({ fingerprint: null });
    } finally {
      server.close();
    }
  });

  it(`answers 400 to a wrong nonce or a malformed body, and keeps waiting`, async () => {
    const server = await startFingerprintCallbackServerAsync({
      nonce: 'abc',
      timeoutMs: 5000,
      lanHost,
    });
    try {
      const url = loopbackUrl(server.callbackUrl);
      expect(
        (await post(url, JSON.stringify({ nonce: 'wrong', fingerprint: 'hash-1' }))).status
      ).toBe(400);
      expect((await post(url, 'not json')).status).toBe(400);
      expect((await fetch(url)).status).toBe(404);
      expect(
        (await post(url, JSON.stringify({ nonce: 'abc', fingerprint: 'hash-2' }))).status
      ).toBe(200);
      await expect(server.result).resolves.toEqual({ fingerprint: 'hash-2' });
    } finally {
      server.close();
    }
  });

  it(`resolves null when nothing arrives before the timeout`, async () => {
    const server = await startFingerprintCallbackServerAsync({
      nonce: 'abc',
      timeoutMs: 50,
      lanHost,
    });
    try {
      await expect(server.result).resolves.toBeNull();
    } finally {
      server.close();
    }
  });

  it(`refuses a body over the cap`, async () => {
    const server = await startFingerprintCallbackServerAsync({
      nonce: 'abc',
      timeoutMs: 500,
      lanHost,
    });
    try {
      const response = await post(
        loopbackUrl(server.callbackUrl),
        `{"nonce":"abc","fingerprint":"${'x'.repeat(10_000)}"}`
      ).catch(() => null);
      // A 413 or a reset connection; never an accepted body.
      if (response) {
        expect(response.status).toBe(413);
      }
      await expect(server.result).resolves.toBeNull();
    } finally {
      server.close();
    }
  });

  it(`close() frees the port, is idempotent, and destroys an in-flight request`, async () => {
    const server = await startFingerprintCallbackServerAsync({
      nonce: 'abc',
      timeoutMs: 5000,
      lanHost,
    });
    const url = new URL(loopbackUrl(server.callbackUrl));
    const socket = net.connect(Number(url.port), url.hostname);
    socket.on('error', () => {});
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(`POST ${CALLBACK_PATH} HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n{"a`);

    server.close();
    server.close();
    await new Promise((resolve) => socket.once('close', resolve));
    await expect(server.result).resolves.toBeNull();

    // The same port binds again, which `port: 0` on a second server would not prove.
    await expect(
      new Promise<void>((resolve, reject) => {
        const probe = http.createServer();
        probe.once('error', reject);
        probe.listen({ port: Number(url.port), host: '0.0.0.0' }, () =>
          probe.close(() => resolve())
        );
      })
    ).resolves.toBeUndefined();
  });

  it(`throws NO_LAN_ADDRESS when this machine has no address a phone can reach`, async () => {
    await expect(
      startFingerprintCallbackServerAsync({ nonce: 'abc', lanHost: () => null })
    ).rejects.toMatchObject({ code: 'NO_LAN_ADDRESS' });
  });
});
