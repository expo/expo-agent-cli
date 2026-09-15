// Print the Tier 1 job summary and append it to the GitHub step summary when one is open.
// Usage: bun evals/summarize.ts
import fs from 'node:fs';

import { readCaseResults, renderSummary } from './harness/summary';
import { artifactRoot } from './harness/workspace';

const summary = renderSummary(readCaseResults(artifactRoot));
process.stdout.write(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
