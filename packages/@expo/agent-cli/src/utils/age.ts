/**
 * An age a reader can weigh at a glance.
 *
 * Whole units and never a decimal: this number is read to decide whether a cached answer can be
 * trusted, and "4m" answers that where "4.31 minutes" only looks like it does. Seconds below a
 * minute, because most hits in an agent loop are seconds old and "0m" would read as stale-proof.
 */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
