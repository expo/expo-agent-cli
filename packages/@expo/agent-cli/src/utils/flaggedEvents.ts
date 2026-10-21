// @ref llp/0015-backend-selection-and-config.rfc.md §The device backend
// The `2g` event factory, with every payload passed through the `--local` rewrite: the stream
// carries the commands an agent runs, so they keep the flag the run was given.
import { events as rawEvents } from '2g';

import { withRunBackendFlagDeep } from './backendFlag';

type Emit = (name: string, payload?: unknown) => unknown;

export const events: typeof rawEvents = Object.assign(
  ((category: string) => {
    const emit = rawEvents(category as Parameters<typeof rawEvents>[0]);
    return Object.assign(
      ((name: string, payload?: unknown) =>
        (emit as unknown as Emit)(name, withRunBackendFlagDeep(payload))) as unknown as typeof emit,
      emit
    );
  }) as unknown as typeof rawEvents,
  rawEvents
);
