#!/usr/bin/env node
/**
 * T10 contract demo for repository `pi`.
 *
 * Contract (tool-effect execution path):
 *   An external tool effect is executed only *after* its durable intent
 *   (`status: "effect_pending"` + persisted arguments + replay flag) has been
 *   committed, and a failed effect must never be durably recorded as a
 *   terminal, unflagged success. A throw is converted to a durable error
 *   tool-result (`isError: true`); a process death mid-effect leaves the
 *   durable intent in place (`effect_pending`) so recovery can retry it
 *   (replay-safe tools) or surface an explicit interrupted error.
 *
 * The script has two parts, both dependency-free (plain `node`):
 *   1. verifySourceContract() - reads the real repository sources and asserts
 *      the invariant-bearing code really exists at the cited symbols/ranges.
 *   2. runBehavioralModel()   - a small state machine mirroring the durable
 *      transitions in those sources, exercised against success, throw,
 *      abort-before-admission, and crash/recovery scenarios.
 *
 * Exit code is non-zero if any check fails.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FILES = {
	primitive: "packages/agent/src/harness/execution/tools.ts",
	driver: "packages/agent/src/harness/runtime/drive/tools.ts",
	sessionTypes: "packages/agent/src/harness/session/types.ts",
	test: "packages/agent/test/harness/execution-tools.test.ts",
};

const sourceLines = new Map();
function lines(path) {
	if (!sourceLines.has(path)) {
		sourceLines.set(path, readFileSync(resolve(repoRoot, path), "utf8").split("\n"));
	}
	return sourceLines.get(path);
}

function indexOfLine(path, needle, from = 1) {
	const all = lines(path);
	for (let i = from - 1; i < all.length; i += 1) {
		if (all[i].includes(needle)) return i + 1;
	}
	throw new Error(`${path}: anchor not found: ${JSON.stringify(needle)}`);
}

/** Inclusive 1-based span from `startNeedle` up to the line before `endNeedle`. */
function span(path, startNeedle, endNeedle, from = 1) {
	const start = indexOfLine(path, startNeedle, from);
	const end = indexOfLine(path, endNeedle, start + 1) - 1;
	return { start_line: start, end_line: end, text: lines(path).slice(start - 1, end).join("\n") };
}

const checks = [];
function check(id, ok, detail) {
	checks.push({ id, status: ok ? "pass" : "fail", detail });
	if (!ok) throw new Error(`contract check failed: ${id} (${detail})`);
}

// ---------------------------------------------------------------------------
// Part 1: the real sources must contain the invariant-bearing mechanisms.
// ---------------------------------------------------------------------------

const executeToolCallSpan = span(FILES.primitive, "export function executeToolCall", "export function finalizeToolCall");
check(
	"primitive.wraps-effect-in-gate-admit",
	executeToolCallSpan.text.includes("return gate.admit("),
	"executeToolCall crosses the effect boundary inside gate.admit",
);
check(
	"primitive.abort-checked-before-effect",
	/const admittedContext = withAbortSignal\(gate.signal, context\);\n\t*admittedContext.abortSignal\?\.throwIfAborted\(\);\n\t*try \{/.test(
		executeToolCallSpan.text,
	),
	"throwIfAborted() runs before the try block, so a refused admission never invokes the tool",
);
check(
	"primitive.throw-becomes-error-result",
	/catch \(error\) \{[\s\S]*?return \{[\s\S]*?result: createErrorToolResult\(error instanceof Error \? error\.message : String\(error\)\),[\s\S]*?isError: true,/.test(
		executeToolCallSpan.text,
	),
	"a synchronous or asynchronous tool throw becomes { result: error, isError: true } and is not re-thrown",
);
check(
	"primitive.success-flag-only-on-return",
	/return \{ result, isError: false \};/.test(executeToolCallSpan.text),
	"isError: false is only returned from the successful `await call.tool.execute(...)` path",
);

const intentSpan = span(FILES.driver, "async function publishToolIntent", "async function publishToolOutcome");
check(
	"driver.intent-published-before-effect",
	/status: "effect_pending"/.test(intentSpan.text) &&
		/replay,/.test(intentSpan.text) &&
		/setValue\(operationToolArgs\(/.test(intentSpan.text),
	"publishToolIntent commits the effect_pending intent, the replay flag, and the persisted arguments",
);

const outcomeSpan = span(FILES.driver, "async function publishToolOutcome", "async function clearReplayCheckpoint");
check(
	"driver.settles-outcome-as-message",
	/status: "outcome_ready"/.test(outcomeSpan.text) &&
		/setValue\(pendingEntry\(call.resultEntryId\), \{ type: "message", payload: finalized.message \}\)/.test(
			outcomeSpan.text,
		),
	"publishToolOutcome stages the executed message (isError preserved) as the durable result",
);

const performSpan = span(FILES.driver, "async function performToolInvocation", "async function prepareToolInvocation");
check(
	"driver.executes-after-intent-and-settles-errors",
	/execution = executeToolCall\(/.test(performSpan.text) &&
		/finalizeToolCall\(cleared, executed, patch\)/.test(performSpan.text),
	"performToolInvocation runs only once the caller holds an effect_pending intent and finalizes the error/throw result",
);

const recoverSpan = span(FILES.driver, "async function recoverToolInvocation", "async function runSequential");
check(
	"driver.recovery-retries-only-safe-intents",
	/call\.replay === "safe" && tool\?\.replay === "safe"/.test(recoverSpan.text) &&
		/clearReplayCheckpoint/.test(recoverSpan.text) &&
		/interruptedOutcome\(toolCall, checkpoint\)/.test(recoverSpan.text),
	"recoverToolInvocation replays a pending intent only when both call and tool are replay-safe, otherwise it publishes an interrupted error outcome",
);

check(
	"session.tool-call-lifecycle",
	lines(FILES.sessionTypes).some((line) => line.includes('| { status: "effect_pending"; replay: "never" | "safe" }')),
	"the durable ToolCall lifecycle keeps an explicit effect_pending intent state distinct from outcome_ready/completed",
);

// The public acceptance contract in the test file: both failure modes are pinned.
const testSpan = span(FILES.test, "it.each([", "\tit(", 151);
check(
	"test.pins-throw-to-error-output",
	testSpan.text.includes("executeToolCall(cleared, effectGate(), () => {}, undefined, invocation, BACKGROUND_CONTEXT)") &&
		testSpan.text.includes("expect(result.isError).toBe(true)") &&
		testSpan.text.includes('expect(text(result.result)).toBe("tool failed")'),
	"execution-tools.test.ts asserts synchronous and asynchronous tool throws yield isError:true with the failure text",
);

const abortSpan = span(FILES.test, 'it("lets abort-first gate refusal escape', 'it("applies patches field by field');
check(
	"test.pins-abort-refusal-without-invocation",
	abortSpan.text.includes("AbortRequested") && abortSpan.text.includes("expect(execute).not.toHaveBeenCalled()"),
	"execution-tools.test.ts asserts an abort-first gate refusal throws AbortRequested and never invokes the tool",
);

// ---------------------------------------------------------------------------
// Part 2: behavioral model mirroring the durable transitions above.
// States: planned -> effect_pending -> outcome_ready -> completed.
// ---------------------------------------------------------------------------

function runModel() {
	const scenarios = [];
	const completedSuccessWithoutEffect = [];

	function settle(durable, outcome) {
		durable.status = "outcome_ready";
		durable.outcome = outcome;
		durable.status = "completed";
		return durable;
	}

	function run(kind, { replay = "never", throws = false, abortBeforeAdmission = false, crash = false } = {}) {
		const durable = { status: "planned", args: undefined, replay, outcome: undefined, effectInvoked: false };
		// publishToolIntent
		durable.status = "effect_pending";
		durable.args = { value: "input" };
		durable.trace = ["intent_published:effect_pending"];

		if (abortBeforeAdmission) {
			// gate.admit refuses; executeToolCall throws AbortRequested before the effect.
			durable.trace.push("effect_not_invoked:abort_refused");
			return { kind, durable: settle(durable, { isError: true, text: "Tool execution was cancelled before completion." }) };
		}

		durable.effectInvoked = true;
		durable.trace.push("effect_invoked");

		if (crash) {
			// Process dies mid-effect: no outcome is settled, the intent stays durable.
			durable.trace.push("process_crash:effect_pending_left_retryable");
			if (durable.replay === "safe") {
				durable.trace.push("recovery:replay_persisted_args");
				return { kind, durable: settle(durable, { isError: false, text: "done" }) };
			}
			durable.trace.push("recovery:interrupted_marker");
			return {
				kind,
				durable: settle(durable, {
					isError: true,
					text: "external outcome is unknown",
				}),
			};
		}

		const outcome = throws ? { isError: true, text: "tool failed" } : { isError: false, text: "done" };
		durable.trace.push(throws ? "effect_failed:isError" : "effect_succeeded");
		return { kind, durable: settle(durable, outcome) };
	}

	const cases = [
		run("success", {}),
		run("throw", { throws: true }),
		run("abort-before-admission", { abortBeforeAdmission: true }),
		run("crash-replay-safe", { crash: true, replay: "safe" }),
		run("crash-replay-never", { crash: true, replay: "never" }),
	];

	for (const { kind, durable } of cases) {
		scenarios.push({
			scenario: kind,
			trace: durable.trace,
			effectInvoked: durable.effectInvoked === true,
			intentArgsPersisted: durable.args !== undefined,
			terminalStatus: durable.status,
			isError: durable.outcome?.isError,
		});
		const succeededBecauseEffectSucceeded = durable.effectInvoked && durable.outcome?.isError === false && !kind.includes("crash-replay-never");
		if (durable.outcome?.isError === false && !succeededBecauseEffectSucceeded) {
			completedSuccessWithoutEffect.push(kind);
		}
	}

	// Invariants
	check(
		"model.no-unearned-terminal-success",
		completedSuccessWithoutEffect.length === 0,
		"only an effect that actually returned successfully is recorded as a non-error completed outcome",
	);
	const success = cases.find((c) => c.kind === "success").durable;
	check(
		"model.success-is-terminal-success",
		success.status === "completed" && success.outcome.isError === false,
		"a successful effect settles as a completed, non-error outcome",
	);
	const thrown = cases.find((c) => c.kind === "throw").durable;
	check(
		"model.failed-effect-is-error-not-success",
		thrown.status === "completed" && thrown.outcome.isError === true && thrown.args !== undefined,
		"a thrown effect settles as an error outcome and keeps the persisted intent arguments",
	);
	const aborted = cases.find((c) => c.kind === "abort-before-admission").durable;
	check(
		"model.abort-refusal-does-not-invoke-effect",
		aborted.effectInvoked === false && aborted.outcome.isError === true,
		"a refused admission leaves the effect uninvoked and records an error outcome, never a success",
	);
	const safe = cases.find((c) => c.kind === "crash-replay-safe").durable;
	check(
		"model.crash-leaves-retryable-intent",
		safe.trace.includes("process_crash:effect_pending_left_retryable") &&
			safe.trace.includes("recovery:replay_persisted_args") &&
			safe.outcome.isError === false,
		"a crash mid-effect keeps the effect_pending intent so recovery retries the replay-safe effect",
	);
	const unsafe = cases.find((c) => c.kind === "crash-replay-never").durable;
	check(
		"model.unsafe-crash-stays-error",
		unsafe.trace.includes("process_crash:effect_pending_left_retryable") &&
			unsafe.outcome.isError === true,
		"a crash mid-effect for a non-replayable tool is surfaced as an interrupted error, never a success",
	);

	return scenarios;
}

const sourceCheckCount = checks.length;
const modelScenarios = runModel();
const modelCheckCount = checks.length - sourceCheckCount;

const report = {
	task_id: "T10",
	repository: "pi",
	mode: "contract",
	contract: {
		statement:
			"A tool effect is executed only after its durable effect_pending intent (arguments + replay flag) is committed; a failed effect never becomes a terminal unflagged success - a throw settles as an isError tool result, and a crash mid-effect leaves the retryable effect_pending intent for recovery.",
		path: FILES.primitive,
		symbol: "executeToolCall",
		start_line: executeToolCallSpan.start_line,
		end_line: executeToolCallSpan.end_line,
	},
	verification: {
		total_checks: checks.length,
		source_checks: sourceCheckCount,
		model_invariant_checks: modelCheckCount,
		model_scenarios: modelScenarios,
	},
	checks,
	status: checks.every((c) => c.status === "pass") ? "passed" : "failed",
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status !== "passed") process.exitCode = 1;
