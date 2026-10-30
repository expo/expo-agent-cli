/** Make `process.platform` answer `value`. `vitest.setup.ts` restores the real value after each test. */
export function mockPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}
