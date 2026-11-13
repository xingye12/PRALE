/**
 * Regression: tool-effect recovery must recheck the *current* tool declaration
 * against the persisted replay intent.
 *
 * Fixed behavior:
 *  - a durable `effect_pending` call replays only when the persisted policy is
 *    "safe" AND the tool is still declared AND its current policy is "safe"
 *    AND the lane is not cancelled;
 *  - every other combination settles as an interrupted tool result, keeping the
 *    checkpoint and never crossing the effect boundary.
 *
 * Original fault: recovery only looked at the persisted policy, so a call whose
 * tool was removed or changed to replay:"never" replayed anyway; a missing tool
 * reached `undefined.execute(...)` and rejected instead of publishing an
 * interrupted outcome.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRecoverySubject } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERRUPTION_MARKER =
	"[Tool execution was interrupted. The preceding output is the latest durable progress snapshot; newer live output may be missing, and the external outcome is unknown.]";

// `toolPolicy`: "safe" | "never" = current declaration, null = declaration
// without a replay policy, undefined = tool no longer exists.
const recover = await createRecoverySubject(root);

async function run(name, fn) {
	try {
		await fn();
	} catch (error) {
		assert.fail(`${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function assertReplayed(result, label) {
	assert.deepEqual(
		result.events,
		["clear", "invoke", "effect-complete", "publish"],
		`${label}: both-safe recovery must clear the checkpoint once, cross the effect boundary once, then publish`,
	);
	assert.equal(result.outcome.recovery, true, `${label}: replay must be marked as recovery`);
	assert.equal(result.outcome.message.isError, false, `${label}: replayed effect result must not be an error`);
	assert.deepEqual(
		Array.from(result.outcome.message.content, (part) => [part.type, part.text]),
		[["text", "effect-result"]],
		`${label}: replayed effect result must be the real invocation result`,
	);
}

function assertInterrupted(result, label) {
	assert.deepEqual(
		result.events,
		["read", "publish"],
		`${label}: recovery must read the durable checkpoint and publish an outcome without touching the effect boundary`,
	);
	assert.ok(!result.events.includes("clear"), `${label}: interrupted recovery must not clear the replay checkpoint`);
	assert.ok(!result.events.includes("invoke"), `${label}: interrupted recovery must not execute the tool`);
	assert.equal(result.outcome.message.isError, true, `${label}: interrupted outcome must be an error result`);
	assert.equal(result.outcome.terminate, false, `${label}: interrupted outcome must not terminate the run`);
	assert.deepEqual(
		Array.from(result.outcome.message.content, (part) => [part.type, part.text]),
		[
			["text", "durable-progress"],
			["text", INTERRUPTION_MARKER],
		],
		`${label}: interrupted outcome must preserve the durable checkpoint and append the interruption marker`,
	);
	// Spread into this realm before comparing: module values come from the VM context.
	assert.deepEqual(
		{ ...result.outcome.message.details },
		{ step: 2 },
		`${label}: interrupted outcome must keep checkpoint details`,
	);
}

await run('both policies "safe" replays the pending effect', async () => {
	const result = await recover("safe", "safe", false);
	assertReplayed(result, "both-safe");
});

await run('declaration changed to "never" settles as interrupted, not replayed', async () => {
	const result = await recover("safe", "never", false);
	assertInterrupted(result, "changed declaration");
});

await run("missing tool settles as interrupted instead of throwing or executing", async () => {
	// The original fault rejected here (undefined tool reached the effect boundary).
	const result = await recover("safe", undefined, false);
	assertInterrupted(result, "missing tool");
});

await run("cancelled invocation does not replay even when both policies are safe", async () => {
	const result = await recover("safe", "safe", true);
	assertInterrupted(result, "cancelled");
});

await run('persisted "never" settles as interrupted even when the tool is safe now', async () => {
	const result = await recover("never", "safe", false);
	assertInterrupted(result, "persisted never");
});

await run("declaration without a replay policy settles as interrupted", async () => {
	const result = await recover("safe", null, false);
	assertInterrupted(result, "policy-less declaration");
});

await run("missing tool with persisted never settles as interrupted", async () => {
	const result = await recover("never", undefined, false);
	assertInterrupted(result, "missing tool / persisted never");
});

console.log("tool recovery replay-order regression: 7 recovery cases passed");
