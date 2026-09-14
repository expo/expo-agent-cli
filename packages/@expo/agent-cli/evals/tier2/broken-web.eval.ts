import { expect, it } from 'vitest';
import { runTier2 } from './harness.mjs';

// Tier 2 retains its separate E2E lifecycle and artifacts while its dedicated kit evolves.
it('repairs the cart and preserves working browser behavior', async ({ signal, skip }) => {
  const { output } = await runTier2('broken-web-cart', signal);
  if (output.status === 'skipped') skip(output.reason);
  expect(output.status, `${output.reason}; artifacts/tier2/outcome.json`).toBe('passed');
});
