// @ref llp/0035-one-device-per-worktree.rfc.md §Reap
// The manual steps that a failed device action names, shared by release and the reap.

/** The command that ends a spawned emulator by hand. */
export function killStep(emulatorPid: number): string {
  return `kill ${emulatorPid}`;
}

/** Text followed by the How line for `step`. */
export function withHow(text: string, step: string): string {
  return `${text}\nHow: run "${step}".`;
}
