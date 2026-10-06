// T10 contract demo: a failed effect leaves a retryable intent rather than a terminal success.
//
// Two layers of evidence are exercised:
//   1. BEHAVIORAL -- the real, dependency-free effect gate (packages/agent/src/harness/execution/effect-gate.ts)
//      is imported and driven directly, showing that a refused (failed) effect is never admitted.
//   2. STATIC -- the durable drive path source is read and its ordering/outcome invariants are asserted.
//
// Run from anywhere:  node .prale-eval/contract-demo.mjs

import { readFileSync } from "node:fs";
import { AbortRequested, createGate } from "../packages/agent/src/harness/execution/effect-gate.ts";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

const results = [];
const failures = [];

function check(id, ok, detail) {
	results.push({ id, ok, detail });
	if (!ok) failures.push(id);
}

// ---------------------------------------------------------------------------
// 1. BEHAVIORAL: real effect gate
// ---------------------------------------------------------------------------
{
	const { gate } = createGate();
	let invoked = false;
	const value = gate.admit(() => {
		invoked = true;
		return "effect-ran";
	});
	check("gate.admit runs an admitted effect", value === "effect-ran" && invoked, `value=${value}`);
}

{
	// Abort wins admission: the effect must NOT run, and the failure must surface as a
	// retryable/abort signal (AbortRequested) -- never as a silent success.
	const { gate, control } = createGate();
	let invoked = false;
	control.beginAbort(Promise.resolve());
	let thrown;
	try {
		gate.admit(() => {
			invoked = true;
			return "should-not-happen";
		});
	} catch (error) {
		thrown = error;
	}
	check(
		"abort-first refusal escapes as AbortRequested without invoking the effect",
		thrown instanceof AbortRequested && invoked === false,
		`thrown=${thrown?.constructor?.name} invoked=${invoked}`,
	);
}

{
	// A closed gate fails the admission with its terminal error and still never runs the effect.
	const { gate, control } = createGate();
	let invoked = false;
	control.close(new Error("gate closed"));
	let thrown;
	try {
		gate.admit(() => {
			invoked = true;
		});
	} catch (error) {
		thrown = error;
	}
	check(
		"closed gate refuses admission without invoking the effect",
		thrown instanceof Error && thrown.message === "gate closed" && invoked === false,
		`thrown=${thrown?.message} invoked=${invoked}`,
	);
}

// ---------------------------------------------------------------------------
// 2. STATIC: durable drive-path ordering and outcome invariants
// ---------------------------------------------------------------------------
const driveTools = read("../packages/agent/src/harness/runtime/drive/tools.ts");
const executionTools = read("../packages/agent/src/harness/execution/tools.ts");
const executionToolsTest = read("../packages/agent/test/harness/execution-tools.test.ts");

const sliceFunction = (source, name) => {
	const start = source.indexOf(`async function ${name}`);
	if (start < 0) return "";
	const next = source.indexOf("\nasync function ", start + 1);
	return source.slice(start, next < 0 ? source.length : next);
};

const intentFn = sliceFunction(driveTools, "publishToolIntent");
const startFn = sliceFunction(driveTools, "startToolInvocation");
const recoverFn = sliceFunction(driveTools, "recoverToolInvocation");

// C1: the retryable intent (effect_pending) and its arguments are committed before the effect.
check(
	"publishToolIntent commits an effect_pending intent carrying a replay policy",
	intentFn.includes('status: "effect_pending"') && intentFn.includes("replay") && intentFn.includes("operationToolArgs"),
	"effect_pending + replay + persisted args",
);
check(
	"startToolInvocation publishes the durable intent before performing the effect",
	startFn.indexOf("publishToolIntent(") >= 0 &&
		startFn.indexOf("publishToolIntent(") < startFn.indexOf("performToolInvocation("),
	`publishToolIntent@${startFn.indexOf("publishToolIntent(")} < performToolInvocation@${startFn.indexOf("performToolInvocation(")}`,
);
// C3: recovery of a persisted intent is replay-or-unknown, never a fabricated success.
check(
	"recoverToolInvocation safe-replays or records an unknown external outcome",
	recoverFn.includes('call.replay === "safe"') && recoverFn.includes("interruptedOutcome"),
	"replay safe -> re-execute; otherwise interruptedOutcome",
);
check(
	"interruptedOutcome marks the effect as an error with an unknown external outcome",
	driveTools.includes("external outcome is unknown") && driveTools.indexOf("INTERRUPTION_MARKER") >= 0,
	"INTERRUPTION_MARKER present",
);
// C2: the primitive executor converts a thrown effect into in-band error output.
check(
	"executeToolCall catches a thrown effect and returns isError: true",
	/export function executeToolCall[\s\S]*?catch \(error\)[\s\S]*?isError: true/.test(executionTools),
	"catch -> isError true",
);
// The public acceptance test for the primitive path asserts exactly that.
check(
	"execution-tools.test.ts asserts thrown tools become error output",
	executionToolsTest.includes("converts %s tool throws to error output") &&
		executionToolsTest.includes("expect(result.isError).toBe(true)"),
	"it.each throw test present",
);

// ---------------------------------------------------------------------------
// Normalized operation result
// ---------------------------------------------------------------------------
const normalized = {
	contract: "failed-effect-leaves-retryable-intent",
	toolExecutionPath: "packages/agent/src/harness/runtime/drive/tools.ts",
	primitivePath: "packages/agent/src/harness/execution/tools.ts",
	checks: results,
	passed: results.length - failures.length,
	failed: failures.length,
};

console.log(JSON.stringify(normalized, null, 2));
if (failures.length > 0) {
	console.error(`FAILED checks: ${failures.join(", ")}`);
	process.exit(1);
}
console.log(`ALL ${results.length} CONTRACT CHECKS PASSED`);
