// @ref llp/0004-smart-start-and-project-state.rfc.md §Decision table
// The steps of a local build: prebuild when asked, then `expo run:<platform>`.

import type { PlanStep } from '../project/types';
import { localRequirement, LOCAL_WHERE } from '../toolchain/runsOn';
import type { NativePlatform } from './types';

/**
 * Build and install, then serve.
 *
 * A development build is built with `run:<platform> --no-bundler`, which exits after the install,
 * so the build is recorded before `serve` starts the dev server, and the dev server's open moves the
 * app to it. An app without `expo-dev-client` cannot be moved after launch: the Expo CLI compiles
 * the bundler port into it, and with `--no-bundler` that port is 8081, whatever serves there. So
 * with no `serve`, one `run:<platform>` step builds, installs and serves on the port `dev` gives it,
 * and the build is recorded when that step ends (llp/0004 Risk 10).
 */
export function localBuildSteps(
  platform: NativePlatform,
  reason: string,
  prebuild: boolean,
  serve: PlanStep | null
): PlanStep[] {
  const steps = prebuild ? [prebuildStep(platform)] : [];
  const builds = `Builds the ${platform} app ${LOCAL_WHERE} (a local build, which needs ${localRequirement(platform)})`;
  if (serve == null) {
    return [
      ...steps,
      localStep(
        'run',
        ['expo', `run:${platform}`],
        'many-minutes',
        `${builds}, installs it, and starts the dev server. ${reason}`
      ),
    ];
  }
  return [
    ...steps,
    localStep(
      'run',
      ['expo', `run:${platform}`, '--no-bundler'],
      'many-minutes',
      `${builds} and installs it. --no-bundler because the next step is the dev server. ${reason}`
    ),
    serve,
  ];
}

/**
 * Prebuild, which runs locally and is labelled so.
 *
 * It generates source rather than a binary, and it is still a `local` step: on iOS it ends in a
 * `pod install` that wants Xcode's command line tools, and it is the first half of a build that
 * only ever happens on this machine. A caller who cannot build here needs to know that at this
 * step, not at the next one.
 */
function prebuildStep(platform: NativePlatform): PlanStep {
  return localStep(
    'prebuild',
    ['expo', 'prebuild', '--platform', platform],
    'a-minute',
    `Generates the ${platform} native project from the app config and the installed packages. Runs ${LOCAL_WHERE}, as the first half of a local build.`
  );
}

function localStep(
  id: string,
  argv: string[],
  timeClass: PlanStep['timeClass'],
  reason: string
): PlanStep {
  return { id, argv, timeClass, reason, runsOn: 'local' };
}
