import { events } from '../utils/flaggedEvents';

import type { InstallImpactReport } from '../project/types';

declare module '2g' {
  interface EventRegistry {
    'install:impact': { packages: string[]; reports: InstallImpactReport[] };
  }
}

export const event = events('install');
export const debugEvent = events.debug('install');
