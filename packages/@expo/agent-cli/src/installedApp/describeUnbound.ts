// @ref llp/0004-smart-start-and-project-state.rfc.md §Reported by status
// The sentence for iOS `no-device`: what the booted simulators are to this worktree.

/** The simulators no worktree bound, or none: absent names say only that none is bound here. */
export function describeUnboundSimulators(names: readonly string[] | undefined): string {
  if (!names?.length) {
    return 'No iOS simulator is bound to this worktree.';
  }
  return `${names.length} iOS ${names.length === 1 ? 'simulator is' : 'simulators are'} booted (${names.join(', ')}), and none is bound to this worktree.`;
}
