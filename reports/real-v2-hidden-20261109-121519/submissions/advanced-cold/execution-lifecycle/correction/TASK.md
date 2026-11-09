# Allow safe recovery without corrupting patched outcomes

Task ID: `advanced/execution-lifecycle/correction`
Repository: `earendil-works/pi`

## Incident

Policy clarification: non-cancelled safe/safe replay is allowed, and an after-tool hook may explicitly clear isError. Preserve unspecified result fields and usage while applying explicit false/empty patch values. If an aborting gate is closed with a terminal error, the terminal error becomes authoritative for future admissions; a pending cancellation must not override that closure.

Locate the faulty production code by investigating the incident. Preserve existing APIs.

## Delivery and local validation

Apply the necessary production repairs, and add an executable `.prale-eval/regression.mjs`. It must load the submitted production modules and assert observable behavior across module boundaries. The read-only `.prale-eval/subject.mjs` helper links real local modules, with only external IO/provider boundaries faked. Node 24 is sufficient; no dependencies, network, credentials or deployment are needed.

Run `node --experimental-vm-modules .prale-eval/regression.mjs` from the workspace root. Use uncaught `node:assert/strict` assertions. The same script must pass the repair and detect the original regression in every source file when that file alone is restored to its faulty baseline. A crash, import error or timeout does not count as a detected regression. Do not use real time, randomness or external services as correctness evidence; control asynchronous ordering with promises.

Create local test inputs under `.prale-eval/` and clean them up so manual validation stays inside the workspace. The controller's hidden tests manage their own temporary directories.

Write `.prale-eval/result.json` with `task_id` exactly `advanced/execution-lifecycle/correction`, `repository` = `earendil-works/pi`, `mode` = `repair`, and `validation` containing `command` = `node --experimental-vm-modules .prale-eval/regression.mjs`, `status` = `passed`, and substantive `notes`. Explain the cross-module fix in `.prale-eval/repair.md`.

Modify only production code needed for this incident and add tests under `.prale-eval/`. Do not modify TASK.md, subject.mjs, locks, Git configuration or harness files. Hidden oracles and mutation patches are not part of your workspace.
