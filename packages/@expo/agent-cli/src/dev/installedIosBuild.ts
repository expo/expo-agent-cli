// @ref llp/0004-smart-start-and-project-state.rfc.md §A current build is not an installed app
import { devicesDisabled, hostBindsPlatform } from '../deviceBinding';
import { isExplicitChoiceRefusal } from '../deviceBinding/errors';
import { previewExplicitDeviceAsync } from '../deviceBinding/preview';
import { readSimulatorsAsync } from '../installedApp/iosSimulator';
import type { DecideStartPlanOptions } from '../plan/types';
import { generateFingerprintAsync } from '../project/fingerprint';
import { readConfiguredAppId } from '../runtime/appId';
import { withSubprocessDeadlineAsync } from '../utils/subprocessDeadline';
import { explicitRequestOf } from './deviceOption';
import type { DevOptions } from './resolveOptions';

export async function findInstalledIosBuildAsync(
  projectRoot: string,
  options: DevOptions
): Promise<DecideStartPlanOptions['installedIosBuild']> {
  const explicit = explicitRequestOf(options.device, options.callerArgv);
  if (!explicit || devicesDisabled() || !hostBindsPlatform('ios')) return;

  const appId = readConfiguredAppId(projectRoot, 'ios');
  if (!appId) return;

  const preview = await previewExplicitDeviceAsync(projectRoot, 'ios', explicit).catch((error) => {
    if (!isExplicitChoiceRefusal(error)) throw error;
    return null;
  });
  if (preview?.device.backend !== 'local-ios') return;

  const simulator = { identifier: preview.device.udid, name: preview.device.name };
  return await withSubprocessDeadlineAsync(
    8000,
    'Installed iOS build check timed out.',
    async () => {
      const installed = await readSimulatorsAsync([simulator], appId, '');
      if (installed.status !== 'ok') return undefined;
      const current = await generateFingerprintAsync(projectRoot, {
        platform: 'ios',
        cache: false,
      });
      return current.hash === installed.hash ? simulator : undefined;
    }
  ).catch(() => undefined);
}
