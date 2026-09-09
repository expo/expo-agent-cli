import fs from 'node:fs';
import path from 'node:path';

import { executeAgentCliAsync, setupFixtureAsync } from '../utils';

// Observe the environment at the actual Expo subprocess boundary, in both output modes.
describe('tunnel v2 default', () => {
  it.each([
    [undefined, '1'],
    ['0', '0'],
    ['1', '1'],
  ])('passes %s as %s to Expo', async (configured, expected) => {
    for (const json of [false, true]) {
      const projectRoot = await setupFixtureAsync('go-app');
      const bin = path.join(projectRoot, 'node_modules/expo/bin/cli');
      const original = await fs.promises.readFile(bin, 'utf8');
      await fs.promises.writeFile(
        bin,
        original.replace(
          '#!/usr/bin/env node',
          `#!/usr/bin/env node\nrequire('fs').writeFileSync('tunnel-env.json', JSON.stringify({ value: process.env.EXPO_UNSTABLE_TUNNEL_V2 ?? null }));`
        )
      );
      await executeAgentCliAsync(projectRoot, ['start', '--tunnel', ...(json ? ['--json'] : [])], {
        env: { EXPO_UNSTABLE_TUNNEL_V2: configured },
      });
      expect(
        JSON.parse(await fs.promises.readFile(path.join(projectRoot, 'tunnel-env.json'), 'utf8'))
      ).toEqual({ value: expected });
    }
  });
});
