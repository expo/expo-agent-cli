/** Everything written to `sink`, joined into one string. The test spies on or mocks the sink. */
export function printed(sink: (...args: any[]) => unknown = console.log): string {
  return vi.mocked(sink).mock.calls.flat().join('\n');
}
