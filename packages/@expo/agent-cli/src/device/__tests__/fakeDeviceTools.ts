// @ref llp/0028-one-device-per-agent.rfc.md §Every verb uses the claim
// Answers `xcrun simctl`, `adb` and `emulator` through the child_process mock by argv, and records
// every call, so a test can assert which device each call named.

import { spawn } from 'child_process';
import { EventEmitter } from 'events';

export interface ToolAnswer {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  /** The spawn fails with this code, as a missing binary does. */
  spawnError?: string;
}

export type ToolHandler = (command: string, args: string[]) => ToolAnswer | undefined;

export interface FakeTools {
  calls: { command: string; args: string[] }[];
  /** The calls whose argv, joined by spaces, contains `text`. */
  callsWith(text: string): string[];
}

export function fakeDeviceTools(handler: ToolHandler): FakeTools {
  const calls: FakeTools['calls'] = [];
  vi.mocked(spawn).mockImplementation(((command: string, args: string[] = []) => {
    calls.push({ command, args });
    const answer = handler(command, args) ?? {};
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      pid: 4242,
      unref: () => {},
      kill: () => true,
    });
    process.nextTick(() => {
      if (answer.spawnError) {
        child.emit(
          'error',
          Object.assign(new Error(`spawn ${command} ENOENT`), {
            code: answer.spawnError,
          })
        );
        return;
      }
      if (answer.stdout) {
        child.stdout.emit('data', Buffer.from(answer.stdout));
      }
      if (answer.stderr) {
        child.stderr.emit('data', Buffer.from(answer.stderr));
      }
      child.emit('close', answer.exitCode ?? 0, null);
    });
    return child as any;
  }) as any);
  return {
    calls,
    callsWith: (text) =>
      calls
        .map(({ command, args }) => [command, ...args].join(' '))
        .filter((line) => line.includes(text)),
  };
}

/** A `simctl list devices -j` payload with every device on one iOS runtime. */
export function simctlDevices(
  devices: { udid: string; name: string; state: 'Booted' | 'Shutdown'; lastBootedAt?: string }[],
  runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-26-0'
): string {
  return JSON.stringify({
    devices: { [runtime]: devices.map((d) => ({ isAvailable: true, ...d })) },
  });
}

/** An `adb devices -l` listing. */
export function adbDevices(rows: { serial: string; model?: string }[]): string {
  return [
    'List of devices attached',
    ...rows.map(({ serial, model }) => `${serial}\tdevice${model ? ` model:${model}` : ''}`),
    '',
  ].join('\n');
}
