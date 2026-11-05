import {
  devicesDisabled,
  hostBindsPlatform,
  localBackendOf,
  type Binding,
} from '../../deviceBinding';
import { bindingPathFor, readBindingFile } from '../../deviceBinding/registry';
import type { CloudPreference } from '../../navigate/device';
import type { SmokeOptions } from '../resolveOptions';
import { buildSmokeTargetSelection, type SmokeTargetSelection } from '../targetSelection';
import { resolveSmokeTargetAsync, type SmokeTarget } from './target';

/**
 * What one `buildSmokeDeps` call shares between its dependencies: the run's inputs, which app it is
 * about and which device it chose. Created once per run.
 */
export interface SmokeDepsContext extends SmokeTargetSelection {
  readonly projectRoot: string;
  readonly options: SmokeOptions;
  /** The cloud route. The request until the run takes the configured EAS route. */
  route: CloudPreference;
  /** The plan's install kind, once anything has asked for the target. Read at call time by `progress`. */
  readonly installKind: SmokeTarget['installWithKind'] | null;
  /**
   * Built once and shared by every phase that reads a target, so no two phases can disagree about
   * which app this run is about (F51). Built lazily: a run that fails at the dev-server phase never
   * spawns a device tool for it.
   */
  targetAsync(): Promise<SmokeTarget>;
  /**
   * Forget it, so the next reader sees the project as it is now.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §A build changes the project it was read from
   * Called after a start phase that **compiled**, and for one reason: `expo prebuild` writes
   * `android.package` and `ios.bundleIdentifier` into the app config when they were not declared,
   * so a build is one of the few things that changes the answer to "which app is this run about"
   * [observed — Kudo, local run, 2026-09-04: an Android project whose package the prebuild was
   * about to write read `null`, so the install phase never fired and the deep link was refused].
   */
  forgetTarget(): void;
  ownBinding(): Binding | null;
}

export function createSmokeDepsContext(
  projectRoot: string,
  options: SmokeOptions
): SmokeDepsContext {
  let target: Promise<SmokeTarget> | null = null;
  let installKind: SmokeTarget['installWithKind'] | null = null;
  const ctx: SmokeDepsContext = {
    ...buildSmokeTargetSelection(projectRoot, options, () => ctx.route),
    projectRoot,
    options,
    route: options.cloud,
    get installKind() {
      return installKind;
    },
    targetAsync: () =>
      (target ??= resolveSmokeTargetAsync(projectRoot, options, ctx.route).then((resolved) => {
        installKind = resolved.installWithKind;
        return resolved;
      })),
    forgetTarget: () => {
      target = null;
    },
    ownBinding: () => {
      const bindsDevice =
        ctx.route !== 'required' && !devicesDisabled() && hostBindsPlatform(options.platform);
      if (!bindsDevice) return null;
      const backend = localBackendOf(options.platform);
      const read = readBindingFile(bindingPathFor(projectRoot, options.platform, backend));
      return read.kind === 'binding' ? read.binding : null;
    },
  };
  return ctx;
}
