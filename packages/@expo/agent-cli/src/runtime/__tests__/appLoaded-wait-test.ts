import { waitForLoadedAppAsync } from '../appLoaded';
import { probeDevServerAsync } from '../devServer';

vi.mock('../devServer', () => ({ probeDevServerAsync: vi.fn() }));

const URL = 'http://127.0.0.1:8081';
const classify = async (targets: any[]) => ({ read: targets });
const reachableEmpty = { reachable: true, targets: [] };

function hangUntilAborted(_url: string, { signal }: { signal?: AbortSignal } = {}) {
  return new Promise<{ reachable: false; targets: [] }>((resolve) =>
    signal?.addEventListener('abort', () => resolve({ reachable: false, targets: [] }))
  );
}

afterEach(() => {
  vi.resetAllMocks();
});

it(`reports an answering server when an earlier poll reached it and the last failed`, async () => {
  vi.mocked(probeDevServerAsync)
    .mockResolvedValueOnce(reachableEmpty)
    .mockResolvedValue({ reachable: false, targets: [], reason: 'timed out' });

  const wait = await waitForLoadedAppAsync(URL, classify, Date.now() + 700);

  expect(wait).toEqual({ kind: 'not-attached', devServerAnswered: true });
});

it(`reports a server that no poll reached as not answering`, async () => {
  vi.mocked(probeDevServerAsync).mockResolvedValue({ reachable: false, targets: [], reason: 'x' });

  const wait = await waitForLoadedAppAsync(URL, classify, Date.now() + 300);

  expect(wait).toEqual({ kind: 'not-attached', devServerAnswered: false });
});

it(`aborts a hung probe at the deadline`, async () => {
  vi.mocked(probeDevServerAsync).mockImplementation(hangUntilAborted);
  const startedAt = Date.now();

  const wait = await waitForLoadedAppAsync(URL, classify, startedAt + 300);

  expect(wait).toMatchObject({ kind: 'not-attached' });
  expect(Date.now() - startedAt).toBeLessThan(2000);
});

it(`aborts a hung probe when stillWanted turns false`, async () => {
  vi.mocked(probeDevServerAsync).mockImplementation(hangUntilAborted);
  const startedAt = Date.now();
  const stillWanted = () => Date.now() - startedAt < 200;

  const wait = await waitForLoadedAppAsync(URL, classify, startedAt + 20_000, { stillWanted });

  expect(wait).toEqual({ kind: 'abandoned' });
  expect(Date.now() - startedAt).toBeLessThan(2000);
});
