import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { FixtureSession } from '../cli';
import { developerCases } from '../developer-cases';
import { checkDeveloperTask } from '../developer-checks';
import { runProcess } from '../process';
import { cliBin, copyWorkspace, snapshot } from '../workspace';

// Prove the graders accept actual CLI outcomes before asking a model to discover the calls.
// A no-op must fail for every fixture, including ones whose files already look correct.
const referenceCases = [
  ...developerCases,
  {
    ...developerCases.find(({ task }) => task === 'bundler-error')!,
    baseline: [['status'], ['smoke', '--ios']],
  },
];
for (const { task, input, baseline } of referenceCases) {
  it(`grades built CLI evidence and rejects no-op: ${task} (${baseline.map((argv) => argv.join(' ')).join(' → ')})`, async () => {
    const root = copyWorkspace(input.fixture, input.linkDependencies);
    const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'developer-eval-test-'));
    const env = { ...process.env, CI: '1', LOG_EVENTS: path.join(artifacts, 'events.jsonl') };
    let fixture: FixtureSession | undefined;
    try {
      fixture = await input.setupProject?.({ root, artifacts, env });
      const before = snapshot(root);
      fs.writeFileSync(env.LOG_EVENTS, '');
      expect(() =>
        checkDeveloperTask(task, {
          root,
          before,
          commands: [],
          summary: '',
          turns: 0,
          cliEvents: [],
          fixtureEvidence: fixture?.evidence?.() ?? null,
        })
      ).toThrow();
      const commands = [];
      for (const argv of baseline) {
        commands.push({
          argv,
          ...(await runProcess(process.execPath, [cliBin, ...argv], {
            cwd: root,
            env,
            signal: AbortSignal.timeout(30_000),
          })),
        });
      }
      const cliEvents = fs
        .readFileSync(env.LOG_EVENTS, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      checkDeveloperTask(task, {
        root,
        before,
        commands,
        summary: '',
        turns: 1,
        cliEvents,
        fixtureEvidence: fixture?.evidence?.() ?? null,
      });
    } finally {
      try {
        await fixture?.close?.();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(artifacts, { recursive: true, force: true });
      }
    }
  }, 45_000);
}
