// @ref llp/0033-device-lifecycle.plan.md §--device on dev
import { readAndroidInventoryAsync } from './emulator';
import { readExplicitChoice, type ExplicitCandidate } from './explicit';
import { readIosInventoryAsync } from './ios';
import { defaultTools } from './tools';
import type { DevicePlatform, DeviceTools } from './types';

/** A plan reads the same choice as acquisition, but never writes, boots or reaps. */
export async function previewExplicitDeviceAsync(
  projectRoot: string,
  platform: DevicePlatform,
  query: string,
  tools: DeviceTools = defaultTools()
) {
  const candidates: ExplicitCandidate[] =
    platform === 'ios'
      ? (await readIosInventoryAsync(tools)).simulators
          .filter((sim) => sim.isAvailable)
          .map((sim) => ({
            backend: 'local-ios',
            platform: 'ios',
            udid: sim.udid,
            name: sim.name,
            origin: 'explicit',
          }))
      : (await readAndroidInventoryAsync(tools)).runningSerials.map((serial) => ({
          backend: 'local-android',
          platform: 'android',
          serial,
          origin: { kind: 'explicit' },
        }));
  return readExplicitChoice(projectRoot, platform, candidates, query, false, tools).choice.device;
}
