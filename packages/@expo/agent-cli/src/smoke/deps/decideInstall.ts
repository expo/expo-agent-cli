import type { ExpoGoVersionCheck } from '../../device/expoGoVersion';
import type { DeviceBackend } from '../../navigate/device';
import type { SmokeTarget } from './target';

/**
 * What {@link decideInstall} reads. `hasApp` and `expoGoVerdict` are device reads that cost a
 * subprocess: `undefined` means "not asked yet", and `hasApp: null` means "asked, and the device
 * could not answer".
 */
export interface InstallFacts {
  deviceId: string | null;
  createdByBoot: boolean;
  backend: DeviceBackend | null;
  /** The plan's install kind. `null` is a plan that could not be read. */
  kind: SmokeTarget['installWithKind'];
  appId: string | null;
  hasApp?: boolean | null;
  expoGoVerdict?: ExpoGoVersionCheck['verdict'];
}

export type InstallDecision =
  | { install: boolean }
  | { ask: 'hasApp'; deviceId: string; appId: string }
  | { ask: 'expoGoVerdict'; deviceId: string };

/**
 * The install table of llp/0005 §The gate installs the app, whichever app it is. The first row that
 * matches decides; the comments carry the row numbers of the table.
 * Row 1, `--no-start`, is the walk's: it never reaches the install step.
 *
 * Pure: a row that needs a device read answers `{ ask }`, and the caller reads it and asks again.
 */
export function decideInstall(facts: InstallFacts): InstallDecision {
  if (facts.deviceId == null) return { install: false }; // 2
  if (facts.kind == null) return { install: false }; // 3
  if (facts.createdByBoot) return { install: true }; // 4
  if (facts.backend !== 'local-ios' && facts.backend !== 'local-android') {
    return { install: false }; // 5
  }
  if (facts.appId == null) return { install: facts.kind === 'native-build' }; // 6, 7
  if (facts.hasApp === undefined)
    return { ask: 'hasApp', deviceId: facts.deviceId, appId: facts.appId };
  if (facts.hasApp === null) return { install: false }; // 8
  if (!facts.hasApp) return { install: true }; // 9
  if (facts.kind === 'expo-go') {
    if (facts.expoGoVerdict === undefined)
      return { ask: 'expoGoVerdict', deviceId: facts.deviceId };
    if (facts.expoGoVerdict === 'mismatch') return { install: true }; // 10
  }
  return { install: false }; // 11
}
