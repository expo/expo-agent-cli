// @ref llp/0010-agent-conventions.rfc.md §Needs-human protocol — the port carve-out.
//
// The samples are the three spellings the Expo CLI actually produces, so a wording change upstream
// fails here rather than silently turning a recoverable stop back into "a person must answer this".

import {
  defaultMetroPort,
  detectPortCollision,
  findFreePortAsync,
  formatPortMove,
  isPortBindableAsync,
  parsePortMove,
} from '../portCollision';

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

// @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port can
// complete — friction run 5, F48-4. The move is decided in the child process of a `--detach` run
// and read back by the parent, so the sentence is a *protocol* between two processes of this CLI
// rather than only prose. These tests pin both ends of it: the parent's report is wrong the moment
// the two drift, and nothing else would notice.
describe('the port move a detached run reports', () => {
  it(`round-trips a move off a port the Expo CLI named`, () => {
    const line = formatPortMove({ from: 8081, to: 8210 });

    expect(line).toContain('8081');
    expect(line).toContain('8210');
    expect(parsePortMove(line)).toEqual({ from: 8081, to: 8210 });
  });

  // The Expo CLI does not always name the port it wanted, and inventing one would be this CLI
  // claiming a fact it was never told. `to` is the half that is always known.
  it(`round-trips a move whose busy port was never named`, () => {
    const line = formatPortMove({ from: null, to: 8210 });

    expect(line).toContain('8210');
    expect(parsePortMove(line)).toEqual({ from: null, to: 8210 });
  });

  it(`finds the move in a log with the bundler's own output around it`, () => {
    const log = [
      'Starting project at /project',
      formatPortMove({ from: 8081, to: 8210 }),
      'Waiting on http://127.0.0.1:8210',
      'iOS Bundled 220ms',
    ].join('\n');

    expect(parsePortMove(log)).toEqual({ from: 8081, to: 8210 });
  });

  // The reason the parent parses rather than comparing the port it asked for against the port the
  // lock reports: a dev server can land on another port for reasons that are not a collision, and
  // reporting those as a move would be this command inventing a busy port nobody observed.
  it(`answers null for a log with no move in it`, () => {
    expect(parsePortMove('Starting project at /project\niOS Bundled 220ms')).toBeNull();
    expect(parsePortMove('')).toBeNull();
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
