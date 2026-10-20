import { parseAgentCliSettings } from '../../settings/parse';
import { resolveRuntimeStopOptions, withConfiguredDevice } from '../resolveStopOptions';

describe(resolveRuntimeStopOptions, () => {
  it(`should leave the device and the app to be worked out`, () => {
    expect(resolveRuntimeStopOptions([])).toEqual({
      platform: undefined,
      cloud: false,
      local: false,
      appId: undefined,
      devServerUrl: null,
      json: false,
      followups: true,
    });
  });

  it(`should read every flag`, () => {
    expect(
      resolveRuntimeStopOptions([
        '--android',
        '--app-id',
        'com.example.demo',
        '--dev-server-url',
        'http://192.168.1.10:8081/',
        '--json',
        '--no-followups',
      ])
    ).toEqual({
      platform: 'android',
      cloud: false,
      local: false,
      appId: 'com.example.demo',
      devServerUrl: 'http://192.168.1.10:8081',
      json: true,
      followups: false,
    });
  });

  it(`should refuse two platforms at once`, () => {
    expect(() => resolveRuntimeStopOptions(['--ios', '--android'])).toThrow(/only one of them/);
  });

  // @ref llp/0010-agent-conventions.rfc.md §Registry rules. Dropping the argument
  // would stop whatever the command worked out on its own and then print the id it stopped, which
  // reads like it obeyed.
  it(`should refuse a bare application id and name the flag that takes one`, () => {
    const error = expectThrow(() => resolveRuntimeStopOptions(['com.example.demo']));
    expect(error.code).toBe('BAD_ARGS');
    expect(error.message).toContain('--app-id com.example.demo');
  });

  it(`should refuse a dev server URL that is not a URL`, () => {
    expect(() => resolveRuntimeStopOptions(['--dev-server-url', 'nope'])).toThrow(
      /--dev-server-url/
    );
  });
});

function expectThrow(run: () => unknown): any {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to throw, but it returned');
}

// @ref llp/0005-runtime-loop-tools.rfc.md §Cloud simulator
describe('resolveRuntimeStopOptions and the cloud backend', () => {
  // The flag used to be accepted only so it could be refused: the first cut believed the session
  // controller had no verb that ends one app. `agent-device close <appId>` is that verb, so the
  // flag now names the backend the way it does on `navigate`.
  it(`names the cloud backend rather than refusing it`, () => {
    expect(resolveRuntimeStopOptions(['--eas']).cloud).toBe(true);
    expect(resolveRuntimeStopOptions([]).cloud).toBe(false);
  });

  it(`still takes a platform alongside it, because a session is iOS or Android too`, () => {
    expect(resolveRuntimeStopOptions(['--eas', '--android'])).toMatchObject({
      cloud: true,
      platform: 'android',
    });
  });
});

// @ref llp/0015-backend-selection-and-config.rfc.md §The device backend
describe('The config puts the device on EAS', () => {
  const onEas = parseAgentCliSettings({ deviceBackend: 'eas' }, 'config');
  const iosOnly = parseAgentCliSettings({ ios: { deviceBackend: 'eas' } }, 'config');

  it(`should act on the session, as --eas does`, () => {
    expect(withConfiguredDevice(resolveRuntimeStopOptions(['--ios']), onEas).cloud).toBe(true);
  });

  it(`should stay local for a platform the config keeps here`, () => {
    expect(withConfiguredDevice(resolveRuntimeStopOptions(['--android']), iosOnly).cloud).toBe(
      false
    );
  });
});

describe('--local keeps the device on this machine', () => {
  const onEas = parseAgentCliSettings({ deviceBackend: 'eas' }, 'config');

  it(`should win over the config`, () => {
    expect(withConfiguredDevice(resolveRuntimeStopOptions(['--ios', '--local']), onEas).cloud).toBe(
      false
    );
  });

  it(`should refuse --eas with --local`, () => {
    expect(() => resolveRuntimeStopOptions(['--ios', '--eas', '--local'])).toThrow(
      /--eas and --local name two places/
    );
  });
});
