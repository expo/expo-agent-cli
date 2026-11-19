import type { ChildProcess } from 'child_process';

import { Log } from '../log';
import { formatStartPlan } from '../plan/format';
import type { StartPlan } from '../project/types';

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
    Log.progress(formatStartPlan(message.plan));
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
