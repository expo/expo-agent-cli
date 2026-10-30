// @ref llp/0035-one-device-per-worktree.rfc.md §Readers
import { vol } from 'memfs';
import path from 'path';

import { cloudProbe } from '../../device/__tests__/fakeCloudProbe';
import { probeCloudSessionAsync } from '../../device/cloudSimulator';
import { cloudRungAsync, cloudVerdict } from '../cloudRung';
import { bindingPathFor, readBindingFile } from '../registry';
import { cloudBindingFor, writeCloudBinding } from './fakeCloudBinding';
import { fakeTools } from './fakeTools';

vi.mock('../../device/cloudSimulator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../device/cloudSimulator')>()),
  probeCloudSessionAsync: vi.fn(),
}));

const ROOT = '/work/app';
const NOW = new Date('2026-10-08T10:00:00.000Z');
const expired = { expiresAt: '2026-10-08T09:30:00.000Z' };

const active = (id: string, platform: 'ios' | 'android' = 'ios') =>
  cloudProbe.active({ id, platform, name: 'Checkout' });

describe(cloudVerdict, () => {
  const live = cloudBindingFor(ROOT, 'ios', 'sess-1');
  const dead = cloudBindingFor(ROOT, 'ios', 'sess-1', expired);
  const device = (id: string, platform: 'ios' | 'android' = 'ios') => ({
    platform,
    id,
    name: 'Checkout',
  });

  it('refuses a queued session as not up yet, with its id and status', () => {
    const verdict = cloudVerdict(
      [live],
      cloudProbe.queued({ id: 'sess-1', platform: 'ios' }),
      null,
      NOW
    );

    expect(verdict).toMatchObject({
      kind: 'refuse',
      error: {
        data: { reason: 'not-up' },
        message: expect.stringContaining(
          'The ios EAS session sess-1 is not up yet (status QUEUED).'
        ),
      },
    });
  });

  // The fallback rung of a plain read verb: a session this run cannot use is a door, not a refusal.
  it('hands a queued session back as no device in the fallback, not as a refusal', () => {
    const probe = cloudProbe.queued({ id: 'sess-1', platform: 'ios' });

    expect(cloudVerdict([live], probe, null, NOW, 'fallback')).toEqual({ kind: 'none', probe });
  });

  it('hands a session on another platform than the flag back as no device in the fallback', () => {
    const probe = active('sess-1', 'ios');

    expect(cloudVerdict([live], probe, 'android', NOW, 'fallback')).toEqual({
      kind: 'none',
      probe,
    });
  });

  it('names no platform for a queued session that reported none, read with no flag', () => {
    const verdict = cloudVerdict([], cloudProbe.queued({ id: 'q' }), null, NOW);

    expect(verdict).toMatchObject({
      kind: 'refuse',
      error: { message: expect.stringContaining('The EAS session q is not up yet') },
    });
  });

  it.each(['queued', 'active'] as const)(
    'refuses a %s session on the other platform as a mismatch',
    (state) => {
      const verdict = cloudVerdict(
        [],
        cloudProbe[state]({ id: 'a', platform: 'android' }),
        'ios',
        NOW
      );

      expect(verdict).toMatchObject({
        kind: 'refuse',
        error: { code: 'CLOUD_SIMULATOR_PLATFORM_MISMATCH' },
      });
    }
  );

  it('refuses an active session that reported no platform, read with no flag', () => {
    const verdict = cloudVerdict([], cloudProbe.active({ id: 'a' }), null, NOW);

    expect(verdict).toMatchObject({
      kind: 'refuse',
      error: { code: 'CLOUD_SIMULATOR_PLATFORM_UNKNOWN' },
    });
  });

  it('takes the flag as the platform of an active session that reported none', () => {
    const verdict = cloudVerdict([], cloudProbe.active({ id: 'a' }), 'android', NOW);

    expect(verdict).toMatchObject({ kind: 'device', device: { platform: 'android', id: 'a' } });
  });

  it('does not let an expired binding hide a live dotenv session', () => {
    expect(cloudVerdict([dead], active('other'), null, NOW)).toEqual({
      kind: 'device',
      device: device('other'),
      extend: null,
    });
  });

  it('refuses a live binding whose session ended, with that binding platform', () => {
    const android = cloudBindingFor(ROOT, 'android', 'sess-9');
    const verdict = cloudVerdict([live, android], cloudProbe.inactive('sess-9'), null, NOW);

    expect(verdict).toMatchObject({
      kind: 'refuse',
      error: { message: expect.stringContaining('The bound android EAS session is ended.') },
    });
  });

  it.each([
    ['unknown', cloudProbe.unknown()],
    ['unavailable', cloudProbe.unavailable()],
  ])('hands back an %s probe as no device, even when the only binding expired', (_state, probe) => {
    expect(cloudVerdict([dead], probe, 'ios', NOW)).toEqual({ kind: 'none', probe });
  });

  it('refuses ended for the platform asked, when the probe named the other platform first', () => {
    const ios = cloudBindingFor(ROOT, 'ios', 'sess-ios');
    const android = cloudBindingFor(ROOT, 'android', 'sess-and');
    const verdict = cloudVerdict([ios, android], cloudProbe.inactive('sess-ios'), 'android', NOW);

    expect(verdict).toMatchObject({
      kind: 'refuse',
      error: { message: expect.stringContaining('The bound android EAS session is ended.') },
    });
  });

  it('extends the binding that names the active session', () => {
    expect(cloudVerdict([live], active('sess-1'), null, NOW)).toEqual({
      kind: 'device',
      device: device('sess-1'),
      extend: live,
    });
  });

  it('refuses an active session whose own binding expired', () => {
    expect(cloudVerdict([dead], active('sess-1'), null, NOW)).toMatchObject({ kind: 'refuse' });
  });

  it('goes on without a binding to extend when none names the session', () => {
    expect(cloudVerdict([], active('sess-1'), null, NOW)).toEqual({
      kind: 'device',
      device: device('sess-1'),
      extend: null,
    });
  });

  it('hands back the probe when no session was selected', () => {
    const probe = cloudProbe.none({ unboundCount: 1 });
    expect(cloudVerdict([], probe, null, NOW)).toEqual({ kind: 'none', probe });
  });
});

describe(cloudRungAsync, () => {
  const file = (platform: 'ios' | 'android' = 'ios') => bindingPathFor(ROOT, platform, 'cloud');
  const expiresAt = (platform: 'ios' | 'android' = 'ios') => {
    const read = readBindingFile(file(platform));
    return read.kind === 'binding' ? read.binding.expiresAt : null;
  };

  beforeEach(() => {
    vol.reset();
    vol.fromJSON({ [`${ROOT}/package.json`]: '{}' });
    vi.mocked(probeCloudSessionAsync).mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('extends the lease of the bound session and returns it as the device', async () => {
    writeCloudBinding(ROOT, 'ios', 'sess-1');
    vi.mocked(probeCloudSessionAsync).mockResolvedValue(active('sess-1'));

    const rung = await cloudRungAsync(ROOT, 'ios', 'required', fakeTools());

    expect(rung).toEqual({
      kind: 'device',
      device: { platform: 'ios', id: 'sess-1', name: 'Checkout' },
    });
    expect(expiresAt()).toBe('2026-10-08T11:00:00.000Z');
    expect(probeCloudSessionAsync).toHaveBeenCalledWith(
      expect.objectContaining({ boundIds: ['sess-1'] })
    );
  });

  it('names the platform of the unreadable file when no platform was asked for', async () => {
    writeCloudBinding(ROOT, 'ios', 'sess-1');
    vol.writeFileSync(file('android'), '{');

    const error = await cloudRungAsync(ROOT, null, 'required', fakeTools()).catch((e) => e);

    expect(error.code).toBe('NO_BOUND_DEVICE');
    expect(error.message).toContain(file('android'));
    expect(error.message).toContain('dev --android');
    expect(probeCloudSessionAsync).not.toHaveBeenCalled();
  });

  it('lists the bindings of the platform asked first in the probe', async () => {
    writeCloudBinding(ROOT, 'ios', 'sess-ios');
    writeCloudBinding(ROOT, 'android', 'sess-and');
    vi.mocked(probeCloudSessionAsync).mockResolvedValue(cloudProbe.none());

    await cloudRungAsync(ROOT, 'android', 'required', fakeTools());

    expect(probeCloudSessionAsync).toHaveBeenCalledWith(
      expect.objectContaining({ boundIds: ['sess-and', 'sess-ios'] })
    );
  });

  it('names the eas bind command for an unreadable binding file', async () => {
    vol.mkdirSync(path.dirname(file('ios')), { recursive: true });
    vol.writeFileSync(file('ios'), '{');

    const error = await cloudRungAsync(ROOT, 'ios', 'required', fakeTools()).catch((e) => e);

    expect(error.exitCode).toBe(7);
    expect(error.message).toContain('dev --ios --eas --detach --wait-ready');
  });

  it('names the cloud wording when the lease is lost to a rebind during the extension', async () => {
    writeCloudBinding(ROOT, 'ios', 'sess-1');
    vi.mocked(probeCloudSessionAsync).mockImplementation(async () => {
      writeCloudBinding(ROOT, 'ios', 'sess-2');
      return active('sess-1');
    });

    const error = await cloudRungAsync(ROOT, 'ios', 'required', fakeTools()).catch((e) => e);

    expect(error.message).toContain('The bound ios EAS session is expired.');
    expect(error.message).toContain('dev --ios --eas --detach --wait-ready');
  });

  it('refuses an expired binding with state-aware recovery', async () => {
    writeCloudBinding(ROOT, 'android', 'sess-9', expired);
    vi.mocked(probeCloudSessionAsync).mockResolvedValue(cloudProbe.none());

    const error = await cloudRungAsync(ROOT, 'android', 'required', fakeTools()).catch((e) => e);

    expect(error.message).toContain('The bound android EAS session is expired.');
    expect(error.suggestedCommand).toBe('npx @expo/agent-cli status');
  });

  it('refuses gone, and writes nothing, when the binding names another session by the extension', async () => {
    writeCloudBinding(ROOT, 'ios', 'sess-1');
    vi.mocked(probeCloudSessionAsync).mockImplementation(async () => {
      writeCloudBinding(ROOT, 'ios', 'sess-2');
      return active('sess-1');
    });

    const error = await cloudRungAsync(ROOT, 'ios', 'required', fakeTools()).catch((e) => e);

    expect(error.code).toBe('NO_BOUND_DEVICE');
    expect(error.data).toEqual({ reason: 'gone' });
    const read = readBindingFile(file());
    expect(read.kind === 'binding' && read.binding.device).toMatchObject({ id: 'sess-2' });
  });
});
