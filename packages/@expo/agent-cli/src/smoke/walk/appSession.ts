import type { OpenRouteResult } from '../../navigate/openRoute';
import type { SmokeDeps } from '../phases';
import { APP_SETTLE_MS } from '../timeouts';
import type { SmokeRunReport } from './walk';

/**
 * What this run did to the app, from phase 5 on.
 *
 * One mutable object because later phases write these and closures made earlier read them: the
 * reload marks the app as moved, and the settle wait the `app` phase handed the picture reads it.
 */
export class AppSession {
  #opened = false;
  #moved = false;
  #devLauncherLeftOnScreen = false;
  #settled = false;

  constructor(
    private readonly deps: SmokeDeps,
    private readonly report: SmokeRunReport,
    private readonly remaining: () => number
  ) {}

  /**
   * Whether this run put the app on the screen. A run with no `--route` still opens the root route
   * when nothing is attached.
   */
  get openedByThisRun(): boolean {
    return this.#opened;
  }

  /**
   * Whether this run changed what the app is running, so it may still be coming up.
   *
   * Opened **or reloaded** (F57 plus the `reload` phase). The two waits below — the target settle
   * and the runtime-ready poll — exist for an app that is mid-load, and after wave 25 there are two
   * ways for this run to have put it there. Kept apart from {@link openedByThisRun}, which still
   * answers a different question: whether the thing on the screen is something this run opened,
   * which is what the picture's caption rests on.
   */
  get movedByThisRun(): boolean {
    return this.#moved;
  }

  /** This run opened the app, on the root route or the one it was given. */
  noteOpened(opened: OpenRouteResult): void {
    this.#opened = true;
    this.#moved = true;
    // @ref llp/0005-runtime-loop-tools.rfc.md §Loading the app is not navigating it. What a
    // development build shows when the launcher URL this run opened never produced a loaded app is
    // the launcher's own screen, and a picture of it has to say so — `openRouteAsync` reports the
    // open it performed, so this is read rather than guessed.
    //
    // **`exitCode === 0` is part of the question**, and leaving it out made the picture lie
    // [observed — Kudo, local run, 2026-09-04]. A launcher open the device *refused* also comes back
    // `attached: false`, so a run whose deep link was rejected with `115` — no app on that device
    // handles the scheme — captioned its screenshot "the loading link was opened and this project's
    // bundle never ran". The link was not opened. Nothing was. The screenshot is the one piece of
    // evidence a reader believes without checking it (llp/0021 §The rules), so a caption that
    // describes an act that never happened is the worst thing in this file to get wrong.
    this.#devLauncherLeftOnScreen =
      opened.launch != null && opened.launch.exitCode === 0 && !opened.launch.attached;
    this.report.deviceId = opened.deviceId;
    this.report.deviceBackend = opened.deviceBackend;
    if (this.report.route != null) {
      this.report.routeCheck = opened.routeCheck;
    }
  }

  /** A reload was proved, so the app is coming back and owes the same waits as a fresh open. */
  noteReloaded(): void {
    this.#moved = true;
  }

  /** What a picture taken with no app of this project connected is a picture of. */
  showingWithoutApp(): 'dev-launcher' | 'device' {
    return this.#devLauncherLeftOnScreen ? 'dev-launcher' : 'device';
  }

  /**
   * Wait for the app this run moved to stop re-registering. At most once, and never otherwise.
   *
   * @ref ../timeouts §APP_SETTLE_MS. Shared by the runtime read and the picture because it is one
   * fact about one app: a second wait would be a second budget spent proving what the first one
   * already proved.
   *
   * "Moved" rather than "opened": a proved reload leaves the app re-registering exactly the way a
   * cold launch does, so it owes this wait for the same reason.
   */
  async settleAsync(): Promise<void> {
    if (!this.#moved || this.#settled) {
      return;
    }
    this.#settled = true;
    await this.deps.waitForStableTargets(
      this.report.devServerUrl,
      Math.min(APP_SETTLE_MS, Math.max(0, this.remaining()))
    );
  }
}
