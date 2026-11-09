# tool-recovery-order/correction

Correct a blanket never-replay rule. Verified safe/safe calls must replay once when not cancelled. Clear their old checkpoint before invocation, publish the resulting outcome after invocation completes, and retain the conditional restrictions for unsafe, missing and cancelled declarations.

Repair `packages/agent/src/harness/runtime/drive/tools.ts` with minimal changes. Add `.prale-eval/regression.mjs`, a standalone Node assertion script that exercises the repaired production code. It must exit zero when fixed and fail with an assertion on this stage's original fault. No dependencies or network are needed: Node 24 provides TypeScript stripping and VM modules. The read-only `.prale-eval/subject.mjs` helper loads the real source with explicit boundary fakes; inspect its exported functions for usage. Run `node --experimental-vm-modules .prale-eval/regression.mjs` from the workspace root. Do not replace assertions with printed success.

Write `.prale-eval/result.json` with `task_id` = `tool-recovery-order/correction`, `repository` = `earendil-works/pi`, `mode` = `repair`, and a `validation` object with `command` exactly `node --experimental-vm-modules .prale-eval/regression.mjs`, `status` = `passed`, and substantive `notes`. Hidden acceptance executes production behavior and replays your regression on isolated fixed and original-fault copies. A timeout, syntax/import error, or missing runtime is a failure, not proof that the regression detected the fault.

Only modify the target source and add regression files under `.prale-eval/`. Do not modify TASK.md, subject.mjs, package locks, Git configuration, or harness files. The acceptance oracle is hidden.
