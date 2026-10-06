#!/usr/bin/env node
/**
 * Tiny local RPC/command adapter demo (task T19).
 *
 * Design contract, borrowed from the degradation/error handling in
 * `packages/agent/src/proxy.ts`:
 *
 *   1. Validation happens *before* the effect. `dispatch()` checks the request
 *      envelope, the command name, and the parameter schema first; the fake
 *      effect is only invoked once every check passed. An invalid request
 *      therefore never mutates adapter state (effectsApplied stays 0).
 *   2. Every failure - malformed request, unknown command, invalid params, and
 *      even a throwing command body - is normalized into exactly one error
 *      shape: `{ ok: false, error: { code, message, details } }`.
 *   3. `dispatch()` never throws. Callers branch on `ok`, like proxy stream
 *      consumers branch on the single terminal `type: "error"` event.
 *
 * The module is dependency-free ESM so it runs with plain `node`.
 *
 * Usage:
 *   node packages/agent/demo/rpc-adapter-demo.mjs                 # scripted, self-checking demo
 *   node packages/agent/demo/rpc-adapter-demo.mjs '{"command":"echo","params":{"text":"hi"}}'
 *   node --test packages/agent/demo/rpc-adapter-demo.test.mjs     # focused validation
 */

/** Canonical error codes. Every rejection uses one of these. */
export const ERROR_CODES = Object.freeze({
	INVALID_REQUEST: "invalid_request",
	UNKNOWN_COMMAND: "unknown_command",
	INVALID_PARAMS: "invalid_params",
	EFFECT_FAILED: "effect_failed",
});

/** Exact key set of the single stable error shape. */
export const ERROR_ENVELOPE_KEYS = Object.freeze(["ok", "error"]);
export const ERROR_BODY_KEYS = Object.freeze(["code", "message", "details"]);
export const SUCCESS_ENVELOPE_KEYS = Object.freeze(["ok", "result"]);

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeName(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/** Build a successful normalized operation result. */
export function resolve(result) {
	return { ok: true, result };
}

/** Build the one and only error shape. This is the only place errors are constructed. */
export function reject(code, message, details = {}) {
	if (typeof code !== "string" || code.length === 0) {
		throw new TypeError("reject() requires a non-empty string code");
	}
	if (typeof message !== "string" || message.length === 0) {
		throw new TypeError("reject() requires a non-empty string message");
	}
	if (!isPlainObject(details)) {
		throw new TypeError("reject() requires a plain object for details");
	}
	return { ok: false, error: { code, message, details } };
}

/** Shape predicate: true only for a well-formed rejection produced by `reject()`. */
export function isErrorEnvelope(value) {
	if (!isPlainObject(value)) return false;
	if (Object.keys(value).length !== ERROR_ENVELOPE_KEYS.length) return false;
	if (!ERROR_ENVELOPE_KEYS.every((key) => Object.hasOwn(value, key))) return false;
	const body = value.error;
	if (!isPlainObject(body)) return false;
	if (Object.keys(body).length !== ERROR_BODY_KEYS.length) return false;
	if (!ERROR_BODY_KEYS.every((key) => Object.hasOwn(body, key))) return false;
	return (
		typeof body.code === "string" &&
		body.code.length > 0 &&
		typeof body.message === "string" &&
		body.message.length > 0 &&
		isPlainObject(body.details)
	);
}

/** Shape predicate for the normalized success result. */
export function isSuccessEnvelope(value) {
	return (
		isPlainObject(value) &&
		Object.keys(value).length === SUCCESS_ENVELOPE_KEYS.length &&
		SUCCESS_ENVELOPE_KEYS.every((key) => Object.hasOwn(value, key)) &&
		value.ok === true
	);
}

const PARAM_CHECKS = {
	string: (value) => (typeof value === "string" ? undefined : "must be a string"),
	"non-empty-string": (value) =>
		typeof value === "string" && value.trim() !== "" ? undefined : "must be a non-empty string",
	number: (value) =>
		typeof value === "number" && Number.isFinite(value) ? undefined : "must be a finite number",
	"number[]": (value) =>
		Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item))
			? undefined
			: "must be an array of finite numbers",
	boolean: (value) => (typeof value === "boolean" ? undefined : "must be a boolean"),
};

/**
 * Validate params against a `{ paramName: typeName }` schema.
 * Returns a list of human readable problems; an empty list means valid.
 * Unknown params are rejected so typos fail loudly instead of being ignored.
 */
export function validateParams(schema, params) {
	const problems = [];
	for (const [key, expected] of Object.entries(schema)) {
		const check = PARAM_CHECKS[expected];
		if (!check) throw new Error(`unknown param type in schema: ${expected}`);
		if (!Object.hasOwn(params, key)) {
			problems.push(`missing required param "params.${key}"`);
			continue;
		}
		const problem = check(params[key]);
		if (problem) problems.push(`params.${key} ${problem}`);
	}
	for (const key of Object.keys(params)) {
		if (!Object.hasOwn(schema, key)) problems.push(`unexpected param "params.${key}"`);
	}
	return problems;
}

/**
 * Command table: `schema` is checked before the command runs, `effect` produces
 * the payload handed to the fake effect. `explode` exists only to prove that a
 * runtime failure is normalized into the same error shape as a rejection.
 */
export const COMMANDS = Object.freeze({
	echo: {
		schema: { text: "non-empty-string" },
		effect: (params) => ({ echoed: params.text }),
	},
	sum: {
		schema: { values: "number[]" },
		effect: (params) => ({ total: params.values.reduce((acc, value) => acc + value, 0) }),
	},
	explode: {
		schema: {},
		effect: () => {
			throw new Error("fake backend exploded");
		},
	},
});

/** A fake side effect: it only records that it ran, so tests can count calls. */
export function createFakeEffect() {
	const applied = [];
	return {
		apply(command, payload) {
			applied.push({ command, payload: JSON.parse(JSON.stringify(payload)) });
			return { applied: true, command, payload };
		},
		count: () => applied.length,
		entries: () => applied.map((entry) => ({ ...entry })),
	};
}

/**
 * Create the adapter. `dispatch` accepts a JSON-ish RPC request
 * (`{ command: string, params?: object }`) and always returns either the
 * success envelope or the single stable error envelope.
 */
export function createLocalRpcAdapter({ effect = createFakeEffect(), commands = COMMANDS } = {}) {
	function dispatch(request) {
		// --- validation phase: nothing below touches the effect ---
		if (!isPlainObject(request)) {
			return reject(ERROR_CODES.INVALID_REQUEST, "request must be a JSON object", {
				field: "request",
				received: typeName(request),
			});
		}
		if (typeof request.command !== "string" || request.command.trim() === "") {
			return reject(ERROR_CODES.INVALID_REQUEST, "request.command must be a non-empty string", {
				field: "command",
				received: typeName(request.command),
			});
		}
		const command = Object.hasOwn(commands, request.command) ? commands[request.command] : undefined;
		if (!command) {
			return reject(ERROR_CODES.UNKNOWN_COMMAND, `unknown command: ${request.command}`, {
				command: request.command,
				known: Object.keys(commands),
			});
		}
		const params = request.params === undefined ? {} : request.params;
		if (!isPlainObject(params)) {
			return reject(ERROR_CODES.INVALID_PARAMS, "request.params must be a JSON object", {
				field: "params",
				received: typeName(params),
			});
		}
		const problems = validateParams(command.schema, params);
		if (problems.length > 0) {
			return reject(ERROR_CODES.INVALID_PARAMS, problems.join("; "), {
				command: request.command,
				problems,
			});
		}

		// --- effect phase: only reached by fully valid input ---
		try {
			const payload = command.effect(params);
			return resolve(effect.apply(request.command, payload));
		} catch (error) {
			return reject(
				ERROR_CODES.EFFECT_FAILED,
				error instanceof Error ? error.message : String(error),
				{ command: request.command },
			);
		}
	}

	return {
		dispatch,
		effect,
		commands,
		errorShapeKeys: { envelope: ERROR_ENVELOPE_KEYS, error: ERROR_BODY_KEYS },
	};
}

const SCRIPTED_CASES = [
	{ label: "valid echo", request: { command: "echo", params: { text: "hello" } }, expect: "ok" },
	{ label: "valid sum", request: { command: "sum", params: { values: [1, 2, 3] } }, expect: "ok" },
	{ label: "command body throws", request: { command: "explode" }, expect: "error:effect_failed" },
	{ label: "unknown command", request: { command: "nope" }, expect: "error:unknown_command" },
	{ label: "missing param", request: { command: "echo", params: {} }, expect: "error:invalid_params" },
	{ label: "wrong param type", request: { command: "echo", params: { text: 42 } }, expect: "error:invalid_params" },
	{ label: "unexpected param", request: { command: "echo", params: { text: "hi", oops: true } }, expect: "error:invalid_params" },
	{ label: "params not an object", request: { command: "echo", params: "hi" }, expect: "error:invalid_params" },
	{ label: "command not a string", request: { command: 7 }, expect: "error:invalid_request" },
	{ label: "request not an object", request: null, expect: "error:invalid_request" },
];

/**
 * Run the scripted demo. Every invalid case must be rejected by the validation
 * phase with the stable shape and must leave the fake effect untouched.
 * Returns true when all expectations hold.
 */
export function runScriptedDemo({ write = (line) => console.log(line) } = {}) {
	const adapter = createLocalRpcAdapter();
	let failures = 0;
	for (const demoCase of SCRIPTED_CASES) {
		const before = adapter.effect.count();
		const outcome = adapter.dispatch(demoCase.request);
		const after = adapter.effect.count();
		const actual = outcome.ok ? "ok" : `error:${outcome.error.code}`;
		let passed = actual === demoCase.expect;
		if (!outcome.ok) {
			passed = passed && isErrorEnvelope(outcome) && after === before;
		} else {
			passed = passed && isSuccessEnvelope(outcome) && after === before + 1;
		}
		if (!passed) failures += 1;
		write(
			JSON.stringify({
				case: demoCase.label,
				request: demoCase.request,
				outcome,
				effectCallsBefore: before,
				effectCallsAfter: after,
				expected: demoCase.expect,
				passed,
			}),
		);
	}
	write(
		JSON.stringify({
			summary: failures === 0 ? "pass" : "fail",
			cases: SCRIPTED_CASES.length,
			failures,
			effectsApplied: adapter.effect.count(),
			errorShape: adapter.errorShapeKeys,
		}),
	);
	return failures === 0;
}

function main(argv) {
	const rawRequest = argv[2];
	if (rawRequest !== undefined) {
		let request;
		try {
			request = JSON.parse(rawRequest);
		} catch (error) {
			// Even CLI-level parse failures use the one stable shape.
			const outcome = reject(ERROR_CODES.INVALID_REQUEST, `request is not valid JSON: ${error.message}`, {
				field: "argv[2]",
			});
			console.log(JSON.stringify(outcome));
			return 0;
		}
		console.log(JSON.stringify(createLocalRpcAdapter().dispatch(request)));
		// A rejection is a normalized result, not a crash: exit 0 either way.
		return 0;
	}
	return runScriptedDemo() ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	process.exitCode = main(process.argv);
}
