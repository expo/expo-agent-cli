import { join } from 'node:path';

/** @param {string} home @param {NodeJS.ProcessEnv} parent @returns {NodeJS.ProcessEnv} */
export function isolatedEnvironment(home, parent = process.env) {
  const env = Object.fromEntries(
    ['PATH', 'TMPDIR', 'LANG', 'SYSTEMROOT'].filter((k) => parent[k]).map((k) => [k, parent[k]])
  );
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    CI: '1',
    EXPO_NO_TELEMETRY: '1',
    BROWSER: 'none',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
}

/** @param {import('./process.mjs').ProcessResult} proc @param {string} log */
export function assertBrokenBaseline(proc, log) {
  const plain = log.replace(/\x1b\[[0-9;]*m/g, '');
  const missingImport =
    /Unable to resolve(?: module)?\s+["']?\.\/src\/total["']?\s+from\s+["']?(?:[^\r\n"']*[\/\\])?App\.js(?:["':\s]|$)/.test(
      plain
    );
  if (
    proc.exitCode === null ||
    proc.exitCode === 0 ||
    proc.timedOut ||
    proc.spawnError ||
    proc.signal ||
    !missingImport
  )
    throw new Error(
      'Fixture did not fail for the intended unresolved ./src/total import in App.js; see baseline logs'
    );
}
