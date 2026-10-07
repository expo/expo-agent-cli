// @ref llp/0010-agent-conventions.rfc.md §Needs-human protocol — the port carve-out.
//
// The samples are the three spellings the Expo CLI actually produces, so a wording change upstream
// fails here rather than silently turning a recoverable stop back into "a person must answer this".

import net from 'net';

import {
  defaultMetroPort,
  detectPortCollision,
  findFreePortAsync,
  formatPortMove,
  isPortBindableAsync,
  resolvePlannedPortAsync,
} from '../portCollision';

/** Hold a port on the unspecified address, the way another project's Metro does. */
async function listenDualStackAsync(): Promise<net.Server> {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.once('error', () => server.listen(0, '0.0.0.0', () => resolve()));
    server.listen({ port: 0, host: '::', ipv6Only: false }, () => resolve());
  });
  return server;
}

function portOf(server: net.Server): number {
  return (server.address() as net.AddressInfo).port;
}

async function closeAsync(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe(detectPortCollision, () => {
  // What the friction run captured, verbatim: the prompt helper quotes the question it could not
  // ask under `Required input:`.
  it(`reads the question the prompt helper quoted back`, () => {
    const output = [
      'Port 8180 is running node in another window',
      '  /Users/someone/app (pid 4242)',
      "Input is required, but 'npx expo' is in non-interactive mode.",
      'Required input:',
      '> Use port 8181 instead?',
    ].join('\n');

    expect(detectPortCollision(output)).toEqual({ requestedPort: 8180, offeredPort: 8181 });
  });

  it(`reads the line above the question when the question is gone`, () => {
    expect(detectPortCollision('› Port 8081 is being used by another process')).toEqual({
      requestedPort: 8081,
      offeredPort: null,
    });
  });

  // The newer branch of `choosePortAsync`, which throws instead of asking for an explicit port.
  it(`reads the non-interactive refusal of an explicit port`, () => {
    const output = `Port 8180 is unavailable and 'npx expo' is running in non-interactive mode, so it can't prompt to use another port.`;

    expect(detectPortCollision(output)).toEqual({ requestedPort: 8180, offeredPort: null });
  });

  // What `expo run:*` printed with another project's Metro on 8081 and no terminal, before it built,
  // deep-linked the app to that Metro, and exited 0 [observed — live suite, 2026-10-05].
  it(`reads the run:* output that skipped the dev server on a busy port`, () => {
    const output = [
      '› Port 8081 is being used by another process',
      "Input is required, but 'npx expo' is in non-interactive mode.",
      '› Use port 8082 instead?',
      '› Skipping dev server',
    ].join('\n');

    expect(detectPortCollision(output)).toEqual({ requestedPort: 8081, offeredPort: 8082 });
  });

  // `choosePortAsync` with `reuseExistingPort` returns before it logs a `Port N is` line when the
  // holder is this project's own dev server: the run reuses it.
  it(`answers null for a skip that reuses this project's dev server`, () => {
    const output = [
      '› Skipping dev server',
      '› Build Succeeded',
      '› Opening exp+stub://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081',
    ].join('\n');

    expect(detectPortCollision(output)).toBeNull();
  });

  // Metro's own bind failing after the port was picked: another worktree took it in between
  // [observed — two worktrees resolving the port at once, 2026-10-05].
  it(`reads Metro's bind failure on a port taken after it was picked`, () => {
    const output = [
      'Starting project at /Users/someone/app',
      'Error: listen EADDRINUSE: address already in use :::8082',
      '    at Server.setupListenHandle [as _listen2] (node:net:1940:16)',
      '    at listenInCluster (node:net:1997:12)',
    ].join('\n');

    expect(detectPortCollision(output)).toEqual({ requestedPort: 8082, offeredPort: null });
    expect(
      detectPortCollision('Error: listen EADDRINUSE: address already in use 127.0.0.1:8083')
    ).toEqual({ requestedPort: 8083, offeredPort: null });
  });

  // `expo run:*` with an explicit port that was taken while it compiled (`ensurePortAvailabilityAsync`).
  it(`reads the run:* stop for a port taken during the build`, () => {
    const output =
      'CommandError: Port "8081" became busy running another process while the app was compiling. Re-run command to use a new port.';

    expect(detectPortCollision(output)).toEqual({ requestedPort: 8081, offeredPort: null });
  });

  it.each([
    ['nothing at all', ''],
    ['another prompt entirely', "Input is required, but 'npx expo' is in non-interactive mode."],
    ['a build failure that mentions a port', 'Could not connect to http://127.0.0.1:8081'],
  ])(`answers null for %s`, (_name, output) => {
    expect(detectPortCollision(output)).toBeNull();
  });
});

describe(findFreePortAsync, () => {
  it(`answers a port nothing can be bound on`, async () => {
    const port = await findFreePortAsync(49500);

    expect(port).not.toBeNull();
    expect(await isPortBindableAsync(port!)).toBe(true);
  });

  it(`does not offer a port that is taken`, async () => {
    const net = require('net') as typeof import('net');
    const server = net.createServer();
    // A fixed port can be reserved by Windows even when nothing is listening on it.
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as import('net').AddressInfo).port;

    try {
      expect(await isPortBindableAsync(port)).toBe(false);
      const free = await findFreePortAsync(port);
      expect(free).not.toBeNull();
      expect(free).not.toBe(port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // A Metro of another project on `*:8081` (IPv6, dual-stack) left `127.0.0.1:8081` bindable, so the
  // probe called the port free [observed — macOS, 2026-10-05: `127.0.0.1` ok, `::` and `0.0.0.0`
  // EADDRINUSE against pid 93886].
  it(`does not offer a port a dual-stack listener on the unspecified address holds`, async () => {
    const net = require('net') as typeof import('net');
    const server = net.createServer();
    await new Promise<void>((resolve) => {
      server.once('error', () => {
        // No IPv6 on this machine: the IPv4 unspecified address is the same shape of listener.
        server.listen(0, '0.0.0.0', () => resolve());
      });
      server.listen({ port: 0, host: '::', ipv6Only: false }, () => resolve());
    });
    const port = (server.address() as import('net').AddressInfo).port;

    try {
      expect(await isPortBindableAsync(port)).toBe(false);
      const free = await findFreePortAsync(port);
      expect(free).not.toBeNull();
      expect(free).not.toBe(port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port is not a step only a person can
// complete — the sentence a person reads when the dev server is not on the port it wanted. It
// carries no protocol: a `--detach` parent computes the move from the plan and the lock.
describe(formatPortMove, () => {
  it(`says the plan moved off a busy port before anything ran`, () => {
    expect(formatPortMove({ busy: 8081, to: 8082, when: 'plan' })).toBe(
      'Port 8081 is busy; the dev server uses 8082.'
    );
  });

  it(`says the retry moved off a port taken before the dev server bound it`, () => {
    expect(formatPortMove({ busy: 8082, to: 8083, when: 'retry' })).toBe(
      'Port 8082 was taken before the dev server bound it; the dev server uses 8083.'
    );
  });

  // The Expo CLI does not always name the port it wanted, and inventing one would be this CLI
  // claiming a fact it was never told.
  it(`names no busy port when none was named`, () => {
    expect(formatPortMove({ busy: null, to: 8210, when: 'retry' })).toBe(
      'The port the dev server wanted is busy; it uses 8210.'
    );
  });
});

// @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port is not a step only a person can
// complete — the port the plan's steps are given, picked before any of them runs.
describe(resolvePlannedPortAsync, () => {
  it(`keeps the preferred port when it is free`, async () => {
    const preferred = (await findFreePortAsync(49600))!;

    expect(await resolvePlannedPortAsync(null, { preferred })).toEqual({
      port: preferred,
      movedFrom: null,
      bindable: true,
    });
  });

  it(`moves off a preferred port another project's Metro holds on the unspecified address`, async () => {
    const server = await listenDualStackAsync();
    const busy = portOf(server);
    try {
      const planned = await resolvePlannedPortAsync(null, { preferred: busy });

      expect(planned.movedFrom).toBe(busy);
      expect(planned.port).toBeGreaterThan(busy);
      expect(planned.bindable).toBe(true);
    } finally {
      await closeAsync(server);
    }
  });

  // A named port is a requirement: it is never moved, and the caller learns whether it is free.
  it(`keeps a named port, and says when it is taken`, async () => {
    const server = await listenDualStackAsync();
    const busy = portOf(server);
    try {
      expect(await resolvePlannedPortAsync(busy)).toEqual({
        port: busy,
        movedFrom: null,
        bindable: false,
      });
    } finally {
      await closeAsync(server);
    }
  });
});

describe(defaultMetroPort, () => {
  afterEach(() => {
    delete process.env.RCT_METRO_PORT;
  });

  it(`is Expo's 8081`, () => {
    delete process.env.RCT_METRO_PORT;
    expect(defaultMetroPort()).toBe(8081);
  });

  // The variable `expo start` and `expo run:*` read their own default from.
  it(`follows RCT_METRO_PORT`, () => {
    process.env.RCT_METRO_PORT = '8300';
    expect(defaultMetroPort()).toBe(8300);
  });
});
