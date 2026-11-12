import type { NativePlatform } from '../plan/types';

/** The argv of the session start, pure and exported so the test table pins it. */
export function buildSessionStartArgs({
  platform,
  app,
  openUrl,
  name,
}: {
  platform: NativePlatform;
  app: { expoGo: true } | { expoGo: false; buildId: string };
  openUrl: string;
  name: string;
}): string[] {
  return [
    // `eas simulator` rather than `eas simulator:start`: that is the command name in the CLI's own
    // manifest, and the one carrying `--expo-go` [observed — eas-cli 22.6 `oclif.manifest.json`].
    'simulator',
    '--platform',
    platform,
    '--type',
    'agent-device',
    ...(app.expoGo ? ['--expo-go'] : ['--build-id', app.buildId]),
    '--open-url',
    openUrl,
    '--non-interactive',
    '--name',
    name,
    '--max-idle-time-minutes',
    '30',
  ];
}

/**
 * The session id out of what `eas simulator` printed.
 *
 * `Simulator session created (id: <id>)` is printed as soon as the session exists — before the
 * wait for readiness, so a start that then fails still names the session it billed
 * [observed — eas-cli 23.2 `simulator/index.ts`; expo-ci, 2026-09-06]. The `--json` form is read
 * too, for a caller that passed it.
 */
export function readSessionId(output: string): string | null {
  // `(id: <id>)` with `--json`, and `(id: <id>, saved to .env.eas-simulator)` without it — the
  // form this CLI runs, which the first regex here did not read [observed — live, expo-ci,
  // 2026-09-08: "Opened the app on EAS Simulator session (id unknown)" beside the session's URL].
  const created = /Simulator session created\s*\(id:\s*([^\s,)]+)/.exec(output);
  if (created) {
    return created[1]!;
  }
  // The session page names it too, and is printed on the same line.
  const fromUrl = /simulator-sessions\/([^\s/)]+)/.exec(output);
  if (fromUrl) {
    return fromUrl[1]!;
  }
  const start = output.indexOf('{');
  if (start >= 0) {
    try {
      const parsed = JSON.parse(output.slice(start)) as { id?: unknown };
      if (typeof parsed.id === 'string' && parsed.id) {
        return parsed.id;
      }
    } catch {
      // Not JSON, or not the JSON of a session — the line above is the answer then.
    }
  }
  return null;
}

/** The session's page on expo.dev out of what `eas simulator` printed, or null. */
export function readSessionUrl(output: string): string | null {
  return /https:\/\/expo\.dev\/\S*simulator-sessions\/[^\s)]+/.exec(output)?.[0] ?? null;
}
