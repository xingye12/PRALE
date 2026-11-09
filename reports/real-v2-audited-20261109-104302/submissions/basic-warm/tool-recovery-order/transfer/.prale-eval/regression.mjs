/**
 * Regression for `tool-recovery-order/transfer`.
 *
 * Drives the real `recoverToolInvocation` + `interruptedOutcome` from
 * packages/agent/src/harness/runtime/drive/tools.ts through the read-only
 * .prale-eval/subject.mjs boundary fakes (checkpoint IO, effect execution and
 * outcome publication only). Every assertion below is behavioral; the fault
 * under test is that recovery used to honor *only* the persisted call policy
 * and therefore replayed an effect whose current tool declaration changed or
 * disappeared.
 *
 * Faulty source: replay whenever `!cancelled && call.replay === "safe"`.
 * Repaired source: replay only when the persisted intent *and* the currently
 * declared tool both say "safe"; a missing tool settles as interrupted.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRecoverySubject } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const recover = await createRecoverySubject(root);

/** Values produced inside the VM realm are rebuilt in the host realm before strict comparison. */
const hostValue = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const INTERRUPTION_MARKER = "external outcome is unknown";
const REPLAY_EVENTS = ["clear", "invoke", "effect-complete", "publish"];
const INTERRUPT_EVENTS = ["read", "publish"];

let checks = 0;
const check = (assertion, label) => {
	assertion(`[${label}]`);
	checks += 1;
};

/** Recovery settled on an interrupted, error-flagged tool result without touching the effect. */
function assertInterrupted(label, { events, outcome }) {
	check(
		() =>
			assert.deepEqual(
				events,
				INTERRUPT_EVENTS,
				`${label}: recovery must read the durable checkpoint and settle without clearing/replaying the effect, got [${events.join(", ")}]`,
			),
		`${label} checkpoint-only`,
	);
	assert.ok(outcome, `[${label}] interrupted recovery must still publish a tool outcome`);
	const result = hostValue(outcome);
	check(
		() => assert.equal(result.toolCall.id, "call-1", `${label}: outcome must reference the recovered tool call`),
		`${label} tool call id`,
	);
	check(
		() => assert.equal(result.toolCall.name, "fixture-tool", `${label}: outcome must keep the tool name`),
		`${label} tool name`,
	);
	check(
		() => assert.equal(result.message.role, "toolResult", `${label}: outcome must be a tool result message`),
		`${label} message role`,
	);
	check(
		() => assert.equal(result.message.isError, true, `${label}: interrupted recovery must report an error result`),
		`${label} isError`,
	);
	check(
		() => assert.equal(result.message.toolCallId, "call-1", `${label}: message must be correlated to the call`),
		`${label} message toolCallId`,
	);
	check(
		() => assert.equal(result.terminate, false, `${label}: an interrupted recovery must not terminate the turn`),
		`${label} terminate`,
	);
	const content = result.message.content;
	check(
		() =>
			assert.equal(
				content.at(-1)?.type,
				"text",
				`${label}: interrupted result must end with a text marker`,
			),
		`${label} marker shape`,
	);
	check(
		() =>
			assert.ok(
				String(content.at(-1)?.text).includes(INTERRUPTION_MARKER),
				`${label}: interrupted result must state that the external outcome is unknown, got ${JSON.stringify(content.at(-1)?.text)}`,
			),
		`${label} marker text`,
	);
	check(
		() =>
			assert.ok(
				!JSON.stringify(content).includes("effect-result"),
				`${label}: interrupted recovery must not publish a replayed effect result`,
			),
		`${label} no replayed effect`,
	);
	// The durable progress snapshot must survive interruption instead of being discarded.
	check(
		() => assert.deepEqual(content.slice(0, -1), [{ type: "text", text: "durable-progress" }]),
		`${label} durable checkpoint content`,
	);
	check(
		() => assert.deepEqual(result.message.details, { step: 2 }, `${label}: checkpoint details must be preserved`),
		`${label} checkpoint details`,
	);
}

/** Recovery genuinely replayed: the durable checkpoint was cleared and the effect ran exactly once. */
function assertReplayed(label, { events, outcome }) {
	check(
		() =>
			assert.deepEqual(
				events,
				REPLAY_EVENTS,
				`${label}: a jointly safe, non-cancelled call must clear its checkpoint and replay once, got [${events.join(", ")}]`,
			),
		`${label} replay order`,
	);
	assert.ok(outcome, `[${label}] replayed recovery must publish the tool outcome`);
	const result = hostValue(outcome);
	check(
		() => assert.equal(result.message.isError, false, `${label}: a replayed effect must report its real result`),
		`${label} isError`,
	);
	check(
		() => assert.deepEqual(result.message.content, [{ type: "text", text: "effect-result" }]),
		`${label} replay content`,
	);
	check(
		() => assert.equal(result.terminate, false, `${label}: replay must not terminate the turn`),
		`${label} terminate`,
	);
}

// --- The fault: a missing current tool declaration must not be replayed -----------------------
// Persisted intent says "safe", but the tool is gone. Before the repair this cleared the
// checkpoint and executed the effect; it must instead settle as interrupted without throwing.
assertInterrupted("missing tool declaration", await recover("safe", undefined, false));

// --- The fault: a changed current declaration must not be replayed ----------------------------
// Persisted "safe" + current tool downgraded to "never": only both-safe calls may replay.
assertInterrupted("changed tool declaration (safe -> never)", await recover("safe", "never", false));

// Persisted "safe" but the current declaration carries no replay policy at all.
assertInterrupted("current declaration without replay policy", await recover("safe", null, false));

// Persisted "never" cannot be upgraded by a currently-safe declaration either.
assertInterrupted("persisted intent without safe replay", await recover("never", "safe", false));

// A cancelled call never replays, even when both declarations are safe.
assertInterrupted("cancelled call", await recover("safe", "safe", true));

// --- Preserved behavior: only the joint both-safe, non-cancelled case replays -----------------
assertReplayed("jointly safe replay", await recover("safe", "safe", false));

console.log(`regression: ${checks} assertions passed across 6 recovery scenarios`);
