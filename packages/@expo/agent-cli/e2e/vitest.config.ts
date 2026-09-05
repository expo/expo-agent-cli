import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';
import { BaseSequencer } from 'vitest/node';
import type { TestSpecification } from 'vitest/node';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Split shards by measured test duration, not by path hash or file size.
 *
 * The default sequencer shards by the sha1 of each path, so which shard gets the slow files is luck,
 * and one shard ran minutes longer than the rest [observed — CI, 2026-09-05]. File size is no better
 * a proxy: `smoke-test.ts` runs ~322 s (it boots devices and waits) while the larger-on-disk
 * `status-test.ts` runs ~92 s. So this bin-packs by real per-file durations, recorded in
 * `shard-weights.json` — largest first, each onto the lightest shard so far. A file not in the map
 * (a new one) gets the median weight, enough to land it on the lightest shard without skewing the
 * split; refresh the map with `test:e2e --reporter=json` when the times drift.
 */
const WEIGHTS: Record<string, number> = JSON.parse(
  readFileSync(path.join(rootDir, 'shard-weights.json'), 'utf8')
);
const WEIGHT_VALUES = Object.values(WEIGHTS).sort((a, b) => a - b);
const MEDIAN_WEIGHT = WEIGHT_VALUES[Math.floor(WEIGHT_VALUES.length / 2)] ?? 10_000;

class DurationBalancedSequencer extends BaseSequencer {
  async shard(specs: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!;
    const bins = Array.from({ length: count }, () => ({ load: 0, specs: [] as TestSpecification[] }));
    const weighted = specs
      .map((spec) => ({ spec, weight: WEIGHTS[path.basename(spec.moduleId)] ?? MEDIAN_WEIGHT }))
      .sort((a, b) => b.weight - a.weight);
    for (const { spec, weight } of weighted) {
      const lightest = bins.reduce((min, bin) => (bin.load < min.load ? bin : min));
      lightest.specs.push(spec);
      lightest.load += weight;
    }
    return bins[index - 1]!.specs;
  }
}

export default defineConfig({
  test: {
    name: 'agent-cli-e2e',
    root: rootDir,
    environment: 'node',
    globals: true,
    include: ['__tests__/**/*-test.ts'],
    // The fixtures ship committed `node_modules` directories as test data. Vitest must never treat
    // them as modules of this project.
    exclude: ['**/node_modules/**', 'fixtures/**'],
    testTimeout: process.platform === 'win32' ? 300_000 : 180_000,
    pool: 'forks',
    sequence: {
      // @see DurationBalancedSequencer — balances shards by measured per-file runtime.
      sequencer: DurationBalancedSequencer,
    },
    env: {
      npm_config_user_agent: '',
      npm_execpath: '',
    },
  },
});
