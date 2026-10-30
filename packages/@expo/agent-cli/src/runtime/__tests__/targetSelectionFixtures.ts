import type { CdpTarget } from '../cdpClient';
import {
  EMPTY_DEVICE_INVENTORY,
  READ_EVERY_TARGET,
  type DeviceInventory,
  type TargetSelection,
} from '../targetSelection';
export function makeDeviceInventory(overrides: Partial<DeviceInventory> = {}): DeviceInventory {
  return {
    booted: [],
    bootedStatus: 'observed',
    androidDevices: [],
    androidReverse: null,
    iosBindings: [],
    ...overrides,
  };
}
export function makeTargetSelection(overrides: Partial<TargetSelection> = {}): TargetSelection {
  return { ...READ_EVERY_TARGET, ...overrides };
}
export const EVERY_TARGET_CLIENT = {
  targetSelection: READ_EVERY_TARGET,
  deviceInventory: EMPTY_DEVICE_INVENTORY,
};

export function makeTarget(overrides: Partial<CdpTarget> = {}): CdpTarget {
  return {
    id: '1',
    appId: 'dev.example.app',
    deviceName: 'iPhone 17',
    description: '',
    type: 'node',
    title: 'React Native',
    devtoolsFrontendUrl: '/devtools',
    webSocketDebuggerUrl: 'ws://127.0.0.1:1/inspector/debug?device=1&page=1',
    ...overrides,
  };
}
