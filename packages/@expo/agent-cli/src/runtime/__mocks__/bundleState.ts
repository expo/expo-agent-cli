// The probe opens one socket per target, and unit tests open none: every own app has run its bundle.
import type { AttachedApps } from '../bundleState';
import type { CdpTarget } from '../cdpClient';

export const attachedAppsAsync = vi.fn(
  async (read: readonly CdpTarget[]): Promise<AttachedApps> => ({
    attached: [...read],
    loading: [],
  })
);
