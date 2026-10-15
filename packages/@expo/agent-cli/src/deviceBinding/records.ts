// @ref llp/0035-one-device-per-worktree.rfc.md §Records
import { bindingPathFor } from './registry';
import { localBackendOf } from './types';

export function ownBindingFiles(projectRoot: string) {
  return (['ios', 'android'] as const).flatMap((platform) =>
    ([localBackendOf(platform), 'cloud'] as const).map((backend) => ({
      platform,
      backend,
      file: bindingPathFor(projectRoot, platform, backend),
    }))
  );
}
