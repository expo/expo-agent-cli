import { events } from '2g';

declare module '2g' {
  interface EventRegistry {
    // @ref llp/0004-smart-start-and-project-state.rfc.md §Plan contract — the port a busy start moved
    // to, so a reader of the event stream can see the dev server is not where it was asked for.
    'dev:start_plan_port_retry': {
      busyPort: number | null;
      offeredPort: number | null;
      port: number | null;
    };
    // @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
    'dev:detach_spawn': { logFile: string; argv: string[] };
    // `ownsTarget` is false for a lock this project holds on a port other than the one `--port`
    // named: the lock was read and deliberately not acted on (llp/0021 §The rules).
    'dev:stop_lock_read': { held: boolean; pid: number | null; ownsTarget: boolean };
    /** `dev:stop --eas` asked the EAS Simulator session to end, and whether it did. */
    'dev:stop_session': { sessionId: string; ok: boolean };
    'dev:stop_signalled': { pid: number; signal: string; ok: boolean };
    // The three checks, separately, because the conclusion is drawn from the first two and the
    // third is the one that used to be able to overrule them (llp/0005 §Stopping the app
    // listener). A reader of the stream can see which of them the verdict came from.
    'dev:stop_outcome': { processGone: boolean; lockGone: boolean; portFree: boolean };
    'dev:stop_done': { stopped: boolean; pid: number | null; reason: string | null };
    // @ref llp/0026-dev-owns-the-open.rfc.md — the acts of the open, so an agent watching the
    // stream sees the same walk the stderr narration describes.
    'dev:open_app_boot': { platform: string };
    'dev:open_app_install_expo_go': { platform: string; replaced: boolean };
    /** `dev --eas` added the simulator dev-client profile to `eas.json` before the build. */
    'dev:eas_json_profile_added': { profile: string };
    /** The `eas build` step finished, and this is the build EAS lists for it. */
    'dev:eas_build_named': { buildId: string };
    /** The EAS Simulator open waited for the dev server's tunnel host, and this is what it got. */
    'dev:open_app_eas_tunnel': { platform: string; host: string | null };
    /** A session this project already had is the one the app is opened on. */
    'dev:open_app_eas_session_reused': { platform: string; sessionId: string };
    /** No session was up, so one is started, with the app named on the command line. */
    'dev:open_app_eas_session_start': {
      platform: string;
      app: 'expo-go' | 'dev-build';
      buildId: string | null;
    };
    'dev:open_app_eas_opened': {
      platform: string;
      sessionId: string | null;
      started: boolean;
    };
    'dev:open_app_opened': {
      platform: string;
      deviceId: string | null;
      booted: boolean;
      installedExpoGo: boolean;
    };
  }
}

export const event = events('dev');
export const debugEvent = events.debug('dev');
