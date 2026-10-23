import {
  CLOUD_SIMULATOR_WAITLIST_URL,
  type CloudRunResult,
  type CloudSessionInfo,
  type CloudSessionProbe,
  type LiveCloudSessionProbe,
} from '../cloudSimulator';

type SessionFields = Partial<CloudSessionInfo> & { id: string };

function session(fields: SessionFields): CloudSessionInfo {
  return {
    status: null,
    platform: null,
    type: 'agent-device',
    name: null,
    createdAt: null,
    ...fields,
  };
}

/** One builder per probe state, so a fixture cannot build a state the probe never returns. */
export const cloudProbe = {
  active: (fields: SessionFields, candidateCount = 1): LiveCloudSessionProbe<'active'> => ({
    state: 'active',
    session: session({ status: 'IN_PROGRESS', ...fields }),
    candidateCount,
  }),
  queued: (fields: SessionFields, candidateCount = 1): LiveCloudSessionProbe<'queued'> => ({
    state: 'queued',
    session: session({ status: 'QUEUED', ...fields }),
    candidateCount,
  }),
  inactive: (
    sessionId: string,
    reason = 'the bound EAS session is no longer listed as active or queued'
  ): CloudSessionProbe => ({ state: 'inactive', sessionId, reason }),
  none: ({
    reason = 'the service lists no running EAS Simulator session for this project',
    wrongTypeCount = 0,
    unboundCount = 0,
  }: {
    reason?: string;
    wrongTypeCount?: number;
    unboundCount?: number;
  } = {}): CloudSessionProbe => ({
    state: 'none',
    reason,
    wrongTypeCount,
    unboundCount,
  }),
  unavailable: (
    waitlistUrl = CLOUD_SIMULATOR_WAITLIST_URL,
    reason = 'EAS Simulator is not enabled on this account, so no session can be started for this project'
  ): CloudSessionProbe => ({ state: 'unavailable', reason, waitlistUrl }),
  unknown: ({
    reason = 'EAS session discovery failed',
    sessionId = null,
    failure = null,
  }: {
    reason?: string;
    sessionId?: string | null;
    failure?: CloudRunResult | null;
  } = {}): CloudSessionProbe => ({ state: 'unknown', reason, sessionId, failure }),
};
