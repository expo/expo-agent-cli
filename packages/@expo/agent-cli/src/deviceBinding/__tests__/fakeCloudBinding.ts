// A cloud binding as `acquireCloudBindingAsync` writes one, for a suite that needs one on disk.

import type { CloudBinding } from '../cloud';
import { bindingPathFor, writeBindingFile } from '../registry';
import type { DevicePlatform } from '../types';

export interface CloudBindingOptions {
  origin?: 'started' | 'dotenv';
  boundAt?: string;
  expiresAt?: string;
}

/** Bound at 09:00 and live until 11:00 on `fakeTools`'s day, unless the caller says otherwise. */
export function cloudBindingFor(
  projectRoot: string,
  platform: DevicePlatform,
  id: string,
  {
    origin = 'started',
    boundAt = '2026-10-08T09:00:00.000Z',
    expiresAt = '2026-10-08T11:00:00.000Z',
  }: CloudBindingOptions = {}
): CloudBinding {
  return {
    version: 1,
    projectRoot,
    device: { backend: 'cloud', platform, id, origin },
    boundAt,
    expiresAt,
  };
}

export function writeCloudBinding(
  projectRoot: string,
  platform: DevicePlatform,
  id: string,
  options?: CloudBindingOptions
): CloudBinding {
  const binding = cloudBindingFor(projectRoot, platform, id, options);
  writeBindingFile(bindingPathFor(projectRoot, platform, 'cloud'), binding);
  return binding;
}
