# tool-recovery-order/transfer

Recovery ignores a changed or missing current tool declaration. Recheck it against persisted replay policy; only both-safe, non-cancelled calls replay. Missing tools must settle as interrupted rather than throw or execute.

Locate the faulty production code and repair it with minimal changes. Add `.prale-eval/regression.mjs`, a standalone Node assertion script that exercises the repaired production code. It must exit zero when fixed and fail with an assertion on this stage's original fault. No dependencies or network are needed: Node 24 provides TypeScript stripping and VM modules. The read-only `.prale-eval/subject.mjs` helper loads the real source with explicit boundary fakes; inspect its exported functions for usage. Run `node --experimental-vm-modules .prale-eval/regression.mjs` from the workspace root. Do not replace assertions with printed success.

Write `.prale-eval/result.json` with `task_id` = `tool-recovery-order/transfer`, `repository` = `earendil-works/pi`, `mode` = `repair`, and a `validation` object with `command` exactly `node --experimental-vm-modules .prale-eval/regression.mjs`, `status` = `passed`, and substantive `notes`. Hidden acceptance executes production behavior and replays your regression on isolated fixed and original-fault copies. A timeout, syntax/import error, or missing runtime is a failure, not proof that the regression detected the fault.

Modify only production code needed for this incident and add tests under `.prale-eval/`. Do not modify TASK.md, subject.mjs, package locks, Git configuration, or harness files. The acceptance oracle is hidden.
