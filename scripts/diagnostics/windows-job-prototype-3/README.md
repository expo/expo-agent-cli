# Windows lifetime census experiment 3

This throwaway experiment supports the four-PR detached-start correction. Product code remains frozen. The question is whether a private helper can retain complete lifetime coverage for practical local tool commands and refuse a stop result when an identity is missing or ambiguous. No native result has been accepted for this payload. `productionWitnessProven`, `nonWrappingLifetimeCountProven`, and `inFlightCreatorOrderingProven` remain false even if every diagnostic passes.

Run 2 measured five lifetime-count gaps after current-member binding. It also reproduced the old count-only failure. One retained pipe holder was unsignaled even at a native sample taken after Node had observed root exit and both raw output EOFs. The earlier sources and results remain unchanged. `ORIGIN-V2.sha256` preserves the preceding source manifest.

## Candidate contract

The helper associates a completion port while its private unnamed job is empty. It creates the root suspended with creation-time `JOB_LIST`, retains the original process handle, and resumes only after the private start permit. Standard output and error remain direct inherited pipes. Descriptor 3 carries control and observations. The helper closes its own copies of the tool's standard handles after creation.

The helper keeps one census of distinct native process handles. A notification PID is only a discovery hint. A newly opened handle must return a creation FILETIME and membership in the exact private job. Existing retained identities are deduplicated without reopening their PID. Retained handles survive natural process exit and the adapter's later settlement observation. Independent fixture observer handles never enter this census.

Before job termination, one complete current-member enumeration supplements notification discovery. A truncated list, failed open, identity ambiguity, failed membership check, or failed wait makes coverage permanently invalid. The helper terminates only through its selected job. There is no quota, per-process termination fallback, later job assignment, output relay, or shared owner-job termination.

The candidate requires all retained process handles to be signaled, including the original root once. It then queries a fresh `TotalProcesses` and requires equality with the number of distinct retained identities. Native coverage validity must also remain true. `ActiveProcesses` is reported but is not the completion certificate. `TotalTerminatedProcesses` is never subtracted. An unexplained extra lifetime count, including a failed admission counted by Windows, gives uncertainty. A later valid capture does not clear an earlier identity failure.

Node independently requires root exit, both raw EOFs, and a valid private acknowledgement before its original absolute deadline. Repeated stop requests reuse the first promise and deadline. Lost control, a missing acknowledgement, or a deadline gives uncertainty. For an observed native result, the controller asks for a separate later native sample after adapter settlement. Exact retained and independent observer handles remain open until that sample finishes.

Natural completion keeps its separate release operation. Root exit and both EOFs permit release. Release clears kill-on-close and acknowledges that change. Coverage loss does not prevent ordinary release and does not create a daemon-termination claim.

## Explicit proof limits

`TotalProcesses` is a DWORD. The helper samples it from the empty job onward, rejects an observed decrease, and rejects counts or retained sets above 4096. It also invalidates collection after 60 seconds. These operational bounds do not prove that an unobserved full counter wrap was impossible. The experiment assumes non-wrapping accounting for its bounded observations. It does not invent a births-per-time bound or claim that the handle cap prevents wrap.

The fixed-point argument also assumes that no ordinary child association can complete after all captured creators have signaled. The documentation and prior runs do not establish that ordering. Concurrent creation rows look for a counterexample. They do not prove the ordering. A creation-begin record with no result at creator exit identifies a possible overlap. The call may have returned before its result was logged. An absent result or first-code marker does not prove that no child was created. Native tick comparisons have millisecond resolution.

The private job must have no external assignment source and no permitted breakaway. Creation-time containment, retained native identities, and nested accounting are essential premises. This is lifecycle management of ordinary descendants, not a security boundary against a hostile same-user process that can duplicate capabilities.

## Observation matrix

- Four ordinary and nested scenarios retain eight short-lived native children through natural retirement. Active-root and exited-root pipe-holder variants check both schedules. Independent fixture waits and creation times establish the retired identities. Current-list omission is measured separately from retained lifetime coverage.
- The missing-notification control suppresses non-root discovery hints. The pre-termination census still captures current members. Eight retired identities remain missing, so an empty job, root exit, and both EOFs must still produce uncertainty.
- The identity control rejects the first descendant capture using an injected creation-time mismatch. A later authentic pre-termination capture restores raw count equality. Sticky coverage invalidity must still refuse success.
- Six bounded concurrent-creation rows log `CreateProcessW` begin and result records, independent child first-code records, captured identities, and separately retained audit handles. A first-code tick after a successful verdict or a still-live independent observer rejects the observation. An honest uncertain race result is permitted and recorded.
- Four rejected count-only pipe-holder comparisons and four lifetime-census pipe-holder observations retain exact handles through the later settlement sample. Failure to reproduce a historical counterexample does not erase the earlier frozen observation.
- Deadline, withheld acknowledgement, termination error, and lost-control rows must return uncertainty. A natural-release row checks that the same independently identified daemon survives despite an intentionally incomplete census. Another row stops selected work while a separate fake EAS sibling stays held and later finishes independently.
- Actual installed Expo and EAS version commands complete under the lifetime collector. Help commands use natural release. A real Expo `config --json --type public` command evaluates an audit-local `app.config.js` that creates a long-lived local fixture descendant. The config command exits before cancellation of that descendant. This measures the real tool subprocess path with an explicitly instrumented config, not an inherent Expo daemon.

## Tool pins and scope

Expo is pinned to `58.0.5`, matching `apps/eas-example/package.json` and `bun.lock`. The project-installed EAS pin is `22.4.0`, matching the dependency fixture and recorded runner behavior in `packages/@expo/agent-cli/src/utils/__tests__/easCli-test.ts` and `src/utils/easCli.ts`. This is compatibility evidence for that exact project runner. It is not a claim about current EAS runtime support or the separate global-runner minimum.

Expo runs through the actual npm-installed `expo.cmd`, matching `resolveExpoCli`'s local-bin branch. EAS runs through actual `npx.cmd --offline --yes eas-cli`, with the project's exact installed package. The commands use version, help, or local config evaluation. They perform no account login, project linking, build submission, simulator request, or billed service operation. Runtime npm resolution is offline. The workflow installs only inside this diagnostic's `toolchain` directory, with package scripts disabled. It does not install or build the product repository.

Direct pins do not freeze transitive dependencies before installation. The artifact retains the resolved package lock, actual installed manifests, command shims, install log, package inventory, and lock hash. The controller records the actual tool and Node provenance. Source manifests do not claim to cover a future transitive resolution.

## Run and artifacts

Copy this complete directory to `scripts/diagnostics/windows-job-prototype-3/` in a new immutable diagnostic commit. Copy `workflow.yml` over `.github/workflows/agent-cli.yml`. Root owns dispatch and artifact review. The workflow uses the same pinned checkout, setup-node, and artifact actions as run 2, Windows 2022, actual Node 24, installed MSVC, and the static CRT.

The manual equivalent in a fresh Windows copy is:

```powershell
.\build.ps1
.\install-tools.ps1
node .\controller.mjs .\job-helper.exe .\results
```

`results/summary.json` separates diagnostic pass status, observed candidate success, and installed-tool success. `events.jsonl` records the native census, raw EOFs, Node settlement, control failures, and every decision. Per-scenario files preserve raw stdout and stderr. Native creator and child files preserve exact fixture identities. Race rows include `race-observation.json`. Build, OS, package, source, and executable provenance accompany the results.

Local checks cover Node syntax, workflow parsing, manifest integrity, and source review. Native compilation and execution require the hosted Windows run. Packaging, architecture support, published assets, full quoting parity, owner integration, public CLI receipts, and independent product review remain separate gates.

The primary contracts are Microsoft's [job lifetime accounting](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information), [completion-port notifications](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_associate_completion_port), [nested jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs), and [job membership enumeration](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_process_id_list). The final count and creator-order inference remains conditional for the reasons above.
