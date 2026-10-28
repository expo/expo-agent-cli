// @ref llp/0005-runtime-loop-tools.rfc.md §The smoke gate
import { resolveDeviceAsync, type NavigateDevice } from '../navigate/device';
import type { CdpTarget } from '../runtime/cdpClient';
import { probeDevServerAsync } from '../runtime/devServer';
import {
  resolveScopeAsync,
  resolveTargetSelectionAsync,
  type ResolvedTargetSelection,
} from '../runtime/resolveTargetSelection';
import type { TargetSelection } from '../runtime/targetSelection';
import type { SmokeOptions } from './resolveOptions';

export interface SmokeTargetSelection {
  /** The scope, and the one target list and inventory it was resolved on. */
  targetSelectionAsync(
    devServerUrl: string
  ): Promise<ResolvedTargetSelection & { targets: CdpTarget[] }>;
  /** The scope alone, for a caller that reads its own target list. Probes nothing. */
  scopeAsync(): Promise<TargetSelection>;
  deviceAsync(): Promise<{ device: NavigateDevice | null; reason: string | null }>;
  setDevice(device: NavigateDevice | null): void;
}

/**
 * Own the run's chosen device; targets and inventory are observations, not cached decisions.
 *
 * | Value                   | Lifetime                                                                   |
 * | ----------------------- | -------------------------------------------------------------------------- |
 * | A device choice         | Until a boot or a session start replaces it; both clear it when they begin |
 * | A lookup in progress    | Shared by the phases that ask while it runs                                |
 * | A failed lookup         | That attempt only; a later phase asks again                                |
 * | A target classification | The one target list it was made from                                       |
 */
export function buildSmokeTargetSelection(
  projectRoot: string,
  options: SmokeOptions
): SmokeTargetSelection {
  let memo: Promise<{ device: NavigateDevice | null; reason: string | null }> | null = null;
  const scope = async () => ({
    projectRoot,
    flags: { platform: options.platform, eas: options.cloud === 'required' },
    device: memo ? (await memo).device : null,
  });
  return {
    deviceAsync: () => {
      if (memo) return memo;
      const pending = resolveDeviceAsync(options.platform, {
        cloud: options.cloud,
        projectRoot,
      }).then(
        (device) => ({ device, reason: null }),
        (error) => {
          // A boot/session may have supplied a device while this lookup was in progress.
          if (memo === pending) memo = null;
          return {
            device: null,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      );
      memo = pending;
      return pending;
    },
    setDevice: (device) => {
      memo = device ? Promise.resolve({ device, reason: null }) : null;
    },
    targetSelectionAsync: async (devServerUrl) => {
      const { targets } = await probeDevServerAsync(devServerUrl);
      const resolved = await resolveTargetSelectionAsync({
        ...(await scope()),
        targets,
        devServerUrl,
      });
      return { ...resolved, targets };
    },
    scopeAsync: async () => await resolveScopeAsync(await scope()),
  };
}
