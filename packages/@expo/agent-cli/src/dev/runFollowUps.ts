// @ref llp/0009-smart-followups.rfc.md §Examples per command — the follow-ups of a `dev` run.

import { resolveDevServerPort, type FollowUp } from '../followups';
import type { StartPlan } from '../project/types';
import {
  resolveStartFollowUpsAsync,
  type StartFollowUpOptions,
  type StartTargetHint,
} from '../start/followUps';
import type { DevServerRun } from '../start/startAsync';
import type { DevOptions } from './resolveOptions';

/**
 * What the shared start ladder is asked for, for one `dev` run.
 *
 * `devServer` is what the run learned about the server it started, and null before it has started
 * one. The port is only claimed when something reported it: `source: 'default'` means neither the
 * dev server nor the command line named one, and a URL built on that assumption is how this
 * command came to tell an agent to open a *different project's* app
 * [observed — friction run, 2026-08-23].
 *
 * The dev-server options a follow-up may quote are the **plan's last step**, never the caller's own
 * arguments. They are the same list for a plan that ends in `expo start`, and they differ for every
 * plan that does not: `--tunnel` cannot be forwarded to `expo run:ios`, and reading the raw
 * arguments once made it print a development-build URL naming a port the step did not serve on
 * [F120, observed — wave 29 live, 2026-08-27]. The plan is the argv that will run (llp/0015 §The
 * plan approved is the plan run), so it is the one thing a follow-up may read.
 */
export function runFollowUpRequest(
  plan: StartPlan,
  options: Pick<DevOptions, 'followups' | 'deviceBackend'>,
  devServer: DevServerRun | null
): { options: StartFollowUpOptions; hint: StartTargetHint } {
  const planArgs = plan.steps.at(-1)?.argv.slice(1) ?? [];
  const port = devServer
    ? // After the run: what the dev server reported, and nothing when it reported nothing.
      devServer.port && devServer.port.source !== 'default'
      ? devServer.port.port
      : null
    : // Before it: the port the plan's own last step carries, or the one the Expo CLI defaults to.
      resolveDevServerPort(planArgs);

  return {
    options: { expoArgs: planArgs, followups: options.followups },
    hint: {
      expoGo: plan.target === 'expo-go',
      web: plan.target === 'web',
      eas: options.deviceBackend === 'eas',
      port,
      // Whatever the plan's own probe established, and null when it planned no build and probed
      // nothing. The cloud-build rung reads it to say why the cloud is still worth choosing.
      localBuild: plan.buildLocation?.status ?? null,
    },
  };
}

/** The follow-ups of a run, which are the dev server's. */
export async function resolveRunFollowUpsAsync(
  projectRoot: string,
  plan: StartPlan,
  options: DevOptions,
  devServer: DevServerRun | null
): Promise<FollowUp[]> {
  const request = runFollowUpRequest(plan, options, devServer);
  return await resolveStartFollowUpsAsync(projectRoot, request.options, request.hint);
}
