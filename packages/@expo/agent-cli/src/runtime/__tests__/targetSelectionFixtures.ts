import { READ_EVERY_TARGET, type DeviceInventory, type TargetSelection } from '../targetSelection';
export function makeDeviceInventory(overrides: Partial<DeviceInventory> = {}): DeviceInventory {
  return { booted: [], androidModels: [], ...overrides };
}
export function makeTargetSelection(overrides: Partial<TargetSelection> = {}): TargetSelection {
  return { ...READ_EVERY_TARGET, ...overrides };
}
export const EVERY_TARGET_CLIENT = {
  targetSelection: READ_EVERY_TARGET,
  deviceInventory: makeDeviceInventory(),
};
