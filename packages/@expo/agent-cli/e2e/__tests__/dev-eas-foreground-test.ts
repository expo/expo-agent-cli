// @ref llp/0027-everything-on-eas.rfc.md §The open is a session
// @ref llp/0035-one-device-per-worktree.rfc.md §EAS
//
// A foreground `dev --eas` opens the app in the same process as the dev server, so what the open
// could not do is said on stderr and the server stays up. Each case runs `go-app` with a 5 s stub
// dev server and the stub `eas`; each has its own fixture copy, port and stub log, so they run
// concurrently. `dev-eas-test.ts` covers the steps and the open that succeeds.
import fs from 'node:fs';
import path from 'node:path';

import {
  cloudBindingFile,
  installStubEasAsync,
  stubEasArgs as easInvocationArgs,
  writeCloudBindingAsync,
  writeCloudSessionFileAsync,
} from '../stubEas';
import {
  executeAgentCliAsync,
  expoHomeOf,
  installStubFingerprintAsync,
  setupFixtureAsync,
  stubExpoEnv,
} from '../utils';

async function setupAsync(): Promise<string> {
  const projectRoot = fs.realpathSync(await setupFixtureAsync('go-app'));
  await installStubFingerprintAsync(projectRoot);
  await installStubEasAsync(projectRoot);
  return projectRoot;
}

/** The cloud binding a run in `projectRoot` writes for its iOS session. */
function sessionBindingFile(projectRoot: string): string {
  return cloudBindingFile(expoHomeOf(projectRoot), projectRoot);
}

/** One foreground run that ends once the open has said what it did. */
async function foregroundOpenAsync(
  projectRoot: string,
  port: number,
  { args = ['--ios'], env = {} }: { args?: string[]; env?: Record<string, string> } = {}
) {
  const result = await executeAgentCliAsync(projectRoot, ['dev', ...args, '--eas'], {
    env: {
      ...stubExpoEnv(projectRoot),
      STUB_EXPO_DEV_SERVER_PORT: String(port),
      STUB_EXPO_LISTEN: '1',
      STUB_EXPO_DELAY_MS: '5000',
      STUB_EXPO_TUNNEL_HOST: 'abc.tunnel.example',
      STUB_EXPO_TUNNEL_DELAY_MS: '50',
      STUB_SIM_SESSIONS: '0',
      ...env,
    },
    reject: false,
  });
  const verbs = easInvocationArgs(projectRoot).map((args) => args[0]);
  return { ...result, verbs };
}

describe.concurrent('@expo/agent-cli dev --eas — a foreground open that ends', () => {
  // Each row is one way the open ends without the app on a session.
  it.each<{
    port: number;
    name: string;
    args: string[];
    env: Record<string, string>;
    /** The session the dotenv of the worktree names. */
    dotenv?: string;
    said: string[];
    started: boolean;
    bound?: boolean;
  }>([
    {
      port: 8540,
      name: 'a session of the other platform, which a second one would be refused beside',
      args: ['--android'],
      env: { STUB_SIM_SESSIONS: '1' },
      dotenv: 'sess-e2e',
      said: [
        'session sess-e2e is an iOS session',
        'navigate / --eas --ios',
        'dev --android --eas --detach',
        'dev:stop --eas',
      ],
      started: false,
    },
    {
      port: 8541,
      name: 'a session of the other platform that is still queued',
      args: ['--android'],
      env: { STUB_SIM_SESSIONS: '1', STUB_SIM_STATUS: 'QUEUED' },
      dotenv: 'sess-e2e',
      said: ['session sess-e2e is an iOS session'],
      started: false,
    },
    {
      port: 8542,
      name: 'a session of this platform that is not up yet',
      args: ['--ios'],
      env: { STUB_SIM_SESSIONS: '1', STUB_SIM_STATUS: 'QUEUED' },
      dotenv: 'sess-e2e',
      said: ['session sess-e2e is not up yet (status QUEUED); run this again in a minute'],
      started: false,
      // The session stays this worktree's, so a later run finds it instead of starting a second.
      bound: true,
    },
    {
      port: 8543,
      name: 'a session list that cannot be read',
      args: ['--ios'],
      env: { STUB_SIM_GET_EXIT: '1', STUB_SIM_STDERR: 'Session not found' },
      said: ['The app was not opened on an EAS Simulator session', 'Session not found'],
      started: false,
    },
    {
      port: 8544,
      name: 'a start that fails after the session was created, which bills until it is stopped',
      args: ['--ios'],
      env: { STUB_SIM_START_EXIT: '1', STUB_SIM_START_ID: 'billed' },
      said: ['exited 1', 'simulator:stop --id billed'],
      started: true,
    },
  ])(
    'says why the app was not opened on $name',
    async ({ port, args, env, dotenv, said, started, bound = false }) => {
      const projectRoot = await setupAsync();
      if (dotenv) await writeCloudSessionFileAsync(projectRoot, dotenv);
      const result = await foregroundOpenAsync(projectRoot, port, { args, env });

      for (const text of said) {
        expect(result.stderr).toContain(text);
      }
      expect(result.stderr).not.toContain('Opened the app on EAS Simulator session');
      expect(result.verbs.filter((verb) => verb === 'simulator')).toHaveLength(started ? 1 : 0);
      expect(fs.existsSync(sessionBindingFile(projectRoot))).toBe(bound);
    }
  );

  it('starts and lists nothing when the binding of this worktree cannot be read', async () => {
    const projectRoot = await setupAsync();
    const file = sessionBindingFile(projectRoot);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, 'garbage');

    const result = await foregroundOpenAsync(projectRoot, 8547);

    expect(result.stderr).toContain('cannot be read, so no session was started');
    expect(result.verbs).not.toContain('simulator');
    expect(result.verbs).not.toContain('simulator:list');
  });

  it('names the command that ends the session, and keeps its binding, when the stop fails', async () => {
    const projectRoot = await setupAsync();

    const result = await foregroundOpenAsync(projectRoot, 8548, {
      env: { STUB_SIM_STOP_EXIT: '1' },
    });

    expect(result.stderr).toContain('Could not stop EAS Simulator session sess-e2e-started: ');
    expect(result.stderr).toContain('simulator:stop --id sess-e2e-started" ends it.');
    expect(fs.existsSync(sessionBindingFile(projectRoot))).toBe(true);
  });

  it('starts no session for a run that opens no app', async () => {
    const projectRoot = await setupAsync();

    const result = await foregroundOpenAsync(projectRoot, 8549, { args: ['--ios', '--no-open'] });

    expect(result.exitCode).toBe(0);
    expect(result.verbs).not.toContain('simulator');
  });

  // The claim renews an expired lease before the probe, so a reap elsewhere cannot stop a session
  // that may be alive. A session the listing does not show is not, so its binding keeps its lease.
  it('puts back the lease it renewed when the session list does not show that session', async () => {
    const projectRoot = await setupAsync();
    const expiresAt = '2000-01-01T00:00:00.000Z';
    await writeCloudBindingAsync(expoHomeOf(projectRoot), projectRoot, { id: 'A', expiresAt });

    // Every start is refused before a session exists, so no new binding replaces this one.
    const result = await foregroundOpenAsync(projectRoot, 8550, {
      env: { STUB_SIM_START_REJECT_FLAG: '--platform' },
    });

    expect(result.stderr).not.toContain('Opened the app on EAS Simulator session');
    const binding = JSON.parse(fs.readFileSync(sessionBindingFile(projectRoot), 'utf8'));
    expect(binding).toMatchObject({ device: { id: 'A' }, expiresAt });
  });
});
