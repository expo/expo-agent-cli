// A `simctl` that keeps simulator state the way the real one does, so a test reads calls and state
// rather than mocking one function per call.

import fs from 'fs';
import path from 'path';

import type { SpawnCaptureResult } from '../../utils/spawnCapture';
import { registryDirectory } from '../registry';
import type { Binding, DeviceTools } from '../types';

export const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-0';
export const DEVICE_TYPE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro';

export interface FakeSimulator {
  udid: string;
  name: string;
  state: 'Booted' | 'Shutdown';
}

export interface FakeSimctlOptions {
  simulators?: FakeSimulator[];
  /** Whether `list runtimes` names an iPhone runtime. */
  runtime?: boolean;
  /** `bootstatus -b` leaves the simulator down and exits non-zero. */
  bootFails?: boolean;
  /** Every call fails to spawn. */
  spawnError?: boolean;
  /** Every `list devices` times out. */
  listTimesOut?: boolean;
}

export interface FakeTools extends DeviceTools {
  calls: string[][];
  simulators: FakeSimulator[];
  /** Whether the registry lock existed when each call ran, by call index. */
  lockedAt: boolean[];
  clock: { now: Date };
}

export function fakeTools({
  simulators = [],
  runtime = true,
  bootFails = false,
  spawnError = false,
  listTimesOut = false,
}: FakeSimctlOptions = {}): FakeTools {
  const state = simulators.map((simulator) => ({ ...simulator }));
  const calls: string[][] = [];
  const lockedAt: boolean[] = [];
  const clock = { now: new Date('2026-10-08T10:00:00.000Z') };
  let created = 0;
  const ok = (stdout = ''): SpawnCaptureResult => ({ stdout, stderr: '', exitCode: 0 });

  const simctl: DeviceTools['simctl'] = async (args) => {
    calls.push(args);
    lockedAt.push(fs.existsSync(path.join(registryDirectory(), '.lock')));
    if (spawnError) {
      return {
        stdout: '',
        stderr: '',
        exitCode: null,
        spawnError: Object.assign(new Error('spawn xcrun ENOENT'), { code: 'ENOENT' }),
      };
    }
    const [command, ...rest] = args;
    if (command === 'list' && rest[0] === 'runtimes') {
      return ok(
        JSON.stringify({
          runtimes: runtime
            ? [
                {
                  identifier: RUNTIME,
                  platform: 'iOS',
                  version: '26.0',
                  isAvailable: true,
                  supportedDeviceTypes: [{ identifier: DEVICE_TYPE, productFamily: 'iPhone' }],
                },
              ]
            : [],
        })
      );
    }
    if (command === 'list') {
      if (listTimesOut) {
        return { stdout: '', stderr: '', exitCode: null };
      }
      return ok(JSON.stringify({ devices: { [RUNTIME]: state } }));
    }
    if (command === 'create') {
      created += 1;
      const udid = `CREATED-${created}`;
      state.push({ udid, name: rest[0]!, state: 'Shutdown' });
      return ok(`${udid}\n`);
    }
    const simulator = state.find((entry) => entry.udid === rest[0]);
    if (!simulator) {
      return { stdout: '', stderr: `Invalid device: ${rest[0]}\n`, exitCode: 148 };
    }
    if (command === 'bootstatus') {
      if (bootFails) {
        return { stdout: '', stderr: 'boot failed\n', exitCode: 1 };
      }
      if (rest.includes('-b')) {
        simulator.state = 'Booted';
      }
      return ok();
    }
    if (command === 'shutdown') {
      if (simulator.state === 'Shutdown') {
        return {
          stdout: '',
          stderr: 'Unable to shutdown device in current state: Shutdown\n',
          exitCode: 149,
        };
      }
      simulator.state = 'Shutdown';
      return ok();
    }
    if (command === 'boot') {
      simulator.state = 'Booted';
      return ok();
    }
    return { stdout: '', stderr: `unexpected ${args.join(' ')}\n`, exitCode: 2 };
  };

  return {
    simctl,
    now: () => clock.now,
    isPidAlive: () => true,
    calls,
    simulators: state,
    lockedAt,
    clock,
  };
}

/** A binding an hour from expiry, as `acquire` writes one. */
export function bindingFor(
  projectRoot: string,
  udid: string,
  {
    expiresAt,
    boundAt,
    name = 'agent-cli 0000',
  }: { expiresAt?: string; boundAt?: string; name?: string } = {}
): Binding {
  return {
    version: 1,
    device: { backend: 'local-ios', platform: 'ios', udid, name, origin: 'created' },
    projectRoot,
    boundAt: boundAt ?? '2026-10-08T09:00:00.000Z',
    expiresAt: expiresAt ?? '2026-10-08T11:00:00.000Z',
  };
}

export function writeBinding(file: string, binding: Binding): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(binding));
}
