import fs from 'node:fs';
import path from 'node:path';

import { isProcessRunning } from '../src/dev/processLiveness';
import { signalProcessAsync } from '../src/dev/processStop';
import { detachEnv } from './detachUtils';
import { installStubEasAsync } from './stubEas';
import {
  bin,
  freePortAsync,
  installStubFingerprintAsync,
  readJsonLines,
  setupFixtureAsync,
  waitForAsync,
} from './utils';

export async function setupDetachedFixtureAsync() {
  const root = await setupFixtureAsync('dev-client-fresh-app');
  const port = await freePortAsync();
  const release = path.join(root, 'release-fingerprint');
  const held = path.join(root, 'held-fingerprint.jsonl');
  const candidates = path.join(root, 'release-candidates');
  const smokeCandidate = path.join(root, 'release-smoke-candidate');
  const spawned = path.join(root, 'spawned.jsonl');
  const preload = path.join(root, 'capture-process.cjs');
  await installStubEasAsync(root);
  await installStubFingerprintAsync(root);
  fs.appendFileSync(
    path.join(root, 'node_modules/@expo/fingerprint/bin/cli'),
    `\nif (process.env.HOLD_FINGERPRINT === '1') {
      fs.appendFileSync(${JSON.stringify(held)}, process.pid + '\\n');
      while (!fs.existsSync(${JSON.stringify(release)})) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }\n`
  );
  fs.writeFileSync(
    preload,
    `const script = process.argv[1];
    const owner = script === ${JSON.stringify(bin)} && process.env.__EXPO_AGENT_CLI_DETACHED === '1';
    if (owner || (script?.startsWith(${JSON.stringify(root)}) && ['start', 'build'].includes(process.argv[2]))) {
      require('node:fs').appendFileSync(${JSON.stringify(spawned)}, JSON.stringify({ pid: process.pid, owner }) + '\\n');
    }
    if (owner && ['1', 'smoke'].includes(process.env.HOLD_CANDIDATE)) {
      const release = process.env.HOLD_CANDIDATE === 'smoke' ? ${JSON.stringify(smokeCandidate)} : ${JSON.stringify(candidates)};
      while (!require('node:fs').existsSync(release)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }`
  );
  const env = {
    ...detachEnv(root, port),
    NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
    STUB_EXPO_LISTEN: '1',
    STUB_EXPO_TUNNEL_HOST: 'owned.tunnel.example',
    STUB_SIM_SESSIONS: '0',
    STUB_FINGERPRINT_HASH: 'feedfacefeedfacefeedfacefeedfacefeedface',
  };
  const heldPids = () => readJsonLines<number>(held);
  const processes = () => readJsonLines<{ pid: number; owner: boolean }>(spawned);
  const releaseSmokeCandidate = () => fs.writeFileSync(smokeCandidate, '');
  const releaseCandidates = () => fs.writeFileSync(candidates, '');
  const releaseFingerprint = () => fs.writeFileSync(release, '');
  async function cleanup() {
    const pids = [...processes().map(({ pid }) => pid), ...heldPids()];
    for (const pid of pids.filter(isProcessRunning)) {
      await signalProcessAsync(pid, 'SIGKILL');
    }
    releaseCandidates();
    releaseSmokeCandidate();
    releaseFingerprint();
    if (!(await waitForAsync(() => pids.every((pid) => !isProcessRunning(pid)), 5000))) {
      throw new Error(
        `Fixture processes still running: ${pids.filter(isProcessRunning).join(', ')}`
      );
    }
  }
  return {
    root,
    port,
    env,
    heldPids,
    processes,
    releaseCandidates,
    releaseSmokeCandidate,
    releaseFingerprint,
    cleanup,
  };
}
