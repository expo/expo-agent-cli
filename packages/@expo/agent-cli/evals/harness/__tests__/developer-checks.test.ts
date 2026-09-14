import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createWorkspace, type DefineChecks, type CheckFn } from '@expo/agent-eval-vitest';
import type { EvalInput, EvalOutput, FixtureSession, CliFixture } from '../cli';
type DeveloperTask = 'expo-go' | 'native' | 'js' | 'reload' | 'bundler-error';
const { checks } = vi.hoisted(() => ({ checks: new Map<string, CheckFn<CliFixture>[]>() }));
// Load the actual colocated checks without registering model-driven suites in this unit run.
vi.mock('../cli', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cli')>()),
  agentEval: (url: string, _options: unknown, define: DefineChecks<CliFixture>) => {
    const name = new URL(url).pathname.split('/').at(-1)!.replace('.eval.ts', '');
    const callbacks: CheckFn<CliFixture>[] = [];
    define((_name, fn) => callbacks.push(fn));
    checks.set(name, callbacks);
  },
}));
import '../../tier1/expo-go.eval';
import '../../tier1/native.eval';
import '../../tier1/js.eval';
import '../../tier1/reload.eval';
import '../../tier1/bundler-error.eval';
function checkDeveloperTask(task: DeveloperTask, output: EvalOutput) {
  const callbacks = checks.get(task)!;
  expect(callbacks).toHaveLength(3);
  for (const check of callbacks)
    check(createWorkspace(output.root, 'without-skill'), {
      fixture: { output: () => output },
      execution: { finalAnswer: null, toolCalls: null, endReason: 'completed', artifacts: [] },
      skip: () => {
        throw new Error('Unexpected skipped check');
      },
    });
}
import { setupImpactFixture } from '../impact-fixture';
import { startRuntimeFixture } from '../runtime-fixture';
import { runProcess } from '../process';
import { cliBin, copyWorkspace, snapshot } from '../workspace';

// Prove the graders accept actual CLI outcomes before asking a model to discover the calls.
// A no-op must fail for every fixture, including ones whose files already look correct.
type ReferenceCase = {
  task: DeveloperTask;
  input: Pick<EvalInput, 'fixture' | 'linkDependencies' | 'setupProject'>;
  baseline: string[][];
};
// Only fixture/reference-command setup belongs here. User prompts live beside their eval tests.
const referenceCases: ReferenceCase[] = [
  {
    task: 'expo-go',
    input: { fixture: 'evals/fixtures/real-app', linkDependencies: true },
    baseline: [['status']],
  },
  ...(['native', 'js'] as const).map((task): ReferenceCase => ({
    task,
    input: {
      fixture: 'e2e/fixtures/dev-client-fresh-app',
      setupProject: (context) => setupImpactFixture(context, task),
    },
    baseline: [['status']],
  })),
  {
    task: 'reload',
    input: {
      fixture: 'e2e/fixtures/go-app',
      setupProject: ({ root }) => startRuntimeFixture(root, 'reload'),
    },
    baseline: [['runtime:reload']],
  },
  ...[[['dev:logs']], [['status'], ['smoke', '--ios']]].map((baseline): ReferenceCase => ({
    task: 'bundler-error',
    input: {
      fixture: 'e2e/fixtures/go-app',
      setupProject: ({ root }) => startRuntimeFixture(root, 'bundler-error'),
    },
    baseline,
  })),
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
