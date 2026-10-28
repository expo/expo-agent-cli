// @ref llp/0021-honest-reports.rfc.md §The rules
//
// The one pure decision F96 turned on: whether the dev server URL in a set of options is the
// caller's own or a finding of the run holding them. Everything else in `routeResolution.ts` needs a
// dev server and a project; this does not, and it is the branch that was wrong.

import { currentTunnelHost, isCallerNamedDevServer } from '../routeResolution';

describe(isCallerNamedDevServer, () => {
  it(`should treat a URL with no source as the caller's, which is the safe reading`, () => {
    expect(isCallerNamedDevServer({ devServerUrl: 'http://127.0.0.1:8081' })).toBe(true);
  });

  it(`should treat an explicit flag as the caller's`, () => {
    expect(
      isCallerNamedDevServer({ devServerUrl: 'http://127.0.0.1:8081', devServerUrlSource: 'flag' })
    ).toBe(true);
  });

  // The whole of F96: `smoke` discovers a dev server in its first phase and hands the URL to its
  // route phase, and that is not a caller naming a host. Read as one, it suppressed the manifest
  // lookup and the gate built a loopback link for a simulator in a datacenter.
  it(`should not treat a URL a step of the run discovered as the caller's`, () => {
    expect(
      isCallerNamedDevServer({
        devServerUrl: 'http://127.0.0.1:8081',
        devServerUrlSource: 'discovered',
      })
    ).toBe(false);
  });

  it(`should say no when there is no URL at all, whatever the source says`, () => {
    expect(isCallerNamedDevServer({ devServerUrl: null })).toBe(false);
    expect(isCallerNamedDevServer({ devServerUrl: null, devServerUrlSource: 'flag' })).toBe(false);
  });
});

describe(currentTunnelHost, () => {
  const logReach = {
    running: true,
    advertised: {
      url: 'https://old.tunnel.example',
      host: 'old.tunnel.example',
      hostType: 'tunnel',
    },
  } as any;

  it('uses the tunnel host the caller just observed over the log host', () => {
    expect(currentTunnelHost({ tunnelHost: 'new.tunnel.example' }, logReach)).toBe(
      'new.tunnel.example'
    );
  });

  it('falls back to the current tunnel of the log', () => {
    expect(currentTunnelHost({}, logReach)).toBe('old.tunnel.example');
  });

  it('returns null for a log that is not a current tunnel', () => {
    expect(currentTunnelHost({}, { ...logReach, running: false })).toBeNull();
  });
});
