import * as Log from '../../log';

/** Everything the command wrote with `console.log`, joined into one string. The test spies on it. */
export function printed(): string {
  return vi.mocked(console.log).mock.calls.flat().join('\n');
}

/** Everything the command wrote with `Log.log`, joined into one string. The test mocks `../log`. */
export function printedLog(): string {
  return vi.mocked(Log.log).mock.calls.flat().join('\n');
}
