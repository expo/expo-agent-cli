// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
import { vol } from 'memfs';

import { readDevRunRecord, writeDevRunRecord } from '../../devLock/runRecord';
import { findPortListenersAsync } from '../portListener';
import { claimEndedRunAsync, judgeEndedRunAsync, readEndedDevRun } from '../untrackedDevServer';

// The zombie case needs a real `ps` and a real child.
vi.unmock('child_process');
vi.unmock('node:child_process');
vi.mock('../portListener', () => ({ findPortListenersAsync: vi.fn(async () => []) }));

const projectRoot = '/project';

type Answer = { root: string } | 'refused' | 'silent';

function serve(answer: Answer) {
  globalThis.fetch = vi.fn(async (_url: string, init: RequestInit) => {
    if (answer === 'refused') throw new Error('connect ECONNREFUSED');
    if (answer === 'silent') {
      return await new Promise((_resolve, reject) =>
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      );
    }
    return {
      headers: new Headers({ 'x-react-native-project-root': encodeURI(answer.root) }),
      body: null,
    };
  }) as never;
}

/** The processes listening on the record's port. */
function listen(...pids: number[]) {
  vi.mocked(findPortListenersAsync).mockResolvedValue(
    pids.map((pid) => ({ pid, command: 'node' }))
  );
}

let livePids: Set<number>;
let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  livePids = new Set([9191]);
  vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
    if (livePids.has(pid)) return true;
    throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
  }) as never);
  vi.mocked(findPortListenersAsync).mockResolvedValue([{ pid: 9191, command: 'node' }]);
  vol.mkdirSync(projectRoot, { recursive: true });
  writeDevRunRecord(projectRoot, { pid: 4242, port: 8082, serverPid: 9191 });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe(judgeEndedRunAsync, () => {
  it(`names the orphan on the port of a run that died, when its own listener names this project`, async () => {
    serve({ root: projectRoot });

    await expect(judgeEndedRunAsync(projectRoot)).resolves.toEqual({
      kind: 'orphan',
      server: {
        port: 8082,
        url: 'http://127.0.0.1:8082',
        runPid: 4242,
        listener: { pid: 9191, command: 'node' },
      },
    });
  });

  it.each([
    // A server started by hand (`npx expo start`) has no record.
    ['no run left a record', () => vol.reset(), null],
    ['the run is alive', () => livePids.add(4242), null],
    // A Metro started by hand on the port of a run that died with its own Metro (a closed terminal).
    ['another process listens on the port', () => listen(5151), 'stale'],
    ['another project took the port', () => (listen(5151), serve({ root: '/other' })), 'stale'],
    ['nothing listens on the port', () => (listen(), serve('refused')), 'stale'],
    // Nothing proved: the record stays for a later read.
    ['the read runs out of time', () => serve('silent'), null],
    ['this machine will not name the listener', () => listen(), null],
    // `expo start --localhost` on [::1] beside the run's Metro on 127.0.0.1: which one answered?
    ['a second process listens beside its own', () => listen(9191, 5151), null],
    // On [::1] only, say: its own listener is there, so the record is not spent.
    ['its own listener refuses /status', () => serve('refused'), null],
  ] as const)(`judges %s, and changes nothing on disk`, async (_, arrange, kind) => {
    serve({ root: projectRoot });
    arrange();
    const before = readDevRunRecord(projectRoot);

    const verdict = await judgeEndedRunAsync(projectRoot);

    expect(verdict?.kind ?? null).toBe(kind);
    expect(readDevRunRecord(projectRoot)).toEqual(before);
  });
});

describe(claimEndedRunAsync, () => {
  it.each([
    ['keeps a record that proved nothing', 'silent', true],
    ['removes a spent record', 'refused', false],
  ] as const)(`%s`, async (_, answer, kept) => {
    if (answer === 'refused') listen();
    serve(answer);

    await expect(claimEndedRunAsync(projectRoot)).resolves.toBeNull();
    expect(readDevRunRecord(projectRoot) != null).toBe(kept);
  });
});

describe(readEndedDevRun, () => {
  // A harness that never reaps its children keeps a killed run as a zombie: `kill -0` still
  // succeeds, and the run reads as alive.
  it.skipIf(process.platform === 'win32')(`reads a run left as a zombie as ended`, async () => {
    vi.mocked(process.kill).mockRestore();
    // `sleep 0` exits and is never reaped: its parent shell became `sleep 5`.
    const { spawn } = await import('child_process');
    const parent = spawn('sh', ['-c', 'sleep 0 & echo $!; exec sleep 5']);
    const zombie = Number(
      await new Promise<string>((resolve) =>
        parent.stdout.once('data', (data) => resolve(`${data}`))
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    writeDevRunRecord(projectRoot, { pid: zombie, port: 8082, serverPid: 9191 });

    try {
      expect(readEndedDevRun(projectRoot)).toMatchObject({ pid: zombie });
    } finally {
      parent.kill('SIGKILL');
    }
  });
});
