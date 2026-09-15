// @ref llp/0002-testing-and-evals.plan.md
import fs from 'node:fs';
import path from 'node:path';

import type { FixtureSession } from './cli';

// The Podfile that `expo prebuild` writes, trimmed. Nothing runs it; its presence is the point.
const PODFILE = `require File.join(File.dirname(\`node --print "require.resolve('expo/package.json')"\`), "scripts/autolinking")

platform :ios, '15.1'

target 'AgentEval' do
  use_expo_modules!
end
`;

/**
 * Turn a copied project into one that checked in its ios directory, as after \`expo prebuild\`.
 * Expo Go cannot run such a project, so the status probe must report it as incompatible.
 * The directory is created before the workspace snapshot, so preservation checks still hold.
 */
export async function addCheckedInNativeProject(root: string): Promise<FixtureSession> {
  const iosDirectory = path.join(root, 'ios');
  await fs.promises.mkdir(iosDirectory, { recursive: true });
  await fs.promises.writeFile(path.join(iosDirectory, 'Podfile'), PODFILE);
  return {
    evidence: () => ({ checkedInNativeDirs: ['ios'] }),
  };
}
