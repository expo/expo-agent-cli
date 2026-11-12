# Throwaway Windows job boundary probe

This isolated probe serves the four-PR detached-start correction. It asks whether one native job created with the target can stop cmd/package-runner descendants, preserve the independent EAS sibling, expose raw target output EOF while the helper remains alive, and release a naturally surviving daemon. This is an experiment, not product code.

No native execution has run at handoff. Local verification was Node syntax checking of both `.mjs` files. A passing Windows run is necessary evidence, not a universal proof of a Windows exit barrier.

## Run the immutable diagnostic

Root copies this source directory, including every file listed in `MANIFEST.sha256`, to `scripts/diagnostics/windows-job-prototype/` in an isolated diagnostic commit. Root copies `workflow.yml` to `.github/workflows/agent-cli.yml`. The workflow is dispatch-only, uses the repository's pinned action revisions, runs Windows 2022 and actual Node 24, and uploads the binary and raw artifacts even on failure. It installs no repository dependencies and builds no CLI. The workflow uses `github.workspace`, not `runner.temp` in job-level environment.

Native execution can also be started from PowerShell in the copied directory.

```powershell
.\build.ps1
node .\controller.mjs .\job-helper.exe .\results
```

`build.ps1` locates installed x64 MSVC with `vswhere`, enters `vcvars64.bat`, and compiles with the Windows SDK and static CRT (`/MT`). No downloaded native dependencies are used. Keep the diagnostic commit SHA and artifact together. `MANIFEST.sha256` describes the source handoff; the workflow computes source hashes again and a separate SHA-256 of the compiled helper.

Inspect `results/summary.json` first, then `results/events.jsonl`. Each schedule records native error codes, command selection, native time and monotonic ticks, raw EOF, target exit, native stop candidate, observer waits, acknowledged terminal result, and helper exit separately. `windows.json`, the environment event, build log, and helper/source hashes record the environment. Each scenario retains exact stdout/stderr in `.bin` files. These pipes carry only target bytes. The private descriptor carries only protocol.

## Mechanism

The Node controller opens descriptor 3 as a duplex `overlapped` pipe. The compiled CRT recovers it through `_get_osfhandle(3)`. Input is a bounded 64 KiB binary frame with a little-endian length, one-byte opcode, integers, and UTF-16LE fields. Responses are bounded JSON lines. `hello` plus `ping/pong` tests both directions through actual Node. A dedicated read thread permits native output and deadline progress independently of the next command.

The helper creates a job with kill-on-close and no breakaway flags. It creates the root suspended with `PROC_THREAD_ATTRIBUTE_JOB_LIST` and `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`. The latter contains exactly duplicated stdin/stdout/stderr handles. The job is unnamed and noninheritable; descriptor 3 is made noninheritable. After creation the helper closes its duplicated and CRT-owned output copies. `ready` includes root creation time and membership. Only `start` resumes the root. Native `root-exited` is independent of captured EOF and helper exit.

Stop and release select one terminal operation in Node. The stop deadline is an absolute Unix millisecond time shared with the helper. Repeated stops join the same promise and cannot extend it. An independent Node watchdog kills an unresponsive helper and records uncertainty. Valid stop requires successful `TerminateJobObject`, a fresh zero-active query, a signaled actual root handle, a matching complete acknowledgement before deadline, actual target exit, and raw output EOF. Missing, malformed, incomplete or late acknowledgements cannot succeed. Helper death never supplies native proof.

For known live fixtures, an audit observer uses a token-bearing fixture marker and, for leaves, a loopback identity challenge. It opens a native process handle while that fixture stays alive, records exact `GetProcessTimes` creation time, retains the handle through the proposed verdict, and logs a zero-time wait at that verdict. These handles observe identities. They never choose the production stop target. The delayed-assignment control uses retained handles only for audit cleanup after recording its counterexample.

The proposed native witness remains visible even if an observed process is unsignaled. Positive schedules reject that observation. The negative schedule must detect it. Accounting with held observers and the root handle is logged, followed by accounting after those handles are dropped. If zero is unavailable until handles drop, the schedule stays uncertain; dropping them never upgrades it to a confirmed stop. The comparison does not use a grace sleep to rescue a verdict.

Natural release is selected only after root exit and raw EOF. The helper clears kill-on-close, closes the job, acknowledges, and exits. The released independent-stdio daemon must answer its original token and create another ordinary child. A later stop returns `already-completed` without claiming termination.

## Executable schedules

- Descriptor-3 roundtrip, suspended creation-time membership, and raw EOF while helper lives. A native child inspects the numeric parent control/job HANDLE values. Absence is recorded; presence is explicitly inconclusive because the child may reuse a value for another object. This numeric check alone never proves a leaked handle.
- Suspended cancellation with no first fixture marker and repeated-stop deadline identity.
- A real cmd wrapper launching a Node fixture with an independent-stdio leaf, plus a separately held fake EAS sibling. Native retained observers must be signaled for the selected tree, while the sibling produces its original fake ID after release.
- Eight immediate and eight 13 ms cmd/package-runner stops, without waiting for fixture readiness. Per-schedule events capture the actual interval. A later fixture marker rejects the result.
- Root exit while a descendant holds both output pipes. Stop must reach the descendant and allow EOF.
- Natural root exit codes 0 and 17 with an independent-stdio daemon. The daemon must survive helper release and spawn a grandchild.
- A deterministic negative control. The root runs without creation-time assignment; a known independent leaf is observed before assigning the root later. The job candidate must be exposed as insufficient by the live retained leaf handle. The observer identity is retained for cleanup.
- Job setup, handle-attribute, and process-creation error injections; helper loss before creation and at suspended-ready; terminate and query failures; native deadline; withheld reply; malformed JSON; an incomplete but syntactically valid stop acknowledgement; active helper crash; and release failure.
- Simultaneous 512 KiB raw stdout/stderr bursts with a private ping during output.
- Direct executable and cmd baseline comparisons for empty arguments, spaces, Unicode, quotes, ampersand, percent, caret, exclamation, metacharacters, trailing backslashes, cwd, environment, binary stdout/stderr and exit code 17.

## Provenance and exact limits

The cmd path quoting and argument escaping are copied from `packages/@expo/agent-cli/src/utils/windowsShim.ts` as read in this investigation. The resulting resolved target is passed to an ordinary actual Node `spawn` baseline and to the helper. The helper adds the same cmd `/d /s /c` wrapper once. Direct argument construction follows the CRT/libuv quote rules and is checked against actual Node output. The helper does not parse user command text or re-escape it.

The relevant primary references are [creation-time job and handle attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute), [Node stdio modes](https://nodejs.org/api/child_process.html#optionsstdio), [libuv Windows stdio construction](https://github.com/libuv/libuv/blob/v1.x/src/win/process-stdio.c), [libuv pipe construction](https://github.com/libuv/libuv/blob/v1.x/src/win/pipe.c), and [libuv argument quoting](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c). The installed Node version and libuv version are recorded at execution. Source provenance does not substitute for the native result.

The first run deliberately leaves these gates open.

- Native compilation, descriptor transport, nested-job behavior, and every runtime outcome are unverified until the Windows artifact returns. No product recommendation is justified by the local syntax checks.
- Early schedules retain the actual cmd root handle. They cannot retain every newborn descendant before an immediate stop, because no fixture identity may have been reported. Known live fixture/leaf observers are decisive in the active schedules. Post-verdict marker absence is corroboration, not universal identity proof.
- Observer handles capture exact native creation time after a controlled live fixture identifies itself. There is no native process-creation event stream covering every transient descendant. A spawn-churn native fixture and adversarial children born during cancellation remain additional experiments if needed.
- The handle allowlist and noninheritability are the launch mechanism. The numeric child HANDLE probe is not an object-identity comparison and can be inconclusive.
- The native termination and accounting witness is empirical. A known unsignaled member, a later child, or an observer-induced count mismatch rejects or leaves it uncertain. A passing stress loop cannot establish a universal documented barrier.
- Shell parity covers the current cmd branch with an explicit absolute local shim. PATH/PATHEXT lookup, the non-cmd ComSpec `-c` branch, injected `ComSpec` differences, Unicode cwd, and complete project-local-bin selection are not implemented here. The probe does not claim those compatibility gates passed.
- Stop-first arbitration is represented by one action latch; repeated stop and release-first behavior run. Exhaustive simultaneous stop/release permutations, crash inside `CreateProcessW`, crash after root exit, real taskkill comparison, and completion-port notification controls are not included. No completion port is used by this witness.
- All native failure injections are labeled. Some deliberately pass invalid native handles or sizes to obtain real Win32 errors. They do not simulate every OS resource failure.
- Only Windows 2022 x64 and the selected Node 24 runtime run here. ARM64, packaged executable resolution, publish/clean/build asset retention, supported-host policy, and antivirus/code-integrity restrictions remain production gates.
- No owner, receipt, lock, public CLI, real Expo/EAS, cloud, device, or billing integration is exercised. The existing both-platform public CLI matrix and four-PR review remain separate.

The source directory is `.audit/detached-restart/windows-job-prototype/`. Root owns Git, dispatch, and result interpretation. The prototype is throwaway.
