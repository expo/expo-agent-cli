import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import type { CdpTarget } from '../src/runtime/cdpClient';
import { makeTarget } from '../src/runtime/__tests__/targetSelectionFixtures';
import { BOOTED_SIMULATOR, bindingFixture } from './__tests__/installedAppStubs';
import { expoHomeOf } from './utils';

/** A reloadable app whose protocol socket can identify which device was evaluated. */
export function runtimeTarget(id: string, overrides: Partial<CdpTarget> = {}): CdpTarget {
  return makeTarget({
    id,
    webSocketDebuggerUrl: `ws://127.0.0.1:1/inspector/debug?device=${id}&page=1`,
    reactNative: { capabilities: { nativePageReloads: true }, logicalDeviceId: id },
    ...overrides,
  });
}

const EXPO_GO = {
  ios: { appId: 'host.exp.Exponent', deviceName: BOOTED_SIMULATOR.name },
  android: { appId: 'host.exp.exponent', deviceName: 'sdk_gphone64_arm64 - 15 - API 35' },
} as const;

/** Expo Go on a stub device of `platform`, with a runtime that the default target selector asks. */
export function expoGoRuntimeTarget(
  platform: keyof typeof EXPO_GO,
  overrides: Partial<CdpTarget> = {}
): CdpTarget {
  return runtimeTarget(platform, { ...EXPO_GO[platform], ...overrides });
}

/**
 * The JavaScript runtime of one app, as an `inspectorEvaluate` responder. It evaluates each
 * expression with `globals` as `globalThis`. `{}` is a runtime that ran no bundle. `{ __r() {} }`
 * is a runtime that ran one: `__r` is the Metro `require` that each bundle defines.
 *
 * `loadedAfterAsks: n` defines `__r` after `n` evaluates. It counts evaluates and reads no clock,
 * because the start time of the CLI varies.
 */
export function appRuntime(
  globals: Record<string, unknown>,
  { loadedAfterAsks }: { loadedAfterAsks?: number } = {}
) {
  const answers: unknown[] = [];
  return {
    evaluate(expression: string): unknown {
      if (loadedAfterAsks != null && answers.length >= loadedAfterAsks) {
        globals.__r = function () {};
      }
      const answer: unknown = runInNewContext(expression, { globalThis: globals });
      answers.push(answer);
      return answer;
    },
    /** The value of each evaluate, in order. */
    answers: () => [...answers],
  };
}

/** Another existing worktree's binding in this fixture's machine-wide registry. */
export async function bindOtherWorktreeAsync(
  root: string,
  udid: string,
  name: string,
  expiresAt?: string
) {
  const otherRoot = await fs.promises.mkdtemp(path.join(root, 'other-worktree-'));
  const file = await bindingFixture(otherRoot, udid, name, expiresAt);
  const registry = path.join(expoHomeOf(root), 'agent-cli', 'bindings');
  await fs.promises.mkdir(registry, { recursive: true });
  await fs.promises.rename(file, path.join(registry, path.basename(file)));
  return otherRoot;
}
