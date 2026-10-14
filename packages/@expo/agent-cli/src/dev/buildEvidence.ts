// @ref llp/0036-record-build-before-metro-exits.plan.md
// Installing is progress only. Expo emits run:install AFTER the awaited installation succeeds.
import type { NativePlatform } from '../plan/types';

export type NativeRunEvent = Record<string, unknown>;

export function isInstallCompletion(
  event: NativeRunEvent,
  platform: NativePlatform,
  appId: string
): boolean {
  return (
    event._e === 'run:install' &&
    event.platform === platform &&
    event.appId === appId &&
    typeof event._t === 'number' &&
    Number.isFinite(event._t) &&
    event._t > 0 &&
    typeof event._d === 'number' &&
    Number.isFinite(event._d) &&
    event._d >= 0 &&
    event._w == null &&
    event.error == null
  );
}

/** Progress marker only: the compiler has handed off to installation, which can still fail. */
export function installationStarted(output: string): boolean {
  return /^\s*›\s*Installing\b/m.test(output) || /installing with Gradle/i.test(output);
}
