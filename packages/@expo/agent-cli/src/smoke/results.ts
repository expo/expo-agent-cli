import type { ScreenshotResult } from '../device/screenshot';
import type { BundleCheckResult } from '../runtime/bundleCheck';
import type { RuntimeErrorRecord } from '../runtime/runtimeErrorCollector';
import type { SmokePhase, SmokeReloadJson } from './types';

/**
 * Whether one record is something the gate fails on. Exported so the report and the follow-ups
 * count the same thing this decides the verdict on.
 */
export function isFailingRecord(record: RuntimeErrorRecord): boolean {
  // Not `source === 'exception'` alone, which is what the design said and what the live round
  // disproved [observed — 2026-08-24, notesapp on SDK 57 in Expo Go, iOS 26.5 simulator]. An
  // uncaught `throw` never reached `Runtime.exceptionThrown` in any run: React Native caught it
  // and reported it through the console path, so a gate reading `source` passed **seventeen
  // crashes** in one window and called them `console.error` calls. `RuntimeErrorRecord.isError`
  // documents the three cases measured to settle it, and the limit it leaves — a deliberately
  // logged `Error` is the same bytes and fails too.
  //
  // `source === 'exception'` stays in the test rather than being dropped: a runtime that does use
  // that channel exists, and a gate reading only the console path would be the same mistake
  // pointed the other way.
  return record.isError === true || record.source === 'exception';
}

/**
 * What the `reload` phase amounts to for a run that never got there.
 *
 * A fresh object each call: this is handed out as the run's own mutable record, and a shared
 * literal would let one run's phase write into the next one's report.
 */
export function noReload(): SmokeReloadJson {
  return {
    disposition: 'not-needed',
    verifiedBy: null,
    knownTargetIds: [],
    freshTargets: null,
    commandSocketReconnected: null,
    targetOutcomes: [],
    bundleServed: null,
  };
}

/**
 * A screenshot that was never attempted, so the report has the same keys either way.
 *
 * @ref llp/0006-agent-native-cli-surface.rfc.md §Output contract.
 */
export function noScreenshot(reason: string): ScreenshotResult {
  return {
    path: '',
    ok: false,
    reason,
    platform: null,
    deviceId: null,
    command: null,
    bytes: null,
  };
}

/** Add a finding to a phase's sentence, after the one already there. */
export function appendReason(phase: SmokePhase, finding: string): void {
  phase.reason = phase.reason == null ? finding : `${phase.reason} · ${finding}`;
}

/** What an `ok` screenshot says it captured, or null when it is the app itself. */
export function showingReason(showing: 'project' | 'dev-launcher' | 'device'): string | null {
  switch (showing) {
    case 'project':
      return null;
    case 'dev-launcher':
      return `the dev launcher's own screen — the loading link was opened and this project's bundle never ran, so this is not a picture of the app`;
    case 'device':
      return `the device's screen — no app of this project was connected, so this is not a picture of it running`;
  }
}

/** The bundler's own error, as one sentence with the location in it. */
export function bundleErrorSentence(bundle: BundleCheckResult): string {
  const where = [bundle.error?.filename, bundle.error?.lineNumber, bundle.error?.column]
    .filter((part) => part != null)
    .join(':');
  return `${where ? `${where}: ` : ''}${bundle.error?.message ?? 'the bundler reported an error'}`;
}
