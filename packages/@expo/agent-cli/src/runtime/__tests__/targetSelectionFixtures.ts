import type { BoundDevice } from '../../deviceBinding/types';
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

type DeviceByBackend = {
  [Backend in BoundDevice['backend']]: Extract<BoundDevice, { backend: Backend }>;
};

export function makeBoundDevice<Backend extends BoundDevice['backend']>(
  backend: Backend,
  overrides: Partial<Omit<DeviceByBackend[Backend], 'backend'>> = {}
): DeviceByBackend[Backend] {
  const defaults: DeviceByBackend = {
    'local-ios': {
      backend: 'local-ios',
      platform: 'ios',
      udid: 'SIM-OWN',
      name: 'iPhone 17 Pro',
      origin: 'created',
    },
    'local-android': {
      backend: 'local-android',
      platform: 'android',
      serial: 'emulator-5554',
      origin: { kind: 'explicit' },
    },
    cloud: { backend: 'cloud', platform: 'ios', id: '01a15bf1', origin: 'started' },
  };
  return { ...defaults[backend], ...overrides };
}
