import { decideInstall, type InstallDecision, type InstallFacts } from '../deps/decideInstall';

const facts = (overrides: Partial<InstallFacts> = {}): InstallFacts => ({
  noStart: false,
  deviceId: 'SIM-1',
  createdByBoot: false,
  backend: 'local-ios',
  kind: 'expo-go',
  appId: 'host.exp.Exponent',
  ...overrides,
});

// @ref llp/0005-runtime-loop-tools.rfc.md §The gate installs the app, whichever app it is
describe(decideInstall, () => {
  // Each row also carries facts of a later row, so the first match is what the row proves.
  it.each<[number, Partial<InstallFacts>, InstallDecision]>([
    [1, { noStart: true, deviceId: null, createdByBoot: true }, { install: false }],
    [2, { deviceId: null, kind: null, createdByBoot: true }, { install: false }],
    [3, { kind: null, createdByBoot: true }, { install: false }],
    [4, { createdByBoot: true, backend: 'cloud', appId: null }, { install: true }],
    [5, { backend: 'cloud', appId: null, kind: 'native-build' }, { install: false }],
    [6, { appId: null, kind: 'native-build' }, { install: true }],
    [7, { appId: null, kind: 'expo-go' }, { install: false }],
    [8, { hasApp: null, expoGoVerdict: 'mismatch' }, { install: false }],
    [9, { hasApp: false, expoGoVerdict: 'match' }, { install: true }],
    [10, { hasApp: true, expoGoVerdict: 'mismatch' }, { install: true }],
    [11, { hasApp: true, expoGoVerdict: 'match' }, { install: false }],
    [11, { hasApp: true, expoGoVerdict: 'unknown' }, { install: false }],
    [11, { kind: 'native-build', hasApp: true, expoGoVerdict: 'mismatch' }, { install: false }],
  ])('row %i: %j', (_row, overrides, expected) => {
    expect(decideInstall(facts(overrides))).toEqual(expected);
  });

  it.each<[Partial<InstallFacts>, InstallDecision]>([
    [{}, { ask: 'hasApp' }],
    [{ hasApp: true }, { ask: 'expoGoVerdict' }],
    [{ hasApp: true, kind: 'native-build' }, { install: false }],
  ])('asks for a device read only when a row needs it: %j', (overrides, expected) => {
    expect(decideInstall(facts(overrides))).toEqual(expected);
  });
});
