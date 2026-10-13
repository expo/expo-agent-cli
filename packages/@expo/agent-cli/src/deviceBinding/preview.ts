// @ref llp/0035-one-device-per-worktree.rfc.md §--device on dev
import { readAndroidInventoryAsync } from './emulator';
import { readExplicitChoice, replacedByExplicit, type ExplicitCandidate } from './explicit';
import { readIosInventoryAsync } from './ios';
import { readBindingFile } from './registry';
import { defaultTools } from './tools';
import { deviceIdOf, deviceNameOf, type DevicePlatform, type DeviceTools } from './types';

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
      : (await readAndroidInventoryAsync(tools, { avds: false })).runningSerials.map((serial) => ({
          backend: 'local-android',
          platform: 'android',
          serial,
          origin: { kind: 'explicit' },
        }));
  const { own, choice } = readExplicitChoice(
    projectRoot,
    platform,
    candidates,
    query,
    false,
    tools
  );
  const label = `${deviceNameOf(choice.device)} (${deviceIdOf(choice.device)})`;
  const parts = [
    choice.reused ? `Will reuse ${label}, already bound to this worktree` : `Will bind ${label}`,
  ];
  for (const file of choice.transfer) {
    const read = readBindingFile(file);
    if (read.kind === 'binding')
      parts.push(`, taken over from ${read.binding.projectRoot} (lease expired)`);
  }
  const replaced = replacedByExplicit(own, choice);
  if (replaced) parts.push(`; will delete ${deviceNameOf(replaced.device)} (replaced by --device)`);
  return { device: choice.device, summary: `${parts.join('')}.` };
}
