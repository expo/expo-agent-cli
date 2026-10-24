import { scopeOfFlags, type DeviceFacts, type RunScope } from '../runScope';

/** Device facts for a test: nothing booted and nothing attached, plus the fields that differ. */
export function makeDeviceFacts(overrides: Partial<DeviceFacts> = {}): DeviceFacts {
  return { booted: [], androidModels: [], iosBindings: [], ...overrides };
}

/** The client options of a run that reads every target, for a test that is not about scope. */
export const READ_EVERY_TARGET: { scope: RunScope; facts: DeviceFacts } = {
  scope: scopeOfFlags({ platform: null, eas: false }),
  facts: makeDeviceFacts(),
};
