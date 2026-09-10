// @ref llp/0002-testing-and-evals.plan.md
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { FixtureContext, FixtureSession } from '../cli';
import { setupImpactFixture } from '../impact-fixture';
import { runProcess } from '../process';
import { cliBin, copyWorkspace } from '../workspace';

it.each(['native', 'js'] as const)(
  'derives %s impact from project fingerprint inputs through the built CLI',
  async (kind) => {
    const root = copyWorkspace('e2e/fixtures/dev-client-fresh-app');
    let artifacts: string | undefined;
    let session: FixtureSession | undefined;
    try {
      artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-fixture-test-'));
      const context: FixtureContext = {
        root,
        artifacts,
        env: {
          ...process.env,
          CI: '1',
          NO_COLOR: '1',
          // Setup must override inherited controls rather than silently using constant output.
          STUB_FINGERPRINT_HASH: 'incorrect',
          STUB_FINGERPRINT_EXIT_CODE: '1',
        },
      };
      const originalPackage = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
      const originalJs = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
      session = await setupImpactFixture(context, kind);
      expect(context.env.STUB_FINGERPRINT_HASH_FROM_PROJECT).toBe('1');
      expect(session.evidence?.()).toMatchObject({
        kind,
        projectPreserved: true,
        fingerprintInvocations: [],
      });
      const recordPath = path.join(root, '.expo/agent-cli-last-build.json');
      const recordText = fs.readFileSync(recordPath, 'utf8');
      const record = JSON.parse(recordText);
      for (const platform of ['ios', 'android']) {
        expect(record[platform].hash).toMatch(/^[a-f0-9]{40}$/);
        expect(record[platform].sources).toContainEqual(
          expect.objectContaining({
            filePath: 'node_modules/fake-native-module',
            reasons: ['expoAutolinkingIos'],
          })
        );
      }
      expect(fs.readFileSync(path.join(root, 'package.json'), 'utf8') === originalPackage).toBe(
        kind === 'js'
      );
      expect(fs.readFileSync(path.join(root, 'index.js'), 'utf8') === originalJs).toBe(
        kind === 'native'
      );
      const result = await runProcess(
        process.execPath,
        [cliBin, 'status', '--json', '--dev-server-url', 'http://127.0.0.1:1'],
        {
          cwd: root,
          env: context.env,
          signal: AbortSignal.timeout(20_000),
        }
      );
      expect(result.timedOut).toBe(false);
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      const report = JSON.parse(result.stdout);
      const local = report.freshness.platforms.filter(
        (p: { backend: string }) => p.backend === 'local'
      );
      expect(local.map((p: { platform: string }) => p.platform).sort()).toEqual(['android', 'ios']);
      for (const platform of local) {
        expect(platform.impact).toMatchObject({
          class: kind === 'native' ? 'needs-native-build' : 'js-only',
          fingerprintChanged: kind === 'native',
          changedCount: kind === 'native' ? 1 : 0,
        });
        if (kind === 'native')
          expect(platform.impact.reason).toContain('autolinked native modules changed');
      }
      const evidence = session.evidence?.() as {
        projectPreserved: boolean;
        fingerprintInvocations: { args: string[]; cwd: string }[];
      };
      expect(evidence.projectPreserved).toBe(true);
      expect(evidence.fingerprintInvocations.length).toBeGreaterThan(0);
      for (const call of evidence.fingerprintInvocations) {
        expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(root));
        expect(call.args[0]).toBe('fingerprint:generate');
      }
      expect(fs.readFileSync(recordPath, 'utf8')).toBe(recordText);
      expect(JSON.parse(JSON.stringify(session.evidence?.()))).toEqual(session.evidence?.());
      await session.close?.();
      expect(fs.existsSync(path.join(root, 'package.json'))).toBe(true);
      // Preservation evidence must actually inspect the project, not return a canned success.
      fs.appendFileSync(path.join(root, 'index.js'), '\n// unexpected agent edit\n');
      expect(session.evidence?.()).toMatchObject({ projectPreserved: false });
    } finally {
      try {
        await session?.close?.();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        if (artifacts) fs.rmSync(artifacts, { recursive: true, force: true });
      }
    }
  },
  30_000
);
