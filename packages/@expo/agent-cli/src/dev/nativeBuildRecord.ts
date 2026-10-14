// @ref llp/0036-record-build-before-metro-exits.plan.md
import { Log } from '../log';
import { recordLastBuildFingerprint, type LastBuildFingerprint } from '../plan/lastBuild';
import type { NativePlatform } from '../plan/types';
import { clearFingerprintMemo, generateFingerprintAsync } from '../project/fingerprint';
import { isValidAppId, readConfiguredAppId } from '../runtime/appId';
import { CommandError } from '../utils/errors';
import { isInstallCompletion, type NativeRunEvent } from './buildEvidence';

async function measure(projectRoot: string): Promise<LastBuildFingerprint | null> {
  clearFingerprintMemo(projectRoot);
  // Match the default, all-platform fingerprint used by probeProjectStateAsync / dev planning.
  // Each measurement must be independent of both the probe and previous attempt measurements.
  const value = await generateFingerprintAsync(projectRoot, { cache: false });
  return value.hash ? { hash: value.hash, sources: value.sources } : null;
}

export async function captureNativeBuildInputsAsync(projectRoot: string) {
  const snapshot = await measure(projectRoot);
  let verifiable = snapshot != null;
  return {
    async beforeCompile() {
      const current = await measure(projectRoot);
      if (snapshot && current && snapshot.hash !== current.hash) {
        throw new CommandError(
          'NATIVE_INPUTS_CHANGED',
          'Native inputs changed during preparation. Compilation was not started. Run dev again to prepare the native project from the current inputs.'
        );
      }
      verifiable &&= current != null;
    },
    async verify(): Promise<LastBuildFingerprint | null> {
      const current = await measure(projectRoot);
      return verifiable && snapshot && current?.hash === snapshot.hash ? snapshot : null;
    },
  };
}

type NativeBuildInputs = Awaited<ReturnType<typeof captureNativeBuildInputsAsync>>;

/** One child invocation, including a separate instance for each port retry. */
export class NativeInstallAttempt {
  installed = false;
  recorded = false;
  private closed = false;
  private readonly startedAt = Date.now();
  private completion?: Promise<void>;
  private selectedTargetMatches: boolean;
  private readonly appId: string | null;
  private readonly target: string | undefined;
  private readonly binary: boolean;

  constructor(
    private readonly projectRoot: string,
    private readonly platform: NativePlatform,
    args: string[],
    private readonly inputs: NativeBuildInputs
  ) {
    this.target = argument(args, '--device', '-d');
    this.selectedTargetMatches = this.target == null;
    this.appId = argument(args, '--app-id') ?? readConfiguredAppId(projectRoot, platform);
    this.binary = args.some((arg) => arg === '--binary' || arg.startsWith('--binary='));
  }

  onEvent = async (event: NativeRunEvent): Promise<void> => {
    if (
      this.closed ||
      this.completion ||
      event._w != null ||
      event.platform !== this.platform ||
      typeof event._t !== 'number' ||
      event._t < this.startedAt
    )
      return;
    if (event._e === 'run:device:selected') {
      this.selectedTargetMatches =
        this.target == null ||
        (typeof event.id === 'string' &&
          event.id.length > 0 &&
          typeof event.name === 'string' &&
          (event.id === this.target || event.name === this.target));
      return;
    }
    if (
      !this.selectedTargetMatches ||
      !this.appId ||
      !isValidAppId(this.appId) ||
      !isInstallCompletion(event, this.platform, this.appId)
    )
      return;
    this.installed = true;
    // Set the promise before yielding: duplicate events and shutdown join this exact completion.
    this.completion = this.publish();
    await this.completion;
  };

  private async publish() {
    try {
      const fingerprint = this.binary ? null : await this.inputs.verify();
      if (!fingerprint) {
        Log.warn(
          'Installation completed, but its native inputs could not be verified. Build freshness is unknown; the previous build record was retained.'
        );
        return;
      }
      this.recorded = await recordLastBuildFingerprint(
        this.projectRoot,
        this.platform,
        fingerprint
      );
      if (!this.recorded) {
        Log.warn(
          'Installation completed, but its build record could not be written. The next plan may request another build.'
        );
      }
    } catch {
      Log.warn(
        'Installation completed, but build verification failed. The previous build record was retained.'
      );
    }
  }

  async finish() {
    this.closed = true;
    await this.completion;
    if (!this.installed) {
      Log.warn(
        'No verified installation completion was received from this Expo CLI run. The previous build record was retained.'
      );
    }
  }
}

function argument(args: string[], ...names: string[]): string | undefined {
  for (let index = args.length - 1; index >= 0; index--) {
    for (const name of names) {
      if (args[index]?.startsWith(`${name}=`)) return args[index]!.slice(name.length + 1);
      if (args[index] === name && args[index + 1] && !args[index + 1]!.startsWith('-'))
        return args[index + 1];
    }
  }
  return undefined;
}
