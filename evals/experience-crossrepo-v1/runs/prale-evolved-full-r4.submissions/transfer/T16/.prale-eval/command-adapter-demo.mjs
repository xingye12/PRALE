#!/usr/bin/env node
/**
 * Tiny local RPC/command adapter demo (pi, task T16).
 *
 * Model: a single `dispatch(request)` entry point, mirroring the request/response
 * adapter style of `packages/agent/src/proxy.ts` (`streamProxy` posts one request
 * and funnels every failure through one terminal error shape).
 *
 * Contract
 *   request  = { id: string, command: string, params?: object }
 *   response = { ok: true,  id, result, error: null }
 *            | { ok: false, id, result: null, error: { code, message } }   <- one stable error shape
 *
 * Guarantee exercised here: invalid input is rejected by validation BEFORE the
 * fake effect runs, so the effect log is never touched by a rejected request.
 *
 * Run: node .prale-eval/command-adapter-demo.mjs
 */
import assert from "node:assert/strict";

export const ERROR_CODES = Object.freeze({
	INVALID_REQUEST: "INVALID_REQUEST",
	UNKNOWN_COMMAND: "UNKNOWN_COMMAND",
	INVALID_PARAMS: "INVALID_PARAMS",
});

/** Only constructor for a success envelope. */
export function ok(id, result) {
	return { ok: true, id, result, error: null };
}

/** Only constructor for a failure envelope: the one stable error shape. */
export function fail(id, code, message) {
	return {
		ok: false,
		id: typeof id === "string" ? id : null,
		result: null,
		error: { code, message },
	};
}

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Build a local command adapter.
 * `handlers[command] = { validate(params) -> {ok, message?}, run(params) }`.
 * `run` is the fake effect; it may only be reached after validation passes.
 */
export function createCommandAdapter({ handlers, onEffect }) {
	const effectLog = [];

	function dispatch(request) {
		// 1. Envelope validation happens first, before any handler lookup/effect.
		if (!isPlainObject(request)) {
			return fail(null, ERROR_CODES.INVALID_REQUEST, "request must be a plain object");
		}
		const { id, command, params } = request;
		if (typeof id !== "string" || id.length === 0) {
			return fail(null, ERROR_CODES.INVALID_REQUEST, "request.id must be a non-empty string");
		}
		if (typeof command !== "string" || command.length === 0) {
			return fail(id, ERROR_CODES.INVALID_REQUEST, "request.command must be a non-empty string");
		}

		// 2. Resolve the command.
		const handler = handlers[command];
		if (!handler) {
			return fail(id, ERROR_CODES.UNKNOWN_COMMAND, `unknown command: ${command}`);
		}

		// 3. Validate params BEFORE the fake effect runs.
		const call = isPlainObject(params) ? params : {};
		const validation = handler.validate(call);
		if (!validation.ok) {
			return fail(id, ERROR_CODES.INVALID_PARAMS, validation.message);
		}

		// 4. Only now perform the (fake) effect exactly once.
		const entry = { id, command, params: call };
		effectLog.push(entry);
		onEffect(entry);
		return ok(id, handler.run(call));
	}

	return { dispatch, effectLog };
}

/** Fake effect target: an in-memory ledger standing in for a real side effect. */
export function createFakeEffect() {
	const applied = [];
	return { applied, apply: (entry) => applied.push(entry) };
}

// ---------------------------------------------------------------------------
// Self-verifying demo
// ---------------------------------------------------------------------------
function run() {
	const effect = createFakeEffect();
	const adapter = createCommandAdapter({
		onEffect: effect.apply,
		handlers: {
			echo: {
				validate: (p) =>
					typeof p.message === "string"
						? { ok: true }
						: { ok: false, message: "echo.params.message must be a string" },
				run: (p) => ({ echoed: p.message }),
			},
			add: {
				validate: (p) =>
					typeof p.a === "number" && typeof p.b === "number"
						? { ok: true }
						: { ok: false, message: "add.params.a and add.params.b must be numbers" },
				run: (p) => ({ sum: p.a + p.b }),
			},
		},
	});

	const cases = [];

	// Valid input -> effect runs once.
	const okEcho = adapter.dispatch({ id: "r1", command: "echo", params: { message: "hi" } });
	assert.equal(okEcho.ok, true);
	assert.deepEqual(okEcho.result, { echoed: "hi" });
	assert.equal(adapter.effectLog.length, 1);
	cases.push({ case: "valid echo", response: okEcho, effects: adapter.effectLog.length });

	const okAdd = adapter.dispatch({ id: "r2", command: "add", params: { a: 3, b: 4 } });
	assert.deepEqual(okAdd.result, { sum: 7 });
	assert.equal(adapter.effectLog.length, 2);
	cases.push({ case: "valid add", response: okAdd, effects: adapter.effectLog.length });

	const effectsBeforeRejections = adapter.effectLog.length;

	// Invalid params -> rejected before the fake effect.
	const badParams = adapter.dispatch({ id: "r3", command: "add", params: { a: 3, b: "4" } });
	assert.equal(badParams.ok, false);
	assert.equal(badParams.error.code, "INVALID_PARAMS");
	assert.equal(adapter.effectLog.length, effectsBeforeRejections, "rejected before fake effect");
	cases.push({ case: "invalid params", response: badParams, effects: adapter.effectLog.length });

	// Unknown command -> rejected before the fake effect.
	const unknown = adapter.dispatch({ id: "r4", command: "explode", params: {} });
	assert.equal(unknown.error.code, "UNKNOWN_COMMAND");
	assert.equal(adapter.effectLog.length, effectsBeforeRejections);
	cases.push({ case: "unknown command", response: unknown, effects: adapter.effectLog.length });

	// Malformed envelope -> rejected before the fake effect.
	const badId = adapter.dispatch({ command: "echo", params: { message: "hi" } });
	assert.equal(badId.error.code, "INVALID_REQUEST");
	assert.equal(badId.id, null);
	assert.equal(adapter.effectLog.length, effectsBeforeRejections);
	cases.push({ case: "missing id", response: badId, effects: adapter.effectLog.length });

	const notObject = adapter.dispatch(null);
	assert.equal(notObject.error.code, "INVALID_REQUEST");
	assert.equal(adapter.effectLog.length, effectsBeforeRejections);
	cases.push({ case: "null request", response: notObject, effects: adapter.effectLog.length });

	// One stable error shape across every failure path.
	const failures = cases.map((c) => c.response).filter((r) => r.ok === false);
	assert.ok(failures.length >= 4);
	for (const response of failures) {
		assert.deepEqual(Object.keys(response).sort(), ["error", "id", "ok", "result"]);
		assert.deepEqual(Object.keys(response.error).sort(), ["code", "message"]);
		assert.equal(response.result, null);
		assert.equal(typeof response.error.code, "string");
		assert.equal(typeof response.error.message, "string");
	}

	const summary = {
		demo: "local RPC/command adapter",
		contract: "request -> { ok, id, result, error }",
		errorShape: "{ ok:false, id, result:null, error:{ code, message } }",
		cases: cases.map((c) => ({ case: c.case, ok: c.response.ok, code: c.response.error?.code ?? null })),
		effectsApplied: adapter.effectLog.length,
		effectsAppliedAfterRejections: adapter.effectLog.length - effectsBeforeRejections,
	};
	console.log(JSON.stringify(summary, null, 2));
	console.log("validation: PASS - invalid input rejected before fake effect, one stable error shape");
}

run();
