// @ref llp/0036-record-build-before-metro-exits.plan.md
import { captureEvents } from '2g/api';
import { events, getEventLoggerInfo } from '2g';
import type { ChildProcess, SpawnOptions } from 'child_process';
import fs from 'fs';
import path from 'path';

export type ChildEventObserver = (event: Record<string, unknown>) => void | Promise<void>;

/** A private pipe per spawn, independent of stdout/stderr and any shared event-log file. */
export function prepareChildEvents(options: SpawnOptions, observer?: ChildEventObserver) {
  if (!observer) return { options, attach: (_child: ChildProcess) => undefined };
  const capture = captureEvents({ debug: true });
  // 2g removes LOG_EVENTS from process.env after taking ownership of its sink.
  const parentLogger = getEventLoggerInfo();
  const configured =
    options.env?.LOG_EVENTS ??
    process.env.LOG_EVENTS ??
    parentLogger?.file ??
    (parentLogger?.fd != null ? String(parentLogger.fd) : undefined);
  const captured = capture.spawnOptions(options);
  const fd = Number(captured.env.LOG_EVENTS);
  return {
    options: captured,
    attach(child: ChildProcess) {
      let accepting = true;
      let origin: string | undefined;
      let relayFd: number | undefined;
      let ownsRelay = false;
      const pipe = child.stdio[fd];
      // Relay the original wire bytes, including debug and unknown events, to the destination
      // the caller configured. Observation must never turn off their event log.
      const relayViaLogger = parentLogger != null && options.env?.LOG_EVENTS == null;
      if (configured && !relayViaLogger) {
        try {
          if (/^\d+$/.test(configured)) relayFd = Number(configured);
          else {
            relayFd = fs.openSync(
              path.resolve(String(options.cwd ?? process.cwd()), configured),
              'a'
            );
            ownsRelay = true;
          }
        } catch {
          /* Logging is advisory; a broken destination must not kill the child. */
        }
      }
      pipe?.on('data', (chunk: string | Buffer) => {
        if (relayFd == null) return;
        try {
          fs.writeSync(relayFd, typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        } catch {
          /* Preserve server behavior. */
        }
      });
      const stop = () => {
        accepting = false;
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      const cleanup = () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        if (ownsRelay && relayFd != null) {
          try {
            fs.closeSync(relayFd);
          } catch {}
          relayFd = undefined;
        }
      };
      let finished: Promise<void>;
      try {
        capture.attach(child);
        finished = (async () => {
          for await (const event of capture) {
            if (relayViaLogger) {
              // The parent owns this sink. A second file descriptor would have an independent
              // position and its writes could be overwritten by the parent's buffered output.
              const separator = event._e.indexOf(':');
              if (separator > 0) {
                try {
                  const log = (event._l === 1 ? events.debug : events)(
                    event._e.slice(0, separator)
                  ) as unknown as (name: string, data: Record<string, unknown>) => void;
                  log(event._e.slice(separator + 1), event);
                } catch {}
              }
            }
            // 2g tags a new CLI as event_log_child:<pid> when its parent is instrumented.
            // A shim/package runner can be the immediate child, so bind its first root init,
            // then reject other workers. The pipe itself is private to this spawn attempt.
            if (
              origin == null &&
              event._e === 'root:init' &&
              typeof event._w === 'string' &&
              /^event_log_child:\d+$/.test(event._w)
            ) {
              origin = event._w;
            }
            if (accepting) {
              const own = event._w === `event_log_child:${child.pid}` || event._w === origin;
              try {
                await observer(own ? { ...event, _w: undefined } : event);
              } catch {
                /* An observer cannot stop Metro. */
              }
            }
          }
        })()
          .catch(() => {})
          .finally(cleanup);
      } catch {
        cleanup();
        finished = Promise.resolve();
      }
      child.once('error', () => {
        stop();
        pipe?.destroy();
        cleanup();
      });
      child.once('close', () => {
        // All pipe data has arrived at close. Drain accepted events before resolving the run.
        pipe?.destroy();
      });
      return { finished };
    },
  };
}
