import { describe, expect, it, vi } from 'vitest';

import { createAppDeps } from '../deps/app';
import type { SmokeDepsContext } from '../deps/shared';

vi.mock('../../project/expoGo', () => ({
  checkExpoGoCompatibilityAsync: vi.fn(async () => ({})),
  decidesAgainstExpoGo: () => false,
}));

function ctxOn(cloud: 'required' | 'fallback'): SmokeDepsContext {
  return {
    projectRoot: '/project',
    options: { platform: 'ios' },
    cloudRoute: { current: cloud },
    targetSelectionAsync: async () => ({
      classifiedTargets: { read: [{ appId: 'host.exp.Exponent' }] },
    }),
  } as unknown as SmokeDepsContext;
}

describe('checkAppFitsProject', () => {
  it.each([
    ['fallback', '"npx @expo/agent-cli dev --ios" makes'],
    ['required', '"npx @expo/agent-cli dev --ios --eas" makes'],
  ] as const)('names the build on the run route (%s)', async (cloud, command) => {
    const result = await createAppDeps(ctxOn(cloud)).checkAppFitsProject('http://localhost:8081');
    expect(result.kind).toBe('expo-go-incompatible');
    expect(result.mismatch).toContain(command);
  });
});
