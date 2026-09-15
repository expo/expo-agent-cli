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
      if (!event || typeof event._e !== 'string') {
        throw new Error(`Invalid CLI event line ${index + 1}`);
      }
      return event;
    });
  const exportInvocations = events.filter(
    (event) =>
      event._e === 'cli:expo_passthrough' &&
      event.command === 'export' &&
      Array.isArray(event.args) &&
      !event.args.some((arg) => ['--help', '-h'].includes(arg))
  );
  let pendingExport = false;
  let successfulExports = 0;
  for (const event of events) {
    if (event._e === 'root:init' || event._e === 'cli:start_plan') {
      pendingExport = false;
    }
    if (event._e === 'cli:expo_passthrough') {
      pendingExport = exportInvocations.includes(event);
    }
    if (event._e === 'cli:expo_exit' && pendingExport) {
      if (event.code === 0 && !event.signal) {
        successfulExports++;
      }
      pendingExport = false;
    }
  }
  const plans = events.filter(
    (event) => event._e === 'cli:start_plan' && event.mode === 'smart' && event.target === 'web'
  );
  const starts = events.filter(
    (event) =>
      event._e === 'cli:start_plan_step' &&
      Array.isArray(event.argv) &&
      event.argv[0] === 'expo' &&
      event.argv[1] === 'start'
  );
  const servers = events.filter(
    (event) =>
      event.port === port &&
      ((event._e === 'cli:dev_lock_acquired' && Number.isInteger(event.pid) && event.pid > 0) ||
        (event._e === 'cli:dev_detach' &&
          event.alreadyRunning === false &&
          event.ready !== false &&
          Number.isInteger(event.pid) &&
          event.pid > 0))
  );
  if (!successfulExports || !plans.length || !starts.length || !servers.length) {
    throw new Error(
      'Missing agent-cli export invocation or executed web dev plan/server events; direct Expo, help and plan-only calls do not satisfy Tier2'
    );
  }
  return {
    exportInvocations: exportInvocations.length,
    successfulExports,
    webDevPlans: plans.length,
    startSteps: starts.length,
    serverEvents: servers.length,
    eventCount: events.length,
  };
}
