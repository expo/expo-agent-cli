import { statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';
import { BaseSequencer } from 'vitest/node';
import type { TestSpecification } from 'vitest/node';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Split shards by file size instead of by path hash.
 *
 * The default sequencer sorts files by the sha1 of their path and slices contiguous chunks, so which
 * shard gets `smoke-test.ts` (~1700 lines) and `status-test.ts` (~2200) is luck — and when they land
 * together, that shard runs minutes longer than the rest [observed — CI, 2026-09-05]. This bin-packs
 * instead: largest file first, each onto the shard with the least on it so far. Byte size is a proxy
 * for runtime, but a good enough one to keep the shards within a file of each other.
 */
class SizeBalancedSequencer extends BaseSequencer {
  async shard(specs: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!;
    const bins = Array.from({ length: count }, () => ({ load: 0, specs: [] as TestSpecification[] }));
    const sized = specs
      .map((spec) => ({ spec, size: sizeOf(spec.moduleId) }))
      .sort((a, b) => b.size - a.size);
    for (const { spec, size } of sized) {
      const lightest = bins.reduce((min, bin) => (bin.load < min.load ? bin : min));
      lightest.specs.push(spec);
      lightest.load += size;
    }
    return bins[index - 1]!.specs;
  }
}

/** File size in bytes, or 0 when it cannot be read — an unreadable file should not sink one bin. */
function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
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
      // @see SizeBalancedSequencer — keeps the two big test files off the same shard.
      sequencer: SizeBalancedSequencer,
    },
    env: {
      npm_config_user_agent: '',
      npm_execpath: '',
    },
  },
});
