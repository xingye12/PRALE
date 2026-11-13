# Recovery authorization must survive effect admission

Task ID: `advanced/execution-lifecycle/learn`
Repository: `earendil-works/pi`

## Incident

Recovery admits an unsafe interrupted operation and executes stale arguments. Repair the entire authorization-to-effect chain: both replay declarations must be safe, cancellation/closed gate must prevent admission, and the executor must use the cleared/persisted arguments rather than the original model arguments. Clear the old checkpoint before invocation and publish only after the effect and durable progress drain finish. Missing tools remain interrupted rather than executing.

Locate the faulty production code by exploring the repository and tracing the incident across producer/consumer boundaries. Preserve existing APIs and unrelated behavior.

## Delivery and local validation

Apply the necessary production repairs, and add an executable `.prale-eval/regression.mjs`. It must load the submitted production modules and assert observable behavior across module boundaries. The read-only `.prale-eval/subject.mjs` helper provides `createGraph(root, modules, bindings, builtinOverrides, trailers)` and `loadModule(root, relativePath, bindings, trailer)`. Discover paths and symbols yourself, select the real modules to link, and supply your own boundary fakes. No task-specific adapters are supplied. Node 24 is sufficient; no dependencies, network, credentials or deployment are needed.

Run `node --experimental-vm-modules .prale-eval/regression.mjs` from the workspace root. Use uncaught `node:assert/strict` assertions. The same script must pass the repair and detect the original regression in every source file when that file alone is restored to its faulty baseline. A crash, import error or timeout does not count as a detected regression. Do not use real time, randomness or external services as correctness evidence; control asynchronous ordering with promises.

Create local test inputs under `.prale-eval/` and clean them up so manual validation stays inside the workspace. The controller's hidden tests manage their own temporary directories.

Write `.prale-eval/result.json` with `task_id` exactly `advanced/execution-lifecycle/learn`, `repository` = `earendil-works/pi`, `mode` = `repair`, and `validation` containing `command` = `node --experimental-vm-modules .prale-eval/regression.mjs`, `status` = `passed`, and substantive `notes`. Explain the cross-module fix in `.prale-eval/repair.md`.

Modify only production code needed for this incident and add tests under `.prale-eval/`. Do not modify TASK.md, subject.mjs, locks, Git configuration or harness files. Hidden oracles and mutation patches are not part of your workspace.
