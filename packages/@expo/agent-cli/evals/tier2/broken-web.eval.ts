import { expect } from 'vitest';
import { describeEval } from 'vitest-evals';
import { tier2Harness } from './harness.mjs';

describeEval(
  'Tier2: diagnose, repair, export, and run a real Expo web app',
  { harness: tier2Harness },
  (it) => {
    it('repairs the cart and preserves working browser behavior', async ({ run, skip }) => {
      const result = await run('broken-web-cart');
      if (result.output.status === 'skipped') skip(result.output.reason);
      expect(result.output.status, `${result.output.reason}; artifacts/tier2/outcome.json`).toBe(
        'passed'
      );
    });
  }
);
