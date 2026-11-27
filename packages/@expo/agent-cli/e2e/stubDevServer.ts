import fs from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { WebSocketServer, type WebSocket } from 'ws';

/** An `inspectorEvaluate` answer that sends no reply, as an app whose answer is lost. */
export const NO_ANSWER = Symbol('no answer');

/**
 * An `inspectorEvaluate` answer that throws in the app, as CDP reports an uncaught exception: an
 * Error has a `description`, a thrown primitive (`throw ""`) has only a `value`.
 */
export class InspectorThrows {
  constructor(readonly thrown: { description: string } | { value: string }) {}
}

/** How a stub dev server should answer, per {@link startStubDevServerAsync}. */
export type StubDevServerOptions = {
  /**
   * Debugger targets `GET /json/list` answers with — the apps a command under test will believe
   * are connected. Defaults to none, which is a dev server nothing has attached to yet. A function
   * is called on every read, for a list that changes between reads, such as one that follows a
   * device-tool invocation log. A function that returns null fails that read with a 500.
   */
  targets?: unknown[] | (() => unknown[] | null);
  /** Begin listening only after the stub Expo start creates this file. */
  readyWithFile?: string;
  /**
   * Delay before `GET /status` answers, in milliseconds.
   *
   * A real dev server does not answer while it is still coming up, and a command that waits for
   * one has to be tested against that, not only against a server that is instantly ready.
   */
  statusDelayMs?: number;
  /** Delay before the first `GET /json/list` answers, standing in for a slow first request. */
  targetsDelayMs?: number;
  /**
   * Project root the `/status` answer names in its header, as the real dev server does.
   *
   * `null` sends no header at all, which is the "undecidable" case: a dev server that names no
   * project root has not been shown to be the wrong one, and the commands that compare roots have
   * to tell that apart from a root that does not match.
   */
  projectRoot?: string | null;
  /**
   * How the stub answers a request for the entry bundle, which is what `dev:wait` checks the
   * project's own code with.
   *
   * - `compiles` — the manifest names an entry bundle, and building it succeeds.
   * - `broken` — building it answers 500 with the `TransformError` body Metro sends.
   * - `no-manifest` — `GET /` 404s, which is the "cannot decide" case a dev server too old to
   *   answer produces.
   */
  bundle?: 'compiles' | 'broken' | 'no-manifest';
  /**
   * Origin the manifest's `launchAsset.url` carries, instead of this stub's own `127.0.0.1` one.
   *
   * What the real dev server puts there is `getDevServerUrl()`, which is the **tunnel** origin
   * whenever a tunnel or a proxy is in front of it — and that is the one address a cloud simulator
   * can use (llp/0005 §Where a device reaches the dev server). A stub bound to the loopback cannot
   * be reached by a hostname, so this is how a test says "this dev server is advertising itself to
   * the world" without inventing DNS.
   */
  manifestOrigin?: string;
  /** Delay before the entry bundle answers, standing in for a cold first build. */
  bundleDelayMs?: number;
  /**
   * How the stub answers on `/message`, the client command socket `@expo/agent-cli runtime:reload` broadcasts on.
   *
   * - `v2` — the real protocol: every frame carries `version: 2`, `getpeers` is answered, and a
   *   `reload` broadcast replaces the reported peer ids, which is what a reloading app does.
   * - `deaf` — the socket opens and nothing is ever answered. This is a dev server speaking
   *   another protocol version, which drops a frame it cannot read without an error.
   * - `no-churn` — `getpeers` is answered but a broadcast changes nothing, i.e. the app did not
   *   act on the reload.
   * - `none` — no socket is mounted at all, so the upgrade is refused.
   */
  messageSocket?: 'v2' | 'deaf' | 'no-churn' | 'none';
  /**
   * Whether the debugger sockets the listed targets point at accept a connection.
   *
   * `live` (the default) is a connected app. `none` is a **stale** target: the dev server still
   * lists the page and nothing is behind it, which is what an app that was force-stopped leaves
   * behind, and what `@expo/agent-cli status` used to count as a connected app [friction run 6, F56].
   *
   * `no-debugger` is the third real state, and the one the exit-code contract turns on: the socket
   * is open and every CDP method is answered `-32601 Method not found`. That is not a double for a
   * JavaScript runtime — llp/0002 §Tier 0 doubles the dev server, not the app rules one out — it is
   * a double for a runtime having **no** debugger, which is a fact about the protocol and nothing
   * about React Native. Expo Go for Android is exactly this [observed — Expo Go 57.0.9 on an
   * Android emulator, 2026-08-22, recorded in `createDefaultTargetSelector`], and it is the state
   * that makes `--fail-on-error` exit 22 rather than report health nothing observed.
   */
  inspectorSocket?: 'live' | 'none' | 'no-debugger';
  /**
   * What a `Page.reload` sent to a `live` inspector socket does.
   *
   * - `replaces-context` (default) — the app's JavaScript context is replaced, so its marker global
   *   is gone [observed — live, iOS and Android, 2026-10-29].
   * - `keeps-context` — the context stays, so the marker survives, and every *other* app's page
   *   registers again under a new page id. This is the case a reload proof has to reject: the
   *   app did not reload and a neighbour churned. Not observed live; it models what the proof
   *   must refuse to count.
   */
  pageReload?: 'replaces-context' | 'keeps-context';
  /**
   * How the inspector socket answers `Runtime.evaluate`, for the commands that ask the app a
   * question rather than only connecting to it.
   *
   * The expression arrives as the CLI sent it, wrapper and all (`src/runtime/promiseSettling.ts`),
   * so a responder recognises the call it cares about by a marker in the source. Returning
   * `undefined` answers `{type: "undefined"}`, which is what an expression whose value is nothing
   * comes back as — and is what the target selector's own probe expects. Returning
   * {@link NO_ANSWER} sends no reply at all.
   */
  inspectorEvaluate?: (expression: string, device: string) => unknown;
  /**
   * Clients `getpeers` reports before any reload. Defaults to one that looks like an iOS app.
   *
   * An empty object is a dev server nothing has connected to, which is the case where there is
   * nothing to reload.
   */
  messagePeers?: Record<string, string | null>;
  /**
   * What `GET /json/list` reports after a reload has been asked for.
   *
   * Either mechanism asks: a `reload` broadcast on a `v2` socket, or an
   * `expo.reloadAppAsync(reason)` evaluate over the debugger.
   *
   * The peer churn and the debugger target list are two independent facts, and friction run 4
   * found `runtime:reload` believing the first about the second. The three values are the three
   * things a real app does:
   *
   * - `reconnect` (default) — the app's JavaScript registers again under a page id the dev server
   *   has never used, which is what a reload looks like [observed — 2026-08-23, live: `8a9d…-1`
   *   -> `8a9d…-2`, 761 ms after the broadcast].
   * - `stale` — the peers churn and the same target stays listed, i.e. the runtime that answers is
   *   the one from before the reload (F39).
   * - `gone` — the app quits and the list empties (F45).
   * - `late-reconnect` — the list empties *and then* the new page id appears, after
   *   {@link reloadReconnectDelayMs}. This is what `reconnect` above compresses to nothing and what
   *   a real app actually does: the runtime that was listed goes and the one that replaces it takes
   *   about half a second to register [observed — 2026-08-23, live: 506ms then 761ms]. Anything that
   *   reads the list inside that window sees an app that is not there, which is F39 for the command
   *   after the reload and F141 for the reload's own report of `appsConnected`.
   */
  reloadTargets?: 'reconnect' | 'stale' | 'gone' | 'late-reconnect';
  /** How long `late-reconnect` leaves the list empty for. */
  reloadReconnectDelayMs?: number;
  /**
   * File a `Bundled` line is appended to when a reload is asked for, or null for none.
   *
   * The dev server's own output, which a detached run captures — and the third proof of a reload
   * (`src/runtime/reload/bundleSignal.ts`, S11). A test points this at the project's
   * `.expo/dev/logs/dev-detached.log` to make the bundle the signal that answers **first**, which is
   * the only way to reproduce a reload proved while the debugger target list is still empty.
   */
  bundleLogPath?: string | null;
  /**
   * Path of a file whose existence is what makes {@link targets} appear in `GET /json/list`.
   *
   * For the device method, where the app is *started* rather than reloaded: its JavaScript runtime
   * registers because a device tool launched it, so the stub reports nothing until the stub device
   * tool has run. Without this the fixture would have to claim an app that has a debugger target
   * and no message-socket peer, which no real app is, and the reload would then be measured
   * against a target that was there all along.
   */
  targetsAppearWithFile?: string | null;
};

/** The `TransformError` body Metro answers a broken build with, recorded from an SDK 57 app. */
export const STUB_TRANSFORM_ERROR = {
  type: 'TransformError',
  lineNumber: 101,
  column: 2,
  filename: 'src/app/index.tsx',
  name: 'SyntaxError',
  message:
    "SyntaxError: /project/src/app/index.tsx: Unexpected keyword 'const'. (101:2)\n\n\u001b[0m \u001b[90m 100 |\u001b[39m function broken( {\n\u001b[31m\u001b[1m>\u001b[22m\u001b[39m\u001b[90m 101 |\u001b[39m   \u001b[36mconst\u001b[39m x \u001b[33m=\u001b[39m\u001b[0m",
  errors: [{ description: 'Unexpected keyword', filename: 'src/app/index.tsx', lineNumber: 101 }],
};

/** Path of the entry bundle the stub manifest names, matching an Expo Router project. */
const STUB_BUNDLE_PATH = '/node_modules/expo-router/entry.bundle';

/**
 * The error page the web dev server renders for a project that does not compile, cut to the fields
 * that are read [observed — `@expo/cli` `metroErrorInterface.ts`, and live on 2026-08-23].
 *
 * `<` is escaped exactly as the CLI escapes it, so the payload cannot close its own script tag.
 */
export const STUB_WEB_ERROR_PAGE = `<html><body><div id="root"></div><script id="_expo-static-error" type="application/json">${JSON.stringify(
  {
    selectedLogIndex: 0,
    logs: [
      {
        level: 'static',
        message: {
          content: stripVTControlCharacters(STUB_TRANSFORM_ERROR.message),
        },
        stack: [{ file: '/project/src/app/index.tsx', lineNumber: 101, column: 2 }],
        codeFrame: {
          content: '  101 |   const x =',
          location: { row: 101, column: 2 },
          fileName: '/project/src/app/index.tsx',
        },
      },
    ],
  }
).replace(/</g, '\\u003c')}</script></body></html>`;

/** A stub dev server, and where it listens. */
export type StubDevServer = {
  /** Origin to hand to `--dev-server-url`, e.g. `http://127.0.0.1:53421`. */
  url: string;
  port: number;
  /** How many `reload` broadcasts the command socket received. */
  broadcasts(): number;
  /** Platforms requested from the entry-bundle endpoint, in request order. */
  bundlePlatforms(): string[];
  /** The `device=` query of each inspector socket that was sent `Page.reload`, in order. */
  pageReloads(): string[];
  /** Stop listening and wait for the server to close. */
  close(): Promise<void>;
};

/**
 * Start an HTTP server that answers the two requests `@expo/agent-cli` uses to recognize a dev server:
 * `GET /status`, which a real Metro answers with `packager-status:running` and the project root in
 * a header, and `GET /json/list`, the debugger target list.
 *
 * It is a double for the protocol, not for Metro: nothing is bundled and no app is involved, so a
 * test can pin what a command does with a dev server that is up, one that is slow to answer, or
 * one with no app attached, in milliseconds and with no ports to guess. Listens on `127.0.0.1` and
 * an ephemeral port, so parallel test files never collide.
 */
export async function startStubDevServerAsync({
  targets = [],
  readyWithFile,
  statusDelayMs = 0,
  targetsDelayMs = 0,
  projectRoot = '/stub-project',
  bundle = 'compiles',
  manifestOrigin,
  bundleDelayMs = 0,
  messageSocket = 'v2',
  inspectorSocket = 'live',
  pageReload = 'replaces-context',
  messagePeers = { 'socket#1': 'role=ios' },
  reloadTargets = 'reconnect',
  reloadReconnectDelayMs = 700,
  bundleLogPath = null,
  targetsAppearWithFile = null,
  inspectorEvaluate,
}: StubDevServerOptions = {}): Promise<StubDevServer> {
  let port = 0;
  const bundlePlatforms: string[] = [];
  // Mutable, because a reload changes it: the debugger target list is the evidence a reload is
  // judged on, so a stub that always answers the same list can only test an app that never moved.
  let listedTargets: unknown[] = typeof targets === 'function' ? [] : targets;
  let nextPageId = 100;
  const server: Server = createServer((request, response) => {
    const route = (request.url ?? '').split('?')[0];

    // The manifest, which is the only thing that knows the entry path of this project. A real dev
    // server answers it with an Expo Updates manifest whose `launchAsset.url` is the bundle URL.
    if (route === '/' && request.headers['expo-platform']) {
      if (bundle === 'no-manifest') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'stub-manifest',
          runtimeVersion: 'exposdk:57.0.0',
          launchAsset: {
            key: 'bundle',
            contentType: 'application/javascript',
            url: `${manifestOrigin ?? `http://127.0.0.1:${port}`}${STUB_BUNDLE_PATH}?platform=${request.headers['expo-platform']}&dev=true`,
          },
        })
      );
      return;
    }

    // The web dev server has no manifest: `GET /` is the page a browser loads, and the entry
    // bundle is the `<script src>` appended to it. A project that does not compile never produces
    // that page — the server renders it, so the failure arrives as the 500 error page instead.
    if (route === '/') {
      if (bundle === 'no-manifest') {
        response.writeHead(404).end();
        return;
      }
      if (bundle === 'broken') {
        response.writeHead(500, { 'Content-Type': 'text/html' });
        response.end(STUB_WEB_ERROR_PAGE);
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(
        `<html><body><div id="root"></div><script src="${STUB_BUNDLE_PATH}?platform=web&dev=true" defer></script></body></html>`
      );
      return;
    }

    if (route === STUB_BUNDLE_PATH) {
      bundlePlatforms.push(new URL(request.url!, 'http://stub').searchParams.get('platform') ?? '');
      // Unreferenced, so a delay a test deliberately never waits out cannot hold the worker open.
      setTimeout(() => {
        if (bundle === 'broken') {
          response.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
          // HEAD gets the status and no body, exactly as it does from Metro.
          response.end(request.method === 'HEAD' ? '' : JSON.stringify(STUB_TRANSFORM_ERROR));
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/javascript' });
        response.end(request.method === 'HEAD' ? '' : 'var __BUNDLE_START_TIME__=0;');
      }, bundleDelayMs).unref();
      return;
    }

    if (route === '/status') {
      // The delay is the point of the option: the socket is accepted and left open, exactly as a
      // dev server that is still starting leaves a probe waiting. Unreferenced, so a long delay
      // that a test deliberately never waits out cannot hold the vitest worker open for its length.
      setTimeout(() => {
        response.writeHead(200, {
          'Content-Type': 'text/plain',
          ...(projectRoot == null ? {} : { 'X-React-Native-Project-Root': projectRoot }),
        });
        response.end('packager-status:running');
      }, statusDelayMs).unref();
      return;
    }

    if (route === '/json/list') {
      if (targetsDelayMs > 0) {
        const delay = targetsDelayMs;
        targetsDelayMs = 0;
        setTimeout(() => server.emit('request', request, response), delay).unref();
        return;
      }
      const started = targetsAppearWithFile == null || fs.existsSync(targetsAppearWithFile);
      const listed = typeof targets === 'function' ? targets() : listedTargets;
      if (listed == null) {
        response.writeHead(500).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      // Rewritten onto this stub's own port, the way a real dev server publishes its debugger URLs
      // — a fixture URL naming 8081 or no port at all is one nothing can connect to, and
      // `@expo/agent-cli status` now opens each of them to tell a live target from a page an app left
      // behind (llp/0005-runtime-loop-tools.rfc.md §Android, F56).
      response.end(JSON.stringify(started ? listed.map(onThisPort) : []));
      return;
    }

    response.writeHead(404).end();
  });

  // The client command socket, mounted the way the real dev server mounts it: an exact-path
  // upgrade on `/message`. This is a double for the *protocol*, so the `version: 2` stamp and the
  // `getpeers` request/response pair are reproduced verbatim — they are the two things a change
  // upstream would break, and they are invisible to a unit test.
  /** One listed target with its debugger URL moved onto the port this stub ended up on. */
  const onThisPort = (target: unknown): unknown => {
    const url = (target as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl;
    if (typeof url !== 'string' || !url) {
      return target;
    }
    const query = url.split('?')[1];
    return {
      ...(target as Record<string, unknown>),
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/inspector/debug${query ? `?${query}` : ''}`,
    };
  };

  /**
   * What the debugger target list reports once a reload has been *asked for*.
   *
   * The app's JavaScript runtime re-registers separately from its command-socket connection, and
   * later: the two are different connections, and believing the first about the second is friction
   * run 4's F39 and F45. Shared by the two mechanisms that ask — the `reload` broadcast and the
   * `expo.reloadAppAsync(reason)` evaluate — because the app does the same thing either way.
   */
  const applyReloadTargets = (): void => {
    if (bundleLogPath != null) {
      fs.mkdirSync(path.dirname(bundleLogPath), { recursive: true });
      fs.appendFileSync(
        bundleLogPath,
        'iOS Bundled 25ms node_modules/expo-router/entry.js (1 module)\n'
      );
    }
    if (reloadTargets === 'gone') {
      listedTargets = [];
    } else if (reloadTargets === 'reconnect') {
      listedTargets = reloadedTargets(listedTargets);
    } else if (reloadTargets === 'late-reconnect') {
      const coming = reloadedTargets(listedTargets);
      listedTargets = [];
      // Unreferenced, so a delay a test never waits out cannot hold the vitest worker open.
      setTimeout(() => {
        listedTargets = coming;
      }, reloadReconnectDelayMs).unref();
    }
  };

  /** The same targets under page ids the dev server has never used, which is what a reload does. */
  const reloadedTargets = (current: unknown[]): unknown[] => {
    const pageId = nextPageId++;
    return current.map((target) => ({
      ...(target as Record<string, unknown>),
      id: `${(target as { id?: string }).id ?? 'device'}-reloaded-${pageId}`,
    }));
  };

  const renamedTarget = (target: unknown): unknown => reloadedTargets([target])[0];

  /** The `device=` query of a listed target's debugger URL. */
  const listedDevice = (target: unknown): string | null => {
    const url = (target as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl;
    return typeof url === 'string' ? new URL(url, 'http://stub').searchParams.get('device') : null;
  };

  let peers: Record<string, string | null> = { ...messagePeers };
  let nextPeerId = 100;
  let broadcasts = 0;
  const pageReloads: string[] = [];
  const messageServer = messageSocket === 'none' ? null : new WebSocketServer({ noServer: true });
  const inspectorServer =
    inspectorSocket === 'none' ? null : new WebSocketServer({ noServer: true });
  // A runtime with no debugger: the socket is there, and every method it is asked for comes back
  // `-32601`. `live` stays silent instead, which is a runtime that is being asked nothing.
  if (inspectorSocket === 'no-debugger') {
    inspectorServer?.on('connection', (socket: WebSocket, request: IncomingMessage) => {
      const device = new URL(request.url ?? '/', 'http://stub').searchParams.get('device') ?? '';
      socket.on('message', (data) => {
        let message: { id?: unknown; method?: unknown };
        try {
          message = JSON.parse(String(data));
        } catch {
          return;
        }
        if (message.id == null) {
          return;
        }
        if (message.method === 'Page.reload') {
          pageReloads.push(device);
        }
        socket.send(
          JSON.stringify({ id: message.id, error: { code: -32601, message: 'Method not found' } })
        );
      });
    });
  }
  // A connected app that is asked nothing answers nothing, which is what `live` alone reproduces.
  // With a responder, the socket also speaks the one CDP method the reading commands send. A
  // `no-debugger` socket keeps its `-32601` answer instead: the responder is a runtime that talks,
  // and that socket's whole point is a runtime that cannot.
  //
  // `runtime:reload` beside a skipped app sends `Page.reload` to its own target, and proves it with
  // a marker global (llp/0005 §What proves a reload). Each app keeps its own globals.
  // `Page.reload` answers `{}`, replaces that one app's JavaScript context, and keeps every page
  // id, as React Native's host agent does [observed — SDK 58 development build, React Native
  // 0.88, 2026-10-21; the new context is not observed].
  const markers = new Map<string, Map<string, string>>();
  if (inspectorSocket === 'live') {
    inspectorServer?.on('connection', (socket: WebSocket, request: IncomingMessage) => {
      const device = new URL(request.url ?? '/', 'http://stub').searchParams.get('device') ?? '';
      socket.on('message', (data) => {
        let message: { id?: number; method?: string; params?: { expression?: string } };
        try {
          message = JSON.parse(String(data));
        } catch {
          return;
        }
        const reply = (result: object) => socket.send(JSON.stringify({ id: message.id, result }));
        if (message.method === 'Page.reload') {
          pageReloads.push(device);
          if (pageReload === 'replaces-context') {
            markers.delete(device);
          } else {
            listedTargets = listedTargets.map((target) =>
              listedDevice(target) === device ? target : renamedTarget(target)
            );
          }
          reply({});
          return;
        }
        if (message.method !== 'Runtime.evaluate') {
          return;
        }
        const expression = message.params?.expression ?? '';
        const globals = markers.get(device) ?? new Map<string, string>();
        markers.set(device, globals);
        const setMarker = /(__expoAgentCliReloadMarker\w*) = "([^"]+)"/.exec(expression);
        const readMarker = /(__expoAgentCliReloadMarker\w*) === "([^"]+)"/.exec(expression);
        const removeMarker = /delete globalThis\.(__expoAgentCliReloadMarker\w*)/.exec(expression);
        if (setMarker) {
          globals.set(setMarker[1]!, setMarker[2]!);
        }
        if (!setMarker && !readMarker && !removeMarker && !inspectorEvaluate) {
          return;
        }
        const value = setMarker
          ? globals.get(setMarker[1]!) === setMarker[2]
          : readMarker
            ? globals.get(readMarker[1]!) === readMarker[2]
            : removeMarker
              ? globals.delete(removeMarker[1]!)
              : inspectorEvaluate!(expression, device);
        if (value === NO_ANSWER) {
          return;
        }
        if (value instanceof InspectorThrows) {
          const exception =
            'description' in value.thrown
              ? { type: 'object', subtype: 'error', description: value.thrown.description }
              : { type: typeof value.thrown.value, value: value.thrown.value };
          reply({
            result: exception,
            exceptionDetails: {
              exceptionId: 1,
              text: 'Uncaught',
              lineNumber: 0,
              columnNumber: 0,
              exception,
            },
          });
          return;
        }
        // The reload call over the debugger reloads only with a reason: the SDK 58 native function
        // takes one string, and called with none it rejects and reloads nothing [observed — SDK 58
        // development build, Expo simulator iOS session, 2026-11-12: "Received 0 arguments, but 1
        // was expected"]. A new context has no marker.
        if (value === 'sent' && /reloadAppAsync\(\s*(["'])[^"']+\1\s*\)/.test(expression)) {
          markers.delete(device);
          applyReloadTargets();
        }
        reply({
          result:
            value === undefined
              ? { type: 'undefined' }
              : { type: typeof value === 'object' ? 'object' : typeof value, value },
        });
      });
    });
  }
  messageServer?.on('connection', (socket: WebSocket) => {
    socket.on('message', (data) => {
      if (messageSocket === 'deaf') {
        return;
      }
      let message: { version?: unknown; method?: unknown; target?: unknown; id?: unknown };
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      // A frame without the current protocol version is dropped with no answer, exactly as
      // `parseRawMessage` drops it.
      if (message.version !== 2) {
        return;
      }
      if (message.target === 'server' && message.method === 'getpeers') {
        socket.send(JSON.stringify({ id: message.id, result: peers, version: 2 }));
        return;
      }
      if (message.method === 'reload' && message.target === undefined) {
        broadcasts++;
      }
      if (message.method === 'reload' && message.target === undefined && messageSocket === 'v2') {
        // An app that acts on the reload drops its connection and makes a new one, which the dev
        // server registers under an id it has never used before.
        peers = Object.fromEntries(
          Object.values(peers).map((query) => [`socket#${nextPeerId++}`, query])
        );
        applyReloadTargets();
      }
    });
  });
  server.on('upgrade', (request, socket, head) => {
    // The inspector socket a debugger target points at. `live` keeps it open and answers nothing,
    // which is exactly what a connected app that is not being asked anything does; `none` refuses
    // the upgrade, which is what a stale page left in `/json/list` does.
    if (inspectorServer && (request.url ?? '').split('?')[0] === '/inspector/debug') {
      inspectorServer.handleUpgrade(request, socket as never, head, (ws) => {
        inspectorServer.emit('connection', ws, request);
      });
      return;
    }
    if (messageServer && (request.url ?? '').split('?')[0] === '/message') {
      messageServer.handleUpgrade(request, socket as never, head, (ws) => {
        messageServer.emit('connection', ws, request);
      });
      return;
    }
    socket.destroy();
  });

  // Nothing keeps the test process alive because of the stub: a test that forgets to close one
  // fails on its assertions, not on a vitest run that never ends.
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  // Read back rather than chosen, and captured for the manifest: the bundle URL a dev server
  // publishes is absolute, so the stub has to know the ephemeral port it ended up on.
  port = (server.address() as AddressInfo).port;
  let startup: ReturnType<typeof setInterval> | undefined;
  let relistenError: Error | undefined;
  if (readyWithFile) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    startup = setInterval(() => {
      if (fs.existsSync(readyWithFile)) {
        clearInterval(startup);
        // The port is free only while nothing else took it; close() reports a lost race.
        server.once('error', (error) => (relistenError = error));
        server.listen(port, '127.0.0.1');
      }
    }, 10).unref();
  }
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    broadcasts: () => broadcasts,
    bundlePlatforms: () => [...bundlePlatforms],
    pageReloads: () => [...pageReloads],
    close: () =>
      new Promise<void>((resolve, reject) => {
        clearInterval(startup);
        // Any request left waiting on `statusDelayMs` holds the server open otherwise.
        for (const client of [
          ...(messageServer?.clients ?? []),
          ...(inspectorServer?.clients ?? []),
        ]) {
          client.terminate();
        }
        messageServer?.close();
        inspectorServer?.close();
        server.closeAllConnections?.();
        server.close(() =>
          relistenError
            ? reject(
                new Error(`stub dev server could not listen again on ${port}: ${relistenError}`)
              )
            : resolve()
        );
      }),
  };
}
