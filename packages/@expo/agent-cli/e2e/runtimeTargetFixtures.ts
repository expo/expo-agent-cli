import fs from 'node:fs';
import path from 'node:path';

import type { CdpTarget } from '../src/runtime/cdpClient';
import { makeTarget } from '../src/runtime/__tests__/targetSelectionFixtures';
import { bindingFixture } from './__tests__/installedAppStubs';
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

/** Another existing worktree's binding in this fixture's machine-wide registry. */
export async function bindOtherWorktreeAsync(root: string, udid: string, name: string) {
  const otherRoot = await fs.promises.mkdtemp(path.join(root, 'other-worktree-'));
  const file = await bindingFixture(otherRoot, udid, name);
  const registry = path.join(expoHomeOf(root), 'agent-cli', 'bindings');
  await fs.promises.mkdir(registry, { recursive: true });
  await fs.promises.rename(file, path.join(registry, path.basename(file)));
  return otherRoot;
}
