// @ref llp/0005-runtime-loop-tools.rfc.md §Reloading the app

/** One way of reloading, and what it did. */
export interface ReloadAttempt {
  method: 'dev-server' | 'runtime' | 'device';
  /** The app was reloaded by this method. */
  ok: boolean;
  /**
   * Whether the mechanism's action **reached the app**, which is not whether it worked.
   *
   * The distinction is F97 [observed — live cloud, 2026-08-27]. A broadcast has three outcomes, not
   * two: the socket refused it, the frame went out and the app was seen to come back, or the frame
   * went out and nothing was seen. The third used to be reported as the first — `ok: false` and no
   * mechanism, so the run exited `20` ("nothing ran") and **skipped the two observations** that
   * exist for a mechanism whose own proof is missing. A live run spent 8.9 s of a 180 s budget that
   * way, with a client registered on the socket and the frame delivered to it.
   *
   * Null for an attempt where delivery is not a separate question from the outcome, which is every
   * attempt that decides by running a device tool: `simctl terminate` naming a process that is not
   * there fails, and there is no "delivered but unproved" for it.
   */
  delivered?: boolean | null;
  /** Why it did not work, or what it did. Never null: an attempt always has something to say. */
  reason: string;
  /**
   * The application id this attempt stopped and could not start again, or null.
   *
   * The device method is a force-stop and a relaunch, so a relaunch that is refused leaves the app
   * **closed** — a state this command produced and used to say nothing about [live run S12: a
   * cloud session was left with no app running, and the report said only "The app was not
   * reloaded"]. Null for every attempt that stopped nothing, including a stop that itself failed.
   */
  leftAppStopped: string | null;
}
