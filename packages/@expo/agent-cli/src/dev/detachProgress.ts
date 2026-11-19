import type { ChildProcess } from 'child_process';

import { Log } from '../log';
import { formatTimeClass } from '../plan/format';
import type { StartPlan } from '../project/types';
import { RUNS_ON_LABELS } from '../toolchain/runsOn';

interface PlanMessage {
  type: 'dev-plan';
  plan: StartPlan;
}

export function sendDetachedPlan(plan: StartPlan): void {
  if (process.connected) {
    process.send?.({ type: 'dev-plan', plan } satisfies PlanMessage, () => {
      // The detached child may outlive its parent.
      if (process.connected) process.disconnect?.();
    });
  }
}

export function reportDetachedProgress(child: ChildProcess, logFile: string, waitReady: boolean) {
  Log.progress(`Live log: ${logFile}`);

  let planPrinted = false;
  let waitingForMetro = false;
  child.once('message', (message: PlanMessage) => {
    if (message?.type !== 'dev-plan') return;
    planPrinted = true;
    Log.progress(formatPlanSteps(message.plan));
    if (waitReady && message.plan.steps.some((step) => step.runsOn != null)) {
      Log.progress('Next: native build or install, then the Metro readiness wait.');
    }
    if (waitingForMetro) Log.progress('Waiting for Metro readiness…');
  });
  child.channel?.unref();

  return () => {
    if (waitingForMetro) return;
    waitingForMetro = true;
    if (planPrinted) Log.progress('Waiting for Metro readiness…');
  };
}

/** Steps only: the full plan, with its reasons, is at the top of the live log. */
function formatPlanSteps(plan: StartPlan): string {
  const steps = plan.steps.map((step, index) => {
    const cost = [formatTimeClass(step.timeClass), step.runsOn && RUNS_ON_LABELS[step.runsOn]];
    return `  ${index + 1}. ${step.argv.join(' ')}  (${cost.filter(Boolean).join(', ')})`;
  });
  return ['Plan (reasons in the live log):', ...steps].join('\n');
}
