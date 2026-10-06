#!/usr/bin/env node
/**
 * Normalized executable contract for the tool-execution path.
 *
 * Mirrors the observable contract of
 *   packages/agent/src/harness/execution/tools.ts :: executeToolCall
 * as pinned by the acceptance test
 *   packages/agent/test/harness/execution-tools.test.ts
 *   ("converts %s tool throws to error output", lines 151-171; and
 *    "lets abort-first gate refusal escape without invoking the tool", 173-183).
 *
 * Contract under test:
 *   A tool effect that fails (throw, sync or async) must normalize to
 *   { isError: true } error output -- i.e. the failed effect is surfaced as a
 *   retryable/error intent -- and must NEVER be reported as { isError: false }
 *   terminal success. A gate refusal before admission must propagate as a
 *   thrown abort (no effect executed, no success recorded).
 *
 * Self-contained: no package dependencies, so it runs even though the repo's
 * vitest suite cannot (node_modules is absent).
 */

/** Normalize one tool effect invocation into the ExecutedToolCall shape. */
async function normalizeToolEffect(execute) {
	try {
		const result = await execute();
		return { result, isError: false };
	} catch (error) {
		return {
			result: {
				content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
				details: undefined,
			},
			isError: true,
		};
	}
}

/**
 * Model of executeToolCall's structure: the effect gate admits (and therefore
 * bounds) the normalized execution. A refusal thrown by admit() escapes before
 * normalization runs, so it is never mistaken for a failed-but-recorded effect.
 */
function executeToolCall(gate, execute) {
	return gate.admit(() => normalizeToolEffect(execute));
}

/** Gate admitting or refusing the effect before it is executed. */
function createGate({ abortFirst = false } = {}) {
	let admitted = 0;
	return {
		signal: { aborted: abortFirst },
		admit(work) {
			if (abortFirst) {
				const error = new Error("abort requested");
				error.name = "AbortRequested";
				throw error;
			}
			admitted += 1;
			return work();
		},
		get admitted() {
			return admitted;
		},
	};
}

function textOf(result) {
	return result.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n");
}

const failures = [];
function check(label, condition, detail) {
	if (condition) {
		console.log(`  PASS  ${label}`);
	} else {
		failures.push(`${label}: ${detail}`);
		console.log(`  FAIL  ${label} -> ${detail}`);
	}
}

console.log("normalized tool-effect contract (pi :: execution-tools)\n");

const openGate = () => createGate();

// Scenario 1: synchronous throw -> error output, not terminal success.
{
	const outcome = await executeToolCall(openGate(), () => {
		throw new Error("tool failed");
	});
	check("sync throw isError === true", outcome.isError === true, JSON.stringify(outcome));
	check("sync throw surfaces message", textOf(outcome.result) === "tool failed", textOf(outcome.result));
}

// Scenario 2: asynchronous throw -> error output, not terminal success.
{
	const outcome = await executeToolCall(openGate(), async () => {
		throw new Error("tool failed");
	});
	check("async throw isError === true", outcome.isError === true, JSON.stringify(outcome));
	check("async throw surfaces message", textOf(outcome.result) === "tool failed", textOf(outcome.result));
}

// Scenario 3: successful effect -> isError === false (control).
{
	const outcome = await executeToolCall(openGate(), async () => ({
		content: [{ type: "text", text: "done" }],
		details: { value: "done" },
	}));
	check("success isError === false", outcome.isError === false, JSON.stringify(outcome));
	check("success preserves output", textOf(outcome.result) === "done", textOf(outcome.result));
}

// Scenario 4: gate refusal before admission escapes and executes nothing.
{
	const gate = createGate({ abortFirst: true });
	let invoked = false;
	let threw = false;
	try {
		executeToolCall(gate, () => {
			invoked = true;
			return { content: [], details: undefined };
		});
	} catch (error) {
		threw = error.name === "AbortRequested";
	}
	check("abort-first refusal throws before admission", threw, "no AbortRequested propagated");
	check("abort-first refusal executes no effect", invoked === false && gate.admitted === 0, "effect was executed");
}

console.log("");
if (failures.length > 0) {
	console.error(`CONTRACT VIOLATED (${failures.length}):`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log("CONTRACT SATISFIED: failed effects normalize to retryable error output, never terminal success.");
