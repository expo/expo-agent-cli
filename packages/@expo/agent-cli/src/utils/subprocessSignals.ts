import type { ChildProcess } from 'node:child_process';

import { killProcessTree } from './processGroup';

export function watchSubprocessSignals(
  child: ChildProcess,
  options: {
    signal?: AbortSignal;
    processGroup: boolean;
    drainOnAbort?: boolean;
    forwardUnmanaged?: boolean;
  }
): () => void {
  const stop = (signal: NodeJS.Signals) => {
    if (options.processGroup || process.platform === 'win32') killProcessTree(child, signal);
    else child.kill(signal);
  };
  if (options.signal) {
    const signal = options.signal;
    const abort = () => {
      const reason: unknown = signal.reason;
      const received =
        reason && typeof reason === 'object' && 'signal' in reason && reason.signal === 'SIGINT'
          ? 'SIGINT'
          : 'SIGTERM';
      stop(received);
    };
    if (!options.drainOnAbort) signal.addEventListener('abort', abort, { once: true });
    return () => signal.removeEventListener('abort', abort);
  }
  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  if (options.forwardUnmanaged) {
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
  }
  return () => {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  };
}
