// @ref llp/0030-one-device-per-agent.rfc.md §The registry
// One device per platform per worktree: a machine-wide registry of claims, and the allocation
// that reads it.

export { allocateDeviceAsync, CREATED_DEVICE_EXPIRY_MS } from './allocate';
export type { AllocateDeviceOptions } from './allocate';
export { chooseDevice } from './choose';
export type { ChooseDeviceInput } from './choose';
export { devicesAllClaimedError } from './errors';
export { CLAIM_GRACE_MS, classifyClaimAsync } from './liveness';
export {
  claimFilePath,
  isSameClaim,
  readClaim,
  deviceRegistryDirectory,
  readClaims,
  REGISTRY_LOCK_STALE_MS,
  releaseClaim,
  releaseProjectClaimsAsync,
  touchClaim,
  withRegistryLockAsync,
  writeClaim,
} from './registry';
export type {
  Allocation,
  ClaimLiveness,
  ClassifiedClaim,
  DeviceBackend,
  DeviceCandidate,
  DeviceChoice,
  DeviceClaim,
  DevicePlatform,
} from './types';
