// @ref llp/0002-testing-and-evals.plan.md
// @ref llp/0011-impact-and-freshness.rfc.md §The record has to hold the sources
import fs from 'node:fs';
import path from 'node:path';
import type { JsonValue } from 'vitest-evals';
import { installStubFingerprintAsync } from '../../e2e/utils';
import type { FixtureContext, FixtureSession } from './cli';
import { runProcess } from './process';
import { snapshot } from './workspace';

/**
 * Prepare a disposable copy of e2e/fixtures/dev-client-fresh-app. The external fingerprint
 * stub hashes project inputs; the real CLI owns the diff and impact classification.
 * Its bounded model treats every declared dependency as native and ignores JS contents.
 * No packages are downloaded and no native build is performed.
 */
export async function setupImpactFixture(
  context: FixtureContext,
  kind: 'native' | 'js'
): Promise<FixtureSession> {
  if (kind !== 'native' && kind !== 'js') throw new Error('Unknown impact fixture kind');
  const { root, artifacts, env } = context;
  if (!(await installStubFingerprintAsync(root))) {
    throw new Error('Impact fixture requires a copy of e2e/fixtures/dev-client-fresh-app');
  }
  fs.mkdirSync(artifacts, { recursive: true });
  const invocationLog = path.join(artifacts, 'impact-fingerprint-invocations.jsonl');
  Object.assign(env, {
    STUB_FINGERPRINT_HASH_FROM_PROJECT: '1',
    STUB_FINGERPRINT_EXIT_CODE: '0',
    STUB_FINGERPRINT_LOG: invocationLog,
  });
  delete env.STUB_FINGERPRINT_HASH;
  fs.writeFileSync(invocationLog, '');

  const baseline: Record<string, { hash: string; sources: JsonValue[] }> = {};
  for (const platform of ['ios', 'android']) {
    const result = await runProcess(
      path.join(root, 'node_modules/.bin/fingerprint'),
      ['fingerprint:generate', root, '--platform', platform],
      { cwd: root, env, signal: AbortSignal.timeout(10_000) }
    );
    if (result.timedOut || result.exitCode !== 0) {
      throw new Error(`Impact fixture baseline failed for ${platform}: ${result.stderr}`);
    }
    const value: { hash?: JsonValue; sources?: JsonValue } = JSON.parse(result.stdout);
    if (typeof value.hash !== 'string' || !Array.isArray(value.sources) || !value.sources.length) {
      throw new Error(`Impact fixture baseline has no native sources for ${platform}`);
    }
    baseline[platform] = { hash: value.hash, sources: value.sources };
  }
  const recordPath = path.join(root, '.expo/agent-cli-last-build.json');
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  const recordText = JSON.stringify(baseline, null, 2) + '\n';
  fs.writeFileSync(recordPath, recordText);

  const changedFile = kind === 'native' ? 'package.json' : 'index.js';
  if (kind === 'native') {
    const packagePath = path.join(root, changedFile);
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (pkg.dependencies?.['fake-native-module'] !== '1.0.0') {
      throw new Error('Impact fixture expects fake-native-module@1.0.0 before the change');
    }
    pkg.dependencies['fake-native-module'] = '2.0.0';
    fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
  } else {
    // Do not add a JS-only dependency here: the stub intentionally classifies all deps as native.
    fs.appendFileSync(
      path.join(root, changedFile),
      "\nexport const screenTitle = 'Updated screen';\n"
    );
  }
  // Setup is not agent evidence. Only fingerprint subprocesses after preparation are retained.
  fs.writeFileSync(invocationLog, '');
  const projectFiles = () =>
    Object.fromEntries(
      Object.entries(snapshot(root)).filter(([file]) => !file.startsWith('.expo/'))
    );
  const preparedFiles = projectFiles();
  return {
    // No persistent processes: runProcess awaits/reaps each child and kills on its deadline.
    // Keep the caller-owned workspace and evidence available for grading after close.
    close: async () => {},
    evidence: () => {
      const currentFiles = projectFiles();
      const projectPreserved =
        JSON.stringify(currentFiles) === JSON.stringify(preparedFiles) &&
        fs.existsSync(recordPath) &&
        fs.readFileSync(recordPath, 'utf8') === recordText;
      const fingerprintInvocations = fs
        .readFileSync(invocationLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line): JsonValue => JSON.parse(line));
      return {
        kind,
        changedFile,
        baseline,
        preparedFiles,
        currentFiles,
        projectPreserved,
        fingerprintInvocations,
      };
    },
  };
}
