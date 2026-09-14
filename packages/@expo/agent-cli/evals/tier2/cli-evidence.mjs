// These are agent-cli's real 2g event shapes (src/events.ts and src/plan/events.ts).
// Read only the LOG_EVENTS file passed to the agent, never verifier/cleanup events.
/** @param {string} raw @param {number} port */
export function assertCliEvidence(raw, port) {
  const events = raw
    .split('\n')
    .filter((line) => line.trim())
    .map((line, index) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new Error(`Malformed CLI event line ${index + 1}`);
      }
      if (!event || typeof event._e !== 'string')
        throw new Error(`Invalid CLI event line ${index + 1}`);
      return event;
    });
  const exports = events.filter(
    (e) =>
      e._e === 'cli:expo_passthrough' &&
      e.command === 'export' &&
      Array.isArray(e.args) &&
      !e.args.some((arg) => ['--help', '-h'].includes(arg))
  );
  let pendingExport = false;
  let successfulExports = 0;
  for (const event of events) {
    if (event._e === 'root:init' || event._e === 'cli:start_plan') pendingExport = false;
    if (event._e === 'cli:expo_passthrough') pendingExport = exports.includes(event);
    if (event._e === 'cli:expo_exit' && pendingExport) {
      if (event.code === 0 && !event.signal) successfulExports++;
      pendingExport = false;
    }
  }
  const plans = events.filter(
    (e) => e._e === 'cli:start_plan' && e.mode === 'smart' && e.target === 'web'
  );
  const starts = events.filter(
    (e) =>
      e._e === 'cli:start_plan_step' &&
      Array.isArray(e.argv) &&
      e.argv[0] === 'expo' &&
      e.argv[1] === 'start'
  );
  const servers = events.filter(
    (e) =>
      e.port === port &&
      ((e._e === 'cli:dev_lock_acquired' && Number.isInteger(e.pid) && e.pid > 0) ||
        (e._e === 'cli:dev_detach' &&
          e.alreadyRunning === false &&
          e.ready !== false &&
          Number.isInteger(e.pid) &&
          e.pid > 0))
  );
  if (!successfulExports || !plans.length || !starts.length || !servers.length)
    throw new Error(
      'Missing agent-cli export invocation or executed web dev plan/server events; direct Expo, help and plan-only calls do not satisfy Tier2'
    );
  return {
    exportInvocations: exports.length,
    successfulExports,
    webDevPlans: plans.length,
    startSteps: starts.length,
    serverEvents: servers.length,
    eventCount: events.length,
  };
}
