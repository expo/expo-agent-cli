import { vol } from 'memfs';
import { generateFingerprintAsync } from '../../project/fingerprint';
import { recordLastBuildFingerprint } from '../../plan/lastBuild';
import { captureNativeBuildInputsAsync, NativeInstallAttempt } from '../nativeBuildRecord';
vi.mock('../../project/fingerprint', () => ({
  clearFingerprintMemo: vi.fn(),
  generateFingerprintAsync: vi.fn(),
}));
vi.mock('../../plan/lastBuild', () => ({ recordLastBuildFingerprint: vi.fn(async () => true) }));
vi.mock('../../log');
const root = '/project';
const fingerprint = { hash: 'input-A', sources: [{ type: 'contents', id: 'config', hash: 'A' }] };
const event = (fields = {}) => ({
  _e: 'run:install',
  _t: Date.now(),
  _d: 10,
  platform: 'ios',
  appId: 'dev.app',
  ...fields,
});
beforeEach(() => {
  vol.reset();
  vol.fromJSON({
    '/project/app.json': JSON.stringify({
      expo: { ios: { bundleIdentifier: 'dev.app' }, android: { package: 'dev.app' } },
    }),
  });
  vi.mocked(generateFingerprintAsync).mockReset().mockResolvedValue(fingerprint);
  vi.mocked(recordLastBuildFingerprint).mockReset().mockResolvedValue(true);
});
it.each(['ios', 'android'] as const)(
  'records %s immediately and once before child exit',
  async (platform) => {
    const inputs = await captureNativeBuildInputsAsync(root);
    const attempt = new NativeInstallAttempt(root, platform, [], inputs);
    await attempt.onEvent(event({ platform }));
    expect(attempt.installed).toBe(true);
    expect(attempt.recorded).toBe(true);
    expect(recordLastBuildFingerprint).toHaveBeenCalledExactlyOnceWith(root, platform, fingerprint);
    await attempt.onEvent(event({ platform }));
    await attempt.finish();
    await attempt.onEvent(event({ platform }));
    expect(recordLastBuildFingerprint).toHaveBeenCalledTimes(1);
    expect(generateFingerprintAsync).toHaveBeenCalledWith(root, { cache: false });
  }
);
it.each([
  { _e: 'run:build:done' },
  { _e: 'run:launch' },
  { platform: 'android' },
  { appId: 'another.app' },
  { appId: '' },
  { _t: 'now' },
  { _d: undefined },
  { _t: 1 },
  { _w: 'another-child' },
  { error: { message: 'failed' } },
])('ignores uncertain or foreign evidence: %j', async (fields) => {
  const attempt = new NativeInstallAttempt(
    root,
    'ios',
    [],
    await captureNativeBuildInputsAsync(root)
  );
  await attempt.onEvent(event(fields));
  await attempt.finish();
  expect(recordLastBuildFingerprint).not.toHaveBeenCalled();
});
it('requires a selected device matching the explicit target', async () => {
  const inputs = await captureNativeBuildInputsAsync(root);
  const attempt = new NativeInstallAttempt(root, 'ios', ['--device', 'wanted'], inputs);
  await attempt.onEvent({
    _e: 'run:device:selected',
    _t: Date.now(),
    platform: 'ios',
    id: 'other',
    name: 'Other',
    type: 'simulator',
    os: 'iOS',
  });
  await attempt.onEvent(event());
  expect(recordLastBuildFingerprint).not.toHaveBeenCalled();
});
it('refuses compilation when preparation changed inputs', async () => {
  const inputs = await captureNativeBuildInputsAsync(root);
  vi.mocked(generateFingerprintAsync).mockResolvedValue({ hash: 'input-B', sources: [] });
  await expect(inputs.beforeCompile()).rejects.toMatchObject({ code: 'NATIVE_INPUTS_CHANGED' });
  expect(recordLastBuildFingerprint).not.toHaveBeenCalled();
});
it.each([
  { hash: 'input-B', sources: [] },
  { hash: null, sources: null },
])('retains the old record when inputs cannot be verified: %j', async (next) => {
  const attempt = new NativeInstallAttempt(
    root,
    'ios',
    [],
    await captureNativeBuildInputsAsync(root)
  );
  vi.mocked(generateFingerprintAsync).mockResolvedValue(next);
  await attempt.onEvent(event());
  await attempt.finish();
  expect(attempt.installed).toBe(true);
  expect(attempt.recorded).toBe(false);
  expect(recordLastBuildFingerprint).not.toHaveBeenCalled();
});
it('never substitutes a later fingerprint for a missing initial snapshot', async () => {
  vi.mocked(generateFingerprintAsync).mockResolvedValueOnce({ hash: null, sources: null });
  const attempt = new NativeInstallAttempt(
    root,
    'ios',
    [],
    await captureNativeBuildInputsAsync(root)
  );
  await attempt.onEvent(event());
  expect(recordLastBuildFingerprint).not.toHaveBeenCalled();
});
it('reports failed writes without retrying them at exit', async () => {
  vi.mocked(recordLastBuildFingerprint).mockResolvedValue(false);
  const attempt = new NativeInstallAttempt(
    root,
    'ios',
    [],
    await captureNativeBuildInputsAsync(root)
  );
  await attempt.onEvent(event());
  await attempt.finish();
  expect(attempt.recorded).toBe(false);
  expect(recordLastBuildFingerprint).toHaveBeenCalledTimes(1);
});
it('closes old callbacks before a port retry', async () => {
  const inputs = await captureNativeBuildInputsAsync(root);
  const old = new NativeInstallAttempt(root, 'ios', [], inputs);
  await old.finish();
  const retry = new NativeInstallAttempt(root, 'ios', [], inputs);
  await old.onEvent(event());
  expect(recordLastBuildFingerprint).not.toHaveBeenCalled();
  await retry.onEvent(event());
  expect(recordLastBuildFingerprint).toHaveBeenCalledTimes(1);
});
