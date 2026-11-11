import { EMPTY_SETTINGS } from '../../settings/types';
import { recoveryRequestFor, recoveryStartCommand } from '../recoveryRequest';
import { resolveDevOptions } from '../resolveOptions';
import { startupRequestFrom } from '../startupRequest';

it.each(['ios', 'android'] as const)(
  'keeps %s EAS Build with a local device dependent on its existing configuration',
  (platform) => {
    const settings = {
      ...EMPTY_SETTINGS,
      buildBackend: 'eas' as const,
      target: 'dev-build' as const,
    };
    const request = startupRequestFrom(
      resolveDevOptions(
        [
          `--${platform}`,
          '--device',
          'test-device',
          '--no-open',
          '--no-fingerprint-cache',
          '--no-agent-skills',
          '--max-workers',
          '2',
          '--scheme',
          'my-app',
          '--',
          'opaque argument',
        ],
        settings
      ),
      settings
    );
    const command = recoveryStartCommand(recoveryRequestFor(platform, request));
    expect(command).not.toContain('--eas');
    expect(command).not.toContain('--local');
    expect(command).toContain('--dev-client');
    expect(command).toContain('--device test-device');
    expect(command).toContain('--no-open --no-fingerprint-cache --no-agent-skills');
    expect(command).toContain(
      "--max-workers 2 --scheme my-app --device test-device --detach --wait-ready -- 'opaque argument'"
    );
  }
);
