/** What Metro answers a failed build with, cut to the fields this CLI reads. */
const TRANSFORM_ERROR = {
  type: 'TransformError',
  lineNumber: 76,
  column: 4,
  filename: 'src/app/notes.tsx',
  message: 'SyntaxError: /project/src/app/notes.tsx: Unexpected token (76:4)',
};

export interface FakeDevServer {
  /** Change what `GET /json/list` answers from now on, as an app does when it reloads. */
  listing: (next: unknown[]) => void;
  /** Every URL fetched since this server was mocked, in order. */
  requested: string[];
}

/**
 * Answer `GET /json/list` with the given targets, or make the dev server unreachable with `null`.
 *
 * The list is mutable through the returned handle, so a test can say what the dev server reports
 * *after* the app acted on the reload. The server also answers the entry-bundle check: the manifest
 * names `${manifestOrigin}/entry.bundle`, and `bundle` says whether that bundle builds.
 *
 * @param bundle `compiles` (the default), `broken` (Metro's 500 with a TransformError) or
 * `no-manifest` (a dev server that answers nothing the check understands).
 * @param manifestOrigin Origin of the manifest's `launchAsset.url`, which is where the tunnel host
 * comes from. A tunnelled run advertises the tunnel origin here and nowhere else a detached run
 * can read (`src/dev/advertisedUrl.ts`, S3).
 */
export function mockDevServer(
  targets: unknown[] | null,
  {
    bundle = 'compiles',
    manifestOrigin = 'http://127.0.0.1:8081',
  }: {
    bundle?: 'compiles' | 'broken' | 'no-manifest';
    manifestOrigin?: string;
  } = {}
): FakeDevServer {
  let now = targets;
  const requested: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    requested.push(url);
    if (now == null) {
      throw new Error('fetch failed');
    }
    if (url.endsWith('/json/list')) {
      return { ok: true, json: async () => now };
    }
    // The entry bundle. A broken one answers the way Metro answers a failed build: 500 with a
    // small JSON body rather than megabytes of JavaScript.
    if (url.includes('entry.bundle')) {
      if (bundle === 'broken') {
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          headers: {
            get: (name: string) =>
              name.toLowerCase() === 'content-type' ? 'application/json' : null,
          },
          text: async () => JSON.stringify(TRANSFORM_ERROR),
        };
      }
      return { ok: true, status: 200, text: async () => '' };
    }
    // The manifest: `GET /` with an `expo-platform` header, whose `launchAsset.url` is the entry
    // bundle.
    if (bundle === 'no-manifest') {
      return { ok: false, status: 404, statusText: 'Not Found' };
    }
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      json: async () => ({ launchAsset: { url: `${manifestOrigin}/entry.bundle?dev=true` } }),
    };
  }) as unknown as typeof fetch;
  return {
    listing: (next) => {
      now = next;
    },
    requested,
  };
}
