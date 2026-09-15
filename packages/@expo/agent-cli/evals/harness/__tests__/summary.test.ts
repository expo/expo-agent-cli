import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readCaseResults, renderSummary, type CaseResult } from '../summary';

const caseResult = (overrides: Partial<CaseResult> = {}): CaseResult => ({
  id: 'expo-go',
  attemptId: 'expo-go-abc123',
  status: 'passed',
  startedAt: '2026-09-15T05:00:00.000Z',
  finishedAt: '2026-09-15T05:01:30.000Z',
  execution: {
    endReason: 'completed',
    metadata: {
      model: 'qwen3:8b',
      digest: '500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41',
      ollamaVersion: '0.32.15',
      cliVersion: '1.0.13',
      turns: 3,
      inputTokens: 4200,
      outputTokens: 150,
    },
  },
  checks: [
    { name: 'inspects this project’s Expo Go compatibility', status: 'passed' },
    { name: 'avoids unrelated setup, builds, or server starts', status: 'passed' },
    { name: 'preserves project sources and configuration', status: 'passed' },
  ],
  counts: { passed: 3, failed: 0, skipped: 0 },
  ...overrides,
});

describe(renderSummary, () => {
  it('should render one table row per case with turns, tokens, checks, and duration', () => {
    const summary = renderSummary([caseResult()]);
    expect(summary).toContain('| expo-go | passed | completed | 3 | 4200 / 150 | 3 / 3 | 90 s |');
    expect(summary).toContain(
      'Model: `qwen3:8b` · digest `500a1f067a9f` · Ollama 0.32.15 · CLI 1.0.13'
    );
    expect(summary).not.toContain('Checks not passed');
  });

  it('should list every check that did not pass with the first line of its error', () => {
    const summary = renderSummary([
      caseResult({
        id: 'reload',
        status: 'failed',
        checks: [
          {
            name: 'dev server receives a reload caused by the agent',
            status: 'failed',
            error: 'expected { reloaded: false } to match\nsecond line',
          },
          { name: 'preserves project sources and configuration', status: 'skipped' },
        ],
        counts: { passed: 0, failed: 1, skipped: 1 },
      }),
    ]);
    expect(summary).toContain('### Checks not passed');
    expect(summary).toContain(
      '- **reload** failed: dev server receives a reload caused by the agent: expected { reloaded: false } to match'
    );
    expect(summary).not.toContain('second line');
    expect(summary).toContain('- **reload** skipped: preserves project sources and configuration');
  });

  it('should show dashes and no model line for a dry run without runner metadata', () => {
    const summary = renderSummary([
      caseResult({
        status: 'dry-run',
        execution: { endReason: 'completed', metadata: { dryRun: true } },
      }),
    ]);
    expect(summary).toContain('| expo-go | dry-run | completed | – | – | 3 / 3 | 90 s |');
    expect(summary).not.toContain('Model:');
  });

  it('should say so when there are no results', () => {
    expect(renderSummary([])).toBe('No Tier 1 case results were written.\n');
  });
});

describe(readCaseResults, () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('should read result.json from each attempt directory and sort by case then start time', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-summary-test-'));
    roots.push(root);
    const write = (directory: string, result: CaseResult) => {
      fs.mkdirSync(path.join(root, directory));
      fs.writeFileSync(path.join(root, directory, 'result.json'), JSON.stringify(result));
    };
    write('reload-b', caseResult({ id: 'reload', startedAt: '2026-09-15T05:02:00.000Z' }));
    write('expo-go-a', caseResult({ id: 'expo-go' }));
    write('reload-a', caseResult({ id: 'reload', startedAt: '2026-09-15T05:00:00.000Z' }));
    fs.mkdirSync(path.join(root, 'no-result-here'));
    fs.writeFileSync(path.join(root, 'results.json'), '{}');
    expect(
      readCaseResults(root).map((result) => [result.id, result.startedAt.slice(11, 16)])
    ).toEqual([
      ['expo-go', '05:00'],
      ['reload', '05:00'],
      ['reload', '05:02'],
    ]);
  });

  it('should return an empty list when the artifact root does not exist', () => {
    expect(readCaseResults(path.join(os.tmpdir(), 'eval-summary-missing-root'))).toEqual([]);
  });
});
