# Windows job witness experiment 2

This is an audit-only continuation of the four-PR detached-start correction. Run 1 disproved zero active accounting plus a signaled root as an actual member-exit witness. The retained pipe-holder handle was unsignaled at that native candidate. No claim is made about its later state at Node settlement because the first helper had already dropped the handle.

This experiment asks whether an active-process quota can block new admissions while a complete current-member list is bound to native process handles before job termination. It separately measures the remaining historical-coverage problem. Neither independent review accepted the mechanism as a complete production proof. No product code changed.

## Run

Copy this whole directory to `scripts/diagnostics/windows-job-prototype-2/` in a fresh immutable diagnostic commit. Copy `workflow.yml` over `.github/workflows/agent-cli.yml`, then dispatch. The workflow uses the same pinned actions as experiment 1, Windows 2022, actual Node 24, installed MSVC/SDK, static CRT, no repository dependency install, and no CLI build. Artifact upload includes the hidden workflow explicitly. Results stay under the nonhidden diagnostic directory.

Manual PowerShell execution in a fresh copied directory is equivalent. The controller refuses an existing events trace, because stale fixture markers cannot be reused.

```powershell
.\build.ps1
node .\controller.mjs .\job-helper.exe .\results
```

The untouched v1 source remains in `windows-job-prototype/`. Its original source manifest is copied here as `ORIGIN-V1.sha256`. This directory's current files have their own `MANIFEST.sha256`. Native compilation and execution have not run locally. Both Node sources pass syntax checking.

## First eight admission observations

The controller covers quota 1 and quota 0, ordinary and nested creation, and an active root or already-exited root with a live pipe holder. Each schedule starts with a Node leaf, a native creator, and two live native children. The creator makes successful additional children before quota installation, keeps creating around the setter, then performs eight explicit post-setter `CreateProcessW` attempts. Successful children write first-code markers and exact native creation times. Native API return values and errors are retained.

Nested rows create an actual child job below the selected job through creation-time `JOB_LIST`. They do not infer nested coverage from the hosted runner's outer job. Quota installation preserves kill-on-close, logs the original count and setter result, reads back the configured limit, and checks retained live observers. Setter failure, a mismatched limit readback, an admitted post-setter child, or removal of an existing held process rejects that observation. Observer membership is checked at capture and again after the setter. Candidate success is recorded only after the bound waits and later settlement checks pass. No alternative mechanism is silently selected.

The native child creation loop is a deliberate scheduling stimulus. Its sleeps and bounded lifetimes do not establish completion. Success predicates use native API results, exact identities, and process-handle waits.

## Experimental handle-bound stop

Descriptor 3 remains private and overlapped. Stdout and stderr remain direct target pipes. Initial creation-time containment and suspended start permission remain unchanged.

One absolute deadline starts at quota selection and covers setter, native creation observations, binding, termination, and waits. Node independently watches that same deadline. A bounded job PID query accepts only a complete list, then opens every listed member with `SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION`, checks membership in the exact job, and records native creation time. Known observer/root identities are cross-checked. A second complete list must match. Missing, changing, ambiguous, partial, or unopenable identities stay uncertain. The limit is 4096 current members. No PID selects a production kill.

The candidate-bound set is separate from the test-observer set. `TerminateJobObject` remains the scoped termination authority. The helper waits every candidate-bound handle, its original root handle, and zero accounting before the experimental acknowledgement. Native errors or deadline loss remain uncertain. Observer handles are not inserted into the candidate set to conceal missing coverage.

All observer and bound handles remain open after the native candidate. Once Node sees target exit and both raw EOFs, it sends a separate settlement observation command. Native waits, fresh membership, PID-list visibility, and accounting are recorded again before handles are dropped. This is a measurement after Node settlement, not proof that the waits had those values at the earlier JavaScript instant.

Fresh `TotalProcesses` and `TotalTerminatedProcesses` are recorded before and after the seal, at binding, at both candidate predicates, and at later settlement. The diagnostic includes candidate identity counts with the original root counted once. It never subtracts `TotalTerminatedProcesses` to guess a failed-admission cohort. These counters do not certify lifetime completeness.

One limit-zero, ordinary, pipe-holder row externally terminates a known initial native child through its already-retained audit handle immediately before the first binding census. It records current membership, list visibility, accounting and waits around that event. This is an audit-only fixture action. The production candidate still terminates only through the selected job.

## Negative comparison and quoting instrument

Eight pipe-holder repetitions retain the rejected v1 count/root candidate for comparison. They record observer waits at that candidate and again after Node settlement. A run that does not reproduce the first counterexample does not erase the frozen run-1 counterexample. Extra diagnostics change timing and are recorded as such.

The quoting instrument runs a direct executable, the exact two-line `%*` fixture used by v1 and the repository's Windows stub writer, and a shim generated by the actual `cmd-shim` dependency bundled with installed npm. It captures the generator path, source, hash, package version and generated shim. It assumes neither shim is defective in advance.

Each parity record contains requested argv, observed argv, the actual Node baseline exit code, helper target exit code, separate baseline/helper raw stdout and stderr, and byte/code equality. Intended-argv preservation is checked separately for direct and installed npm shim launches. All original metacharacters remain. A faithful shim that fails identically in the baseline and helper exposes a baseline quoting defect, not helper divergence. Product escaping is unchanged.

## Read the artifact

Start with `results/summary.json`. `passed` means the diagnostic assertions ran successfully, while `candidateObservationSuccess` reports the eight measured candidates. `productionWitnessProven` remains false unconditionally. A rejected setter or conservative binding failure is a useful measured outcome even when the diagnostic itself completed.

`results/events.jsonl` contains the controller and private native events. Per-scenario `creator-one.jsonl` captures all creation attempts, and `birth-*.jsonl` captures executed native children. `bound-member` and `bound-wait` belong to the candidate set. `observer`, `observer-membership`, and audit retirement events belong to the independent fixture set. `member-list` and `listed-member` expose current membership. Each parity directory has `parity.json` and exact raw output files. OS, Node/libuv versions, Node executable SHA-256, helper SHA-256, compiler output, and source hashes are retained.

## Remaining proof and experiment gaps

- Setter acceptance and blocked tested admissions do not establish a documented linearizable seal for every in-flight birth. Zero-to-one admission during a zero-current-member transition is not covered.
- A complete current PID list need not contain every historically admitted process whose object has not yet signaled. The controlled external retirement observes one case. Natural exit ordering and all transient histories remain unresolved.
- A newly opened process creation time alone does not authenticate an earlier bare PID. Known identities are compared, and membership plus the proposed seal is measured, but the unknown-identity premises remain unproved.
- Lifetime totals are diagnostics. Nested accounting, failed associations, wrapping, and ordering would need supported invariants before a lifetime census could serve as a production certificate. Churn can create permanent coverage gaps.
- No per-handle termination/enumeration fallback is implemented. The independent reviews rejected it as a standalone complete witness.
- This is the first focused second experiment, not the full v1 compatibility/fault matrix or owner integration. ARM64, packaging, published assets, actual Expo/EAS, both-platform public CLI receipts, and independent product review remain separate gates.

Primary reference contracts are [active-process limits](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information), [nested PID lists](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_process_id_list), [job accounting](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information), and [npm's shim generator](https://github.com/npm/cmd-shim/blob/main/lib/index.js). Runtime provenance uses the actually installed generator, not the moving upstream source.
